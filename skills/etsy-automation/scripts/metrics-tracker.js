#!/usr/bin/env node
/**
 * Metrics Tracker
 *
 * Fetches daily shop performance data from the Etsy API and builds a
 * running history of what drives top-earning digital products.
 *
 * Tracks per listing:
 *   - Views, favorites, sales, revenue
 *
 * Tracks shop-wide:
 *   - Total daily revenue, conversion rate, most-viewed / most-sold listings
 *
 * After collecting data, uses Claude to generate actionable insights that
 * feed back into future product_analyzer.js selections.
 *
 * Output:
 *   /root/clawd/etsy-automation/metrics/YYYY-MM-DD.json  — daily snapshot
 *   /root/clawd/etsy-automation/metrics/insights.json    — rolling AI insights
 *
 * Usage:
 *   node metrics-tracker.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { etsyFetch } = require('./etsy-auth');

const DATA_DIR    = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const METRICS_DIR = path.join(DATA_DIR, 'metrics');
const SHOP_ID     = process.env.ETSY_SHOP_ID;

// ─── Claude helper (same as product-analyzer) ─────────────────────────────────

async function callClaude(messages, systemPrompt) {
  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-5',
      max_tokens: 2048,
      system:     systemPrompt,
      messages,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

// ─── Fetch shop listings with stats ──────────────────────────────────────────

async function fetchShopListings() {
  if (!SHOP_ID) throw new Error('ETSY_SHOP_ID is not set');

  const params = new URLSearchParams({
    limit:  '100',
    offset: '0',
    includes: 'stats',
    state: 'active',
  });

  const data = await etsyFetch(
    `/v3/application/shops/${SHOP_ID}/listings?${params}`,
  );

  return data.results || [];
}

// ─── Fetch recent transactions (sales) ───────────────────────────────────────

async function fetchRecentTransactions() {
  if (!SHOP_ID) throw new Error('ETSY_SHOP_ID is not set');

  // Get transactions from the last 24 hours
  const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

  const params = new URLSearchParams({
    limit:  '100',
    offset: '0',
    min_created: String(oneDayAgo),
  });

  try {
    const data = await etsyFetch(
      `/v3/application/shops/${SHOP_ID}/transactions?${params}`,
    );
    return data.results || [];
  } catch (err) {
    console.warn(`[metrics] Could not fetch transactions: ${err.message}`);
    return [];
  }
}

// ─── Load previous metrics history ───────────────────────────────────────────

function loadHistory(limit = 30) {
  const files = fs
    .readdirSync(METRICS_DIR)
    .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
    .sort()
    .slice(-limit);

  return files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(METRICS_DIR, f), 'utf8'));
    } catch { return null; }
  }).filter(Boolean);
}

// ─── Generate AI insights ─────────────────────────────────────────────────────

async function generateInsights(todaySnapshot, history) {
  console.log('[metrics] Generating AI insights with Claude...');

  const histSummary = history.slice(-7).map((h) => ({
    date:         h.date,
    total_sales:  h.total_sales,
    revenue_usd:  h.revenue_usd,
    top_listings: (h.listings || [])
      .sort((a, b) => (b.sales_today || 0) - (a.sales_today || 0))
      .slice(0, 5)
      .map((l) => ({ title: l.title, sales: l.sales_today, views: l.views_today })),
  }));

  const systemPrompt = `You are an Etsy shop analytics expert. Analyze performance data and provide concise, actionable insights for a digital product shop. Focus on patterns that predict sales: pricing, keywords, product types, seasonality, and design trends. Respond ONLY with valid JSON.`;

  const responseText = await callClaude(
    [{
      role:    'user',
      content: `Analyze this Etsy shop performance data and return actionable insights.

TODAY'S SNAPSHOT:
${JSON.stringify(todaySnapshot, null, 2)}

LAST 7 DAYS:
${JSON.stringify(histSummary, null, 2)}

Return a JSON object:
{
  "updated_at": "${new Date().toISOString()}",
  "summary": "2-3 sentence overall performance summary",
  "top_performing_categories": ["category1", ...],
  "winning_price_range": { "min": 2.99, "max": 5.99 },
  "high_converting_tags": ["tag1", ...],
  "design_trends": ["trend1", ...],
  "recommendations": [
    "Actionable recommendation 1",
    "Actionable recommendation 2",
    "Actionable recommendation 3"
  ],
  "avoid_creating": ["pattern or type to avoid due to poor performance"]
}`,
    }],
    systemPrompt,
  );

  try {
    const cleaned = responseText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    return JSON.parse(cleaned);
  } catch {
    console.warn('[metrics] Could not parse Claude insights as JSON');
    return { updated_at: new Date().toISOString(), raw: responseText };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runMetricsTracker() {
  const date = new Date().toISOString().slice(0, 10);
  console.log(`[metrics] Tracking metrics for ${date}...`);

  fs.mkdirSync(METRICS_DIR, { recursive: true });

  // Fetch data
  const [listings, transactions] = await Promise.all([
    fetchShopListings(),
    fetchRecentTransactions(),
  ]);

  // Map transactions to listing IDs
  const salesByListing = {};
  let totalRevenue = 0;

  for (const tx of transactions) {
    const lid = String(tx.listing_id);
    if (!salesByListing[lid]) salesByListing[lid] = { count: 0, revenue: 0 };
    salesByListing[lid].count++;
    salesByListing[lid].revenue += tx.price?.amount
      ? tx.price.amount / (tx.price.divisor || 100)
      : 0;
    totalRevenue += salesByListing[lid].revenue;
  }

  // Build per-listing metrics
  const listingMetrics = listings.map((l) => {
    const lid    = String(l.listing_id);
    const sales  = salesByListing[lid] || { count: 0, revenue: 0 };
    return {
      listing_id:    l.listing_id,
      title:         l.title,
      price_usd:     l.price?.amount ? l.price.amount / (l.price.divisor || 100) : null,
      views_today:   l.stats?.views || 0,
      favorites:     l.num_favorers || 0,
      sales_today:   sales.count,
      revenue_today: parseFloat(sales.revenue.toFixed(2)),
      state:         l.state,
    };
  });

  const snapshot = {
    date,
    timestamp:     new Date().toISOString(),
    total_listings: listings.length,
    total_sales:   transactions.length,
    revenue_usd:   parseFloat(totalRevenue.toFixed(2)),
    listings:      listingMetrics,
  };

  // Save daily snapshot
  fs.writeFileSync(path.join(METRICS_DIR, `${date}.json`), JSON.stringify(snapshot, null, 2));
  console.log(
    `[metrics] Snapshot saved: ${listings.length} listings, ${transactions.length} sales today, $${snapshot.revenue_usd} revenue`,
  );

  // Generate insights every day (used by product-analyzer)
  try {
    const history  = loadHistory(30);
    const insights = await generateInsights(snapshot, history);
    fs.writeFileSync(path.join(METRICS_DIR, 'insights.json'), JSON.stringify(insights, null, 2));
    console.log('[metrics] Insights updated');
  } catch (err) {
    console.warn(`[metrics] Insights generation failed: ${err.message}`);
  }

  return snapshot;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runMetricsTracker()
    .then((snap) => {
      console.log(`\nToday's metrics:`);
      console.log(`  Active listings: ${snap.total_listings}`);
      console.log(`  Sales today:     ${snap.total_sales}`);
      console.log(`  Revenue today:   $${snap.revenue_usd}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[metrics] Fatal error:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { runMetricsTracker };
}
