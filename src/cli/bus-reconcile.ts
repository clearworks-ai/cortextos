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
 *
 * NOTE (RW-8 convergence): the daemon-resident ReconcileTrigger
 * (src/daemon/reconcile-trigger.ts) was removed — upstream runs no reconciler
 * and its synchronous 15-min passes + Atomics.wait file locks ran ON the
 * daemon event loop, with dryRun:false task reclaim keyed off known-wrong
 * daemon-internal liveness. The gather/emit helpers it shared with this CLI
 * now live here; this command remains the only (on-demand, out-of-process,
 * read-only) reconcile entry point.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { resolveEnv, parseEnvFile } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { IPCClient } from '../daemon/ipc-server.js';
import type { AgentConfig, AgentStatus, CronSummaryRow } from '../types/index.js';
import {
  reconcile,
  driftFindings,
  type DeclaredAgent,
  type LiveProcess,
  type ScheduledCrons,
  type DriftReport,
} from '../bus/reconcile.js';

/**
 * Agents that are intentionally OFF and must NEVER be flagged as drift.
 * "hunter" was permanently shut down (2026-06-27, re-confirmed 2026-06-29) and
 * must be skipped in every heartbeat/reconcile check. This is a hard exclusion
 * layered on top of each agent's `enabled` flag.
 */
export const DEFAULT_KNOWN_OFF = ['hunter'];

/** Read one agent config. Malformed input is surfaced instead of hidden as {}. */
function readAgentConfig(agentDir: string): AgentConfig {
  const configPath = join(agentDir, 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as AgentConfig;
  } catch (error) {
    throw new Error(
      'Malformed agent config at ' + configPath + ': '
      + (error instanceof Error ? error.message : String(error)),
    );
  }
}

/** Env keys present for an agent: its .env file keys merged with process.env. */
function presentEnvKeysFor(agentDir: string): string[] {
  const keys = new Set<string>();
  const envPath = join(agentDir, '.env');
  if (existsSync(envPath)) {
    for (const k of Object.keys(parseEnvFile(envPath))) keys.add(k);
  }
  for (const k of Object.keys(process.env)) keys.add(k);
  return [...keys];
}

/**
 * Assemble the declared-agent list by scanning orgs/<org>/agents/<name> and
 * reading each config.json for the enabled flag, declared crons, and declared
 * env keys. Pure filesystem read — no daemon state, no side effects.
 *
 * The `enabled` flag here reflects ONLY the per-agent config.json. The daemon
 * also honors instance-level enabled-agents.json; callers that have that map
 * can post-filter, but for drift purposes a config.json `enabled: false` is
 * the primary intentional-disable signal, and the knownOff list is the hard
 * backstop for "never flag this one".
 */
export function gatherDeclaredAgents(frameworkRoot: string): DeclaredAgent[] {
  const declared: DeclaredAgent[] = [];
  const orgsBase = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsBase)) return declared;

  let orgNames: string[] = [];
  try {
    orgNames = readdirSync(orgsBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return declared;
  }

  for (const org of orgNames) {
    const agentsBase = join(orgsBase, org, 'agents');
    if (!existsSync(agentsBase)) continue;
    let agentDirs: string[];
    try {
      agentDirs = readdirSync(agentsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      continue;
    }
    for (const name of agentDirs) {
      if (!/^[a-z0-9_-]+$/.test(name)) continue;
      const dir = join(agentsBase, name);
      const config = readAgentConfig(dir);
      const declaredCrons = (config.crons ?? [])
        .filter(c => c.type !== 'disabled')
        .map(c => c.name);
      const declaredEnvKeys = config.required_env ?? [];
      declared.push({
        name,
        dir,
        org,
        enabled: config.enabled !== false,
        declaredCrons,
        declaredEnvKeys: declaredEnvKeys.length > 0 ? declaredEnvKeys : undefined,
        presentEnvKeys:
          declaredEnvKeys.length > 0 ? presentEnvKeysFor(dir) : undefined,
      });
    }
  }
  return declared;
}

/** Map daemon AgentStatus[] to the pure reconcile LiveProcess shape. */
export function toLiveProcesses(statuses: AgentStatus[]): LiveProcess[] {
  return statuses.map(s => ({
    name: s.name,
    status: s.status,
    pid: s.pid,
    uptime: s.uptime,
  }));
}

/**
 * Emit a drift event for each finding on the deterministic event log, plus a
 * single summary. A clean report emits ONE quiet `fleet_reconcile_clean`
 * event and nothing else. Never sends Telegram, never mutates state.
 *
 * `emitAgent`/`emitOrg` identify WHO is logging, not the agent that drifted —
 * the drifted agent is carried in each event's metadata.
 */
export function emitDriftEvents(
  report: DriftReport,
  instanceId: string,
  emitAgent: string,
  emitOrg: string,
): void {
  const paths = resolvePaths(emitAgent, instanceId, emitOrg);

  if (report.clean) {
    logEvent(paths, emitAgent, emitOrg, 'action', 'fleet_reconcile_clean', 'info', {
      checked: report.total,
    });
    return;
  }

  for (const finding of driftFindings(report)) {
    logEvent(paths, emitAgent, emitOrg, 'action', 'fleet_reconcile_drift', 'warning', {
      kind: finding.kind,
      agent: finding.agent,
      org: finding.org ?? null,
      detail: finding.detail ?? null,
      message: finding.message,
    });
  }

  // One summary event so a downstream reader sees the aggregate in a single line.
  logEvent(paths, emitAgent, emitOrg, 'action', 'fleet_reconcile_summary', 'warning', {
    total: report.total,
    missing_process: report.missing_process.length,
    orphan_process: report.orphan_process.length,
    missing_cron: report.missing_cron.length,
    missing_env: report.missing_env.length,
  });
}

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

    // Emit drift events unless --no-emit. The CLI logs under the invoking
    // agent's identity.
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
