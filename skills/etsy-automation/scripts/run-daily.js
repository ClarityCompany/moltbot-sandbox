#!/usr/bin/env node
/**
 * Daily Etsy Automation Orchestrator
 *
 * Runs the full daily workflow:
 *   1. Research   — Discover today's top-selling digital products on Etsy
 *   2. Analyze    — Use Claude to select 3 copyright-safe product opportunities
 *   3. Design     — Create product files and mockups via Canva Connect API
 *   4. List       — Post the products as Etsy listings
 *   5. Metrics    — Pull shop performance data + generate insights
 *   6. Notify     — Send Telegram summary messages
 *
 * If any step fails, the failure is logged and the workflow continues with
 * remaining steps (partial success is better than total failure).
 *
 * Writes /root/clawd/etsy-automation/last-run.json after each run.
 *
 * Usage:
 *   node run-daily.js                      (run today's full workflow)
 *   node run-daily.js --skip-design        (skip Canva step — use existing designs)
 *   node run-daily.js --skip-mockups       (skip DALL-E 3 mockup generation)
 *   node run-daily.js --skip-sheets        (skip Google Sheets step)
 *   node run-daily.js --skip-listing       (skip Etsy posting)
 *   node run-daily.js --skip-notify        (skip Telegram messages)
 *   node run-daily.js --date=2025-06-01    (re-run a specific date)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.ETSY_DATA_DIR || '/root/clawd/etsy-automation';
const SKILLS_DIR = path.dirname(__dirname); // /root/clawd/skills/etsy-automation

// Lazily require each step module
function step(name) {
  return require(path.join(SKILLS_DIR, 'scripts', name));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseFlag(flag) {
  return process.argv.includes(flag);
}

function parseDateArg() {
  const arg = process.argv.find((a) => a.startsWith('--date='));
  return arg ? arg.split('=')[1] : new Date().toISOString().slice(0, 10);
}

async function runStep(label, fn) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[run-daily] STEP: ${label}`);
  console.log(`${'─'.repeat(60)}`);
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[run-daily] ✅ ${label} completed in ${elapsed}s`);
    return { status: 'success', result };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`[run-daily] ❌ ${label} failed after ${elapsed}s: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

// ─── Main workflow ────────────────────────────────────────────────────────────

async function main() {
  const date      = parseDateArg();
  const skipDesign   = parseFlag('--skip-design');
  const skipMockups  = parseFlag('--skip-mockups');
  const skipSheets   = parseFlag('--skip-sheets');
  const skipListing = parseFlag('--skip-listing');
  const skipMetrics = parseFlag('--skip-metrics');
  const skipNotify  = parseFlag('--skip-notify');

  const startedAt = new Date().toISOString();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[run-daily] ETSY AUTOMATION — ${date}`);
  console.log(`[run-daily] Started at: ${startedAt}`);
  console.log(`${'═'.repeat(60)}`);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const log = {
    date,
    started_at: startedAt,
    steps:      {},
  };

  // ── Step 1: Research ──────────────────────────────────────────────────────
  const researchResult = await runStep('Research (Etsy top sellers)', () =>
    step('etsy-research').runResearch(),
  );
  log.steps.research = { status: researchResult.status, error: researchResult.error };

  if (researchResult.status === 'failed') {
    // Without research data we cannot proceed to analysis
    console.error('[run-daily] Research failed — aborting product creation steps');
    log.status = 'partial_failure';
    saveSummary(log, date);
    // Still run metrics + notify
  } else {
    // ── Step 2: Analyze ──────────────────────────────────────────────────────
    const analyzeResult = await runStep('Analyze (Claude product selection)', () =>
      step('product-analyzer').analyzeProducts(date),
    );
    log.steps.analyze = { status: analyzeResult.status, error: analyzeResult.error };

    // ── Step 3: Design (Claude SVG generator) ────────────────────────────────
    if (!skipDesign) {
      const designResult = await runStep('Design (Claude SVG generator)', () =>
        step('svg-designer').runDesigner(date),
      );
      log.steps.design = { status: designResult.status, error: designResult.error };
    } else {
      console.log('[run-daily] Skipping design step (--skip-design)');
      log.steps.design = { status: 'skipped' };
    }

    // ── Step 4: Mockup Generation (DALL-E 3) ──────────────────────────────────
    if (!skipMockups) {
      const mockupResult = await runStep('Mockup Generation (DALL-E 3)', () =>
        step('mockup-generator').runMockupGenerator(date),
      );
      log.steps.mockups = { status: mockupResult.status, error: mockupResult.error };
    } else {
      console.log('[run-daily] Skipping mockup step (--skip-mockups)');
      log.steps.mockups = { status: 'skipped' };
    }

    // ── Step 5: Google Sheets ──────────────────────────────────────────────────
    if (!skipSheets) {
      const sheetsResult = await runStep('Google Sheets (write product rows)', () =>
        step('google-sheets-writer').runGoogleSheetsWriter(date),
      );
      log.steps.sheets = { status: sheetsResult.status, error: sheetsResult.error };
    } else {
      console.log('[run-daily] Skipping sheets step (--skip-sheets)');
      log.steps.sheets = { status: 'skipped' };
    }

    // ── Step 6: List on Etsy ──────────────────────────────────────────────────
    if (!skipListing) {
      const listResult = await runStep('List (Etsy listings)', () =>
        step('etsy-lister').runLister(date),
      );
      log.steps.listing = { status: listResult.status, error: listResult.error };

      // Attach listing URLs to the log for easy reference
      if (listResult.status === 'success') {
        log.listings = (listResult.result?.listings || [])
          .filter((l) => l.status === 'success')
          .map((l) => ({ title: l.title, url: l.listing_url, price: l.price_usd }));
      }
    } else {
      console.log('[run-daily] Skipping listing step (--skip-listing)');
      log.steps.listing = { status: 'skipped' };
    }
  }

  // ── Step 7: Metrics ───────────────────────────────────────────────────────
  if (!skipMetrics) {
    const metricsResult = await runStep('Metrics (shop performance)', () =>
      step('metrics-tracker').runMetricsTracker(),
    );
    log.steps.metrics = { status: metricsResult.status, error: metricsResult.error };

    if (metricsResult.status === 'success') {
      log.sales_today = metricsResult.result?.total_sales ?? 0;
      log.revenue_today = metricsResult.result?.revenue_usd ?? 0;
    }
  } else {
    console.log('[run-daily] Skipping metrics step (--skip-metrics)');
    log.steps.metrics = { status: 'skipped' };
  }

  // ── Step 8: Notify ────────────────────────────────────────────────────────
  if (!skipNotify) {
    const notifyResult = await runStep('Notify (Telegram)', () =>
      step('telegram-notifier').runNotifier(date),
    );
    log.steps.notify = { status: notifyResult.status, error: notifyResult.error };
  } else {
    console.log('[run-daily] Skipping notify step (--skip-notify)');
    log.steps.notify = { status: 'skipped' };
  }

  // ── Finalise ──────────────────────────────────────────────────────────────
  log.ended_at  = new Date().toISOString();
  const elapsed  = ((new Date(log.ended_at) - new Date(log.started_at)) / 1000).toFixed(0);
  const failures = Object.values(log.steps).filter((s) => s.status === 'failed').length;
  log.status     = failures === 0 ? 'success' : failures < 3 ? 'partial_success' : 'failed';

  saveSummary(log, date);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[run-daily] COMPLETED in ${elapsed}s — Status: ${log.status.toUpperCase()}`);
  if (log.listings?.length) {
    console.log(`[run-daily] Listings created:`);
    log.listings.forEach((l) => console.log(`  • ${l.title} — ${l.url}`));
  }
  console.log(`${'═'.repeat(60)}\n`);

  return log;
}

function saveSummary(log, date) {
  // last-run.json — always latest
  fs.writeFileSync(path.join(DATA_DIR, 'last-run.json'), JSON.stringify(log, null, 2));
  // Archive per-date run log
  const runLogsDir = path.join(DATA_DIR, 'run-logs');
  fs.mkdirSync(runLogsDir, { recursive: true });
  fs.writeFileSync(path.join(runLogsDir, `${date}.json`), JSON.stringify(log, null, 2));
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main()
  .then((log) => {
    process.exit(log.status === 'failed' ? 1 : 0);
  })
  .catch((err) => {
    console.error('[run-daily] Unexpected fatal error:', err);
    process.exit(1);
  });
