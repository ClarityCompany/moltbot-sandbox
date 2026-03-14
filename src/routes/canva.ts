/**
 * Canva Connect API OAuth 2.0 routes
 *
 * Public:
 *   GET /canva/callback  - OAuth callback from Canva (registered as redirect URI)
 *
 * Protected (Cloudflare Access required):
 *   GET  /canva/auth     - Start the Canva OAuth 2.0 + PKCE flow
 *   GET  /canva/status   - Show Canva authorization status
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { waitForProcess } from '../gateway/utils';

// Canva OAuth endpoints (Connect API)
// https://www.canva.dev/docs/connect/authentication/
const CANVA_AUTH_URL  = 'https://www.canva.com/api/oauth/authorize';
const CANVA_TOKEN_URL = 'https://www.canva.com/api/oauth/token';

// Scopes required for design export automation
// Note: scopes are NOT cumulative — specify read AND write explicitly
const CANVA_SCOPES = [
  'design:meta:read',     // List and read design metadata
  'design:content:read',  // Read design content
  'asset:read',           // Read assets
].join(' ');

// ─── PKCE helpers (same implementation as etsy.ts) ───────────────────────────

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

// ─── Router ───────────────────────────────────────────────────────────────────

const canva = new Hono<AppEnv>();

// ─── PUBLIC: OAuth callback ───────────────────────────────────────────────────

canva.get('/callback', async (c) => {
  const code  = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.html(
      `<h2>Canva OAuth Error</h2><p>${error}: ${c.req.query('error_description') ?? ''}</p>`,
      400,
    );
  }

  if (!code || !state) {
    return c.html('<h2>Bad Request</h2><p>Missing code or state parameter.</p>', 400);
  }

  let codeVerifier: string;
  let redirectUri: string;
  try {
    const decoded = JSON.parse(atob(state.replace(/-/g, '+').replace(/_/g, '/')));
    codeVerifier = decoded.cv;
    redirectUri  = decoded.ru;
  } catch {
    return c.html('<h2>Bad Request</h2><p>Invalid state parameter.</p>', 400);
  }

  const clientId     = c.env.CANVA_CLIENT_ID;
  const clientSecret = c.env.CANVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.html(
      '<h2>Configuration Error</h2><p>CANVA_CLIENT_ID or CANVA_CLIENT_SECRET is not set.</p>',
      500,
    );
  }

  // Exchange auth code for tokens
  // Canva requires HTTP Basic auth (client_id:client_secret) for token endpoint
  const credentials = btoa(`${clientId}:${clientSecret}`);
  let tokenData: { access_token: string; refresh_token: string; expires_in: number };

  try {
    const resp = await fetch(CANVA_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri:  redirectUri,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return c.html(`<h2>Token Exchange Failed</h2><pre>${resp.status}: ${body}</pre>`, 502);
    }

    tokenData = (await resp.json()) as typeof tokenData;
  } catch (err) {
    return c.html(
      `<h2>Token Exchange Error</h2><p>${err instanceof Error ? err.message : 'Unknown'}</p>`,
      500,
    );
  }

  // Save tokens to container filesystem (synced to R2)
  const sandbox    = c.get('sandbox');
  const expiresAt  = Date.now() + tokenData.expires_in * 1000;
  const tokenJson  = JSON.stringify(
    {
      access_token:  tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at:    expiresAt,
      saved_at:      new Date().toISOString(),
    },
    null,
    2,
  );

  const escaped = tokenJson.replace(/'/g, "'\\''");
  try {
    const proc = await sandbox.startProcess(
      `mkdir -p /root/clawd/etsy-automation && printf '%s' '${escaped}' > /root/clawd/etsy-automation/canva-tokens.json`,
    );
    await waitForProcess(proc, 10000);
  } catch (err) {
    console.error('[canva/callback] Failed to save tokens:', err);
    return c.html(
      '<h2>Storage Error</h2><p>Tokens obtained but could not be saved to container.</p>',
      500,
    );
  }

  return c.html(`
    <html>
      <head><title>Canva Connected</title></head>
      <body style="font-family:sans-serif;max-width:600px;margin:2rem auto;padding:1rem">
        <h2>✅ Canva Connected Successfully</h2>
        <p>Your Canva account has been authorized. The daily automation can now export your template designs.</p>
        <p><strong>Access token expires:</strong> ${new Date(expiresAt).toUTCString()}</p>
        <p><strong>Next step:</strong> Add your Canva template design IDs to the config file.</p>
        <pre style="background:#f4f4f4;padding:1rem;border-radius:4px">cat /root/clawd/etsy-automation/config/canva-templates.json</pre>
        <p>You can close this window.</p>
      </body>
    </html>
  `);
});

// ─── PROTECTED routes ─────────────────────────────────────────────────────────

const canvaProtected = new Hono<AppEnv>();
canvaProtected.use('*', createAccessMiddleware({ type: 'html' }));

// GET /canva/auth — Start OAuth flow
canvaProtected.get('/auth', async (c) => {
  const clientId = c.env.CANVA_CLIENT_ID;
  if (!clientId) {
    return c.html(
      '<h2>Configuration Error</h2><p>CANVA_CLIENT_ID is not set. Run: wrangler secret put CANVA_CLIENT_ID</p>',
      500,
    );
  }

  const workerUrl   = c.env.WORKER_URL || `https://${new URL(c.req.url).host}`;
  const redirectUri = `${workerUrl}/canva/callback`;

  const codeVerifier  = randomBase64url(32);
  const codeChallenge = await sha256Base64url(codeVerifier);

  const statePayload = JSON.stringify({ cv: codeVerifier, ru: redirectUri });
  const state = btoa(statePayload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const authUrl = new URL(CANVA_AUTH_URL);
  authUrl.searchParams.set('code_challenge',        codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('scope',                 CANVA_SCOPES);
  authUrl.searchParams.set('response_type',         'code');
  authUrl.searchParams.set('client_id',             clientId);
  authUrl.searchParams.set('state',                 state);
  authUrl.searchParams.set('redirect_uri',          redirectUri);

  return c.redirect(authUrl.toString());
});

// GET /canva/status — Check Canva authorization status
canvaProtected.get('/status', async (c) => {
  const sandbox = c.get('sandbox');
  let tokenStatus = 'not configured';
  let templateCount = 0;

  try {
    const tokProc = await sandbox.startProcess(
      'cat /root/clawd/etsy-automation/canva-tokens.json 2>/dev/null || echo ""',
    );
    await waitForProcess(tokProc, 5000);
    const tokJson = (await tokProc.getLogs()).stdout?.trim();
    if (tokJson && tokJson !== '') {
      const tok = JSON.parse(tokJson) as { expires_at?: number };
      tokenStatus = Date.now() < (tok.expires_at ?? 0) ? 'valid' : 'expired (will auto-refresh)';
    }
  } catch { /* ignore */ }

  try {
    const tplProc = await sandbox.startProcess(
      'cat /root/clawd/etsy-automation/config/canva-templates.json 2>/dev/null || echo ""',
    );
    await waitForProcess(tplProc, 5000);
    const tplJson = (await tplProc.getLogs()).stdout?.trim();
    if (tplJson && tplJson !== '') {
      const tpl = JSON.parse(tplJson) as { templates?: unknown[] };
      templateCount = tpl.templates?.length ?? 0;
    }
  } catch { /* ignore */ }

  return c.html(`
    <html>
      <head><title>Canva Status</title></head>
      <body style="font-family:sans-serif;max-width:700px;margin:2rem auto;padding:1rem">
        <h2>Canva Connect API Status</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>OAuth Token</strong></td>
              <td style="padding:8px;border:1px solid #ddd">${tokenStatus}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Templates Configured</strong></td>
              <td style="padding:8px;border:1px solid #ddd">${templateCount} template design${templateCount !== 1 ? 's' : ''}</td></tr>
        </table>
        <br>
        ${tokenStatus === 'not configured'
          ? `<a href="/canva/auth" style="background:#7d2ae8;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">Connect Canva Account</a>`
          : ''}
        ${templateCount === 0
          ? `<p style="margin-top:1rem;color:#856404;background:#fff3cd;padding:0.75rem;border-radius:4px">
               ⚠ No templates configured yet. Add your Canva template design IDs to<br>
               <code>/root/clawd/etsy-automation/config/canva-templates.json</code>
             </p>`
          : ''}
      </body>
    </html>
  `);
});

canva.route('/', canvaProtected);

export { canva };
