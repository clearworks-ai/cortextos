/**
 * Fleet reconcile — deterministic config-vs-live drift detection.
 *
 * Compares intent (enabled-agents.json, per-agent config.json crons, .env
 * briefs URL) against reality (daemon process list, live crons.json, live
 * HTTP status) for the three lived failures:
 *
 *   1. sage not restarted after a fleet restart (processes vs enabled-agents)
 *   2. Muse's week-long crons-vs-config drift
 *   3. the 4x briefs bad-link .env drift
 *
 * HARD CONSTRAINTS (2026-06-29 alert-recursion incident):
 *   - Output goes ONLY to the receipt file
 *     `state/fleet-reconcile-receipts.jsonl` — NEVER raw Telegram. This
 *     module must contain zero Telegram send paths.
 *   - Auto-restart must NEVER start an agent whose enabled-agents.json
 *     entry has `enabled: false` (hunter is permanently off).
 *   - No daemon-internal edits: this module talks to the daemon exclusively
 *     through the injected IPC `send` (IPCClient-compatible) using the
 *     existing 'status' / 'list-agents' / 'start-agent' commands.
 *
 * All logic is pure and dependency-injected so tests never touch a live
 * daemon or the real briefs URL.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readCrons } from '../bus/crons.js';
import type { AgentStatus, CronDefinition } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReconcileTrigger = 'post-restart' | 'daily' | 'manual';

export type CronDriftKind = 'missing-in-crons' | 'missing-in-config' | 'schedule-mismatch';

export interface CronDriftEntry {
  agent: string;
  kind: CronDriftKind;
  id: string;
}

export interface BriefsCheckResult {
  url: string | null;
  status: number | null;
  ok: boolean;
  note?: string;
}

export interface ReconcileReport {
  run_at: string;
  trigger: ReconcileTrigger;
  agents: {
    missing: string[];
    restarted: string[];
    skipped_disabled: string[];
    extra: string[];
  };
  cronDrift: CronDriftEntry[];
  briefsCheck: BriefsCheckResult;
  errors: string[];
}

/** Shape of one entry in config/enabled-agents.json (agent-manager registry). */
export interface EnabledAgentEntry {
  enabled?: boolean;
  org?: string;
  status?: string;
}

/** Minimal cron shape needed for drift comparison (subset of CronDefinition). */
export interface CronLike {
  name: string;
  schedule?: string;
}

/**
 * Structural IPC dependency — satisfied by IPCClient (src/daemon/ipc-server.ts)
 * without importing any daemon internals here.
 */
export interface ReconcileIpc {
  send(request: {
    type: 'status' | 'list-agents' | 'start-agent';
    agent?: string;
    data?: Record<string, unknown>;
    source?: string;
  }): Promise<{ success: boolean; data?: unknown; error?: string }>;
}

/** Injected fetcher: resolves to the HTTP status code, throws on network error. */
export type ReconcileFetcher = (url: string) => Promise<number>;

export interface ReconcileDeps {
  /** Instance root — enabled-agents.json, state/, and live crons live here. */
  ctxRoot: string;
  ipc: ReconcileIpc;
  fetcher: ReconcileFetcher;
  now: () => Date;
  /** Root containing `orgs/<org>/agents/<name>/config.json`. Defaults to ctxRoot. */
  frameworkRoot?: string;
  /** Path to the local .env holding BRIEFS_BASE_URL + DASHBOARD_BRIEF_TOKEN. Defaults to join(ctxRoot, '.env'). */
  envFilePath?: string;
  /** When true, report drift only — never send start-agent. */
  dryRun?: boolean;
  /** Explicit trigger label; when omitted it is auto-detected via the daemon-start marker. */
  trigger?: ReconcileTrigger;
}

// ---------------------------------------------------------------------------
// diffAgents — enabled-agents.json intent vs running processes
// ---------------------------------------------------------------------------

export interface AgentDiff {
  /** Enabled (or default-on) agents that are not running. Candidates for auto-restart. */
  missing: string[];
  /** Agents explicitly disabled (enabled: false) that are not running. NEVER started. */
  skipped_disabled: string[];
  /** Running agents with no entry in the registry. */
  extra: string[];
}

/**
 * Pure diff of the enabled-agents registry (shape from agent-manager's
 * readInstanceEnableList) against the list of currently running agent names.
 *
 * Registry semantics match the daemon: an agent present with `enabled: false`
 * is explicitly off; anything else in the registry defaults to enabled.
 */
