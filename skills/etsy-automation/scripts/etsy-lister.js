#!/usr/bin/env node
/**
 * Etsy Lister
 *
 * Creates new Etsy draft listings for each designed product, uploading:
 *   - The digital product file (PDF)
 *   - The listing image (PNG mockup)
 *
 * Listings are created as DRAFT so you can review them before publishing.
 * Set AUTO_PUBLISH=true in environment to publish immediately.
 *
 * Output: writes /root/clawd/etsy-automation/listings/YYYY-MM-DD.json
 *
 * Usage:
 *   node etsy-lister.js
 *   node etsy-lister.js --date=2025-06-01
 *   AUTO_PUBLISH=true node etsy-lister.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { etsyFetch } = require('./etsy-auth');

const DATA_DIR     = process.env.ETSY_DATA_DIR || '/root/clawd/etsy-automation';
const DESIGNS_DIR  = path.join(DATA_DIR, 'designs');
const PRODUCTS_DIR = path.join(DATA_DIR, 'products');
const LISTINGS_DIR = path.join(DATA_DIR, 'listings');

const SHOP_ID      = process.env.ETSY_SHOP_ID;
const AUTO_PUBLISH = process.env.AUTO_PUBLISH === 'true';

// Etsy taxonomy ID for digital downloads (Art & Collectibles > Digital Prints)
// Full taxonomy list: https://www.etsy.com/developers/documentation/reference/taxonomy
const DIGITAL_TAXONOMY_ID = 2078; // Art & Collectibles > Digital Prints

// ─── Upload listing image ─────────────────────────────────────────────────────

async function uploadListingImage(listingId, imagePath) {
  console.log(`  [lister] Uploading listing image for listing ${listingId}...`);

  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const mimeType    = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  // Etsy API: POST /v3/application/shops/{shop_id}/listings/{listing_id}/images
  // Uses multipart/form-data — we must set the correct Content-Type
  const formData = new FormData();
  const blob     = new Blob([imageBuffer], { type: mimeType });
  formData.append('image', blob, path.basename(imagePath));
  formData.append('rank', '1');
  formData.append('overwrite', 'true');

  const apiKey = process.env.ETSY_API_KEY;
  const { getAccessToken } = require('./etsy-auth');
  const token = await getAccessToken();

  const resp = await fetch(
    `https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings/${listingId}/images`,
    {
      method:  'POST',
      headers: {
        'x-api-key':     apiKey,
        'Authorization': `Bearer ${token}`,
        // Don't set Content-Type — let fetch set it with boundary for multipart
      },
      body: formData,
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Image upload failed (${resp.status}): ${body}`);
  }

  return resp.json();
}

// ─── Upload digital file ──────────────────────────────────────────────────────

async function uploadDigitalFile(listingId, filePath) {
  console.log(`  [lister] Uploading digital file for listing ${listingId}...`);

  const fileBuffer = fs.readFileSync(filePath);
  const formData   = new FormData();
  const blob       = new Blob([fileBuffer], { type: 'application/pdf' });
  formData.append('file', blob, path.basename(filePath));
  formData.append('rank', '1');
  formData.append('name', path.basename(filePath));

  const apiKey = process.env.ETSY_API_KEY;
  const { getAccessToken } = require('./etsy-auth');
  const token = await getAccessToken();

  const resp = await fetch(
    `https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings/${listingId}/files`,
    {
      method:  'POST',
      headers: {
        'x-api-key':     apiKey,
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`File upload failed (${resp.status}): ${body}`);
  }

  return resp.json();
}

// ─── Create a single Etsy listing ────────────────────────────────────────────

async function createListing(product, designResult) {
  console.log(`[lister] Creating listing for product ${product.id}: "${product.title}"`);

  if (!SHOP_ID) {
    throw new Error('ETSY_SHOP_ID environment variable is not set');
  }

  // POST /v3/application/shops/{shop_id}/listings
  const listingBody = {
    quantity:        999,
    title:           product.title.slice(0, 140),
    description:     product.description,
    price:           product.price_usd || 3.99,
    who_made:        'i_did',
    when_made:       'made_to_order',
    taxonomy_id:     DIGITAL_TAXONOMY_ID,
    type:            'download',
    is_digital:      true,
    should_auto_renew: true,
    tags:            (product.tags || []).slice(0, 13), // Etsy max 13 tags
    state:           AUTO_PUBLISH ? 'active' : 'draft',
  };

  const data = await etsyFetch(
    `/v3/application/shops/${SHOP_ID}/listings`,
    {
      method: 'POST',
      body:   JSON.stringify(listingBody),
    },
  );

  const listingId  = data.listing_id;
  const listingUrl = `https://www.etsy.com/listing/${listingId}`;
  console.log(`  [lister] Listing created: ${listingId} (${AUTO_PUBLISH ? 'active' : 'draft'})`);

  // Upload listing image
  if (designResult?.png_path && fs.existsSync(designResult.png_path)) {
    try {
      await uploadListingImage(listingId, designResult.png_path);
    } catch (err) {
      console.warn(`  [lister] Image upload failed (non-fatal): ${err.message}`);
    }
  }

  // Upload digital product file
  if (designResult?.pdf_path && fs.existsSync(designResult.pdf_path)) {
    try {
      await uploadDigitalFile(listingId, designResult.pdf_path);
    } catch (err) {
      console.warn(`  [lister] File upload failed (non-fatal): ${err.message}`);
    }
  }

  return {
    listing_id:   listingId,
    listing_url:  listingUrl,
    title:        product.title,
    price_usd:    product.price_usd,
    state:        AUTO_PUBLISH ? 'active' : 'draft',
    product_id:   product.id,
    created_at:   new Date().toISOString(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runLister(date) {
  date = date || new Date().toISOString().slice(0, 10);

  const productsFile = path.join(PRODUCTS_DIR, `${date}.json`);
  const designsFile  = path.join(DESIGNS_DIR, date, 'design-results.json');

  if (!fs.existsSync(productsFile)) {
    throw new Error(`No products file for ${date}: ${productsFile}`);
  }
  if (!fs.existsSync(designsFile)) {
    throw new Error(`No design results for ${date}: ${designsFile}`);
  }

  const { products }    = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
  const { results: dr } = JSON.parse(fs.readFileSync(designsFile, 'utf8'));

  console.log(`[lister] Creating ${products.length} Etsy listings for ${date}...`);
  fs.mkdirSync(LISTINGS_DIR, { recursive: true });

  const listingResults = [];

  for (const product of products) {
    const designResult = dr.find((d) => d.product_id === product.id && d.status === 'success');

    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await createListing(product, designResult);
      listingResults.push({ ...result, status: 'success' });
    } catch (err) {
      console.error(`[lister] Failed for product ${product.id}: ${err.message}`);
      listingResults.push({ product_id: product.id, status: 'failed', error: err.message });
    }

    // Rate limit: Etsy allows 10 req/s
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
  }

  const outFile = path.join(LISTINGS_DIR, `${date}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ date, listings: listingResults }, null, 2));

  const successful = listingResults.filter((r) => r.status === 'success').length;
  console.log(`[lister] Done. ${successful}/${listingResults.length} listings created.`);

  return { date, listings: listingResults };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date    = dateArg ? dateArg.split('=')[1] : undefined;

  runLister(date)
    .then((result) => {
      result.listings.forEach((l) => {
        const icon = l.status === 'success' ? '✅' : '❌';
        console.log(`  ${icon} ${l.title || `Product ${l.product_id}`}: ${l.listing_url || l.error}`);
      });
      process.exit(0);
    })
    .catch((err) => {
      console.error('[lister] Fatal error:', err.message);
      process.exit(1);
    });
} else {
  module.exports = { runLister };
}
