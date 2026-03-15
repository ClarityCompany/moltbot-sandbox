#!/usr/bin/env node
/**
 * Canva Designer (Canva Connect API)
 *
 * How it works:
 *   The Canva Connect API lets you export designs from your own Canva account.
 *   It does NOT provide access to Canva's public template library.
 *
 *   Workflow:
 *     1. You create template designs in your Canva account (one per product
 *        category, e.g. "Wall Art Template", "SVG Template", etc.)
 *     2. You save those design IDs in:
 *          /root/clawd/etsy-automation/config/canva-templates.json
 *     3. For each product the analyzer selects, this script:
 *          a. Finds the best-matching template by category/style
 *          b. Exports it as a high-res PDF (the purchasable digital file)
 *          c. Exports it as a PNG (the Etsy listing image)
 *          d. Saves both files to the designs directory
 *
 *   To find a design's ID: open it in Canva, copy from the URL:
 *     https://www.canva.com/design/DAGxxxxxxxx/edit
 *                                    ^^^^^^^^^^^^  ← this is the design ID
 *
 * Output: /root/clawd/etsy-automation/designs/YYYY-MM-DD/product-N/
 *
 * Usage:
 *   node canva-designer.js
 *   node canva-designer.js --date=2025-06-01
 *   node canva-designer.js --list-designs    (list all designs in your Canva account)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR      = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const DESIGNS_DIR   = path.join(DATA_DIR, 'designs');
const PRODUCTS_DIR  = path.join(DATA_DIR, 'products');
const CONFIG_DIR    = path.join(DATA_DIR, 'config');
const TOKEN_FILE    = path.join(DATA_DIR, 'canva-tokens.json');
const TEMPLATES_FILE = path.join(CONFIG_DIR, 'canva-templates.json');

const CANVA_API       = 'https://api.canva.com/rest/v1';
const CANVA_TOKEN_URL = 'https://www.canva.com/api/oauth/token';

// ─── Token management ─────────────────────────────────────────────────────────

function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch { return null; }
}

function saveTokens(tokens) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function refreshToken(refreshToken) {
  const clientId     = process.env.CANVA_CLIENT_ID;
  const clientSecret = process.env.CANVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('CANVA_CLIENT_ID or CANVA_CLIENT_SECRET is not set');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch(CANVA_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Canva token refresh failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
    refreshed_at:  new Date().toISOString(),
  };
}

async function getToken() {
  const tokens = loadTokens();
  if (!tokens?.access_token) {
    throw new Error(
      'Canva is not authorized.\n' +
      'Visit https://<your-worker>/canva/auth to connect your account.',
    );
  }
  const BUFFER_MS = 5 * 60 * 1000;
  if (Date.now() + BUFFER_MS >= (tokens.expires_at || 0)) {
    console.log('[canva] Refreshing access token...');
    const refreshed = await refreshToken(tokens.refresh_token);
    saveTokens(refreshed);
    return refreshed.access_token;
  }
  return tokens.access_token;
}

async function canvaFetch(apiPath, opts = {}) {
  const token = await getToken();
  const resp  = await fetch(`${CANVA_API}${apiPath}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      ...opts.headers,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Canva API ${resp.status} at ${apiPath}: ${body}`);
  }

  // 204 No Content has no body
  if (resp.status === 204) return null;
  return resp.json();
}

// ─── Template configuration ───────────────────────────────────────────────────

/**
 * Load user-configured Canva template design IDs.
 * Returns default structure with instructions if file doesn't exist yet.
 */
function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_FILE)) {
    console.warn(
      '[canva] canva-templates.json not found.\n' +
      '  Create it at: ' + TEMPLATES_FILE + '\n' +
      '  See SKILL.md for instructions on finding your Canva design IDs.',
    );
    return null;
  }
  return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
}

/**
 * Find the best-matching template for a given product.
 * Matches on category name, then falls back to 'default'.
 */
function findTemplateForProduct(product, templates) {
  if (!templates?.templates?.length) return null;

  const category = (product.category || '').toLowerCase();

  // Exact category match
  const exact = templates.templates.find(
    (t) => (t.category || '').toLowerCase() === category,
  );
  if (exact) return exact;

  // Keyword match
  const keyword = templates.templates.find((t) => {
    const kws = (t.keywords || []).map((k) => k.toLowerCase());
    return kws.some((kw) => category.includes(kw) || kw.includes(category));
  });
  if (keyword) return keyword;

  // Fall back to the template tagged as default, or first in list
  return templates.templates.find((t) => t.default) || templates.templates[0];
}

// ─── Canva export ─────────────────────────────────────────────────────────────

/**
 * Request an export job for a design and wait for it to complete.
 */
