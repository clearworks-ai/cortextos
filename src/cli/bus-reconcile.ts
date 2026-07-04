/**
 * bus-reconcile.ts — `cortextos bus fleet-reconcile` CLI command (WS4).
 *
 * Gathers the LIVE fleet inputs (running processes + scheduled crons via daemon
 * IPC) and the DECLARED config (filesystem scan of orgs/<org>/agents), runs the
 * pure reconcile() logic, prints the drift report, and emits a drift event per
 * finding on the deterministic event log — the same channel other workers use.
 *
 * READ-ONLY: it reports drift, it does NOT auto-restart agents or mutate config.
 * It never pages Josh raw — per fleet policy alerts get diagnosed then surfaced.
 *
 * This is the thin wiring around the pure function; the deterministic drift
 * logic lives in src/bus/reconcile.ts and is what the fleet-reconcile-worker
 * SKILL should call rather than reimplementing the diff.
 */

import { Command } from 'commander';
import { resolveEnv } from '../utils/env.js';
import { IPCClient } from '../daemon/ipc-server.js';
import type { AgentStatus, CronSummaryRow } from '../types/index.js';
import { reconcile, driftFindings, type ScheduledCrons } from '../bus/reconcile.js';
import {
  gatherDeclaredAgents,
  toLiveProcesses,
  emitDriftEvents,
  DEFAULT_KNOWN_OFF,
} from '../daemon/reconcile-trigger.js';

export const fleetReconcileCommand = new Command('fleet-reconcile')
  .description('Detect fleet drift (enabled-but-not-running agents, unscheduled crons, missing env) and emit drift events. Read-only.')
  .option('--json', 'Emit the drift report as JSON')
  .option('--no-emit', 'Do not write drift events (report only)')
  .action(async (opts: { json?: boolean; emit?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();

    // --- DECLARED: filesystem scan of orgs/<org>/agents ---
    const declaredAgents = gatherDeclaredAgents(frameworkRoot);

    // --- LIVE: running processes + scheduled crons via daemon IPC ---
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (!daemonRunning) {
      console.error('ERROR: daemon is not running — cannot read live fleet state. Start it with: cortextos start');
      process.exit(1);
    }

    const statusResp = await ipc.send({ type: 'status', source: 'cortextos bus fleet-reconcile' });
    if (!statusResp.success) {
      console.error(`ERROR: failed to read live status from daemon: ${statusResp.error ?? 'unknown'}`);
      process.exit(1);
    }
    const liveProcesses = toLiveProcesses((statusResp.data as AgentStatus[]) ?? []);

    // Scheduled crons: any cron the daemon reports in list-all-crons is scheduled.
    const scheduledCrons: ScheduledCrons = {};
    const cronsResp = await ipc.send({ type: 'list-all-crons', source: 'cortextos bus fleet-reconcile' });
    if (cronsResp.success && Array.isArray(cronsResp.data)) {
      for (const row of cronsResp.data as CronSummaryRow[]) {
        (scheduledCrons[row.agent] ??= []).push(row.cron.name);
      }
    }

    const report = reconcile({
      declaredAgents,
      liveProcesses,
      scheduledCrons,
      knownOff: DEFAULT_KNOWN_OFF,
    });

    // Emit drift events unless --no-emit. Uses the same event path as the daemon
    // trigger; the CLI logs under the invoking agent's identity.
    if (opts.emit !== false) {
      emitDriftEvents(report, env.instanceId, env.agentName, env.org);
    }

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (report.clean) {
      console.log(`Fleet in sync — no drift across ${declaredAgents.length} declared agent(s).`);
      return;
    }

    console.log(`Fleet drift detected — ${report.total} finding(s):\n`);
    for (const f of driftFindings(report)) {
      console.log(`  [${f.kind}] ${f.message}`);
    }
    console.log('');
  });
