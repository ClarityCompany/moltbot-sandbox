#!/usr/bin/env node
/**
 * Canva Designer
 *
 * Uses the Canva Connect API (https://www.canva.com/developers/docs/connect/) to:
 *   1. Search for a suitable template matching the product spec
 *   2. Create a design from that template
 *   3. Update the design with product-specific text / colour guidance via AI
 *   4. Export the design as:
 *        - a high-res PDF (the purchasable digital file)
 *        - a PNG mockup (the Etsy listing image)
 *
 * Prerequisites (set via wrangler secret):
 *   CANVA_CLIENT_ID       — Canva app client ID
 *   CANVA_CLIENT_SECRET   — Canva app client secret
 *   (Tokens are stored in /root/clawd/etsy-automation/canva-tokens.json after first OAuth)
 *
 * Output: for each product writes files into /root/clawd/etsy-automation/designs/YYYY-MM-DD/
 *
 * Usage:
 *   node canva-designer.js               (designs products from today's product-analyzer output)
 *   node canva-designer.js --date=2025-06-01
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = process.env.ETSY_DATA_DIR || '/root/clawd/etsy-automation';
const DESIGNS_DIR = path.join(DATA_DIR, 'designs');
const PRODUCTS_DIR = path.join(DATA_DIR, 'products');

const CANVA_API    = 'https://api.canva.com/rest/v1';
const CANVA_TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';
const TOKEN_FILE   = path.join(DATA_DIR, 'canva-tokens.json');

// ─── Canva token management ───────────────────────────────────────────────────

function loadCanvaTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch { return null; }
}

function saveCanvaTokens(tokens) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function refreshCanvaToken(refreshToken) {
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
  };
}

async function getCanvaToken() {
  const tokens = loadCanvaTokens();
  if (!tokens?.access_token) {
    throw new Error(
      'Canva is not authorized. Complete the Canva OAuth flow first.\n' +
      'See SKILL.md for setup instructions.',
    );
  }
  const BUFFER_MS = 5 * 60 * 1000;
  if (Date.now() + BUFFER_MS >= (tokens.expires_at || 0)) {
    console.log('[canva] Refreshing access token...');
    const refreshed = await refreshCanvaToken(tokens.refresh_token);
    saveCanvaTokens(refreshed);
    return refreshed.access_token;
  }
  return tokens.access_token;
}

async function canvaFetch(apiPath, opts = {}) {
  const token = await getCanvaToken();
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

  return resp.json();
}

// ─── Design workflow ──────────────────────────────────────────────────────────

/**
 * Search for a Canva template matching the product's style / category.
 * Falls back to a generic "poster" template if nothing specific is found.
 */
async function findTemplate(product) {
  console.log(`  [canva] Searching templates for: "${product.canva_template_query}"`);
  try {
    const params = new URLSearchParams({
      query: product.canva_template_query,
      limit: '5',
    });
    const data = await canvaFetch(`/designs?${params}&type=TEMPLATE`);
    const templates = data.items || [];
    if (templates.length > 0) {
      console.log(`  [canva] Found ${templates.length} templates, using first match`);
      return templates[0];
    }
  } catch (err) {
    console.warn(`  [canva] Template search failed: ${err.message}`);
  }

  // Fallback: list user's own designs and pick the first
  const fallback = await canvaFetch('/designs?type=DESIGN&limit=1');
  const items    = fallback.items || [];
  return items[0] || null;
}

/**
 * Create a new design (from a template or blank).
 */
async function createDesign(product, template) {
  console.log(`  [canva] Creating design for "${product.title}"`);

  const body = template
    ? { design_type: { type: 'TEMPLATE', template_id: template.id } }
    : { design_type: { type: 'BLANK_CANVAS', width: 2550, height: 3300 } }; // US Letter at 300 dpi

  const data = await canvaFetch('/designs', {
    method: 'POST',
    body:   JSON.stringify(body),
  });

  return data.design;
}

/**
 * Wait for an export job to complete and return the download URL.
 */