async function exportDesign(designId, format, outputPath) {
  console.log(`  [canva] Exporting design ${designId} as ${format}...`);

  // Start export job
  const exportBody = {
    design_id: designId,
    format:    format.toUpperCase(),
    ...(format.toUpperCase() === 'PDF' && {
      export_quality: 'pro',      // highest quality
      pdf_background:  true,
    }),
  };

  const exportJob = await canvaFetch('/exports', {
    method: 'POST',
    body:   JSON.stringify(exportBody),
  });

  const exportId = exportJob?.job?.id || exportJob?.id;
  if (!exportId) {
    throw new Error(`Canva export request returned no job ID: ${JSON.stringify(exportJob)}`);
  }

  // Poll for completion (max 2 minutes)
  const maxWait  = 120 * 1000;
  const interval = 3000;
  const start    = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, interval));

    const status = await canvaFetch(`/exports/${exportId}`);
    const job    = status?.job || status;

    if (job?.status === 'success') {
      const downloadUrl = job.urls?.[0] || job.url;
      if (!downloadUrl) throw new Error('Export succeeded but no download URL returned');

      // Download the file
      const fileResp = await fetch(downloadUrl);
      if (!fileResp.ok) throw new Error(`Download failed: ${fileResp.status} ${downloadUrl}`);

      const buffer = await fileResp.arrayBuffer();
      fs.writeFileSync(outputPath, Buffer.from(buffer));
      console.log(`  [canva] Saved ${format} → ${outputPath} (${buffer.byteLength} bytes)`);
      return outputPath;
    }

    if (job?.status === 'failed') {
      throw new Error(`Canva export failed: ${JSON.stringify(job.error || job)}`);
    }

    console.log(`  [canva] Export ${exportId} status: ${job?.status || 'unknown'}`);
  }

  throw new Error(`Canva export timed out after ${maxWait / 1000}s`);
}

// ─── List designs (helper / debugging) ───────────────────────────────────────

async function listDesigns() {
  console.log('[canva] Fetching your Canva designs...\n');
  const data = await canvaFetch('/designs?limit=50');
  const items = data?.items || [];

  if (items.length === 0) {
    console.log('No designs found in your Canva account.');
    return [];
  }

  console.log(`Found ${items.length} design(s):\n`);
  items.forEach((d) => {
    console.log(`  Design ID: ${d.id}`);
    console.log(`  Name:      ${d.title || '(untitled)'}`);
    console.log(`  URL:       ${d.urls?.edit_url || 'n/a'}`);
    console.log(`  Updated:   ${d.updated_at || 'n/a'}`);
    console.log('');
  });

  return items;
}

// ─── Design a single product ──────────────────────────────────────────────────

async function designProduct(product, templates, date, outDir) {
  const productDir = path.join(outDir, `product-${product.id}`);
  fs.mkdirSync(productDir, { recursive: true });

  fs.writeFileSync(path.join(productDir, 'spec.json'), JSON.stringify(product, null, 2));

  const template = findTemplateForProduct(product, templates);

  if (!template?.design_id) {
    const msg = `No Canva template found for category "${product.category}". ` +
                'Add a template to canva-templates.json.';
    console.warn(`  [canva] ${msg}`);
    return { product_id: product.id, status: 'skipped', reason: msg };
  }

  console.log(
    `[canva] Product ${product.id}: "${product.title}" → using template ${template.design_id} (${template.label || template.category})`,
  );

  // Export as high-res PDF (the purchasable digital file)
  const pdfPath = path.join(productDir, 'product.pdf');
  await exportDesign(template.design_id, 'PDF', pdfPath);

  // Export as PNG (Etsy listing image)
  const pngPath = path.join(productDir, 'listing-image.png');
  await exportDesign(template.design_id, 'PNG', pngPath);

  // Save design metadata for reference
  fs.writeFileSync(
    path.join(productDir, 'design-meta.json'),
    JSON.stringify({
      template_id:    template.design_id,
      template_label: template.label,
      pdf_path:       pdfPath,
      png_path:       pngPath,
      exported_at:    new Date().toISOString(),
    }, null, 2),
  );

  return {
    product_id:  product.id,
    design_id:   template.design_id,
    pdf_path:    pdfPath,
    png_path:    pngPath,
    product_dir: productDir,
    status:      'success',
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runDesigner(date) {
  date = date || new Date().toISOString().slice(0, 10);
  const productsFile = path.join(PRODUCTS_DIR, `${date}.json`);

  if (!fs.existsSync(productsFile)) {
    throw new Error(`No products file for ${date}: ${productsFile}`);
  }

  const { products } = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
  const templates    = loadTemplates();

  if (!templates) {
    throw new Error(
      'Canva templates not configured.\n' +
      `Create ${TEMPLATES_FILE} with your design IDs.\n` +
      'Run with --list-designs to see your available Canva designs.',
    );
  }

  console.log(`[canva] Designing ${products.length} products for ${date}...`);

  const outDir = path.join(DESIGNS_DIR, date);
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const product of products) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await designProduct(product, templates, date, outDir);
      results.push(result);
    } catch (err) {
      console.error(`[canva] Failed product ${product.id}: ${err.message}`);
      results.push({ product_id: product.id, status: 'failed', error: err.message });
    }
    // Rate limiting: Canva allows 20 export requests per user per 10 seconds
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 600));
  }

  const summaryFile = path.join(outDir, 'design-results.json');
  fs.writeFileSync(summaryFile, JSON.stringify({ date, results }, null, 2));

  const ok = results.filter((r) => r.status === 'success').length;
  console.log(`[canva] Done. ${ok}/${results.length} products exported.`);

  return { date, results };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  if (process.argv.includes('--list-designs')) {
    listDesigns().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
  } else {
    const dateArg = process.argv.find((a) => a.startsWith('--date='));
    runDesigner(dateArg ? dateArg.split('=')[1] : undefined)
      .then((r) => {
        r.results.forEach((res) => {
          const icon = res.status === 'success' ? '✅' : res.status === 'skipped' ? '⏭' : '❌';
          console.log(`  ${icon} Product ${res.product_id}: ${res.status}${res.reason ? ' — ' + res.reason : ''}`);
        });
        process.exit(0);
      })
      .catch((e) => { console.error('[canva] Fatal:', e.message); process.exit(1); });
  }
} else {
  module.exports = { runDesigner, listDesigns };
}
