/**
 * bus-activity-ledger.ts — `cortextos bus activity-ledger` CLI command (WS10 / R6).
 *
 * Gathers the LIVE signal streams (event JSONL, verification receipts, cron-state,
 * cron-execution logs, declared crons from config) for a time window and runs the
 * pure correlateActivity() logic to surface did-vs-claimed mismatches.
 *
 * READ-ONLY: reports mismatches, does NOT auto-fix, mutate state, or page Josh
 * directly. Per fleet policy, findings go through larry (feedback_railway_alerts_
 * route_to_larry generalises: infra noise → larry, never Josh raw).
 *
 * --emit-events: emits one `system/did_vs_claimed_drift` warning event per
 *   finding, mirroring bus-reconcile.ts's per-finding logEvent pattern.
 *   Warn-only. Never blocks.
 *
 * Intended callers:
 *   - Manual: `cortextos bus activity-ledger --window 24h --json`
 *   - larry worker cron `did-vs-claimed-check` (interval 6h, Josh-gated before enabling)
 *
 * Architectural template: bus-reconcile.ts (thin CLI wrapping a pure function).
 */

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveEnv } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { parseDurationMs, readCronState } from '../bus/cron-state.js';
import { detectsCompletionClaim } from '../utils/claim-detector.js';
import {
  correlateActivity,
  ledgerFindings,
  type ClaimSignal,
  type ActionSignal,
  type DeclaredCron,
  type LedgerFinding,
} from '../bus/activity-ledger.js';
import type { AgentConfig, CronExecutionLogEntry } from '../types/index.js';

// ---------------------------------------------------------------------------
// Signal-gathering helpers
// ---------------------------------------------------------------------------

/** Default window for claim/action correlation: 30 minutes (same as CLAIM_RECEIPT_WINDOW_MS). */
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Parse a duration flag value ("30m", "6h", "24h") to milliseconds.
 * Returns the default when the input is invalid.
 */
function parseFlagDuration(val: string, defaultMs: number): number {
  const ms = parseDurationMs(val);
  return Number.isNaN(ms) || ms <= 0 ? defaultMs : ms;
}

/** Parse an event JSONL file and return raw objects; silently skips malformed lines. */
function readEventJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => {
        try { return JSON.parse(l) as Record<string, unknown>; }
        catch { return null; }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
  } catch {
    return [];
  }
}

/** Parse verification-receipts.jsonl into ActionSignals. */
function gatherReceiptSignals(ctxRoot: string, targetAgent: string | null): ActionSignal[] {
  const receiptPath = join(ctxRoot, 'state', 'verification-receipts.jsonl');
  if (!existsSync(receiptPath)) return [];
  const signals: ActionSignal[] = [];
  try {
    const lines = readFileSync(receiptPath, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const agent = String(obj.agent ?? '');
        if (!agent) continue;
        if (targetAgent && agent !== targetAgent) continue;
        const ts = Date.parse(String(obj.ts ?? ''));
        if (Number.isNaN(ts)) continue;
        signals.push({
          agent,
          kind: 'receipt',
          ts,
          ref: String(obj.kind ?? ''),
        });
      } catch { /* skip malformed */ }
    }
  } catch { /* best-effort */ }
  return signals;
}

/**
 * Gather ClaimSignals from the event JSONL files for all agents (or a single
 * agent if targetAgent is set). Reads up to 2 daily files (today + yesterday)
 * for a 24h-window query to bound I/O — same pattern as hasRecentReceipt.
 */
