#!/usr/bin/env node
/**
 * Mockup Generator
 *
 * Uses DALL-E 3 to generate 3 photorealistic lifestyle mockup images for each
 * product. These are added alongside the existing SVG render (listing-image.png)
 * to give 4 images total per product for the Google Sheet / Etsy listing.
 *
 * Output per product (saved into the existing designs/YYYY-MM-DD/product-N/ dir):
 *   mockup-1.png  — product displayed framed on a wall
 *   mockup-2.png  — flat lay on marble/desk surface
 *   mockup-3.png  — lifestyle context (home office / shelf)
 *
 * Updates design-results.json with mockup_paths for each product.
 *
 * Required env vars:
 *   OPENAI_API_KEY  — OpenAI API key with DALL-E 3 access
 *
 * Usage:
 *   node mockup-generator.js
 *   node mockup-generator.js --date=2025-06-01
 *   node mockup-generator.js --product=1   (single product by ID)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = process.env.ETSY_DATA_DIR || '/root/clawd/etsy-automation';
const DESIGNS_DIR  = path.join(DATA_DIR, 'designs');
const PRODUCTS_DIR = path.join(DATA_DIR, 'products');

// Three distinct lifestyle scenes for the mockups
const MOCKUP_SCENES = [
  'framed and hanging on a clean white wall in a bright Scandinavian living room, soft natural window light, professional product photography, 85mm lens',
  'flat lay on a white marble surface with a ceramic coffee cup, dried eucalyptus sprigs, and a gold pen, overhead shot, editorial lifestyle photography',
  'displayed in a cozy home office on a light oak desk beside a small succulent plant and an open notebook, warm ambient lighting, shallow depth of field',
];

// ─── DALL-E 3 API ─────────────────────────────────────────────────────────────

async function callDallE(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:           'dall-e-3',
      prompt,
      n:               1,
      size:            '1024x1024',
      quality:         'hd',
      response_format: 'url',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DALL-E API error (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  return data.data[0].url;
}

async function downloadImage(url, destPath) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download image (${resp.status})`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildMockupPrompt(product, scene) {
  const category = product.category || 'digital print';
  return (
    `Photorealistic product mockup photograph for an Etsy shop: ` +
    `a beautifully designed "${product.title}" ${category} ${scene}. ` +
    `The artwork is elegant and clearly visible. ` +
    `No watermarks, no extra text overlays, no borders. ` +
    `Professional e-commerce photography style.`
  );
}

// ─── Generate 3 mockups for one product ──────────────────────────────────────

async function generateMockupsForProduct(product, productDir) {
  const mockupPaths = [];

  for (let i = 0; i < MOCKUP_SCENES.length; i++) {
    const prompt   = buildMockupPrompt(product, MOCKUP_SCENES[i]);
    const destPath = path.join(productDir, `mockup-${i + 1}.png`);

    console.log(`  [mockup-gen] Generating mockup ${i + 1}/3 for "${product.title}"...`);

    try {
      const imageUrl = await callDallE(prompt); // eslint-disable-line no-await-in-loop
      await downloadImage(imageUrl, destPath);  // eslint-disable-line no-await-in-loop
      mockupPaths.push(destPath);
      console.log(`  [mockup-gen] ✅ Mockup ${i + 1} saved to ${destPath}`);
    } catch (err) {
      console.warn(`  [mockup-gen] ⚠️  Mockup ${i + 1} failed (non-fatal): ${err.message}`);
      mockupPaths.push(null);
    }

    // DALL-E 3 rate limit: 5 img/min on tier 1 — space requests out
    if (i < MOCKUP_SCENES.length - 1) {
      await new Promise((r) => setTimeout(r, 13000)); // eslint-disable-line no-await-in-loop
    }
  }

  return mockupPaths;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runMockupGenerator(date) {
  date = date || new Date().toISOString().slice(0, 10);

  const productsFile = path.join(PRODUCTS_DIR, `${date}.json`);
  const designsFile  = path.join(DESIGNS_DIR, date, 'design-results.json');

  if (!fs.existsSync(productsFile)) {
    throw new Error(`No products file for ${date}: ${productsFile}`);
  }
  if (!fs.existsSync(designsFile)) {
    throw new Error(`No design results for ${date}: ${designsFile}`);
  }

  const { products } = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
  const designData   = JSON.parse(fs.readFileSync(designsFile, 'utf8'));
  const results      = designData.results || [];

  // Optional: limit to a single product via --product=N
  const productArg = process.argv.find((a) => a.startsWith('--product='));
  const productFilter = productArg ? parseInt(productArg.split('=')[1], 10) : null;

  const targets = productFilter
    ? products.filter((p) => p.id === productFilter)
    : products;

  console.log(`[mockup-gen] Generating mockups for ${targets.length} product(s) (${date})...`);

  for (const product of targets) {
    const design = results.find(
      (d) => d.product_id === product.id && d.status === 'success',
    );

    if (!design || !design.png_path) {
      console.log(`[mockup-gen] Skipping product ${product.id} — no successful design found`);
      continue;
    }

    const productDir  = path.dirname(design.png_path);
    const mockupPaths = await generateMockupsForProduct(product, productDir); // eslint-disable-line no-await-in-loop

    // Store paths back into design results (filter out nulls from failed generations)
    design.mockup_paths = mockupPaths.filter(Boolean);

    const ok = design.mockup_paths.length;
    console.log(`[mockup-gen] Product ${product.id}: ${ok}/3 mockups generated`);
  }

  // Persist updated design results with mockup_paths
  fs.writeFileSync(designsFile, JSON.stringify(designData, null, 2));
  console.log(`[mockup-gen] Done. design-results.json updated.`);

  return { date, results };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date    = dateArg ? dateArg.split('=')[1] : undefined;

  runMockupGenerator(date)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[mockup-gen] Fatal error:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { runMockupGenerator };
}
