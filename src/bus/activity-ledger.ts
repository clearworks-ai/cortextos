/**
 * activity-ledger.ts — R6 did-vs-claimed activity ledger (pure logic).
 *
 * WS10 — Completeness / Correctness Layer.
 *
 * Correlates three existing signal streams to surface mismatches between
 * what agents *claimed* and what actually *fired/happened*:
 *
 *   - ClaimSignal   — derived from event JSONL: `message/telegram_sent` (whose
 *                     preview trips detectsCompletionClaim) + the pre-computed
 *                     `message/claim_without_receipt` guard events.
 *   - ActionSignal  — from verification-receipts.jsonl, cron-state.json, and
 *                     cron-execution.log.
 *   - LedgerFinding — a mismatch detected by correlateActivity.
 *
 * This module is DELIBERATELY PURE: it takes plain data inputs and returns a
 * structured report with NO side effects — no fs reads, no shell, no env
 * access. Gathering the signals is the CLI's job (src/cli/bus-activity-ledger.ts).
 *
 * Three correlation rules (all warn-only, mirroring WS2 posture):
 *   1. claim_without_action  — telegram completion claim with no receipt
 *      from the same agent within ±windowMs. Reuses detectsCompletionClaim
 *      as the claim test (single source of truth, already tuned conservative).
 *   2. silent_cron           — a declared cron whose last_fire is older than
 *      2×interval AND no exec-log entry exists in that window.
 *   3. cron_error_unreported — a cron-execution.log entry with status:'failed'
 *      in-window for which no surfacing event (receipt/message) exists.
 *
 * FALSE-POSITIVE BIAS: deliberately conservative. The ±window tolerance, the
 * 2×interval heuristic (same gap used by cron-state.ts daemon detection), and
 * the warn-only posture all mirror the proven WS2 approach.
 *
 * Architectural template: reconcile.ts (pure analyzer) + bus-reconcile.ts
 * (thin CLI that gathers inputs and emits events).
 */

import { detectsCompletionClaim } from '../utils/claim-detector.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A signal that an agent CLAIMED something was done.
 * Derived from the event JSONL: either a raw `message/telegram_sent` whose
 * preview trips detectsCompletionClaim, or a pre-computed
 * `message/claim_without_receipt` event (the warn-only guard already detected it).
 */
export interface ClaimSignal {
  agent: string;
  kind: 'telegram_claim' | 'claim_without_receipt';
  /** Unix milliseconds */
  ts: number;
  /** Optional text snippet or event ref for human-readable output. */
  ref?: string;
}

/**
 * A signal that an agent actually DID something: recorded a verification
 * receipt, a cron fired, or a cron execution log entry was written.
 */
export interface ActionSignal {
  agent: string;
  kind: 'receipt' | 'cron_fire' | 'cron_exec';
  /** Unix milliseconds */
  ts: number;
  /** Optional cron name or receipt kind for human-readable output. */
  ref?: string;
}

/** A declared cron entry from an agent's config. */
export interface DeclaredCron {
  agent: string;
  name: string;
  /** Interval string like "6h", "24h", "30m" — same format as cron-state.ts. */
  interval: string;
}

/** A finding emitted by correlateActivity when claims do not match actions. */
export interface LedgerFinding {
  kind: 'claim_without_action' | 'silent_cron' | 'cron_error_unreported';
  agent: string;
  detail?: string;
  message: string;
  /** Unix ms timestamp of the claim that triggered this finding (when applicable). */
  claimTs?: number;
  windowStart: number;
  windowEnd: number;
}

export interface LedgerReport {
  findings: LedgerFinding[];
  /** True when there are zero findings. */
  clean: boolean;
  /** Total number of findings. */
  total: number;
  counts: {
    claim_without_action: number;
    silent_cron: number;
    cron_error_unreported: number;
  };
}