export function diffAgents(
  enabled: Record<string, EnabledAgentEntry>,
  running: string[]
): AgentDiff {
  const runningSet = new Set(running);
  const missing: string[] = [];
  const skipped_disabled: string[] = [];

  for (const [name, entry] of Object.entries(enabled)) {
    if (runningSet.has(name)) continue;
    if (entry && entry.enabled === false) {
      skipped_disabled.push(name);
    } else {
      missing.push(name);
    }
  }

  const registered = new Set(Object.keys(enabled));
  const extra = running.filter(name => !registered.has(name));

  return { missing, skipped_disabled, extra };
}

// ---------------------------------------------------------------------------
// diffCrons — per-agent config.json crons vs live crons.json
// ---------------------------------------------------------------------------

/**
 * Pure diff of an agent's config.json `crons` field (intent) against its live
 * crons.json (reality), keyed by cron id (the `name` field).
 *
 * Returns entries without the agent name; the orchestrator attaches it.
 */
export function diffCrons(
  configCrons: CronLike[],
  liveCrons: CronLike[]
): Array<{ kind: CronDriftKind; id: string }> {
  const drift: Array<{ kind: CronDriftKind; id: string }> = [];
  const liveById = new Map(liveCrons.map(c => [c.name, c]));
  const configById = new Map(configCrons.map(c => [c.name, c]));

  for (const [id, cfg] of configById) {
    const live = liveById.get(id);
    if (!live) {
      drift.push({ kind: 'missing-in-crons', id });
    } else if ((cfg.schedule ?? '') !== (live.schedule ?? '')) {
      drift.push({ kind: 'schedule-mismatch', id });
    }
  }

  for (const id of liveById.keys()) {
    if (!configById.has(id)) {
      drift.push({ kind: 'missing-in-config', id });
    }
  }

  return drift;
}

// ---------------------------------------------------------------------------
// checkBriefsUrl — .env intent vs live HTTP status
// ---------------------------------------------------------------------------

