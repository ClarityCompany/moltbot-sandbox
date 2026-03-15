#!/usr/bin/env node
/**
 * SVG Designer
 *
 * Uses Claude to generate a complete SVG design for each product concept,
 * then renders it to PNG (Etsy listing image) and PDF (downloadable product)
 * using puppeteer-core with the system Chrome browser.
 *
 * Drop-in replacement for canva-designer.js — same runDesigner(date) interface.
 *
 * Output per product:
 *   product-N/
 *     product.svg          — the AI-generated SVG design (also the product file for SVG categories)
 *     listing-image.png    — PNG render of the SVG (Etsy listing photo, 2000×2000)
 *     product.pdf          — PDF render (for Wall Art, Planner, Party Printables, etc.)
 *     spec.json            — copy of the product spec
 *     design-meta.json     — render metadata
 *
 * Usage:
 *   node svg-designer.js
 *   node svg-designer.js --date=2025-06-01
 *   node svg-designer.js --product=1        (design just one product by ID)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = process.env.ETSY_DATA_DIR || path.join(__dirname, '..', 'data');
const DESIGNS_DIR  = path.join(DATA_DIR, 'designs');
const PRODUCTS_DIR = path.join(DATA_DIR, 'products');

// Design canvas size (square, good for Etsy)
const SVG_SIZE = 2000;

// ─── Claude API ───────────────────────────────────────────────────────────────

async function callClaude(messages, systemPrompt, maxTokens = 8192) {
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
      max_tokens: maxTokens,
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

// ─── SVG generation ───────────────────────────────────────────────────────────

const DESIGN_SYSTEM_PROMPT = `You are an expert digital product designer specialising in Etsy bestsellers.
When asked to design a product, you output ONLY a complete, valid SVG document.
No markdown fences, no explanation, no commentary — just the raw SVG starting with <svg and ending with </svg>.

Technical requirements:
- viewBox="0 0 2000 2000" width="2000" height="2000"
- Self-contained: no external image URLs, no external font URLs in <image> elements
- Fonts: load via <style>@import url('https://fonts.googleapis.com/css2?family=...');</style>
  Always include generic fallbacks: serif, sans-serif, or monospace
- All colours as hex codes (#rrggbb) or rgb()
- All shapes via SVG primitives: <rect>, <circle>, <ellipse>, <path>, <polygon>, <line>
- Decorative elements drawn with SVG paths (no base64 PNG backgrounds)
- Text as <text> elements with tspan for line breaks — never embed text as images
- Must render identically in Chrome, Firefox, and Inkscape

Category-specific style guidelines:
- "Printable Wall Art":     Elegant typography, decorative botanical/geometric borders using SVG paths,
                            sophisticated muted palette (sage green, dusty rose, warm cream, slate),
                            large central quote or phrase, print-ready white margins
- "SVG Cut Files":          Bold black silhouette design on white, clean single-layer paths,
                            optimised for vinyl cutting / Cricut / Silhouette machines,
                            high-contrast, no gradients, no thin lines < 1pt
- "Digital Planner":        Structured grid layout, weekly or monthly spread aesthetic,
                            pastel colour tabs/headers, functional navigation elements,
                            clean sans-serif typography, subtle drop shadows on panels
- "Canva Template":         Modern social media post or presentation slide,
                            placeholder text boxes clearly marked, bold colour blocking,
                            trendy layout (asymmetric, layered), lifestyle-brand aesthetic
- "Party Printables":       Festive and celebratory, bright or pastel palette, confetti/star/balloon
                            motifs drawn in SVG paths, bold headline font, decorative banner or label
- "Resume Template":        Clean two-column professional layout, dummy placeholder text in
                            correct resume sections (Summary, Experience, Education, Skills),
                            subtle accent colour bar, modern sans-serif hierarchy`;

/**
 * Ask Claude to generate an SVG design for a given product spec.
 * Returns the raw SVG string.
 */
