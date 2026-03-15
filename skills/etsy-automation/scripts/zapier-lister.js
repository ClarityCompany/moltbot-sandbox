#!/usr/bin/env node
/**
 * Zapier Single-Listing Creator
 *
 * Creates one Etsy draft listing from a JSON payload passed via --listing=<json>.
 * Designed to be called by the /etsy/webhook/zapier worker endpoint.
 *
 * Usage:
 *   node zapier-lister.js --listing='{"title":"...", "description":"...", "price":4.99, ...}'
 *
 * Optional fields:
 *   tags          - comma-separated string or array (max 13)
 *   quantity      - integer, defaults to 999
 *   auto_publish  - "true" to publish immediately, otherwise creates a draft
 *   image_url     - HTTPS URL; image will be fetched and uploaded to the listing
 *
 * Exit codes:
 *   0  success — prints JSON to stdout: { listing_id, listing_url, title }
 *   1  failure — prints JSON to stdout: { error }
 */

'use strict';

const { etsyFetch, getAccessToken } = require('./etsy-auth');

const SHOP_ID = process.env.ETSY_SHOP_ID;
const DIGITAL_TAXONOMY_ID = 2078; // Art & Collectibles > Digital Prints

async function createListing(data) {
  if (!SHOP_ID) throw new Error('ETSY_SHOP_ID env var is not set');

  const tags = normaliseTags(data.tags);
  const autoPublish = String(data.auto_publish).toLowerCase() === 'true';

  const body = {
    quantity:          Number(data.quantity) || 999,
    title:             String(data.title).slice(0, 140),
    description:       String(data.description),
    price:             Number(data.price),
    who_made:          'i_did',
    when_made:         'made_to_order',
    taxonomy_id:       DIGITAL_TAXONOMY_ID,
    type:              'download',
    is_digital:        true,
    should_auto_renew: true,
    tags,
    state:             autoPublish ? 'active' : 'draft',
  };

  const listing = await etsyFetch(`/v3/application/shops/${SHOP_ID}/listings`, {
    method: 'POST',
    body:   JSON.stringify(body),
  });

  // Upload listing image if a URL was provided
  if (data.image_url) {
    try {
      await uploadImageFromUrl(listing.listing_id, data.image_url);
    } catch (err) {
      // Non-fatal — listing still created
      console.error(`[zapier-lister] Image upload failed (non-fatal): ${err.message}`);
    }
  }

  return {
    listing_id:  listing.listing_id,
    listing_url: `https://www.etsy.com/listing/${listing.listing_id}`,
    title:       listing.title,
    state:       listing.state,
  };
}

async function uploadImageFromUrl(listingId, imageUrl) {
  const apiKey = process.env.ETSY_API_KEY;
  const token  = await getAccessToken();

  const fetched = await fetch(imageUrl);
  if (!fetched.ok) throw new Error(`Failed to fetch image (${fetched.status}): ${imageUrl}`);

  const contentType = fetched.headers.get('content-type') || 'image/jpeg';
  const buffer      = Buffer.from(await fetched.arrayBuffer());
  const ext         = contentType.includes('png') ? 'png' : 'jpg';

  const formData = new FormData();
  formData.append('image', new Blob([buffer], { type: contentType }), `listing.${ext}`);
  formData.append('rank',      '1');
  formData.append('overwrite', 'true');

  const resp = await fetch(
    `https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings/${listingId}/images`,
    {
      method:  'POST',
      headers: { 'x-api-key': apiKey, Authorization: `Bearer ${token}` },
      body:    formData,
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Image upload API error (${resp.status}): ${body}`);
  }
}

function normaliseTags(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr.map((t) => t.trim()).filter(Boolean).slice(0, 13);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const arg = process.argv.find((a) => a.startsWith('--listing='));
if (!arg) {
  process.stdout.write(JSON.stringify({ error: 'Missing --listing=<json> argument' }) + '\n');
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(arg.slice('--listing='.length));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: `Invalid JSON: ${e.message}` }) + '\n');
  process.exit(1);
}

if (!payload.title || !payload.description || !payload.price) {
  process.stdout.write(JSON.stringify({ error: 'title, description, and price are required' }) + '\n');
  process.exit(1);
}

createListing(payload)
  .then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  })
  .catch((err) => {
    process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
    process.exit(1);
  });
