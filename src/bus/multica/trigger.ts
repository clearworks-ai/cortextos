import { spawn } from 'node:child_process';

import { resolveMulticaConfig } from './client.js';

/**
 * Real-time Multica mirror.
 *
 * Fired from the bus task-mutation CLI handlers (create/update/claim/complete)
 * so a bus status change is reflected on the matching Multica issue the moment
 * it happens — no cron, no poll lag.
 *
 * Design constraints:
 *  - MUST NOT slow or break the bus op. The push runs in a DETACHED child that
 *    is unref'd, so the parent CLI returns immediately and never awaits Multica.
 *  - MUST be a no-op when Multica is not configured (other orgs, tests, CI) —
 *    a cheap sync config probe gates the spawn so we don't fork a node process
 *    for nothing.
 *  - MUST never throw. Any failure here is swallowed; a task write already
 *    succeeded and mirroring is best-effort.
 *
 * Uses `--direction out` only, so the mirror can never write bus tasks and can
 * never feed back into itself.
 */
export function triggerMulticaMirror(taskId: string): void {
  try {
    // Cheap gate: if Multica isn't configured for this org, do nothing at all.
    if (resolveMulticaConfig() === null) {
      return;
    }

    // The cli.js currently executing — reuse it so the child is the same build.
    const cliPath = process.argv[1];
    if (!cliPath) {
      return;
    }

    const child = spawn(
      process.execPath,
      [cliPath, 'bus', 'multica-sync', '--direction', 'out', '--task', taskId],
      {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    // Let the parent exit without waiting on the mirror.
    child.unref();
  } catch {
    // Best-effort: the task mutation already landed; never surface a mirror error.
  }
}
