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
