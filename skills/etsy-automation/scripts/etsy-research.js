#!/usr/bin/env node
/**
 * Etsy Research Module
 *
 * Uses Claude Sonnet 4.6 with the web_search tool to research current
 * best-selling digital products on Etsy. Claude visits search results,
 * Etsy listing pages, trend blogs, and Reddit discussions to build a
 * comprehensive picture of what is selling well right now.
 *
 * No Etsy API key required.
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

const DATA_DIR     = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const RESEARCH_DIR = path.join(DATA_DIR, 'research');

// ─── Claude API with web_search ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert Etsy market research analyst. Your job is to discover
what digital download products are CURRENTLY bestselling on Etsy by searching the internet —
including Etsy itself, TikTok trends, Instagram aesthetics, Pinterest boards, and design blogs.

You will search for:
- Actual Etsy listings with high favorite counts and strong sales
- TikTok videos tagged #EtsySeller, #DigitalDownload, #PrintableArt showing viral products
- Instagram hashtags like #EtsyShop #DigitalPrint #PrintableWallArt for trending aesthetics
- Pinterest boards featuring digital printables, planners, and SVG projects
- Blog posts and YouTube videos about top-selling Etsy digital products
- Reddit discussions (r/Etsy, r/EtsySellers, r/DigitalDownloads) about what sells
- Current design trend reports (Pantone colors, typography trends, aesthetic movements)

Pay particular attention to cross-platform signals:
- A product style that is trending on TikTok AND appearing on Etsy = high opportunity
- Pinterest boards with thousands of saves for a design style = strong demand signal
- Instagram reels showing a digital product going viral = immediate opportunity

Focus exclusively on DIGITAL DOWNLOAD products (not physical items):
- Printable wall art and decor
- SVG cut files (Cricut/Silhouette)
- Digital planners (Goodnotes, Notability, PDF)
- Canva templates (social media, business, wedding)
- Printable planners, trackers, and organizers
- Wedding and party invitation templates
- Resume and CV templates
- Clipart and illustration bundles
- Spreadsheet templates (budgets, trackers)
- Digital stickers and journals

After your research, output a single JSON object — NO markdown fences, NO extra text.
The JSON must follow this exact structure:

{
  "date": "YYYY-MM-DD",
  "analysis_summary": "2-3 sentences summarising the key trends you observed today",
  "listings": [
    {
      "title": "Exact or representative product title from Etsy",
      "category": "Human-readable category (e.g. Printable Wall Art)",
      "price_usd": 3.99,
      "favorites": 5000,
      "views": 25000,
      "tags": ["tag1", "tag2", "tag3"],
      "description": "Why this product sells: what makes it popular, its audience, its value",
      "source": "web_research",
      "trend_signal": "Platform/source that indicates this is popular (e.g. 'TikTok viral', 'Pinterest 50k saves', 'Etsy bestseller badge')"
    }
  ]
}

Include AT LEAST 25 listings across at least 6 different categories.
Estimate favorites/views based on any evidence you find (badge counts, review counts, seller stats).
If you cannot find exact numbers, use conservative estimates (e.g. 500 favorites if the listing appears
in multiple bestseller lists).`;

const RESEARCH_PROMPT = `Today is ${new Date().toISOString().slice(0, 10)}.

Research what digital download products are currently trending and bestselling. Search ACROSS platforms:

ETSY:
1. "best selling etsy digital downloads ${new Date().getFullYear()}"
2. "most popular etsy printables top sellers"
3. Specific categories: wall art printables, SVG cut files, digital planners, Canva templates, wedding invitations

TIKTOK:
4. TikTok #EtsySeller #DigitalDownload #PrintableArt trending products
5. "tiktok etsy digital products viral" or "etsy made me buy it digital"
6. Any TikTok design trends (aesthetics, color palettes, styles) that translate to printable products

INSTAGRAM + PINTEREST:
7. Instagram #digitaldownload #etsyprintable trending posts and reels
8. Pinterest "best selling digital products etsy" or "printable wall art ideas"
9. Pinterest boards for "digital planner", "printable home decor", "svg files cricut"

DESIGN TRENDS:
10. Current design trends ${new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })}: popular aesthetics, color palettes, typography
11. Any seasonal or cultural moments driving demand right now

For each product you find, note WHERE you found the signal (TikTok, Pinterest, Etsy, Reddit, etc.)
and use that as the trend_signal field.

Output the JSON object when you have enough data (aim for 25+ listings spanning multiple platforms).`;

// ─── Agentic loop ─────────────────────────────────────────────────────────────

async function runClaudeResearch() {
  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');

  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  console.log('[etsy-research] Starting Claude-powered web research...');

  const messages = [{ role: 'user', content: RESEARCH_PROMPT }];
  let finalText  = '';
  const MAX_TURNS = 20; // safety limit on agentic iterations

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`  [etsy-research] API call ${turn + 1}/${MAX_TURNS}...`);

    // eslint-disable-next-line no-await-in-loop
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':  'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 8192,
        system:     SYSTEM_PROMPT,
        tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Claude API error ${resp.status}: ${errText}`);
    }

    // eslint-disable-next-line no-await-in-loop
    const data = await resp.json();

    // Append the assistant's full turn (may include tool_use + tool_result blocks)
    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'end_turn') {
      // Claude finished — extract the final text block
      const textBlock = data.content.find((b) => b.type === 'text');
      if (textBlock?.text) {
        finalText = textBlock.text;
        console.log(`  [etsy-research] Research complete after ${turn + 1} turn(s).`);
      }
      break;
    }

    if (data.stop_reason === 'tool_use') {
      // web_search_20250305 is server-side: Anthropic executes the searches.
      // We provide tool_result shells to continue the conversation; the API
      // fills in the actual search results on the next call.
      const toolResults = data.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          type:        'tool_result',
          tool_use_id: b.id,
          content:     '',
        }));

      if (toolResults.length > 0) {
        const queries = data.content
          .filter((b) => b.type === 'tool_use' && b.name === 'web_search')
          .map((b) => b.input?.query || '(search)')
          .join(', ');
        console.log(`  [etsy-research] Claude is searching: ${queries}`);
        messages.push({ role: 'user', content: toolResults });
      }
    }
  }

  if (!finalText) {
    throw new Error('Claude did not produce a final text response after research');
  }

  return finalText;
}

// ─── Parse Claude's JSON output ───────────────────────────────────────────────

function parseResearchOutput(rawText, date) {
  // Strip markdown fences if Claude included them despite instructions
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```$/m, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Try to extract a JSON block from the text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        throw new Error(`Failed to parse Claude's research output as JSON: ${err.message}`);
      }
    } else {
      throw new Error(`No JSON found in Claude's response: ${err.message}`);
    }
  }

  // Normalise the output to match the expected schema
  const listings = (parsed.listings || []).map((l, i) => ({
    listing_id:    `web-${date}-${i + 1}`,
    title:         l.title         || '',
    description:   l.description   || '',
    price_usd:     Number(l.price_usd) || null,
    currency:      'USD',
    tags:          Array.isArray(l.tags) ? l.tags : [],
    views:         Number(l.views)     || 0,
    favorites:     Number(l.favorites) || 0,
    url:           l.url            || '',
    thumbnail_url: l.thumbnail_url  || null,
    taxonomy_path: [],
    source:        'web_research',
    category:      l.category       || 'Digital Download',
    trend_signal:  l.trend_signal   || '',
  }));

  // Sort by estimated popularity
  listings.sort((a, b) => (b.favorites || 0) - (a.favorites || 0));

  return {
    date,
    started_at:       new Date().toISOString(),
    ended_at:         new Date().toISOString(),
    total:            listings.length,
    categories:       [...new Set(listings.map((l) => l.category))],
    analysis_summary: parsed.analysis_summary || '',
    listings,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runResearch() {
  const date = new Date().toISOString().slice(0, 10);
  console.log(`[etsy-research] Running web research for ${date}...`);

  fs.mkdirSync(RESEARCH_DIR, { recursive: true });

  const rawText = await runClaudeResearch();
  const report  = parseResearchOutput(rawText, date);

  const outFile = path.join(RESEARCH_DIR, `${date}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`[etsy-research] Done. ${report.total} listings saved to ${outFile}`);
  console.log(`[etsy-research] Summary: ${report.analysis_summary}`);

  return report;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runResearch()
    .then((report) => {
      if (process.argv.includes('--print')) {
        console.log('\nTop 10 by estimated favorites:');
        report.listings.slice(0, 10).forEach((l, i) => {
          console.log(
            `  ${i + 1}. [${l.category}] ${l.title.slice(0, 60)} | ❤️ ~${l.favorites} | $${l.price_usd}`,
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
