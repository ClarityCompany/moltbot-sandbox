/**
 * Canva DAM (Digital Asset Management) backend routes
 *
 * Used by the "Etsy Product Ideas" Canva App (apps/canva-dam/).
 * SearchableListView calls POST /dam/resources/find to list product concepts.
 *
 * Authentication: every request must include a Canva user JWT in the
 * Authorization: Bearer <token> header. We verify it against Canva's JWKs.
 *
 * Resources returned:
 *   - CONTAINER (date_folder) — one per research date, newest first
 *   - IMAGE                   — one per AI-generated product concept
 *     thumbnail.url → /dam/thumbnail/:date/:id  (SVG concept card served by this Worker)
 *
 * Protected (Cloudflare Access is NOT required for this route because
 * the Canva App frontend runs inside canva.com — it cannot pass CF Access JWTs).
 * Instead, we gate access using the Canva user JWT.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { waitForProcess } from '../gateway/utils';

const dam = new Hono<AppEnv>();

// ─── Canva JWT verification ───────────────────────────────────────────────────

const CANVA_JWKS_URL = 'https://api.canva.com/.well-known/jwks.json';

// Simple in-memory JWK cache (lives for the duration of a Worker isolate)
let jwksCache: { keys: JsonWebKey[] } | null = null;
let jwksCacheAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getCanvaJwks(): Promise<{ keys: JsonWebKey[] }> {
  if (jwksCache && Date.now() - jwksCacheAt < JWKS_TTL_MS) return jwksCache;
  const resp = await fetch(CANVA_JWKS_URL);
  if (!resp.ok) throw new Error(`Failed to fetch Canva JWKs: ${resp.status}`);
  jwksCache = (await resp.json()) as { keys: JsonWebKey[] };
  jwksCacheAt = Date.now();
  return jwksCache;
}

/**
 * Verify a Canva user JWT.
 * Returns the decoded payload on success, throws on failure.
 */
async function verifyCanvaJwt(token: string, appId: string): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const [headerB64, payloadB64, sigB64] = parts;

  // Decode header to get key ID (kid)
  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/'))) as {
    kid?: string;
    alg?: string;
  };

  const payload = JSON.parse(
    atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')),
  ) as Record<string, unknown>;

  // Validate audience — must match our app ID
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(appId)) {
    throw new Error(`JWT audience mismatch: expected ${appId}, got ${String(payload.aud)}`);
  }

  // Validate expiry
  if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) {
    throw new Error('JWT expired');
  }

  // Find the matching JWK by kid
  const jwks = await getCanvaJwks();
  const jwk = header.kid
    ? jwks.keys.find((k: JsonWebKey & { kid?: string }) => (k as { kid?: string }).kid === header.kid)
    : jwks.keys[0];

  if (!jwk) throw new Error(`No JWK found for kid=${header.kid ?? 'unknown'}`);

  // Import the public key and verify the signature
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = Uint8Array.from(
    atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );

  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput);
  if (!valid) throw new Error('JWT signature verification failed');

  return payload;
}

/** Extract and verify the Canva JWT from the Authorization header. */
async function authenticate(
  authHeader: string | undefined,
  appId: string,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string }> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, error: 'Missing Authorization header' };
  }
  try {
    const payload = await verifyCanvaJwt(authHeader.slice(7), appId);
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'JWT verification failed' };
  }
}

// ─── Resource helpers ─────────────────────────────────────────────────────────

interface ProductSpec {
  id: number;
  title: string;
  description: string;
  category: string;
  trend_score?: number;
  style_keywords?: string[];
}

/** Read research data for a given date from the container filesystem. */
async function loadProductsForDate(
  sandbox: ReturnType<typeof Object.create>,
  date: string,
): Promise<ProductSpec[]> {
  const file = `/root/clawd/etsy-automation/products/${date}.json`;
  try {
    const proc = await sandbox.startProcess(`cat "${file}" 2>/dev/null || echo ""`);
    await waitForProcess(proc, 5000);
    const raw = ((await proc.getLogs()) as { stdout?: string }).stdout?.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { products?: ProductSpec[] };
    return parsed.products ?? [];
  } catch {
    return [];
  }
}