function gatherClaimSignals(
  ctxRoot: string,
  windowStartMs: number,
  targetAgent: string | null,
): ClaimSignal[] {
  const signals: ClaimSignal[] = [];

  // Find all agent event dirs under orgs/<org>/analytics/events/<agent>/
  // and under <ctxRoot>/analytics/events/<agent>/ (legacy path).
  const candidateDirs: Array<{ eventsDir: string }> = [];

  // Walk orgs
  const orgsBase = join(ctxRoot, 'orgs');
  if (existsSync(orgsBase)) {
    try {
      for (const org of readdirSync(orgsBase, { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        const evDir = join(orgsBase, org.name, 'analytics', 'events');
        if (existsSync(evDir)) candidateDirs.push({ eventsDir: evDir });
      }
    } catch { /* best-effort */ }
  }
  // Legacy flat analytics
  const flatEvDir = join(ctxRoot, 'analytics', 'events');
  if (existsSync(flatEvDir)) candidateDirs.push({ eventsDir: flatEvDir });

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];

  for (const { eventsDir } of candidateDirs) {
    let agentDirs: string[];
    try {
      agentDirs = readdirSync(eventsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { continue; }

    for (const agent of agentDirs) {
      if (targetAgent && agent !== targetAgent) continue;

      for (const date of [today, yesterday]) {
        const filePath = join(eventsDir, agent, `${date}.jsonl`);
        const events = readEventJsonl(filePath);
        for (const ev of events) {
          const ts = Date.parse(String(ev.timestamp ?? ''));
          if (Number.isNaN(ts) || ts < windowStartMs) continue;

          // Pre-computed claim_without_receipt events
          if (ev.event === 'claim_without_receipt') {
            const snippet = (ev.metadata as Record<string, unknown>)?.snippet;
            signals.push({
              agent,
              kind: 'claim_without_receipt',
              ts,
              ref: typeof snippet === 'string' ? snippet.slice(0, 120) : undefined,
            });
            continue;
          }

          // Raw telegram_sent events — check the snippet for completion claims
          if (ev.event === 'telegram_sent') {
            const text = (ev.metadata as Record<string, unknown>)?.text;
            const preview = typeof text === 'string' ? text : '';
            if (detectsCompletionClaim(preview)) {
              signals.push({
                agent,
                kind: 'telegram_claim',
                ts,
                ref: preview.slice(0, 120),
              });
            }
          }
        }
      }
    }
  }

  return signals;
}

/**
 * Gather cron_fire ActionSignals from each agent's cron-state.json.
 * state/<agent>/cron-state.json is under ctxRoot (daemon-managed state).
 */
function gatherCronFireSignals(
  ctxRoot: string,
  targetAgent: string | null,
): ActionSignal[] {
  const signals: ActionSignal[] = [];
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return signals;

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return signals; }

  for (const agent of agentDirs) {
    if (targetAgent && agent !== targetAgent) continue;
    const agentStateDir = join(stateDir, agent);
    const cronState = readCronState(agentStateDir);
    for (const record of cronState.crons) {
      const ts = Date.parse(record.last_fire);
      if (Number.isNaN(ts)) continue;
      signals.push({ agent, kind: 'cron_fire', ts, ref: record.name });
    }
  }
  return signals;
}

/**
 * Gather cron_exec ActionSignals from each agent's cron-execution.log.
 * The log lives at .cortextOS/state/agents/<agent>/cron-execution.log
 * relative to ctxRoot (see crons-schema.ts CRONS_DIRECTORY).
 */
function gatherCronExecSignals(
  ctxRoot: string,
  windowStartMs: number,
  targetAgent: string | null,
): ActionSignal[] {
  const signals: ActionSignal[] = [];
  const agentsDir = join(ctxRoot, '.cortextOS', 'state', 'agents');
  if (!existsSync(agentsDir)) return signals;

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return signals; }

  for (const agent of agentDirs) {
    if (targetAgent && agent !== targetAgent) continue;
    const logPath = join(agentsDir, agent, 'cron-execution.log');
    if (!existsSync(logPath)) continue;

    try {
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as CronExecutionLogEntry;
          const ts = Date.parse(entry.ts);
          if (Number.isNaN(ts) || ts < windowStartMs) continue;
          // Encode status in the ref field as "cronName:status" so correlateActivity
          // can identify failed entries (see activity-ledger.ts Rule 3 comment).
          signals.push({
            agent,
            kind: 'cron_exec',
            ts,
            ref: `${entry.cron}:${entry.status}`,
          });
        } catch { /* skip malformed */ }
      }
    } catch { /* best-effort */ }
  }
  return signals;
}

/**
 * Gather declared crons from all agent config.json files under
 * orgs/<org>/agents/<agent>/config.json (same filesystem walk as reconcile-trigger.ts).
 */
