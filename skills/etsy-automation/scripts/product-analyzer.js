#!/usr/bin/env node
/**
 * Product Analyzer
 *
 * Takes today's Etsy research data and uses Claude to:
 *   1. Identify the 3 most promising, copyright-safe product opportunities
 *   2. Generate complete product specs for each (title, description, tags, price,
 *      Canva search query, style notes, file format)
 *   3. Explain the data-driven reasoning behind each selection
 *
 * Output: writes /root/clawd/etsy-automation/products/YYYY-MM-DD.json
 *
 * Usage:
 *   node product-analyzer.js              (reads today's research, writes product specs)
 *   node product-analyzer.js --date=2025-06-01  (analyze a specific date's research)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const PRODUCTS_DIR = path.join(DATA_DIR, 'products');
const RESEARCH_DIR = path.join(DATA_DIR, 'research');
const METRICS_DIR  = path.join(DATA_DIR, 'metrics');

// ─── Claude API helper ────────────────────────────────────────────────────────

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
      max_tokens: 4096,
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

// ─── Load historical metrics for context ─────────────────────────────────────

function loadHistoricalInsights() {
  try {
    const insightsFile = path.join(METRICS_DIR, 'insights.json');
    if (fs.existsSync(insightsFile)) {
      return JSON.parse(fs.readFileSync(insightsFile, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Main analysis ────────────────────────────────────────────────────────────

async function analyzeProducts(researchDate) {
  const date = researchDate || new Date().toISOString().slice(0, 10);
  const researchFile = path.join(RESEARCH_DIR, `${date}.json`);

  if (!fs.existsSync(researchFile)) {
    throw new Error(`No research file found for ${date}: ${researchFile}`);
  }

  const research = JSON.parse(fs.readFileSync(researchFile, 'utf8'));
  console.log(`[product-analyzer] Analyzing ${research.total} listings from ${date}...`);

  // Summarise top listings for the prompt (keep token count manageable)
  const topListings = research.listings.slice(0, 40).map((l) => ({
    title:       l.title,
    category:    l.category,
    price_usd:   l.price_usd,
    favorites:   l.favorites,
    views:       l.views,
    tags:        l.tags?.slice(0, 8),
    description: (l.description || '').slice(0, 200),
  }));

  const historicalInsights = loadHistoricalInsights();
  const insightsText = historicalInsights
    ? `\n\nHistorical performance insights from our own shop:\n${JSON.stringify(historicalInsights, null, 2)}`
    : '';

  const systemPrompt = `You are an expert Etsy digital product strategist. Your job is to analyze market data and design original, bestselling digital products that are 100% copyright-free.

Key rules you must follow:
- NEVER suggest products based on trademarked characters, brands, celebrities, or copyrighted artwork
- Focus on evergreen, original designs: abstract art, typography, geometric patterns, nature illustrations, inspirational quotes (generic), organizational tools, templates
- Products must be immediately manufacturable in Canva using standard design tools
- Price recommendations should be competitive (typically $2–$8 for digital downloads)
- Tags must target real Etsy search terms (check the research data for inspiration)

Respond ONLY with a valid JSON object — no markdown fences, no extra text.`;

  const userMessage = `Here is today's Etsy market research data (${date}):

TOP LISTINGS BY POPULARITY:
${JSON.stringify(topListings, null, 2)}
${insightsText}

Based on this data, select the 3 best product opportunities to create today.

Return a JSON object with this exact shape:
{
  "date": "${date}",
  "analysis_summary": "2–3 sentences on today's market trends",
  "products": [
    {
      "id": 1,
      "category": "e.g. Printable Wall Art",
      "title": "Etsy listing title (max 140 chars, keyword-rich)",
      "description": "Full Etsy listing description (3–4 paragraphs, include what's included, file formats, how to use)",
      "tags": ["tag1", "tag2", ...],
      "price_usd": 3.99,
      "file_format": "PDF",
      "dimensions": "8.5x11 inches",
      "canva_template_query": "Search query to find a good starting Canva template",
      "style_notes": "Detailed visual direction: color palette, fonts, layout, mood",
      "copyright_clear": true,
      "selection_reason": "Why this product + what data supports it"
    }
  ]
}

Provide exactly 3 products. Each must be a different category/format.`;

  const responseText = await callClaude([{ role: 'user', content: userMessage }], systemPrompt);

  let products;
  try {
    // Strip any accidental markdown code fences
    const cleaned = responseText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    products = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Claude response as JSON: ${err.message}\n\nResponse:\n${responseText}`);
  }

  fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
  const outFile = path.join(PRODUCTS_DIR, `${date}.json`);
  fs.writeFileSync(outFile, JSON.stringify(products, null, 2));

  console.log(`[product-analyzer] Done. ${products.products?.length || 0} products saved to ${outFile}`);
  console.log(`[product-analyzer] Summary: ${products.analysis_summary}`);

  return products;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date    = dateArg ? dateArg.split('=')[1] : undefined;

  analyzeProducts(date)
    .then((result) => {
      console.log('\nSelected products:');
      (result.products || []).forEach((p) => {
        console.log(`  ${p.id}. [${p.category}] ${p.title} — $${p.price_usd}`);
      });
      process.exit(0);
    })
    .catch((err) => {
      console.error('[product-analyzer] Fatal error:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { analyzeProducts };
}
