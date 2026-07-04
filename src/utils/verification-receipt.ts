/**
 * Verification-receipt ledger for the outbound-comms certainty guard.
 *
 * A "receipt" is a small, durable record that an agent ACTUALLY verified
 * something before claiming it — a build that passed, a URL that returned 200,
 * a test run that went green. The certainty guard at the send-telegram choke
 * point checks this ledger: when an outbound message makes a completion claim
 * but no recent receipt exists, it logs a warn-only `claim_without_receipt`
 * event so the gap is visible.
 *
 * Storage: {ctxRoot}/state/verification-receipts.jsonl — an append-only JSONL
 * ledger, one JSON object per line: {agent, kind, ref, ts}. Append-only (not
 * atomic full-file rewrite) so concurrent multi-agent writes never clobber
 * each other's receipts. Reads tolerate partial/malformed trailing lines.
 *
 * All functions are pure w.r.t. their explicit ctxRoot argument (no ambient
 * process.env reads) so they are trivially unit-testable, and every path is
 * wrapped to fail-open — a broken ledger must NEVER block a send.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { BusPaths } from '../types/index.js';
import { detectsCompletionClaim } from './claim-detector.js';
import { logEvent } from '../bus/event.js';
import { classifyClaim, requiredReceiptKinds } from './claim-classifier.js';
import type { ClaimClass, ClaimRung } from './claim-classifier.js';

export interface VerificationReceipt {
  /** Agent that recorded the verification (CTX_AGENT_NAME). */
  agent: string;
  /** Kind of verification, e.g. 'build', 'curl', 'test', 'tsc'. */
  kind: string;
  /** Free-form reference: a URL, PR link, command, commit, etc. */
  ref: string;
  /** ISO-8601 timestamp of when the verification happened. */
  ts: string;
}

/** Absolute path to the shared receipt ledger for a given ctxRoot. */
export function receiptLedgerPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'verification-receipts.jsonl');
}

/**
 * Append a verification receipt to the shared ledger. `ts` defaults to now
 * (ISO-8601) when omitted. Fail-open: any I/O error is swallowed — recording
 * a receipt is best-effort telemetry and must never break the caller.
 */
