/**
 * Etsy automation routes
 *
 * Protected (Cloudflare Access required):
 *   GET  /etsy/status   — Show last automation run status
 *   POST /etsy/trigger  — Manually trigger the daily workflow
 *
 * The daily workflow (research → design → mockups → Google Sheets) runs
 * automatically at 09:00 UTC via the cron trigger in wrangler.toml.
 * Make reads the Google Sheet and creates the Etsy listings.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { buildEnvVars } from '../gateway/env';
import { waitForProcess } from '../gateway/utils';

const etsy = new Hono<AppEnv>();
etsy.use('*', createAccessMiddleware({ type: 'html' }));

// GET /etsy/status — Last run info
etsy.get('/status', async (c) => {
  const sandbox = c.get('sandbox');

  let lastRun: string | null = null;
  let lastRunStatus: string | null = null;
  let lastRunSteps: Record<string, string> = {};

  let rawJson = '';
  try {
    const proc = await sandbox.startProcess(
      'cat /root/clawd/skills/etsy-automation/data/last-run.json 2>/dev/null || echo ""',
    );
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    const raw = logs.stdout?.trim();
    rawJson = raw || '';
    if (raw) {
      const run = JSON.parse(raw) as {
        timestamp?: string;
        started_at?: string;
        status?: string;
        steps?: Record<string, { status: string; error?: string }>;
      };
      lastRun = run.started_at ?? run.timestamp ?? null;
      lastRunStatus = run.status ?? null;
      if (run.steps) {
        lastRunSteps = Object.fromEntries(
          Object.entries(run.steps).map(([k, v]) => [k, v.status]),
        );
      }
    }
  } catch {
    // ignore
  }

  // Parse full step details (including error messages) for display
  let stepDetails: Array<{ step: string; status: string; error?: string }> = [];
  if (rawJson) {
    try {
      const run = JSON.parse(rawJson) as { steps?: Record<string, { status: string; error?: string }> };
      if (run.steps) {
        stepDetails = Object.entries(run.steps).map(([step, v]) => ({
          step,
          status: v.status,
          error: v.error,
        }));
      }
    } catch { /* ignore */ }
  }

  const stepsHtml = stepDetails
    .map(({ step, status, error }) => {
      const icon = status === 'success' ? '✅' : status === 'skipped' ? '⏭️' : status === 'failed' ? '❌' : '—';
      return `<tr>
        <td style="padding:6px 12px;border:1px solid #ddd;vertical-align:top">${step}</td>
        <td style="padding:6px 12px;border:1px solid #ddd;vertical-align:top">${icon} ${status}${error ? `<br><small style="color:#c00">${error}</small>` : ''}</td>
      </tr>`;
    })
    .join('');

  return c.html(`
    <html>
      <head><title>Etsy Automation Status</title></head>
      <body style="font-family:sans-serif;max-width:800px;margin:2rem auto;padding:1rem">
        <h2>Etsy Automation Status</h2>
        <table style="border-collapse:collapse;width:100%;margin-bottom:1.5rem">
          <tr>
            <td style="padding:8px 12px;border:1px solid #ddd"><strong>Last Run</strong></td>
            <td style="padding:8px 12px;border:1px solid #ddd">${lastRun ?? 'Never'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #ddd"><strong>Status</strong></td>
            <td style="padding:8px 12px;border:1px solid #ddd">${lastRunStatus ?? '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #ddd"><strong>Schedule</strong></td>
            <td style="padding:8px 12px;border:1px solid #ddd">09:00 UTC daily (automatic)</td>
          </tr>
        </table>

        ${stepsHtml ? `
        <h3>Last Run Steps</h3>
        <table style="border-collapse:collapse;width:100%;margin-bottom:1.5rem">
          ${stepsHtml}
        </table>` : ''}

        ${rawJson ? `
        <details style="margin-bottom:1.5rem">
          <summary style="cursor:pointer;font-weight:bold">Raw last-run.json</summary>
          <pre style="background:#f5f5f5;padding:1rem;overflow:auto;font-size:0.8rem;margin-top:0.5rem">${rawJson.replace(/</g, '&lt;')}</pre>
        </details>` : ''}

        <form method="POST" action="/etsy/trigger">
          <button type="submit" style="background:#333;color:#fff;padding:10px 20px;border:none;border-radius:4px;cursor:pointer">
            ▶ Run Now (Manual Trigger)
          </button>
        </form>
      </body>
    </html>
  `);
});

// POST /etsy/trigger — Manually kick off the workflow
etsy.post('/trigger', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const envVars = buildEnvVars(c.env);
    const proc = await sandbox.startProcess(
      'node /root/clawd/skills/etsy-automation/scripts/run-daily.js',
      { env: envVars },
    );

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
          <p>The automation is running in the background (Research → Design → Mockups → Google Sheets → Telegram).</p>
          <p>Process ID: <code>${proc.id}</code></p>
          <p><a href="/etsy/status">← Back to Status</a></p>
        </body>
      </html>
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.html(`<h2>Error</h2><p>${msg}</p>`, 500);
  }
});

export { etsy };
