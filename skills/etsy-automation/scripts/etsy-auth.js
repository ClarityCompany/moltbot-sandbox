#!/usr/bin/env node
/**
 * Etsy OAuth 2.0 token manager
 *
 * Reads / refreshes the Etsy access token stored at:
 *   /root/clawd/etsy-automation/etsy-tokens.json
 *
 * Usage (as library):
 *   const { getAccessToken, etsyFetch } = require('./etsy-auth');
 *   const token = await getAccessToken();          // auto-refresh if needed
 *   const resp  = await etsyFetch('/v3/application/shops/SHOP_ID');
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = process.env.ETSY_DATA_DIR || '/root/clawd/etsy-automation';
const TOKEN_FILE  = path.join(DATA_DIR, 'etsy-tokens.json');
const ETSY_API    = 'https://openapi.etsy.com';
const TOKEN_URL   = 'https://api.etsy.com/v3/public/oauth/token';

// ─── Token file helpers ───────────────────────────────────────────────────────

function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

// ─── Refresh access token ─────────────────────────────────────────────────────

async function refreshAccessToken(refreshToken) {
  const apiKey = process.env.ETSY_API_KEY;
  if (!apiKey) throw new Error('ETSY_API_KEY environment variable is not set');

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     apiKey,
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refreshToken, // Etsy may not issue a new refresh token
    expires_at:    Date.now() + data.expires_in * 1000,
    refreshed_at:  new Date().toISOString(),
  };
}

// ─── Public: get a valid access token ────────────────────────────────────────

/**
 * Returns a valid Etsy access token, refreshing if necessary.
 * Throws if no tokens are stored (user must first complete OAuth via /etsy/auth).
 */
async function getAccessToken() {
  const tokens = loadTokens();

  if (!tokens || !tokens.access_token) {
    throw new Error(
      'Etsy is not authorized. Visit https://<your-worker>/etsy/auth to connect your account.',
    );
  }

  // Refresh if token expires within the next 5 minutes
  const BUFFER_MS = 5 * 60 * 1000;
  if (Date.now() + BUFFER_MS >= (tokens.expires_at || 0)) {
    console.log('[etsy-auth] Access token expired or expiring soon — refreshing...');
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    saveTokens(refreshed);
    return refreshed.access_token;
  }

  return tokens.access_token;
}

// ─── Public: authenticated Etsy API fetch ────────────────────────────────────

/**
 * Wrapper around fetch() for Etsy OpenAPI v3.
 *
 * @param {string} path  - e.g. '/v3/application/shops/12345/listings/active'
 * @param {object} opts  - standard fetch options (method, body, etc.)
 * @returns {Promise<object>} Parsed JSON response
 */
async function etsyFetch(apiPath, opts = {}) {
  const apiKey = process.env.ETSY_API_KEY;
  if (!apiKey) throw new Error('ETSY_API_KEY environment variable is not set');

  const token = await getAccessToken();

  const url = `${ETSY_API}${apiPath}`;
  const headers = {
    'x-api-key':    apiKey,
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    ...opts.headers,
  };

  const resp = await fetch(url, { ...opts, headers });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Etsy API error ${resp.status} at ${apiPath}: ${body}`);
  }

  return resp.json();
}

/**
 * Etsy API fetch — app-level key only (no OAuth token).
 * Used for reading public listing data that doesn't require shop ownership.
 */
async function etsyPublicFetch(apiPath, opts = {}) {
  const apiKey = process.env.ETSY_API_KEY;
  if (!apiKey) throw new Error('ETSY_API_KEY environment variable is not set');

  const url = `${ETSY_API}${apiPath}`;
  const headers = {
    'x-api-key': apiKey,
    ...opts.headers,
  };

  const resp = await fetch(url, { ...opts, headers });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Etsy API error ${resp.status} at ${apiPath}: ${body}`);
  }

  return resp.json();
}

module.exports = { getAccessToken, etsyFetch, etsyPublicFetch };
