#!/usr/bin/env node
/**
 * Google Sheets Writer
 *
 * After products are designed, uploads each product's listing image to Google
 * Drive and appends a row to the configured Google Sheet with all product details.
 *
 * Sheet columns (must match your sheet headers):
 *   title | description | price | tag1..tag8 | Image
 *
 * Required environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  — JSON string of a Google Service Account key file
 *   GOOGLE_SHEET_ID             — Spreadsheet ID (from the sheet URL)
 *
 * The service account must have:
 *   - Editor access to the Google Sheet
 *   - Google Drive API enabled (to upload images)
 *   - Google Sheets API enabled
 *
 * Usage:
 *   node google-sheets-writer.js
 *   node google-sheets-writer.js --date=2025-06-01
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR    = process.env.ETSY_DATA_DIR || '/root/clawd/etsy-automation';
const DESIGNS_DIR = path.join(DATA_DIR, 'designs');
const PRODUCTS_DIR = path.join(DATA_DIR, 'products');

const SHEET_ID   = process.env.GOOGLE_SHEET_ID   || '1S52Ld2pXjJxKFzqDH90XJYXu7L2BzyyGbHi8L0uGulI';
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Sheet1';

// ─── Google Service Account JWT auth ──────────────────────────────────────────

function base64url(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function getGoogleAccessToken() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set');

  const key = JSON.parse(keyJson);
  const now  = Math.floor(Date.now() / 1000);

  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss:   key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  }));

  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key.private_key, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const jwt = `${signingInput}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Google OAuth token error (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ─── Google Drive: upload image ───────────────────────────────────────────────

async function uploadToDrive(token, imagePath, fileName) {
  console.log(`  [sheets-writer] Uploading ${fileName} to Google Drive...`);

  const imageBuffer = fs.readFileSync(imagePath);
  const mimeType    = 'image/png';

  // Multipart upload: metadata + image body
  const boundary = '-------moltbot314159265';
  const metadata  = JSON.stringify({ name: fileName, mimeType });

  const multipartBody = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    'Content-Transfer-Encoding: base64',
    '',
    imageBuffer.toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');

  const uploadResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  `multipart/related; boundary="${boundary}"`,
      },
      body: multipartBody,
    },
  );

  if (!uploadResp.ok) {
    const body = await uploadResp.text();
    throw new Error(`Drive upload failed (${uploadResp.status}): ${body}`);
  }

  const fileData = await uploadResp.json();
  const fileId   = fileData.id;

  // Make the file publicly readable so the URL works from the sheet
  const permResp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    },
  );

  if (!permResp.ok) {
    const body = await permResp.text();
    throw new Error(`Drive permission update failed (${permResp.status}): ${body}`);
  }

  const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;
  console.log(`  [sheets-writer] Uploaded: ${viewUrl}`);
  return viewUrl;
}

// ─── Google Sheets: append row ────────────────────────────────────────────────

async function appendSheetRow(token, rowData) {
  const range = encodeURIComponent(`${SHEET_NAME}!A:O`);
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const resp = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ values: [rowData] }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Sheets append failed (${resp.status}): ${body}`);
  }

  return resp.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runGoogleSheetsWriter(date) {
  date = date || new Date().toISOString().slice(0, 10);

  const productsFile = path.join(PRODUCTS_DIR, `${date}.json`);
  const designsFile  = path.join(DESIGNS_DIR, date, 'design-results.json');

  if (!fs.existsSync(productsFile)) {
    throw new Error(`No products file for ${date}: ${productsFile}`);
  }

  const { products } = JSON.parse(fs.readFileSync(productsFile, 'utf8'));

  // Design results are optional — used only to locate listing-image.png
  let designResults = [];
  if (fs.existsSync(designsFile)) {
    const dr = JSON.parse(fs.readFileSync(designsFile, 'utf8'));
    designResults = dr.results || [];
  }

  console.log(`[sheets-writer] Writing ${products.length} products to Google Sheet (${SHEET_ID})...`);

  const token   = await getGoogleAccessToken();
  const written = [];

  for (const product of products) {
    try {
      // Find the matching design result
      const design = designResults.find(
        (d) => d.product_id === product.id && d.status === 'success',
      );

      // Build list of image paths: [listing-image.png, mockup-1.png, mockup-2.png, mockup-3.png]
      const imagePaths = [];
      if (design?.png_path && fs.existsSync(design.png_path)) {
        imagePaths.push(design.png_path);
      }
      for (const mp of (design?.mockup_paths || [])) {
        if (mp && fs.existsSync(mp)) imagePaths.push(mp);
      }

      // Upload all available images to Drive (up to 4)
      const imageUrls = [];
      for (let i = 0; i < Math.min(imagePaths.length, 4); i++) {
        const fileName = `etsy-product-${date}-${product.id}-img${i + 1}.png`;
        const url = await uploadToDrive(token, imagePaths[i], fileName); // eslint-disable-line no-await-in-loop
        imageUrls.push(url);
      }
      // Pad to 4 columns
      while (imageUrls.length < 4) imageUrls.push('');

      if (imageUrls.every((u) => !u)) {
        console.log(`  [sheets-writer] No images found for product ${product.id} — image cells will be empty`);
      }

      // Map tags to 8 columns, pad with empty strings if fewer than 8
      const tags = (product.tags || []).slice(0, 8);
      while (tags.length < 8) tags.push('');

      // Row: title, description, price, tag1..tag8, image1, image2, image3, image4
      const row = [
        product.title       || '',
        product.description || '',
        product.price_usd   || '',
        ...tags,
        ...imageUrls,
      ];

      await appendSheetRow(token, row);
      console.log(`  [sheets-writer] ✅ Row added for: "${product.title}" (${imageUrls.filter(Boolean).length} images)`);
      written.push({ product_id: product.id, title: product.title, image_urls: imageUrls.filter(Boolean), status: 'success' });
    } catch (err) {
      console.error(`  [sheets-writer] ❌ Failed for product ${product.id}: ${err.message}`);
      written.push({ product_id: product.id, status: 'failed', error: err.message });
    }

    // Small delay between rows to avoid rate limits
    await new Promise((r) => setTimeout(r, 300)); // eslint-disable-line no-await-in-loop
  }

  const successful = written.filter((w) => w.status === 'success').length;
  console.log(`[sheets-writer] Done. ${successful}/${written.length} rows written.`);
  return { date, rows: written };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date    = dateArg ? dateArg.split('=')[1] : undefined;

  runGoogleSheetsWriter(date)
    .then((result) => {
      result.rows.forEach((r) => {
        const icon = r.status === 'success' ? '✅' : '❌';
        const img  = r.image_url ? ` → ${r.image_url}` : '';
        const imgs = r.image_urls?.length ? ` (${r.image_urls.length} images)` : '';
      console.log(`  ${icon} ${r.title || `Product ${r.product_id}`}${imgs}`);
      });
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sheets-writer] Fatal error:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { runGoogleSheetsWriter };
}