async function generateSvgDesign(product) {
  const prompt = `Design a ${SVG_SIZE}×${SVG_SIZE}px digital product for Etsy.

Product spec:
  Category:       ${product.category}
  Title:          ${product.title}
  Style notes:    ${product.style_notes || 'professional, clean, modern'}
  File format:    ${product.file_format || 'SVG'}
  Dimensions:     ${product.dimensions || '8.5x11 inches'}

Design brief:
  Create a beautiful, print-ready design that will sell well on Etsy.
  The product title should appear prominently in the design.
  Use the style notes above to guide the visual direction.
  Make it look like a premium, professional product worth $${product.price_usd || '3.99'}.

Output ONLY the SVG — nothing else.`;

  console.log(`  [svg-designer] Asking Claude to design "${product.title}"...`);
  const rawSvg = await callClaude(
    [{ role: 'user', content: prompt }],
    DESIGN_SYSTEM_PROMPT,
    8192,
  );

  // Strip any accidental markdown code fences
  const cleaned = rawSvg
    .replace(/^```(?:svg|xml)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  if (!cleaned.startsWith('<svg')) {
    throw new Error(
      `Claude returned non-SVG output. First 200 chars:\n${cleaned.slice(0, 200)}`,
    );
  }

  return cleaned;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/** Find the system Chrome/Chromium executable path. */
function findChromePath() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/local/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Wrap SVG content in a minimal HTML page for accurate Chrome rendering. */
function svgToHtml(svgContent, width, height) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: white; }
  svg { display: block; width: ${width}px; height: ${height}px; }
</style>
</head>
<body>${svgContent}</body>
</html>`;
}

/**
 * Render SVG to PNG using puppeteer-core + system Chrome.
 * Returns the PNG as a Buffer.
 */
async function renderToPng(svgContent, width, height, htmlPath) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    throw new Error(
      'puppeteer-core is not installed.\n' +
      'Run: cd /root/clawd/skills/etsy-automation && npm install puppeteer-core',
    );
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      'Chrome/Chromium not found. Tried: /usr/bin/google-chrome, /usr/bin/chromium, etc.\n' +
      'Install with: apt-get install -y chromium-browser',
    );
  }

  // Write HTML to temp file (avoids data: URI length limits)
  const html = svgToHtml(svgContent, width, height);
  fs.writeFileSync(htmlPath, html);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none', // crisper text rendering
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 30000 });
    // Give Google Fonts an extra moment to load
    await new Promise((r) => setTimeout(r, 1000));
    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width, height },
    });
    return png;
  } finally {
    await browser.close();
  }
}

/**
 * Render SVG to PDF using puppeteer-core + system Chrome.
 * Returns the PDF as a Buffer.
 */
