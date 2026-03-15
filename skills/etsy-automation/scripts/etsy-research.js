#!/usr/bin/env node
/**
 * Etsy Research Module
 *
 * Discovers the top-selling digital products on Etsy each day.
 *
 * Strategy (two-pass):
 *   1. Etsy API — query active digital listings with sort_on=top_listings across
 *      several high-value taxonomy/keyword combinations.
 *   2. Browser scraping (CDP fallback) — if the API returns sparse results, scrape
 *      Etsy's public search page to supplement with visual/ranking signals.
 *
 * Output: writes /root/clawd/etsy-automation/research/YYYY-MM-DD.json
 *
 * Usage:
 *   node etsy-research.js               (runs research, writes file)
 *   node etsy-research.js --print       (also prints summary to stdout)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { etsyPublicFetch } = require('./etsy-auth');

const DATA_DIR      = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const RESEARCH_DIR  = path.join(DATA_DIR, 'research');

// ─── Configuration ────────────────────────────────────────────────────────────

// Product categories to research (Etsy taxonomy IDs for digital goods)
// https://www.etsy.com/developers/documentation/getting_started/taxonomy
const RESEARCH_QUERIES = [
  { label: 'Printable Wall Art',   keywords: 'printable wall art digital download' },
  { label: 'SVG Cut Files',        keywords: 'svg cut file cricut silhouette digital' },
  { label: 'Digital Planner',      keywords: 'digital planner pdf goodnotes' },
  { label: 'Canva Template',       keywords: 'canva template editable social media' },
  { label: 'Budget Spreadsheet',   keywords: 'budget spreadsheet excel google sheets template' },
  { label: 'Printable Planner',    keywords: 'printable planner pages inserts pdf' },
  { label: 'Clipart Bundle',       keywords: 'clipart bundle digital illustration' },
  { label: 'Resume Template',      keywords: 'resume template word canva instant download' },
];

const LISTINGS_PER_QUERY = 25; // Etsy API max 100, we cap at 25 per query
const MIN_FAVORITES = 10;       // Filter out listings with very few saves

// ─── Etsy API research ────────────────────────────────────────────────────────

async function fetchTopListingsForQuery(query) {
  console.log(`  [research] Querying Etsy API: "${query.keywords}"`);

  try {
    const params = new URLSearchParams({
      keywords:           query.keywords,
      limit:              String(LISTINGS_PER_QUERY),
      sort_on:            'score',       // relevancy + popularity signals
      listing_type:       'download',    // digital downloads only
      includes:           'images,tags',
      fields:             'listing_id,title,description,price,tags,views,num_favorers,url,images,taxonomy_path,created_timestamp',
    });

    const data = await etsyPublicFetch(`/v3/application/listings/active?${params}`);
    const listings = (data.results || []).filter(
      (l) => (l.num_favorers || 0) >= MIN_FAVORITES,
    );

    return listings.map((l) => ({
      listing_id:    l.listing_id,
      title:         l.title,
      description:   (l.description || '').slice(0, 500),
      price_usd:     l.price?.amount ? l.price.amount / l.price.divisor : null,
      currency:      l.price?.currency_code || 'USD',
      tags:          l.tags || [],
      views:         l.views || 0,
      favorites:     l.num_favorers || 0,
      url:           l.url,
      thumbnail_url: l.images?.[0]?.url_570xN || null,
      taxonomy_path: l.taxonomy_path || [],
      created:       l.created_timestamp,
      source:        'etsy_api',
      category:      query.label,
    }));
  } catch (err) {
    console.warn(`  [research] API query failed for "${query.keywords}": ${err.message}`);
    return [];
  }
}

// ─── Browser-based scraping (fallback / supplemental) ────────────────────────

async function scrapeEtsySearch(keywords) {
  // Only attempt if CDP is configured
  if (!process.env.CDP_SECRET || !process.env.WORKER_URL) {
    return [];
  }

  console.log(`  [research] Scraping Etsy search page for: "${keywords}"`);
  let client;
  try {
    const { createClient } = require('../../cloudflare-browser/scripts/cdp-client');
    client = await createClient();

    await client.setViewport(1280, 900);

    const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keywords)}&listing_type=digital&order=top_seller`;
    await client.navigate(searchUrl, 5000);

    // Extract listing cards from the search results page
    const result = await client.evaluate(`
      (() => {
        const cards = Array.from(document.querySelectorAll('[data-listing-id]')).slice(0, 20);
        return cards.map(card => {
          const titleEl   = card.querySelector('[data-listing-id] h3, .wt-text-caption, .v2-listing-card__info h3');
          const priceEl   = card.querySelector('[data-price], .currency-value');
          const linkEl    = card.querySelector('a[href*="/listing/"]');
          const imgEl     = card.querySelector('img');
          const favEl     = card.querySelector('[data-favoriting]');
          return {
            title:         titleEl?.textContent?.trim() || '',
            price_text:    priceEl?.textContent?.trim() || '',
            url:           linkEl?.href || '',
            thumbnail_url: imgEl?.src || '',
            listing_id:    card.getAttribute('data-listing-id') || '',
          };
        }).filter(c => c.listing_id && c.title);
      })()
    `);

    const items = result?.result?.value;
    if (!Array.isArray(items)) return [];

    return items.map((item) => ({
      ...item,
      source:   'browser_scrape',
      category: keywords,
      tags:     [],
      views:    0,
      favorites: 0,
    }));
  } catch (err) {
    console.warn(`  [research] Browser scrape failed: ${err.message}`);
    return [];
  } finally {
    client?.close();
  }
}

// ─── Main research function ───────────────────────────────────────────────────

async function runResearch() {
  console.log('[etsy-research] Starting daily research...');
  const startedAt = new Date().toISOString();

  fs.mkdirSync(RESEARCH_DIR, { recursive: true });

  const allListings = [];
  const seenIds     = new Set();

  for (const query of RESEARCH_QUERIES) {
    // eslint-disable-next-line no-await-in-loop
    const listings = await fetchTopListingsForQuery(query);
    for (const l of listings) {
      if (!seenIds.has(l.listing_id)) {
        seenIds.add(l.listing_id);
        allListings.push(l);
      }
    }

    // Polite rate limiting: 10 req/s Etsy limit
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }

  // Supplement with browser scraping for "top seller" signal
  if (allListings.length < 10) {
    for (const query of RESEARCH_QUERIES.slice(0, 3)) {
      // eslint-disable-next-line no-await-in-loop
      const scraped = await scrapeEtsySearch(query.keywords);
      for (const l of scraped) {
        if (!seenIds.has(l.listing_id) && l.listing_id) {
          seenIds.add(l.listing_id);
          allListings.push(l);
        }
      }
    }
  }

  // Sort by favorites desc (strongest popularity signal available)
  allListings.sort((a, b) => (b.favorites || 0) - (a.favorites || 0));

  const report = {
    date:       new Date().toISOString().slice(0, 10),
    started_at: startedAt,
    ended_at:   new Date().toISOString(),
    total:      allListings.length,
    categories: RESEARCH_QUERIES.map((q) => q.label),
    listings:   allListings,
  };

  const outFile = path.join(RESEARCH_DIR, `${report.date}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`[etsy-research] Done. ${allListings.length} listings saved to ${outFile}`);

  return report;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runResearch()
    .then((report) => {
      if (process.argv.includes('--print')) {
        console.log('\nTop 10 by favorites:');
        report.listings.slice(0, 10).forEach((l, i) => {
          console.log(
            `  ${i + 1}. [${l.category}] ${l.title.slice(0, 60)} | ❤️ ${l.favorites} | $${l.price_usd}`,
          );
        });
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[etsy-research] Fatal error:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { runResearch };
}
