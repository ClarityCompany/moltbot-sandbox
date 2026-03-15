#!/usr/bin/env node
/**
 * Mockup Generator
 *
 * Uses DALL-E 3 to generate 4 photorealistic lifestyle mockup images for each
 * product. Scenes are chosen based on product category/title so a wedding
 * invitation gets wedding-venue shots while wall art gets gallery-wall shots.
 *
 * Output per product (saved into the existing designs/YYYY-MM-DD/product-N/ dir):
 *   mockup-1.png  — primary lifestyle scene
 *   mockup-2.png  — secondary lifestyle scene
 *   mockup-3.png  — flat lay / editorial scene
 *   mockup-4.png  — in-use / hands-on scene
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

const DATA_DIR     = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const DESIGNS_DIR  = path.join(DATA_DIR, 'designs');
const PRODUCTS_DIR = path.join(DATA_DIR, 'products');

// ─── Product-adaptive scene selector ─────────────────────────────────────────

/**
 * Return 4 lifestyle scene descriptions tailored to the product type.
 * Scenes drive the DALL-E prompt so mockups look appropriate for the item.
 */
function getScenesForProduct(product) {
  const cat   = (product.category || '').toLowerCase();
  const title = (product.title   || '').toLowerCase();

  // Wedding / invitation / stationery
  if (
    cat.includes('wedding') || cat.includes('invitation') || cat.includes('stationery') ||
    title.includes('wedding') || title.includes('invitation') || title.includes('bridal')
  ) {
    return [
      'placed on a white linen tablecloth at an elegant wedding reception, surrounded by white rose petals and tea light candles, soft romantic bokeh background, professional event photography',
      'held gently by a bride wearing white lace gloves in an outdoor garden ceremony, natural golden-hour sunlight, shallow depth of field, lifestyle wedding photography',
      'displayed on a wooden easel at a wedding venue entrance, blurred greenery and fairy lights background, warm dusk lighting, editorial photography',
      'flat lay arrangement with white garden roses, a gold wax seal, a calligraphy pen, and a cream envelope on a marble surface, overhead editorial shot',
    ];
  }

  // Signs / home decor labels / farmhouse decor
  if (
    cat.includes('sign') || cat.includes('label') || cat.includes('farmhouse') || cat.includes('home decor') ||
    title.includes('sign') || title.includes('welcome') || title.includes('farmhouse') || title.includes('doormat')
  ) {
    return [
      'mounted on a weathered wooden post in a lush cottage garden with morning sunlight filtering through climbing roses, professional lifestyle photography',
      'displayed beside a bright front door of a cozy painted brick home, terracotta potted plants nearby, warm afternoon light, welcoming atmosphere',
      'flat lay on a rustic reclaimed-wood farmhouse table with fresh lavender sprigs, a linen napkin, and a small lantern, overhead natural light photography',
      'leaning against a white shiplap wall in a modern farmhouse entryway beside a woven basket and potted eucalyptus, interior lifestyle photography',
    ];
  }

  // Planner / journal / organizer / tracker
  if (
    cat.includes('planner') || cat.includes('organizer') || cat.includes('journal') || cat.includes('tracker') ||
    title.includes('planner') || title.includes('journal') || title.includes('tracker') || title.includes('organizer')
  ) {
    return [
      'open on a light oak desk beside a ceramic coffee mug and a small potted succulent, soft morning window light, cozy productive workspace photography',
      'being written in by a woman in a bright minimalist home office, natural light from a large window, professional lifestyle photography',
      'flat lay with a rose-gold pen, a pastel highlighter, reading glasses, and a small house plant on a clean white linen surface, overhead editorial photography',
      'displayed on a tablet screen propped on a wooden stand beside a latte art coffee cup and fresh tulips in a glass vase, modern work-from-home aesthetic',
    ];
  }

  // Wall art / prints / posters / gallery
  if (
    cat.includes('wall art') || cat.includes('print') || cat.includes('poster') || cat.includes('art') ||
    title.includes('print') || title.includes('poster') || title.includes('wall art') || title.includes('watercolor')
  ) {
    return [
      'framed in a thin black frame hanging on a clean white wall in a bright Scandinavian living room with a fiddle leaf fig tree visible, soft natural window light, professional interior photography',
      'part of a curated gallery wall arrangement with three complementary framed prints above a white linen sofa in a modern apartment, styled interior photography',
      'unframed print flat lay on a light marble surface with a small ceramic vase of dried pampas grass and a golden pair of scissors, overhead editorial lifestyle shot',
      'leaning against a whitewashed plaster wall in a boho-styled bedroom with macramé wall hanging and warm string lights, lifestyle interior photography',
    ];
  }

  // SVG / cut file / Cricut / crafting
  if (
    cat.includes('svg') || cat.includes('cut file') || cat.includes('cricut') || cat.includes('craft') ||
    title.includes('svg') || title.includes('cut file') || title.includes('cricut') || title.includes('vinyl')
  ) {
    return [
      'finished project displayed as a vinyl decal on a white farmhouse-style wooden sign leaning against a shiplap wall, natural light, craft photography',
      'freshly cut design being lifted from a Cricut cutting mat with a weeding tool on a bright craft table with colorful vinyl rolls nearby, overhead shot',
      'iron-on transfer applied to a white cotton tote bag placed on a wooden table with autumn leaves, warm fall lifestyle photography',
      'completed wooden sign with the cut design hanging on a front porch door, potted mums nearby, bright autumn afternoon light',
    ];
  }

  // Kids / nursery / baby
  if (
    cat.includes('kids') || cat.includes('nursery') || cat.includes('baby') || cat.includes('children') ||
    title.includes('kids') || title.includes('nursery') || title.includes('baby') || title.includes('children')
  ) {
    return [
      'framed and hanging above a white wooden crib in a soft pastel nursery with a mobile and stuffed animals nearby, gentle morning light, interior photography',
      'flat lay on a cream knit blanket with wooden alphabet blocks, a tiny pair of baby shoes, and a sprig of eucalyptus, overhead editorial photography',
      'displayed in a child\'s brightly lit bedroom above a small bookshelf with colorful picture books, warm playful lifestyle photography',
      'framed print leaning against a painted wood wall on a kids\' activity table with crayons and a small vase of sunflowers, cheerful natural light',
    ];
  }

  // Recipe / food / kitchen
  if (
    cat.includes('recipe') || cat.includes('kitchen') || cat.includes('food') || cat.includes('cooking') ||
    title.includes('recipe') || title.includes('kitchen') || title.includes('menu') || title.includes('cookbook')
  ) {
    return [
      'displayed in a wooden recipe card holder on a bright modern kitchen counter beside fresh herbs in small terracotta pots and a linen dish towel, natural light food photography',
      'framed and hanging on a shiplap kitchen wall above a farmhouse sink with fresh herbs and a small cutting board visible, warm kitchen lifestyle photography',
      'flat lay on a white marble countertop surrounded by fresh ingredients, a vintage rolling pin, and scattered flour, overhead editorial food photography',
      'held open on a wooden cookbook stand beside a steaming mug of tea on a cozy kitchen table, warm ambient lighting, lifestyle photography',
    ];
  }

  // Default: versatile lifestyle scenes for any digital product
  return [
    'displayed elegantly in a bright modern living room setting, professional interior lifestyle photography, warm natural light, clean minimal aesthetic',
    'flat lay on a white marble surface with a small ceramic coffee cup, a gold pen, and a sprig of fresh eucalyptus, overhead editorial photography',
    'shown in a cozy Scandinavian-style home office on a light wood desk with soft window light, a small succulent plant, and an open notebook beside it',
    'held by a smiling woman at a bright café table with a latte and a few dried flowers in a bud vase, lifestyle photography, warm natural light',
  ];
}

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
  const category = product.category || 'digital product';
  return (
    `Photorealistic product mockup photograph for an Etsy shop: ` +
    `a beautifully designed "${product.title}" ${category} ${scene}. ` +
    `The artwork is elegant, clearly visible, and takes up a meaningful portion of the image. ` +
    `No watermarks, no extra text overlays, no logos. ` +
    `Professional e-commerce photography style. High quality, well-lit, aspirational.`
  );
}

// ─── Generate 4 mockups for one product ──────────────────────────────────────

async function generateMockupsForProduct(product, productDir) {
  const scenes      = getScenesForProduct(product);
  const mockupPaths = [];

  for (let i = 0; i < scenes.length; i++) {
    const prompt   = buildMockupPrompt(product, scenes[i]);
    const destPath = path.join(productDir, `mockup-${i + 1}.png`);

    console.log(`  [mockup-gen] Generating mockup ${i + 1}/${scenes.length} for "${product.title}"...`);

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
    if (i < scenes.length - 1) {
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
  const productArg    = process.argv.find((a) => a.startsWith('--product='));
  const productFilter = productArg ? parseInt(productArg.split('=')[1], 10) : null;

  const targets = productFilter
    ? products.filter((p) => p.id === productFilter)
    : products;

  console.log(`[mockup-gen] Generating 4 mockups for ${targets.length} product(s) (${date})...`);

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
    console.log(`[mockup-gen] Product ${product.id}: ${ok}/4 mockups generated`);
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