export function recordVerificationReceipt(
  ctxRoot: string,
  agent: string,
  receipt: { kind: string; ref: string; ts?: string },
): void {
  try {
    if (!ctxRoot || !agent) return;
    const path = receiptLedgerPath(ctxRoot);
    mkdirSync(dirname(path), { recursive: true });
    const entry: VerificationReceipt = {
      agent,
      kind: receipt.kind,
      ref: receipt.ref,
      ts: receipt.ts ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Best-effort: ledger append failures must not surface to the caller.
  }
}

/**
 * Return whether `agent` has any verification receipt within the last
 * `withinMs` milliseconds. Fail-open: on any read/parse error, returns false
 * (i.e. "no recent receipt") so the guard can warn — never throws.
 */
export function hasRecentReceipt(
  ctxRoot: string,
  agent: string,
  withinMs: number,
): boolean {
  try {
    if (!ctxRoot || !agent) return false;
    const path = receiptLedgerPath(ctxRoot);
    if (!existsSync(path)) return false;

    const cutoff = Date.now() - withinMs;
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n');
    // Scan newest-first; ledgers are append-only so the tail is the most
    // recent activity and an early exit avoids parsing the whole file.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj: Partial<VerificationReceipt>;
      try {
        obj = JSON.parse(line) as Partial<VerificationReceipt>;
      } catch {
        continue; // tolerate a partial/malformed line (e.g. mid-append)
      }
      if (obj.agent !== agent || typeof obj.ts !== 'string') continue;
      const t = Date.parse(obj.ts);
      if (Number.isNaN(t)) continue;
      if (t >= cutoff) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Default lookback window for a "recent" verification receipt (~30 min). */
export const CLAIM_RECEIPT_WINDOW_MS = 30 * 60 * 1000;

/**
 * WARN-ONLY certainty guard for the outbound-comms choke point.
 *
 * If `text` makes a completion claim AND the agent has no verification
 * receipt within `withinMs`, emit a `claim_without_receipt` warning event via
 * logEvent and return true. Otherwise return false. This function is a pure
 * OBSERVER: it never blocks, never delays, never throws (fail-open on any
 * error), and returns only whether a warning was emitted — the caller's send
 * result is entirely independent of this value.
 */
export function emitClaimWithoutReceiptWarning(
  paths: BusPaths,
  ctxRoot: string,
  agentName: string,
  org: string,
  text: string,
  extraMetadata: Record<string, unknown> = {},
  withinMs: number = CLAIM_RECEIPT_WINDOW_MS,
): boolean {
  try {
    if (!detectsCompletionClaim(text)) return false;
    if (hasRecentReceipt(ctxRoot, agentName, withinMs)) return false;
    const snippet = text.length > 200 ? text.slice(0, 200) + '…' : text;
    logEvent(paths, agentName, org, 'message', 'claim_without_receipt', 'warning', {
      ...extraMetadata,
      snippet,
    });
    return true;
  } catch {
    // Fail-open: warn-only telemetry must never affect the send path.
    return false;
  }
}

// ---------------------------------------------------------------------------
// WS2 Tier 2 — graduated claim gate
// ---------------------------------------------------------------------------

/**
 * Check whether the agent has a verification receipt within the window whose
 * `kind` is in the provided `acceptedKinds` set. Thin filter on top of the
 * existing ledger scan. Fail-open: returns false on any error.
 */
export function hasRecentReceiptOfKind(
  ctxRoot: string,
  agent: string,
  acceptedKinds: readonly string[],
  withinMs: number,
): boolean {
  try {
    if (!ctxRoot || !agent || acceptedKinds.length === 0) return false;
    const path = receiptLedgerPath(ctxRoot);
    if (!existsSync(path)) return false;

    const cutoff = Date.now() - withinMs;
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj: Partial<VerificationReceipt>;
      try {
        obj = JSON.parse(line) as Partial<VerificationReceipt>;
      } catch {
        continue;
      }
      if (obj.agent !== agent || typeof obj.ts !== 'string' || typeof obj.kind !== 'string') continue;
      const t = Date.parse(obj.ts);
      if (Number.isNaN(t) || t < cutoff) continue;
      if (acceptedKinds.includes(obj.kind)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Path for the dated claim-gate override marker (banned-prompt style).
 * When this file exists and contains `{"expires": "<ISO date in future>"}`,
 * a block-rung hold is bypassed and logged as an override.
 */
export function claimGateOverridePath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'claim-gate-override.json');
}

/**
 * Returns true if a valid, non-expired gate override marker exists.
 * Fail-open: any parse/read error → returns false (no override).
 */
function hasGateOverride(ctxRoot: string): boolean {
  try {
    const path = claimGateOverridePath(ctxRoot);
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, 'utf-8');
    const obj = JSON.parse(raw) as { expires?: string };
    if (typeof obj.expires !== 'string') return false;
    const exp = Date.parse(obj.expires);
    if (Number.isNaN(exp)) return false;
    return Date.now() < exp;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GateDecision — the verdict returned by evaluateClaimGate
// ---------------------------------------------------------------------------

export type GateDecision =
  | { action: 'allow' }
  | { action: 'warn'; cls: ClaimClass }
  | {
      action: 'hold';
      cls: ClaimClass;
      rung: Exclude<ClaimRung, 'warn'>;
      reason: string;
      requiredKinds: readonly string[];
      hasOverride: boolean;
    };

// ---------------------------------------------------------------------------
// evaluateClaimGate — the single decision function
// ---------------------------------------------------------------------------

/**
 * Evaluate whether an outbound Telegram message should be allowed, warned, or
 * held (blocked) based on the claim gate configuration.
 *
 * Decision matrix:
 *  - not isOwnerChat              → allow (agent↔agent traffic never gated)
 *  - CTX_CLAIM_GATE=off           → allow
 *  - no claim detected            → allow
 *  - generic claim                → warn (today's behaviour, unchanged)
 *  - high-stakes, receipt present → allow
 *  - require-confirm, confirmFlag → allow (logged as override)
 *  - block, override marker       → allow (logged as override)
 *  - otherwise                    → hold
 *
 * Fail-open invariant: on ANY internal error, returns `{action:'allow'}`.
 * A broken gate must never wedge outbound comms.
 */
export function evaluateClaimGate(opts: {
  ctxRoot: string;
  agent: string;
  org: string;
  paths: BusPaths;
  text: string;
  isOwnerChat: boolean;
  confirmFlag: boolean;
  gateMode: 'off' | 'warn' | 'enforce';
  withinMs?: number;
}): GateDecision {
  try {
    const {
      ctxRoot, agent, org, paths, text, isOwnerChat, confirmFlag, gateMode,
      withinMs = CLAIM_RECEIPT_WINDOW_MS,
    } = opts;

    // Gate kill-switch or non-owner chat → always allow
    if (gateMode === 'off' || !isOwnerChat) return { action: 'allow' };

    // Classify the claim
    const classification = classifyClaim(text);
    if (!classification) return { action: 'allow' };

    const { cls, rung } = classification;

    // Generic claim — delegate to existing warn-only path
    if (rung === 'warn') return { action: 'warn', cls };

    // In warn mode (default), even high-stakes claims only warn, never hold.
    if (gateMode === 'warn') return { action: 'warn', cls };

    // --- enforce mode below ---

    const requiredKinds = requiredReceiptKinds(cls);

    // Receipt present → allow regardless of rung
    if (hasRecentReceiptOfKind(ctxRoot, agent, requiredKinds, withinMs)) {
      return { action: 'allow' };
    }

    // require-confirm rung: --confirm-claim flag is an accepted bypass
    if (rung === 'require-confirm' && confirmFlag) {
      // Log the explicit override so the gap is auditable
      try {
        logEvent(
          paths, agent, org, 'message', 'claim_confirmed_override', 'warning',
          { cls, rung, snippet: text.slice(0, 200) },
        );
      } catch { /* non-fatal */ }
      return { action: 'allow' };
    }

    // block rung: only a dated override marker bypasses it
    if (rung === 'block') {
      if (hasGateOverride(ctxRoot)) {
        try {
          logEvent(
            paths, agent, org, 'message', 'claim_gate_override_used', 'warning',
            { cls, rung, snippet: text.slice(0, 200) },
          );
        } catch { /* non-fatal */ }
        return { action: 'allow' };
      }
    }

    // No bypass found — hold the send
    const reasonMap: Record<Exclude<ClaimRung, 'warn'>, string> = {
      'require-confirm':
        `Message contains a "${cls}" claim (e.g. deployed/merged) with no verification receipt in the last ` +
        `${Math.round(withinMs / 60000)}m. Record a receipt first: bus verify-receipt --kind ${requiredKinds[0] ?? cls} --ref <url|commit|note>. ` +
        `Or re-run with --confirm-claim to assert you verified off-ledger.`,
      'block':
        `Message contains an "${cls}" claim (e.g. sent to client/invoice sent) with no verification receipt. ` +
        `Record a receipt first: bus verify-receipt --kind ${requiredKinds[0] ?? cls} --ref <note>. ` +
        `To force-override, create state/claim-gate-override.json with {"expires":"<future ISO date>"}.`,
    };

    return {
      action: 'hold',
      cls,
      rung,
      reason: reasonMap[rung],
      requiredKinds,
      hasOverride: false,
    };
  } catch {
    // Fail-open: a broken gate must never wedge comms.
    return { action: 'allow' };
  }
}
