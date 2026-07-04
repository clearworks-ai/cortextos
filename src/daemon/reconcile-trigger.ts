/**
 * reconcile-trigger.ts — Daemon auto-trigger for fleet reconcile (WS4).
 *
 * The previous WS4 attempt had NO daemon trigger — reconcile only ran when a
 * worker session happened to fire it. That is the gap this module closes:
 * the daemon runs the reconcile check automatically on a fixed cadence (and
 * once shortly after boot), emitting a drift event per finding on the same
 * deterministic event log other workers use. It does NOT page Josh and does
 * NOT restart or mutate any agent — it is READ-ONLY drift detection. Per
 * fleet policy, alerts get diagnosed then surfaced; they don't page raw.
 *
 * Reuses:
 *   - the pure reconcile() logic (src/bus/reconcile.ts)
 *   - the AgentManager's live status + cron-scheduler introspection
 *   - logEvent (src/bus/event.ts) for the deterministic event/receipt channel
 *
 * The gather helpers here are shared with the CLI (src/cli/bus-reconcile.ts)
 * so the two entry points assemble declared inputs identically.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { AgentConfig, AgentStatus } from '../types/index.js';
import { logEvent } from '../bus/event.js';
import { resolvePaths } from '../utils/paths.js';
import { parseEnvFile } from '../utils/env.js';
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

/** Default reconcile cadence: every 15 minutes. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;

/** Delay before the first post-boot reconcile — lets agents finish starting. */
const INITIAL_DELAY_MS = 90 * 1000;

/**
 * Read one agent's config.json (best-effort). Returns {} on any failure so a
 * single malformed config never breaks the whole reconcile pass.
 */
function readAgentConfig(agentDir: string): AgentConfig {
  const configPath = join(agentDir, 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as AgentConfig;
  } catch {
    return {};
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
 * env keys. Pure filesystem read — no daemon state, no side effects — so the
 * CLI and daemon build identical inputs.
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
 * `emitAgent`/`emitOrg` identify WHO is logging (the daemon acts as the fleet
 * on behalf of the whole install), not the agent that drifted — the drifted
 * agent is carried in each event's metadata.
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

/**
 * Minimal AgentManager surface the trigger needs. Declared as an interface so
 * this module does not create an import cycle with agent-manager.ts and stays
 * trivially testable.
 */
export interface ReconcileManagerLike {
  getAllStatuses(): AgentStatus[];
  getCronScheduler(agentName: string): { getNextFireTimes(): Array<{ name: string; nextFireAt: number }> } | undefined;
}

export interface ReconcileTriggerOptions {
  intervalMs?: number;
  knownOff?: string[];
  /** Agent identity the daemon uses when emitting events. Default 'daemon'. */
  emitAgent?: string;
  /** Org the daemon uses when emitting events. Default the daemon's org. */
  emitOrg?: string;
}

/**
 * Periodic fleet-reconcile driver, owned by the daemon. Runs one pass shortly
 * after boot and then every `intervalMs`. Reuses the same 30s-style
 * setInterval mechanism the daemon already uses elsewhere — no new scheduler.
 */
export class ReconcileTrigger {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly manager: ReconcileManagerLike,
    private readonly instanceId: string,
    private readonly frameworkRoot: string,
    private readonly org: string,
    private readonly options: ReconcileTriggerOptions = {},
  ) {}

  /** Start the periodic reconcile loop (idempotent). */
  start(): void {
    if (this.timer || this.initialTimer) return;
    const intervalMs = this.options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;

    // First pass after a short delay so agents finish their startup_delay
    // before we judge them missing.
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.runOnce();
    }, INITIAL_DELAY_MS);
    if (typeof this.initialTimer.unref === 'function') this.initialTimer.unref();

    this.timer = setInterval(() => this.runOnce(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the periodic loop and clear timers. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  /**
   * Run a single reconcile pass: gather live + declared inputs, run the pure
   * reconcile, and emit drift events. Best-effort — any error is swallowed so
   * a reconcile hiccup never crashes the daemon. Re-entrancy guarded so a slow
   * pass never overlaps the next tick.
   */
  runOnce(): DriftReport | null {
    if (this.running) return null;
    this.running = true;
    try {
      const declaredAgents = gatherDeclaredAgents(this.frameworkRoot);
      const statuses = this.manager.getAllStatuses();
      const liveProcesses = toLiveProcesses(statuses);
      const scheduledCrons = this.gatherScheduledCrons(declaredAgents);

      const report = reconcile({
        declaredAgents,
        liveProcesses,
        scheduledCrons,
        knownOff: this.options.knownOff ?? DEFAULT_KNOWN_OFF,
      });

      emitDriftEvents(
        report,
        this.instanceId,
        this.options.emitAgent ?? 'daemon',
        this.options.emitOrg ?? this.org,
      );
      return report;
    } catch (err) {
      console.error(
        `[reconcile-trigger] pass failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Ask the AgentManager which crons each declared agent has scheduled. */
  private gatherScheduledCrons(declaredAgents: DeclaredAgent[]): ScheduledCrons {
    const out: ScheduledCrons = {};
    for (const a of declaredAgents) {
      const scheduler = this.manager.getCronScheduler(a.name);
      if (!scheduler) continue;
      out[a.name] = scheduler.getNextFireTimes().map(f => f.name);
    }
    return out;
  }
}