/** List all research dates available (newest first). */
async function listResearchDates(
  sandbox: ReturnType<typeof Object.create>,
): Promise<string[]> {
  try {
    const proc = await sandbox.startProcess(
      `ls /root/clawd/etsy-automation/products/*.json 2>/dev/null | sort -r | xargs -I{} basename {} .json`,
    );
    await waitForProcess(proc, 5000);
    const raw = ((await proc.getLogs()) as { stdout?: string }).stdout?.trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Thumbnail SVG generator ──────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, [string, string]> = {
  'Printable Wall Art':  ['#F56400', '#FFF8F4'],
  'SVG Cut Files':       ['#7D2AE8', '#F8F4FF'],
  'Digital Planner':     ['#1A56A4', '#F0F5FF'],
  'Canva Template':      ['#2D7D46', '#F0FFF5'],
  'Party Printables':    ['#C0392B', '#FFF5F5'],
  'Resume Template':     ['#2C3E50', '#F5F6FA'],
};

function generateThumbnailSvg(product: ProductSpec): string {
  const [bg, fg] = CATEGORY_COLORS[product.category] ?? ['#888', '#fff'];
  const safeTitle = product.title.replace(/[<>&"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
  );
  const safeCategory = product.category.replace(/[<>&"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
  );
  const score = product.trend_score ? `⭐ ${product.trend_score}/10` : '';

  // Word-wrap title into ≤24-char lines
  const words = safeTitle.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > 24) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current);

  const titleLines = lines
    .slice(0, 3)
    .map((l, i) => `<text x="200" y="${130 + i * 26}" text-anchor="middle" font-size="18" font-weight="bold" fill="${bg}">${l}</text>`)
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="${fg}"/>
  <rect width="400" height="70" fill="${bg}"/>
  <text x="200" y="30" text-anchor="middle" font-size="13" font-family="sans-serif" fill="white" font-weight="bold">${safeCategory}</text>
  <text x="200" y="52" text-anchor="middle" font-size="11" font-family="sans-serif" fill="rgba(255,255,255,0.8)">${score}</text>
  <rect y="70" width="400" height="2" fill="${bg}" opacity="0.3"/>
  <text x="200" y="100" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#666">PRODUCT CONCEPT</text>
  ${titleLines}
</svg>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /dam/resources/find
 *
 * Body: FindResourcesRequest (from @canva/app-components)
 * Returns: FindResourcesResponse
 */
dam.post('/resources/find', async (c) => {
  const appId = c.env.CANVA_APP_ID;
  if (!appId) {
    return c.json({ errorCode: 'INTERNAL_ERROR', message: 'CANVA_APP_ID is not configured' }, 500);
  }

  const auth = await authenticate(c.req.header('Authorization'), appId);
  if (!auth.ok) {
    return c.json({ errorCode: 'UNAUTHORIZED', message: auth.error }, 401);
  }

  const body = (await c.req.json()) as {
    types?: string[];
    containerId?: string;
    query?: string;
    filters?: Record<string, string | string[]>;
    continuation?: string;
  };

  const sandbox = c.get('sandbox');
  const workerUrl = c.env.WORKER_URL || `https://${new URL(c.req.url).host}`;
  const types = body.types ?? ['CONTAINER', 'IMAGE'];

  const resources: unknown[] = [];

  // ── Top level: list date folders (CONTAINER) ──
  if (!body.containerId && types.includes('CONTAINER')) {
    const dates = await listResearchDates(sandbox);
    for (const date of dates.slice(0, 30)) {
      resources.push({
        id:            `date:${date}`,
        type:          'CONTAINER',
        containerType: 'date_folder',
        name:          date,
      });
    }
  }

  // ── Inside a date folder: list products (IMAGE) ──
  if (body.containerId?.startsWith('date:') && types.includes('IMAGE')) {
    const date     = body.containerId.slice(5);
    const products = await loadProductsForDate(sandbox, date);

    const categoryFilter = body.filters?.category;
    const trendFilter    = body.filters?.trendScore;
    const query          = (body.query ?? '').toLowerCase();

    for (const product of products) {
      // Apply category filter
      if (categoryFilter) {
        const cats = Array.isArray(categoryFilter) ? categoryFilter : [categoryFilter];
        if (!cats.includes(product.category)) continue;
      }
      // Apply trend score filter
      if (trendFilter) {
        const score = product.trend_score ?? 5;
        if (trendFilter === 'high' && score < 8) continue;
        if (trendFilter === 'medium' && (score < 5 || score > 7)) continue;
      }
      // Apply search query
      if (query) {
        const searchable = `${product.title} ${product.category} ${(product.style_keywords ?? []).join(' ')}`.toLowerCase();
        if (!searchable.includes(query)) continue;
      }

      resources.push({
        id:       `product:${date}:${product.id}`,
        type:     'IMAGE',
        name:     product.title,
        mimeType: 'image/svg+xml',
        thumbnail: {
          url: `${workerUrl}/dam/thumbnail/${date}/${product.id}`,
        },
        url: `${workerUrl}/dam/thumbnail/${date}/${product.id}`,
      });
    }
  }

  // ── Top-level search across all dates (IMAGE) ──
  if (!body.containerId && types.includes('IMAGE') && body.query) {
    const dates = await listResearchDates(sandbox);
    for (const date of dates.slice(0, 7)) {
      const products = await loadProductsForDate(sandbox, date);
      const query    = body.query.toLowerCase();
      for (const product of products) {
        const searchable = `${product.title} ${product.category} ${(product.style_keywords ?? []).join(' ')}`.toLowerCase();
        if (!searchable.includes(query)) continue;
        resources.push({
          id:       `product:${date}:${product.id}`,
          type:     'IMAGE',
          name:     `${product.title} (${date})`,
          mimeType: 'image/svg+xml',
          thumbnail: { url: `${workerUrl}/dam/thumbnail/${date}/${product.id}` },
          url:       `${workerUrl}/dam/thumbnail/${date}/${product.id}`,
        });
      }
    }
  }

  return c.json({ resources, continuation: null });
});

/**
 * GET /dam/thumbnail/:date/:productId
 * Returns a simple SVG concept card for the given product.
 * No authentication required — URLs are not guessable (date + product ID).
 */
dam.get('/thumbnail/:date/:productId', async (c) => {
  const { date, productId } = c.req.param();
  const sandbox = c.get('sandbox');

  const products = await loadProductsForDate(sandbox, date);
  const product  = products.find((p) => String(p.id) === productId);

  if (!product) {
    // Return a simple "not found" SVG placeholder
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
      <rect width="400" height="300" fill="#f4f4f4"/>
      <text x="200" y="155" text-anchor="middle" font-family="sans-serif" fill="#999" font-size="14">Product not found</text>
    </svg>`;
    return new Response(svg, {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' },
    });
  }

  const svg = generateThumbnailSvg(product);
  return new Response(svg, {
    headers: {
      'Content-Type':  'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

export { dam };
