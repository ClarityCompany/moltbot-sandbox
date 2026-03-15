import type { Sandbox } from '@cloudflare/sandbox';
import { waitForProcess } from './utils';

export interface AutoApproveResult {
  approved: string[];
  attempts: number;
}

/**
 * Poll for pending OpenClaw devices and approve them automatically.
 *
 * Safe to do unconditionally: the Worker already gates access behind Cloudflare Access,
 * so any device that reaches the gateway has already been authenticated.
 *
 * Typical usage: fire-and-forget via `executionCtx.waitUntil(...)` immediately after
 * the gateway closes a WebSocket with "pairing required", so the client's next
 * reconnect attempt succeeds without human intervention.
 *
 * @param sandbox   - The sandbox instance
 * @param token     - MOLTBOT_GATEWAY_TOKEN value (forwarded as --token to the CLI)
 * @param maxWaitMs - How long to keep polling for pending devices (default 60 s)
 */
export async function autoApprovePendingDevices(
  sandbox: Sandbox,
  token: string | undefined,
  maxWaitMs = 60_000,
): Promise<AutoApproveResult> {
  const tokenArg = token ? ` --token ${token}` : '';
  const deadline = Date.now() + maxWaitMs;
  const approved: string[] = [];
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    try {
      // Ask the gateway for its pending device list
      const listProc = await sandbox.startProcess(
        `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await waitForProcess(listProc, 10_000);
      const listLogs = await listProc.getLogs();

      const jsonMatch = listLogs.stdout?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]) as { pending?: Array<{ requestId: string }> };
        const pending = data.pending ?? [];

        for (const device of pending) {
          // eslint-disable-next-line no-await-in-loop
          const approveProc = await sandbox.startProcess(
            `openclaw devices approve ${device.requestId} --url ws://localhost:18789${tokenArg}`,
          );
          // eslint-disable-next-line no-await-in-loop
          await waitForProcess(approveProc, 10_000);
          approved.push(device.requestId);
          console.log('[auto-approve] Approved device:', device.requestId);
        }

        if (approved.length > 0) {
          console.log('[auto-approve] Done — approved', approved.length, 'device(s)');
          return { approved, attempts };
        }
      }
    } catch (err) {
      console.error('[auto-approve] Poll error:', err instanceof Error ? err.message : err);
    }

    // Wait before trying again
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2_000));
  }

  if (approved.length === 0) {
    console.log('[auto-approve] No pending devices found after', attempts, 'attempts');
  }

  return { approved, attempts };
}