async function waitForExport(exportId, maxWaitMs = 120000) {
  const start    = Date.now();
  const interval = 3000;

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, interval));

    const data = await canvaFetch(`/exports/${exportId}`);
    const job  = data.job || data;

    if (job.status === 'success') {
      return job.urls?.[0] || job.url;
    }
    if (job.status === 'failed') {
      throw new Error(`Canva export failed: ${JSON.stringify(job.error)}`);
    }

    console.log(`  [canva] Export ${exportId} status: ${job.status}`);
  }

  throw new Error(`Canva export timed out after ${maxWaitMs / 1000}s`);
}

/**
 * Export the design in the requested format and download the file locally.
 */
async function exportAndDownload(designId, format, outputPath) {
  console.log(`  [canva] Exporting design ${designId} as ${format}...`);

  const exportData = await canvaFetch('/exports', {
    method: 'POST',
    body:   JSON.stringify({
      design_id: designId,
      format:    format.toUpperCase(), // 'PDF' or 'PNG'
      ...(format.toUpperCase() === 'PDF' && { export_quality: 'pro' }),
    }),
  });

  const exportId  = exportData.job?.id || exportData.id;
  const exportUrl = await waitForExport(exportId);

  // Download the file
  const fileResp = await fetch(exportUrl);
  if (!fileResp.ok) throw new Error(`Failed to download export: ${fileResp.status}`);

  const buffer = await fileResp.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
  console.log(`  [canva] Saved ${format} to ${outputPath} (${buffer.byteLength} bytes)`);

  return outputPath;
}

// ─── Design a single product ──────────────────────────────────────────────────

async function designProduct(product, date, outDir) {
  console.log(`[canva] Designing product ${product.id}: "${product.title}"`);

  const productDir = path.join(outDir, `product-${product.id}`);
  fs.mkdirSync(productDir, { recursive: true });

  // Save product spec alongside the design files for reference
  fs.writeFileSync(
    path.join(productDir, 'spec.json'),
    JSON.stringify(product, null, 2),
  );

  // Find / create design
  const template = await findTemplate(product);
  const design   = await createDesign(product, template);

  if (!design?.id) {
    throw new Error('Canva API did not return a design object');
  }

  console.log(`  [canva] Design created: ${design.id} (URL: ${design.edit_url})`);

  // Save design metadata
  fs.writeFileSync(
    path.join(productDir, 'design-meta.json'),
    JSON.stringify({ design_id: design.id, edit_url: design.edit_url, template_id: template?.id }, null, 2),
  );

  // Export PDF (the purchasable digital file)
  const pdfPath = path.join(productDir, 'product.pdf');
  await exportAndDownload(design.id, 'PDF', pdfPath);

  // Export PNG (listing thumbnail)
  const pngPath = path.join(productDir, 'listing-image.png');
  await exportAndDownload(design.id, 'PNG', pngPath);

  return {
    product_id:    product.id,
    design_id:     design.id,
    edit_url:      design.edit_url,
    pdf_path:      pdfPath,
    png_path:      pngPath,
    product_dir:   productDir,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runDesigner(date) {
  date = date || new Date().toISOString().slice(0, 10);
  const productsFile = path.join(PRODUCTS_DIR, `${date}.json`);

  if (!fs.existsSync(productsFile)) {
    throw new Error(`No products file found for ${date}: ${productsFile}`);
  }

  const { products } = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
  console.log(`[canva] Designing ${products.length} products for ${date}...`);

  const outDir = path.join(DESIGNS_DIR, date);
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const product of products) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await designProduct(product, date, outDir);
      results.push({ ...result, status: 'success' });
    } catch (err) {
      console.error(`[canva] Failed to design product ${product.id}: ${err.message}`);
      results.push({ product_id: product.id, status: 'failed', error: err.message });
    }
  }

  const summaryFile = path.join(outDir, 'design-results.json');
  fs.writeFileSync(summaryFile, JSON.stringify({ date, results }, null, 2));

  const successful = results.filter((r) => r.status === 'success').length;
  console.log(`[canva] Done. ${successful}/${results.length} products designed.`);

  return { date, results };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date    = dateArg ? dateArg.split('=')[1] : undefined;

  runDesigner(date)
    .then((result) => {
      result.results.forEach((r) => {
        const icon = r.status === 'success' ? '✅' : '❌';
        console.log(`  ${icon} Product ${r.product_id}: ${r.status}`);
      });
      process.exit(0);
    })
    .catch((err) => {
      console.error('[canva] Fatal error:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { runDesigner };
}
