#!/usr/bin/env node
/**
 * Daily Etsy Automation Orchestrator
 *
 * Runs the full daily workflow:
 *   1. Research  — Claude searches the web for today's top digital products on Etsy
 *   2. Analyze   — Claude selects 3 unique product opportunities with full metadata
 *   3. Design    — Claude generates SVG designs → renders to PNG (the download file)
 *   4. Mockups   — DALL-E 3 generates 4 lifestyle mockup images per product
 *   5. Sheets    — Uploads mockups to Google Drive, writes row to Google Sheet
 *   6. Notify    — Sends Telegram summary
 *
 * Make then reads the Google Sheet and creates the Etsy listings.
 *
 * Usage:
 *   node run-daily.js                      (run today's full workflow)
 *   node run-daily.js --skip-design        (use existing designs)
 *   node run-daily.js --skip-mockups       (skip DALL-E mockup generation)
 *   node run-daily.js --skip-sheets        (skip Google Sheets step)
 *   node run-daily.js --skip-notify        (skip Telegram messages)
 *   node run-daily.js --date=2025-06-01    (re-run a specific date)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const SKILLS_DIR = path.dirname(__dirname);

function step(name) {
  return require(path.join(SKILLS_DIR, 'scripts', name));
}

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
    const result  = await fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[run-daily] ✅ ${label} completed in ${elapsed}s`);
    return { status: 'success', result };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`[run-daily] ❌ ${label} failed after ${elapsed}s: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}

async function main() {
  const date        = parseDateArg();
  const skipDesign  = parseFlag('--skip-design');
  const skipMockups = parseFlag('--skip-mockups');
  const skipSheets  = parseFlag('--skip-sheets');
  const skipNotify  = parseFlag('--skip-notify');

  const startedAt = new Date().toISOString();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[run-daily] ETSY AUTOMATION — ${date}`);
  console.log(`[run-daily] Started at: ${startedAt}`);
  console.log(`${'═'.repeat(60)}`);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const log = { date, started_at: startedAt, steps: {} };

  // ── Step 1: Research ────────────────────────────────────────────────────────
  const researchResult = await runStep('Research (Claude web search)', () =>
    step('etsy-research').runResearch(),
  );
  log.steps.research = { status: researchResult.status, error: researchResult.error };

  if (researchResult.status === 'failed') {
    console.error('[run-daily] Research failed — aborting product creation steps');
    log.status = 'partial_failure';
    saveSummary(log, date);
  } else {
    // ── Step 2: Analyze ────────────────────────────────────────────────────────
    const analyzeResult = await runStep('Analyze (Claude product selection)', () =>
      step('product-analyzer').analyzeProducts(date),
    );
    log.steps.analyze = { status: analyzeResult.status, error: analyzeResult.error };

    // ── Step 3: Design ─────────────────────────────────────────────────────────
    if (!skipDesign) {
      const designResult = await runStep('Design (Claude SVG generator)', () =>
        step('svg-designer').runDesigner(date),
      );
      log.steps.design = { status: designResult.status, error: designResult.error };
    } else {
      console.log('[run-daily] Skipping design step (--skip-design)');
      log.steps.design = { status: 'skipped' };
    }

    // ── Step 4: Mockups ────────────────────────────────────────────────────────
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
      const sheetsResult = await runStep('Google Sheets (upload + write row)', () =>
        step('google-sheets-writer').runGoogleSheetsWriter(date),
      );
      log.steps.sheets = { status: sheetsResult.status, error: sheetsResult.error };
    } else {
      console.log('[run-daily] Skipping sheets step (--skip-sheets)');
      log.steps.sheets = { status: 'skipped' };
    }
  }

  // ── Step 6: Notify ───────────────────────────────────────────────────────────
  if (!skipNotify) {
    const notifyResult = await runStep('Notify (Telegram)', () =>
      step('telegram-notifier').runNotifier(date),
    );
    log.steps.notify = { status: notifyResult.status, error: notifyResult.error };
  } else {
    console.log('[run-daily] Skipping notify step (--skip-notify)');
    log.steps.notify = { status: 'skipped' };
  }

  // ── Finalise ─────────────────────────────────────────────────────────────────
  log.ended_at  = new Date().toISOString();
  const elapsed  = ((new Date(log.ended_at) - new Date(log.started_at)) / 1000).toFixed(0);
  const failures = Object.values(log.steps).filter((s) => s.status === 'failed').length;
  log.status     = failures === 0 ? 'success' : failures < 3 ? 'partial_success' : 'failed';

  saveSummary(log, date);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[run-daily] COMPLETED in ${elapsed}s — Status: ${log.status.toUpperCase()}`);
  console.log(`${'═'.repeat(60)}\n`);

  return log;
}

function saveSummary(log, date) {
  fs.writeFileSync(path.join(DATA_DIR, 'last-run.json'), JSON.stringify(log, null, 2));
  const runLogsDir = path.join(DATA_DIR, 'run-logs');
  fs.mkdirSync(runLogsDir, { recursive: true });
  fs.writeFileSync(path.join(runLogsDir, `${date}.json`), JSON.stringify(log, null, 2));
}

main()
  .then((log) => process.exit(log.status === 'failed' ? 1 : 0))
  .catch((err) => {
    console.error('[run-daily] Unexpected fatal error:', err);
    process.exit(1);
  });
