/**
 * activity-ledger.ts — Correlated did-vs-claimed activity ledger (WS10 / R6).
 *
 * Agents repeatedly claim actions ("fix is live", "cron installed") that were
 * never verified against reality. This ledger records every claimed action
 * alongside its verification evidence (the command run and an output excerpt)
 * so `correlate()` can produce a machine-readable report of claims that have
 * no backing verification.
 *
 * Storage: append-only JSONL at {ctxRoot}/state/activity-ledger.jsonl.
 * Appends are serialized with the shared mkdir-mutex (utils/lock.ts) so two
 * concurrent writers cannot interleave partial lines.
 *
 * The type is intentionally co-located here (not in src/types/index.ts) to
 * keep this workstream's surface self-contained.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { withFileLockSync } from '../utils/lock.js';

export interface ActivityLedgerEntry {
  /** ISO 8601 UTC timestamp of the claim. */
  ts: string;
  /** Agent making the claim. */
  agent: string;
  /** What the agent says it did. */
  claimed_action: string;
  /** Verification evidence, or null when the claim was never checked. */
  verification: {
    command: string;
    output_excerpt: string;
    checked_at: string;
  } | null;
  /** True only when verification ran and confirmed the claim. */
  verified: boolean;
  /** Correlation id linking related claims/checks across entries. */
  correlation_id: string;
}

export interface ReadLedgerOptions {
  /** Only entries from this agent. */
  agent?: string;
  /** Only entries with ts >= since (ISO 8601 string, lexicographic-safe). */
  since?: string;
  /** Return at most this many entries (most-recent last, tail of the file). */
  limit?: number;
}

export interface CorrelateReport {
  /** Entries claimed but never verified (verified=false or verification=null). */
  claimed_unverified: ActivityLedgerEntry[];
  /** Count of entries whose claims are verified. */
  verified: number;
}

function ledgerPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'activity-ledger.jsonl');
}

function ledgerDir(ctxRoot: string): string {
  return join(ctxRoot, 'state');
}

/**
 * Append one entry as a single JSONL line, under the per-directory lock.
 */
export function appendLedgerEntry(ctxRoot: string, entry: ActivityLedgerEntry): void {
  const dir = ledgerDir(ctxRoot);
  mkdirSync(dir, { recursive: true });
  withFileLockSync(dir, () => {
    appendFileSync(ledgerPath(ctxRoot), JSON.stringify(entry) + '\n', 'utf-8');
  });
}

/**
 * Read ledger entries, oldest first. Missing file returns [].
 * Malformed JSONL lines are silently skipped (append-only files can carry a
 * torn final line after a crash — never let that poison the whole read).
 */
export function readLedger(
  ctxRoot: string,
  opts: ReadLedgerOptions = {}
): ActivityLedgerEntry[] {
  const path = ledgerPath(ctxRoot);
  if (!existsSync(path)) {
    return [];
  }

  const lines = readFileSync(path, 'utf-8').split('\n');
  let entries: ActivityLedgerEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as ActivityLedgerEntry).ts === 'string' &&
        typeof (parsed as ActivityLedgerEntry).agent === 'string' &&
        typeof (parsed as ActivityLedgerEntry).claimed_action === 'string'
      ) {
        entries.push(parsed as ActivityLedgerEntry);
      }
    } catch {
      // Skip torn/corrupt lines.
    }
  }

  if (opts.agent !== undefined) {
    entries = entries.filter(e => e.agent === opts.agent);
  }
  if (opts.since !== undefined) {
    const since = opts.since;
    entries = entries.filter(e => e.ts >= since);
  }
  if (opts.limit !== undefined && opts.limit >= 0) {
    entries = entries.slice(-opts.limit);
  }

  return entries;
}

/**
 * The machine-readable did-vs-claimed report: every claim without backing
 * verification, plus a count of the verified ones.
 */
export function correlate(ctxRoot: string): CorrelateReport {
  const entries = readLedger(ctxRoot);
  const claimed_unverified = entries.filter(
    e => e.verified === false || e.verification === null
  );
  const verified = entries.length - claimed_unverified.length;
  return { claimed_unverified, verified };
}