/** Minimal KEY=VALUE .env parser (comments + surrounding quotes tolerated). */
function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(filePath, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** The only host the briefs link is allowed to resolve to (feedback_verify_links_before_sending). */
const BRIEFS_HOST_SUFFIX = 'briefs.clearworks.ai';

/**
 * Read BRIEFS_BASE_URL + DASHBOARD_BRIEF_TOKEN from a local .env file,
 * construct the brief URL, and probe it with the injected fetcher.
 *
 * `ok` is true ONLY when the URL host ends with `briefs.clearworks.ai` AND
 * the live status is exactly 200 — the 4x bad-link incident (2026-07-02) was
 * a local .env silently drifting from the live Railway value.
 */
export async function checkBriefsUrl(
  envFilePath: string,
  fetcher: ReconcileFetcher
): Promise<BriefsCheckResult> {
  if (!existsSync(envFilePath)) {
    return { url: null, status: null, ok: false, note: `env file not found: ${envFilePath}` };
  }

  let env: Record<string, string>;
  try {
    env = parseEnvFile(envFilePath);
  } catch (err) {
    return {
      url: null,
      status: null,
      ok: false,
      note: `env file unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const base = env.BRIEFS_BASE_URL;
  const token = env.DASHBOARD_BRIEF_TOKEN;
  if (!base || !token) {
    const missing = [!base && 'BRIEFS_BASE_URL', !token && 'DASHBOARD_BRIEF_TOKEN']
      .filter(Boolean)
      .join(', ');
    return { url: null, status: null, ok: false, note: `missing env vars: ${missing}` };
  }

  const trimmedBase = base.replace(/\/+$/, '');
  const url = `${trimmedBase}${trimmedBase.includes('?') ? '&' : '?'}token=${token}`;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { url, status: null, ok: false, note: `BRIEFS_BASE_URL is not a valid URL: ${base}` };
  }

  const hostOk = host === BRIEFS_HOST_SUFFIX || host.endsWith(`.${BRIEFS_HOST_SUFFIX}`);

  let status: number | null = null;
  let note: string | undefined;
  try {
    status = await fetcher(url);
  } catch (err) {
    note = `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const ok = hostOk && status === 200;
  if (!ok && !note) {
    note = !hostOk
      ? `host "${host}" is not ${BRIEFS_HOST_SUFFIX}`
      : `expected 200, got ${status}`;
  }

  return { url, status, ok, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// Internal readers (filesystem intent sources)
// ---------------------------------------------------------------------------

/**
 * Read the instance-level enabled-agents.json registry
 * (same file agent-manager's readInstanceEnableList reads).
 * Missing file → empty. Malformed → empty + error recorded.
 */
function readEnabledAgents(
  ctxRoot: string,
  errors: string[]
): Record<string, EnabledAgentEntry> {
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  if (!existsSync(enabledFile)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(enabledFile, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, EnabledAgentEntry>;
    }
    errors.push(`enabled-agents.json is not an object: ${enabledFile}`);
    return {};
  } catch (err) {
    errors.push(
      `enabled-agents.json unreadable/malformed: ${err instanceof Error ? err.message : String(err)}`
    );
    return {};
  }
}

/**
 * Scan `frameworkRoot/orgs/<org>/agents/<name>/config.json` (the same org
 * layout agent-manager discovers) and collect each agent's `crons` field.
 * Agents whose config.json has no `crons` array carry no declared intent and
 * are skipped.
 */
function readConfigCronsByAgent(
  orgsRoot: string,
  errors: string[]
): Map<string, CronLike[]> {
  const result = new Map<string, CronLike[]>();
  const orgsBase = join(orgsRoot, 'orgs');
  if (!existsSync(orgsBase)) return result;

  let orgNames: string[] = [];
  try {
    orgNames = readdirSync(orgsBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return result;
  }

  for (const org of orgNames) {
    const agentsBase = join(orgsBase, org, 'agents');
    if (!existsSync(agentsBase)) continue;
    let agentNames: string[] = [];
    try {
      agentNames = readdirSync(agentsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      continue;
    }

    for (const name of agentNames) {
      const configPath = join(agentsBase, name, 'config.json');
      if (!existsSync(configPath)) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
        const crons = (parsed as { crons?: unknown })?.crons;
        if (Array.isArray(crons)) {
          result.set(
            name,
            crons
              .filter((c): c is CronLike => !!c && typeof (c as CronLike).name === 'string')
              .map(c => ({ name: c.name, schedule: c.schedule }))
          );
        }
      } catch (err) {
        errors.push(
          `config.json unreadable for agent "${name}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return result;
}

/**
 * Read the live crons.json for an agent via the bus reader. readCrons resolves
 * its path from process.env.CTX_ROOT, so pin it to deps.ctxRoot for the call
 * and restore afterwards — keeps the orchestrator deterministic under test.
 */
function readLiveCrons(ctxRoot: string, agentName: string): CronDefinition[] {
  const prev = process.env.CTX_ROOT;
  process.env.CTX_ROOT = ctxRoot;
  try {
    return readCrons(agentName);
  } finally {
    if (prev === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = prev;
  }
}

// ---------------------------------------------------------------------------
// Trigger detection — post-restart vs daily, no daemon edits
// ---------------------------------------------------------------------------

/** Marker file owned by this module; stores the last observed daemon start (ms epoch). */
const DAEMON_START_MARKER = '.fleet-reconcile-last-daemon-start';

/** Tolerance for uptime-derived daemon-start jitter (seconds granularity + run latency). */
const DAEMON_START_TOLERANCE_MS = 120_000;

/**
 * Derive the daemon start time from the 'status' response: the longest-lived
 * agent's uptime approximates daemon uptime (agents start at daemon boot).
 * Returns null when no uptime data is available.
 */
function deriveDaemonStartMs(statuses: AgentStatus[], nowMs: number): number | null {
  let maxUptime = -1;
  for (const s of statuses) {
    if (typeof s.uptime === 'number' && s.uptime > maxUptime) maxUptime = s.uptime;
  }
  if (maxUptime < 0) return null;
  return nowMs - maxUptime * 1000;
}

function detectTrigger(
  ctxRoot: string,
  statuses: AgentStatus[],
  nowMs: number,
  errors: string[]
): ReconcileTrigger {
  const stateDir = join(ctxRoot, 'state');
  const markerPath = join(stateDir, DAEMON_START_MARKER);
  const currentStart = deriveDaemonStartMs(statuses, nowMs);

  if (currentStart === null) {
    // No live daemon data — cannot distinguish; treat as manual.
    return 'manual';
  }

  let previousStart: number | null = null;
  if (existsSync(markerPath)) {
    try {
      const parsed = Number(readFileSync(markerPath, 'utf-8').trim());
      if (Number.isFinite(parsed)) previousStart = parsed;
    } catch (err) {
      errors.push(
        `daemon-start marker unreadable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const changed =
    previousStart !== null && Math.abs(currentStart - previousStart) > DAEMON_START_TOLERANCE_MS;

  // Persist the freshest observation (only when meaningfully changed, so
  // per-run uptime jitter does not creep the stored value forward).
  if (previousStart === null || changed) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(markerPath, String(currentStart), 'utf-8');
    } catch (err) {
      errors.push(
        `daemon-start marker unwritable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return changed ? 'post-restart' : 'daily';
}

// ---------------------------------------------------------------------------
// runFleetReconcile — the orchestrator
// ---------------------------------------------------------------------------

const RECEIPTS_FILE = 'fleet-reconcile-receipts.jsonl';

/** Agent statuses that count as "running" for reconcile purposes. */
const LIVE_STATUSES = new Set(['running', 'starting']);

/**
 * Run one reconcile pass: diff agents, auto-start enabled-but-missing agents
 * (never disabled ones), diff crons, probe the briefs URL, and append exactly
 * one JSON receipt line to `state/fleet-reconcile-receipts.jsonl`.
 *
 * Receipt channel ONLY — this function never sends Telegram or any other
 * outbound notification.
 */
export async function runFleetReconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const errors: string[] = [];
  const runAt = deps.now().toISOString();
  const nowMs = deps.now().getTime();

  // --- 1. Intent: enabled-agents registry -------------------------------
  const enabled = readEnabledAgents(deps.ctxRoot, errors);

  // --- 2. Reality: running agents via IPC 'status' ----------------------
  let statuses: AgentStatus[] = [];
  try {
    const res = await deps.ipc.send({ type: 'status', source: 'reconcile-fleet' });
    if (res.success && Array.isArray(res.data)) {
      statuses = res.data as AgentStatus[];
    } else if (!res.success) {
      errors.push(`ipc status failed: ${res.error ?? 'unknown error'}`);
    }
  } catch (err) {
    errors.push(`ipc status threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  const running = statuses.filter(s => LIVE_STATUSES.has(s.status)).map(s => s.name);

  // --- 3. Diff + auto-fix ------------------------------------------------
  const diff = diffAgents(enabled, running);
  const restarted: string[] = [];

  if (!deps.dryRun) {
    for (const name of diff.missing) {
      // Disabled agents are structurally excluded from `missing` by
      // diffAgents — only enabled-but-not-running agents reach this loop.
      try {
        const res = await deps.ipc.send({
          type: 'start-agent',
          agent: name,
          data: { name },
          source: 'reconcile-fleet',
        });
        if (res.success) {
          restarted.push(name);
        } else {
          errors.push(`start-agent ${name} failed: ${res.error ?? 'unknown error'}`);
        }
      } catch (err) {
        errors.push(
          `start-agent ${name} threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // --- 4. Cron drift ------------------------------------------------------
  const cronDrift: CronDriftEntry[] = [];
  const orgsRoot = deps.frameworkRoot ?? deps.ctxRoot;
  const configCronsByAgent = readConfigCronsByAgent(orgsRoot, errors);
  for (const [agent, configCrons] of configCronsByAgent) {
    try {
      const liveCrons = readLiveCrons(deps.ctxRoot, agent);
      for (const entry of diffCrons(configCrons, liveCrons)) {
        cronDrift.push({ agent, ...entry });
      }
    } catch (err) {
      errors.push(
        `cron diff failed for agent "${agent}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // --- 5. Briefs URL check ------------------------------------------------
  const envFilePath = deps.envFilePath ?? join(deps.ctxRoot, '.env');
  const briefsCheck = await checkBriefsUrl(envFilePath, deps.fetcher);

  // --- 6. Trigger label ----------------------------------------------------
  const trigger = deps.trigger ?? detectTrigger(deps.ctxRoot, statuses, nowMs, errors);

  // --- 7. Receipt (the ONLY output channel) --------------------------------
  const report: ReconcileReport = {
    run_at: runAt,
    trigger,
    agents: {
      missing: diff.missing,
      restarted,
      skipped_disabled: diff.skipped_disabled,
      extra: diff.extra,
    },
    cronDrift,
    briefsCheck,
    errors,
  };

  try {
    const stateDir = join(deps.ctxRoot, 'state');
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, RECEIPTS_FILE), JSON.stringify(report) + '\n', 'utf-8');
  } catch (err) {
    // Receipt write failure is surfaced on the returned report; there is no
    // other channel by design.
    report.errors.push(
      `receipt append failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return report;
}