async function renderToPdf(svgContent, width, height, htmlPath) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    throw new Error('puppeteer-core is not installed');
  }

  const chromePath = findChromePath();
  if (!chromePath) throw new Error('Chrome/Chromium not found');

  const html = svgToHtml(svgContent, width, height);
  fs.writeFileSync(htmlPath, html);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1000));
    const pdf = await page.pdf({
      width:  `${width}px`,
      height: `${height}px`,
      printBackground: true,
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

// ─── Product design orchestration ────────────────────────────────────────────

/**
 * Categories where the SVG itself is the primary product deliverable.
 * For all others, we export PDF as the downloadable product.
 */
const SVG_PRODUCT_CATEGORIES = new Set(['SVG Cut Files']);

async function designProduct(product, outDir) {
  const productDir = path.join(outDir, `product-${product.id}`);
  fs.mkdirSync(productDir, { recursive: true });

  // Save spec for reference
  fs.writeFileSync(path.join(productDir, 'spec.json'), JSON.stringify(product, null, 2));

  // ── 1. Generate SVG via Claude ───────────────────────────────────────────
  const svgContent = await generateSvgDesign(product);
  const svgPath = path.join(productDir, 'product.svg');
  fs.writeFileSync(svgPath, svgContent);
  console.log(`  [svg-designer] SVG written → ${svgPath} (${svgContent.length} chars)`);

  // ── 2. Render PNG (listing image) ────────────────────────────────────────
  const pngPath   = path.join(productDir, 'listing-image.png');
  const htmlPath  = path.join(productDir, '_render.html');

  let pngRendered = false;
  try {
    console.log(`  [svg-designer] Rendering PNG (${SVG_SIZE}×${SVG_SIZE})...`);
    const pngBuffer = await renderToPng(svgContent, SVG_SIZE, SVG_SIZE, htmlPath);
    fs.writeFileSync(pngPath, pngBuffer);
    console.log(`  [svg-designer] PNG written → ${pngPath} (${pngBuffer.byteLength} bytes)`);
    pngRendered = true;
  } catch (err) {
    console.warn(`  [svg-designer] PNG render failed (listing image unavailable): ${err.message}`);
  }

  // ── 3. Render PDF (product deliverable for non-SVG categories) ───────────
  let pdfRendered = false;
  let pdfPath = null;

  if (!SVG_PRODUCT_CATEGORIES.has(product.category)) {
    pdfPath = path.join(productDir, 'product.pdf');
    const pdfHtmlPath = path.join(productDir, '_render-pdf.html');
    try {
      console.log(`  [svg-designer] Rendering PDF...`);
      const pdfBuffer = await renderToPdf(svgContent, SVG_SIZE, SVG_SIZE, pdfHtmlPath);
      fs.writeFileSync(pdfPath, pdfBuffer);
      console.log(`  [svg-designer] PDF written → ${pdfPath} (${pdfBuffer.byteLength} bytes)`);
      pdfRendered = true;
    } catch (err) {
      console.warn(`  [svg-designer] PDF render failed: ${err.message}`);
    }
  }

  // ── 4. Save design metadata ───────────────────────────────────────────────
  const meta = {
    product_id:        product.id,
    designed_by:       'claude-sonnet-4-5',
    svg_path:          svgPath,
    png_path:          pngRendered ? pngPath : null,
    pdf_path:          pdfRendered ? pdfPath : null,
    svg_size_chars:    svgContent.length,
    is_svg_product:    SVG_PRODUCT_CATEGORIES.has(product.category),
    rendered_at:       new Date().toISOString(),
  };
  fs.writeFileSync(path.join(productDir, 'design-meta.json'), JSON.stringify(meta, null, 2));

  return {
    product_id:  product.id,
    svg_path:    svgPath,
    png_path:    pngRendered ? pngPath : null,
    pdf_path:    pdfRendered ? pdfPath : null,
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
  console.log(`[svg-designer] Designing ${products.length} products for ${date}...`);

  const outDir = path.join(DESIGNS_DIR, date);
  fs.mkdirSync(outDir, { recursive: true });

  // Filter to a specific product if requested (for testing)
  const productIdArg = process.argv.find((a) => a.startsWith('--product='));
  const filterProductId = productIdArg ? parseInt(productIdArg.split('=')[1]) : null;
  const targetProducts  = filterProductId
    ? products.filter((p) => p.id === filterProductId)
    : products;

  const results = [];
  for (const product of targetProducts) {
    console.log(`\n[svg-designer] ─── Product ${product.id}: ${product.category} ───`);
    try {
      const result = await designProduct(product, outDir);
      results.push(result);
    } catch (err) {
      console.error(`[svg-designer] Failed product ${product.id}: ${err.message}`);
      results.push({ product_id: product.id, status: 'failed', error: err.message });
    }
  }

  const summaryFile = path.join(outDir, 'design-results.json');
  fs.writeFileSync(summaryFile, JSON.stringify({ date, designer: 'svg-claude', results }, null, 2));

  const ok = results.filter((r) => r.status === 'success').length;
  console.log(`\n[svg-designer] Done. ${ok}/${results.length} products designed.`);

  return { date, results };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  runDesigner(dateArg ? dateArg.split('=')[1] : undefined)
    .then((r) => {
      r.results.forEach((res) => {
        const icon = res.status === 'success' ? '✅' : '❌';
        console.log(
          `  ${icon} Product ${res.product_id}: ${res.status}` +
          (res.error ? ` — ${res.error}` : '') +
          (res.svg_path ? `\n     SVG: ${res.svg_path}` : '') +
          (res.png_path ? `\n     PNG: ${res.png_path}` : '') +
          (res.pdf_path ? `\n     PDF: ${res.pdf_path}` : ''),
        );
      });
      process.exit(0);
    })
    .catch((e) => {
      console.error('[svg-designer] Fatal:', e.message);
      process.exit(1);
    });
} else {
  module.exports = { runDesigner, generateSvgDesign };
}