export interface CorrelateActivityInput {
  /** Completion claims extracted from the event log. */
  claims: ClaimSignal[];
  /** Actions extracted from receipts, cron-state, and exec-log. */
  actions: ActionSignal[];
  /** Declared crons from agent configs (to detect silent ones). */
  declaredCrons: DeclaredCron[];
  /** Unix ms: logical "now" for computing windows and recency. */
  now: number;
  /** Half-width of the claim/action correlation window in ms (default: 30 min). */
  windowMs: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse an interval string ("6h", "30m", "24h", "1d", "2w") to milliseconds.
 * Returns NaN for unrecognised formats. Mirrors parseDurationMs from cron-state.ts
 * (kept local so this module stays pure and import-free from the rest of the bus).
 */
function parseDurationMs(interval: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
  if (!match) return NaN;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * (multipliers[unit] ?? NaN);
}

// ---------------------------------------------------------------------------
// Core pure function
// ---------------------------------------------------------------------------

/**
 * Correlate did-vs-claimed signals and return a structured ledger report.
 *
 * Pure — no side effects, no fs/env access. Called twice with the same input
 * must return an identical result (deterministic).
 *
 * @param input - All signal streams and configuration for the analysis window.
 * @returns A structured LedgerReport with findings and clean/total summary.
 */
export function correlateActivity(input: CorrelateActivityInput): LedgerReport {
  const { claims, actions, declaredCrons, now, windowMs } = input;
  const windowStart = now - windowMs * 2; // look back 2×window for context
  const windowEnd = now;

  const findings: LedgerFinding[] = [];

  // ── Rule 1: claim_without_action ─────────────────────────────────────────
  //
  // A telegram completion claim with no receipt ActionSignal from the same
  // agent within ±windowMs. We also honour pre-computed claim_without_receipt
  // events (the WS2 guard already flagged them); those are always findings
  // since the guard confirmed no receipt existed at send time.
  //
  // For raw telegram_claim signals: recheck detectsCompletionClaim to stay
  // consistent with the single source of truth for "is this a completion claim."

  // Index action signals by agent for fast lookup.
  const receiptsByAgent = new Map<string, ActionSignal[]>();
  for (const a of actions) {
    if (a.kind === 'receipt') {
      (receiptsByAgent.get(a.agent) ?? receiptsByAgent.set(a.agent, []).get(a.agent)!).push(a);
    }
  }

  for (const claim of claims) {
    // Only consider claims within the analysis window.
    if (claim.ts < windowStart || claim.ts > windowEnd) continue;

    // Pre-computed claim_without_receipt: the guard already confirmed no receipt.
    if (claim.kind === 'claim_without_receipt') {
      findings.push({
        kind: 'claim_without_action',
        agent: claim.agent,
        detail: claim.ref,
        message: `agent "${claim.agent}" claimed completion (claim_without_receipt event) but no verification receipt exists — ${claim.ref ?? 'no ref'}`,
        claimTs: claim.ts,
        windowStart,
        windowEnd,
      });
      continue;
    }

    // Raw telegram_claim: check whether there is a receipt within ±windowMs.
    if (claim.kind === 'telegram_claim') {
      // Validate it actually is a completion claim (single source of truth).
      if (claim.ref && !detectsCompletionClaim(claim.ref)) continue;

      const agentReceipts = receiptsByAgent.get(claim.agent) ?? [];
      const hasMatchingReceipt = agentReceipts.some(
        r => Math.abs(r.ts - claim.ts) <= windowMs,
      );
      if (!hasMatchingReceipt) {
        findings.push({
          kind: 'claim_without_action',
          agent: claim.agent,
          detail: claim.ref,
          message: `agent "${claim.agent}" claimed completion in Telegram but no verification receipt within ±${Math.round(windowMs / 60_000)}min — "${(claim.ref ?? '').slice(0, 80)}"`,
          claimTs: claim.ts,
          windowStart,
          windowEnd,
        });
      }
    }
  }

  // ── Rule 2: silent_cron ──────────────────────────────────────────────────
  //
  // A declared cron whose last_fire is older than 2×interval AND no
  // cron-execution.log entry exists within 2×interval of now. This catches
  // the "SILENT-OK masked a cron that never ran" failure pattern.

  // Index cron_fire and cron_exec action signals by agent+name for lookup.
  const cronFireByAgentName = new Map<string, number>(); // key: "agent:name" → ts
  const cronExecByAgentName = new Map<string, ActionSignal[]>(); // key: "agent" → signals

  for (const a of actions) {
    if (a.kind === 'cron_fire' && a.ref) {
      const key = `${a.agent}:${a.ref}`;
      const existing = cronFireByAgentName.get(key);
      if (existing === undefined || a.ts > existing) {
        cronFireByAgentName.set(key, a.ts);
      }
    }
    if (a.kind === 'cron_exec') {
      const list = cronExecByAgentName.get(a.agent);
      if (list) {
        list.push(a);
      } else {
        cronExecByAgentName.set(a.agent, [a]);
      }
    }
  }

  for (const cron of declaredCrons) {
    const intervalMs = parseDurationMs(cron.interval);
    if (Number.isNaN(intervalMs) || intervalMs <= 0) continue; // skip cron-expr format

    const gapMs = 2 * intervalMs; // the 2×interval heuristic from cron-state.ts docs
    const expectedAfter = now - gapMs;

    // Check cron-state.json last_fire (carried as cron_fire action signal).
    const lastFireKey = `${cron.agent}:${cron.name}`;
    const lastFireTs = cronFireByAgentName.get(lastFireKey);
    const hasCronStateFire = lastFireTs !== undefined && lastFireTs >= expectedAfter;

    // Check exec-log entries in window (cron_exec action signals, ref="cronName:status").
    // A "fired" or "retried" exec entry (not "failed") within the window is a live signal.
    const execEntries = cronExecByAgentName.get(cron.agent) ?? [];
    const hasExecLogFire = execEntries.some(e => {
      if (e.ts < expectedAfter) return false;
      if (!e.ref) return false;
      // Ref is encoded as "cronName:status" by the CLI gather layer.
      const colonIdx = e.ref.lastIndexOf(':');
      const execCronName = colonIdx >= 0 ? e.ref.slice(0, colonIdx) : e.ref;
      const execStatus = colonIdx >= 0 ? e.ref.slice(colonIdx + 1) : '';
      // Only count successful/retried execs as evidence the cron actually ran.
      // A failed status without a follow-up means the cron tried but errored —
      // but it DID fire, so it's not "silent". Rule 3 handles the error-unreported case.
      return execCronName === cron.name && execStatus !== 'failed';
    });

    if (!hasCronStateFire && !hasExecLogFire) {
      findings.push({
        kind: 'silent_cron',
        agent: cron.agent,
        detail: cron.name,
        message:
          `cron "${cron.name}" for agent "${cron.agent}" has not fired in the last ${Math.round(gapMs / 3_600_000 * 10) / 10}h (2×${cron.interval}) — SILENT-OK may be masking a missed run`,
        windowStart,
        windowEnd,
      });
    }
  }

  // ── Rule 3: cron_error_unreported ────────────────────────────────────────
  //
  // A cron-execution.log entry with status:'failed' in-window for which no
  // corresponding surfacing event (receipt/message) exists from the same agent
  // after the failure timestamp. A failure that WAS surfaced (any receipt or
  // message action signal after it) is NOT flagged.

  // Collect all failed exec entries (we carry status in the ref field as
  // "cronName:status" from the CLI gather layer — see bus-activity-ledger.ts).
  const messageActionsByAgent = new Map<string, ActionSignal[]>();
  for (const a of actions) {
    if (a.kind === 'receipt' || a.kind === 'cron_exec') {
      // Use receipt and cron_fire as "surfacing" signals — if ANY action
      // followed the failure, we consider it reported. This is conservative:
      // a cron fire after a failure means the retry succeeded and someone knows.
      const list = messageActionsByAgent.get(a.agent);
      if (list) {
        list.push(a);
      } else {
        messageActionsByAgent.set(a.agent, [a]);
      }
    }
  }

  // Also count telegram_claim signals as "something was said" — any claim
  // event after a failure means the agent was active and aware.
  for (const c of claims) {
    const list = messageActionsByAgent.get(c.agent);
    const pseudo: ActionSignal = { agent: c.agent, kind: 'receipt', ts: c.ts };
    if (list) {
      list.push(pseudo);
    } else {
      messageActionsByAgent.set(c.agent, [pseudo]);
    }
  }

  // Walk actions looking for failed exec signals.
  // The CLI encodes failed cron-exec entries with ref="cronName:failed".
  const seenErrorKeys = new Set<string>(); // deduplicate per agent+cron+ts
  for (const a of actions) {
    if (a.kind !== 'cron_exec') continue;
    if (!a.ref?.endsWith(':failed')) continue;
    if (a.ts < windowStart || a.ts > windowEnd) continue;

    const cronName = a.ref.slice(0, a.ref.length - ':failed'.length);
    const errorKey = `${a.agent}:${cronName}:${a.ts}`;
    if (seenErrorKeys.has(errorKey)) continue;
    seenErrorKeys.add(errorKey);

    // Was there any surfacing action AFTER this failure (within the window)?
    const agentActions = messageActionsByAgent.get(a.agent) ?? [];
    const wasSurfaced = agentActions.some(
      s => s.ts > a.ts && s.ts <= windowEnd,
    );

    if (!wasSurfaced) {
      findings.push({
        kind: 'cron_error_unreported',
        agent: a.agent,
        detail: cronName,
        message: `cron "${cronName}" for agent "${a.agent}" failed at ${new Date(a.ts).toISOString()} but no surfacing event or receipt followed — silent failure`,
        windowStart,
        windowEnd,
      });
    }
  }

  const counts = {
    claim_without_action: findings.filter(f => f.kind === 'claim_without_action').length,
    silent_cron: findings.filter(f => f.kind === 'silent_cron').length,
    cron_error_unreported: findings.filter(f => f.kind === 'cron_error_unreported').length,
  };

  return {
    findings,
    clean: findings.length === 0,
    total: findings.length,
    counts,
  };
}

/** Flatten LedgerReport findings for iteration or display. */
export function ledgerFindings(report: LedgerReport): LedgerFinding[] {
  return report.findings;
}