function gatherDeclaredCrons(
  frameworkRoot: string,
  targetAgent: string | null,
): DeclaredCron[] {
  const declared: DeclaredCron[] = [];
  const orgsBase = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsBase)) return declared;

  let orgNames: string[];
  try {
    orgNames = readdirSync(orgsBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return declared; }

  for (const org of orgNames) {
    const agentsBase = join(orgsBase, org, 'agents');
    if (!existsSync(agentsBase)) continue;

    let agentDirs: string[];
    try {
      agentDirs = readdirSync(agentsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { continue; }

    for (const agentName of agentDirs) {
      if (targetAgent && agentName !== targetAgent) continue;
      const configPath = join(agentsBase, agentName, 'config.json');
      if (!existsSync(configPath)) continue;

      let config: AgentConfig;
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8')) as AgentConfig;
      } catch { continue; }

      if (!config.crons) continue;
      for (const cron of config.crons) {
        if (cron.type === 'disabled') continue;
        // The interval field for cron-state entries comes from the update-cron-fire
        // call inside each cron's prompt. We take it from config if present as a
        // best-effort — cron-state.json records the live interval when fired.
        const interval = cron.interval;
        if (!interval) continue; // skip cron-expr format crons (can't parse for gap check)
        declared.push({ agent: agentName, name: cron.name, interval });
      }
    }
  }
  return declared;
}

/**
 * Emit one `system/did_vs_claimed_drift` warning event per finding.
 * Never throws — best-effort telemetry.
 */
function emitLedgerEvents(
  findings: LedgerFinding[],
  paths: ReturnType<typeof resolvePaths>,
  agentName: string,
  org: string,
): void {
  for (const finding of findings) {
    try {
      logEvent(
        paths,
        agentName,
        org,
        'action',
        'did_vs_claimed_drift',
        'warning',
        {
          kind: finding.kind,
          agent: finding.agent,
          detail: finding.detail ?? null,
          message: finding.message,
        },
      );
    } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const activityLedgerCommand = new Command('activity-ledger')
  .description(
    'Correlate did-vs-claimed signals (R6): surface completion claims with no backing receipt, silent crons, and unreported cron errors. Read-only; warn-only findings.',
  )
  .option('--window <dur>', 'Claim/action correlation window (e.g. 30m, 6h, 24h)', '30m')
  .option('--agent <name>', 'Limit analysis to a single agent')
  .option('--json', 'Emit the ledger report as JSON')
  .option('--emit-events', 'Write a did_vs_claimed_drift event per finding to the event log')
  .action(async (opts: { window: string; agent?: string; json?: boolean; emitEvents?: boolean }) => {
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot || join(homedir(), '.cortextos', env.instanceId || 'default');
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const targetAgent = opts.agent ?? null;

    const windowMs = parseFlagDuration(opts.window, DEFAULT_WINDOW_MS);
    const now = Date.now();
    // Look back 2×window (for context) when gathering signals, but use windowMs
    // as the correlation tolerance in correlateActivity itself.
    const windowStartMs = now - windowMs * 2;

    // --- Gather all signal streams ---
    const claims = gatherClaimSignals(ctxRoot, windowStartMs, targetAgent);
    const actions: ActionSignal[] = [
      ...gatherReceiptSignals(ctxRoot, targetAgent),
      ...gatherCronFireSignals(ctxRoot, targetAgent),
      ...gatherCronExecSignals(ctxRoot, windowStartMs, targetAgent),
    ];
    const declaredCrons = gatherDeclaredCrons(frameworkRoot, targetAgent);

    // --- Run pure correlation ---
    const report = correlateActivity({ claims, actions, declaredCrons, now, windowMs });

    // --- Emit events if requested ---
    if (opts.emitEvents && report.findings.length > 0) {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org);
      emitLedgerEvents(ledgerFindings(report), paths, env.agentName, env.org);
    }

    // --- Output ---
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (report.clean) {
      console.log(`Activity ledger: clean — no did-vs-claimed drift in the last ${opts.window}.`);
      return;
    }

    console.log(`Activity ledger: ${report.total} finding(s) in the last ${opts.window}:\n`);
    for (const f of ledgerFindings(report)) {
      console.log(`  [${f.kind}] ${f.message}`);
    }
    console.log('');
    console.log(`Counts: ${report.counts.claim_without_action} claim_without_action, ${report.counts.silent_cron} silent_cron, ${report.counts.cron_error_unreported} cron_error_unreported`);
  });
