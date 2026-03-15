/**
 * Etsy automation routes
 *
 * Public:
 *   GET /etsy/callback  - OAuth 2.0 callback from Etsy (must be registered as redirect URI)
 *
 * Protected (Cloudflare Access required):
 *   GET  /etsy/auth     - Start the Etsy OAuth 2.0 + PKCE flow
 *   GET  /etsy/status   - Show automation status (last run, OAuth state)
 *   POST /etsy/trigger  - Manually trigger the daily automation workflow
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { buildEnvVars } from '../gateway/env';
import { waitForProcess } from '../gateway/utils';

// ---- PKCE helpers (no external dependencies) --------------------------------

function randomBase64url(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function sha256Base64url(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ---- Etsy OAuth constants ----------------------------------------------------

const ETSY_AUTH_URL = 'https://www.etsy.com/oauth/connect';
const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

// Scopes required for the automation (space-separated)
const ETSY_SCOPES = [
  'listings_r', // Read own listings
  'listings_w', // Create / update listings
  'listings_d', // Delete listings
  'transactions_r', // Read transactions (for metrics)
  'shops_r', // Read shop info
].join(' ');

// ---- Router ------------------------------------------------------------------

const etsy = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// PUBLIC ROUTE: OAuth callback (Etsy redirects here after user authorizes)
// ---------------------------------------------------------------------------

etsy.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.html(
      `<h2>Etsy OAuth Error</h2><p>${error}: ${c.req.query('error_description') ?? ''}</p>`,
      400,
    );
  }

  if (!code || !state) {
    return c.html('<h2>Bad Request</h2><p>Missing code or state parameter.</p>', 400);
  }

  // Decode state: base64url JSON containing { cv: code_verifier, redirectUri }
  let codeVerifier: string;
  let redirectUri: string;
  try {
    const decoded = JSON.parse(atob(state.replace(/-/g, '+').replace(/_/g, '/')));
    codeVerifier = decoded.cv;
    redirectUri = decoded.ru;
  } catch {
    return c.html('<h2>Bad Request</h2><p>Invalid state parameter.</p>', 400);
  }

  const apiKey = c.env.ETSY_API_KEY;
  const apiSecret = c.env.ETSY_API_SECRET;

  if (!apiKey || !apiSecret) {
    return c.html(
      '<h2>Configuration Error</h2><p>ETSY_API_KEY or ETSY_API_SECRET is not set.</p>',
      500,
    );
  }

  // Exchange authorization code for tokens
  let tokenData: { access_token: string; refresh_token: string; expires_in: number };
  try {
    const resp = await fetch(ETSY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: apiKey,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return c.html(
        `<h2>Token Exchange Failed</h2><pre>${resp.status}: ${body}</pre>`,
        502,
      );
    }

    tokenData = (await resp.json()) as typeof tokenData;
  } catch (err) {
    return c.html(
      `<h2>Token Exchange Error</h2><p>${err instanceof Error ? err.message : 'Unknown error'}</p>`,
      500,
    );
  }

  // Save tokens into the container filesystem via a shell command.
  // The container will persist them to R2 on the next sync cycle.
  const sandbox = c.get('sandbox');
  const expiresAt = Date.now() + tokenData.expires_in * 1000;
  const tokenJson = JSON.stringify(
    {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt,
      saved_at: new Date().toISOString(),
    },
    null,
    2,
  );

  // Escape single quotes in the JSON string for the shell command
  const escaped = tokenJson.replace(/'/g, "'\\''");
  try {
    const proc = await sandbox.startProcess(
      `mkdir -p /root/clawd/etsy-automation && printf '%s' '${escaped}' > /root/clawd/etsy-automation/etsy-tokens.json`,
    );
    await waitForProcess(proc, 10000);
  } catch (err) {
    console.error('[etsy/callback] Failed to save tokens:', err);
    return c.html(
      '<h2>Storage Error</h2><p>Tokens obtained but could not be saved to container.</p>',
      500,
    );
  }

  return c.html(`
    <html>
      <head><title>Etsy Connected</title></head>
      <body style="font-family:sans-serif;max-width:600px;margin:2rem auto;padding:1rem">
        <h2>✅ Etsy Connected Successfully</h2>
        <p>Your Etsy account has been authorized. The daily automation will now be able to post listings to your shop.</p>
        <p><strong>Access token expires:</strong> ${new Date(expiresAt).toUTCString()}</p>
        <p>You can close this window.</p>
      </body>
    </html>
  `);
});

// ---------------------------------------------------------------------------
// PUBLIC ROUTE: Zapier webhook — create a single Etsy listing
// Secured by ZAPIER_WEBHOOK_SECRET rather than Cloudflare Access.
// ---------------------------------------------------------------------------
//
// Expected JSON body (from Zapier "Webhooks by Zapier" action):
//   {
//     "title":       "My Wall Art Print",          // required
//     "description": "A beautiful digital print",  // required
//     "price":       4.99,                          // required (USD)
//     "tags":        "wall art, printable, boho",  // optional, comma-separated
//     "image_url":   "https://...",                 // optional
//     "quantity":    999,                           // optional, default 999
//     "auto_publish": false                         // optional, default false (creates draft)
//   }
//
// Responds with:
//   { listing_id, listing_url, title, state }  on success
//   { error }                                  on failure
//
// Set up in Zapier:
//   Trigger: Google Sheets → New Spreadsheet Row
//   Action:  Webhooks by Zapier → POST
//     URL:     https://<your-worker>.workers.dev/etsy/webhook/zapier
//     Headers: X-Zapier-Secret: <ZAPIER_WEBHOOK_SECRET value>
//     Data:    (map sheet columns to the JSON fields above)
// ---------------------------------------------------------------------------

etsy.post('/webhook/zapier', async (c) => {
  const secret = c.env.ZAPIER_WEBHOOK_SECRET;

  // Require a secret to be configured
  if (!secret) {
    return c.json({ error: 'Webhook is not configured (ZAPIER_WEBHOOK_SECRET not set)' }, 503);
  }

  // Validate the caller's secret
  const provided = c.req.header('x-zapier-secret') ?? '';
  if (provided !== secret) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400);
  }

  if (!body.title || !body.description || !body.price) {
    return c.json({ error: 'title, description, and price are required' }, 400);
  }

  const sandbox = c.get('sandbox');

  // Escape the payload for safe shell embedding
  const listingJson = JSON.stringify(body).replace(/'/g, "'\\''");

  let proc: Awaited<ReturnType<typeof sandbox.startProcess>>;
  try {
    proc = await sandbox.startProcess(
      `node /root/clawd/skills/etsy-automation/scripts/zapier-lister.js --listing='${listingJson}'`,
      { env: { ETSY_API_KEY: c.env.ETSY_API_KEY ?? '', ETSY_SHOP_ID: c.env.ETSY_SHOP_ID ?? '' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to start process';
    return c.json({ error: msg }, 500);
  }

  try {
    await waitForProcess(proc, 30_000);
  } catch {
    // timeout or non-zero exit — read output anyway
  }

  const logs = await proc.getLogs();
  const stdout = logs.stdout?.trim() ?? '';

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(stdout);
  } catch {
    return c.json({ error: `Script output was not valid JSON: ${stdout.slice(0, 300)}` }, 500);
  }

  if (result.error) {
    return c.json({ error: result.error }, 500);
  }

  return c.json(result, 201);
});

// ---------------------------------------------------------------------------
// PROTECTED ROUTES (Cloudflare Access required)
// ---------------------------------------------------------------------------

const etsyProtected = new Hono<AppEnv>();
etsyProtected.use('*', createAccessMiddleware({ type: 'html' }));

// GET /etsy/auth — Start OAuth flow
etsyProtected.get('/auth', async (c) => {
  const apiKey = c.env.ETSY_API_KEY;
  if (!apiKey) {
    return c.html(
      '<h2>Configuration Error</h2><p>ETSY_API_KEY is not set. Run: wrangler secret put ETSY_API_KEY</p>',
      500,
    );
  }

  const workerUrl = c.env.WORKER_URL || `https://${new URL(c.req.url).host}`;
  const redirectUri = `${workerUrl}/etsy/callback`;

  const codeVerifier = randomBase64url(32); // 43-char URL-safe string
  const codeChallenge = await sha256Base64url(codeVerifier);

  // Encode state: base64url JSON with code_verifier and redirect URI
  const statePayload = JSON.stringify({ cv: codeVerifier, ru: redirectUri });
  const state = btoa(statePayload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const authUrl = new URL(ETSY_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', ETSY_SCOPES);
  authUrl.searchParams.set('client_id', apiKey);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return c.redirect(authUrl.toString());
});

// GET /etsy/status — Check automation status
etsyProtected.get('/status', async (c) => {
  const sandbox = c.get('sandbox');

  let tokenStatus = 'not configured';
  let lastRun: string | null = null;
  let lastRunStatus: string | null = null;

  try {
    const tokProc = await sandbox.startProcess(
      'cat /root/clawd/etsy-automation/etsy-tokens.json 2>/dev/null || echo ""',
    );
    await waitForProcess(tokProc, 5000);
    const tokLogs = await tokProc.getLogs();
    const tokJson = tokLogs.stdout?.trim();
    if (tokJson && tokJson !== '') {
      const tok = JSON.parse(tokJson) as { expires_at?: number };
      const expiresAt = tok.expires_at ?? 0;
      tokenStatus = Date.now() < expiresAt ? 'valid' : 'expired (will auto-refresh)';
    }
  } catch {
    // ignore
  }

  try {
    const runProc = await sandbox.startProcess(
      'cat /root/clawd/etsy-automation/last-run.json 2>/dev/null || echo ""',
    );
    await waitForProcess(runProc, 5000);
    const runLogs = await runProc.getLogs();
    const runJson = runLogs.stdout?.trim();
    if (runJson && runJson !== '') {
      const run = JSON.parse(runJson) as { timestamp?: string; status?: string };
      lastRun = run.timestamp ?? null;
      lastRunStatus = run.status ?? null;
    }
  } catch {
    // ignore
  }

  return c.html(`
    <html>
      <head><title>Etsy Automation Status</title></head>
      <body style="font-family:sans-serif;max-width:700px;margin:2rem auto;padding:1rem">
        <h2>Etsy Automation Status</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>OAuth Token</strong></td>
              <td style="padding:8px;border:1px solid #ddd">${tokenStatus}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Last Run</strong></td>
              <td style="padding:8px;border:1px solid #ddd">${lastRun ?? 'Never'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Last Run Status</strong></td>
              <td style="padding:8px;border:1px solid #ddd">${lastRunStatus ?? '-'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Daily Schedule</strong></td>
              <td style="padding:8px;border:1px solid #ddd">09:00 UTC (automatic)</td></tr>
        </table>
        <br>
        ${tokenStatus === 'not configured' ? `<a href="/etsy/auth" style="background:#f56400;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">Connect Etsy Account</a>` : ''}
        <form method="POST" action="/etsy/trigger" style="display:inline;margin-left:1rem">
          <button type="submit" style="background:#333;color:#fff;padding:10px 20px;border:none;border-radius:4px;cursor:pointer">
            Run Now (Manual Trigger)
          </button>
        </form>
      </body>
    </html>
  `);
});

// POST /etsy/trigger — Manually trigger the daily workflow
etsyProtected.post('/trigger', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const envVars = buildEnvVars(c.env);
    const proc = await sandbox.startProcess(
      'node /root/clawd/skills/etsy-automation/scripts/run-daily.js --skip-listing --skip-metrics',
      { env: envVars },
    );

    // Fire-and-forget: don't wait for completion (could take many minutes)
    c.executionCtx.waitUntil(
      waitForProcess(proc, 20 * 60 * 1000).catch((err) =>
        console.error('[etsy/trigger] Workflow error:', err),
      ),
    );

    return c.html(`
      <html>
        <head><title>Workflow Triggered</title></head>
        <body style="font-family:sans-serif;max-width:600px;margin:2rem auto;padding:1rem">
          <h2>✅ Daily Workflow Triggered</h2>
          <p>The Etsy automation workflow has started running in the background.</p>
          <p>Process ID: <code>${proc.id}</code></p>
          <p>Check <a href="/etsy/status">Etsy Status</a> for results, or your Telegram for the daily summary notification.</p>
        </body>
      </html>
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.html(`<h2>Error</h2><p>${msg}</p>`, 500);
  }
});

// Mount protected routes onto the main router
etsy.route('/', etsyProtected);

export { etsy };
