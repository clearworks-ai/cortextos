import { Command } from 'commander';
import { resolveEnv } from '../utils/env.js';
import { IPCClient } from '../daemon/ipc-server.js';
import { runFleetReconcile } from '../daemon/fleet-reconcile.js';
import type { ReconcileTrigger } from '../daemon/fleet-reconcile.js';

const VALID_TRIGGERS: ReconcileTrigger[] = ['post-restart', 'daily', 'manual'];

/** HTTP probe timeout for the briefs URL check. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * `cortextos reconcile-fleet` — deterministic config-vs-live drift check.
 *
 * Diffs enabled-agents.json vs running processes (auto-starting enabled but
 * missing agents unless --dry-run), per-agent config.json crons vs live
 * crons.json, and the local .env briefs URL vs its live HTTP status.
 *
 * Output: one JSON receipt line appended to state/fleet-reconcile-receipts.jsonl
 * plus the same report on stdout. Never Telegram. Drift is data, not a CLI
 * failure — exit 0 even when drift is found; exit 1 only on internal error.
 */
export const reconcileFleetCommand = new Command('reconcile-fleet')
  .description('Reconcile fleet intent (configs) against reality (processes, crons, briefs URL); receipt-file output only')
  .option('--dry-run', 'Report drift only — never send start-agent')
  .option('--trigger <t>', "Trigger label: 'post-restart', 'daily', or 'manual' (default: auto-detect)")
  .action(async (opts: { dryRun?: boolean; trigger?: string }) => {
    try {
      if (opts.trigger && !VALID_TRIGGERS.includes(opts.trigger as ReconcileTrigger)) {
        console.error(`Error: invalid --trigger "${opts.trigger}" (expected one of: ${VALID_TRIGGERS.join(', ')})`);
        process.exit(1);
      }

      const env = resolveEnv();
      const client = new IPCClient(env.instanceId);

      const fetcher = async (url: string): Promise<number> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(url, { signal: controller.signal });
          return res.status;
        } finally {
          clearTimeout(timer);
        }
      };

      const report = await runFleetReconcile({
        ctxRoot: env.ctxRoot,
        frameworkRoot: env.frameworkRoot || env.projectRoot || env.ctxRoot,
        ipc: client,
        fetcher,
        now: () => new Date(),
        dryRun: Boolean(opts.dryRun),
        trigger: opts.trigger as ReconcileTrigger | undefined,
      });

      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });
