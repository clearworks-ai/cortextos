import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteSync } from '../utils/atomic.js';

/**
 * KB ingest receipts — fail-loud accounting for every `bus kb-ingest` run.
 *
 * Motivation (live incident): the kb-ingest cron reported exit 0 for 7/7
 * runs while the underlying mmrag.py child was being killed by ETIMEDOUT.
 * Nothing on disk recorded what actually happened, so "success" was
 * indistinguishable from "the child never finished". Every ingest run now
 * writes a receipt with real counts, the real exit code, and a status that
 * monitoring can gate on (errored>0 OR receipt older than 36h = RED line,
 * never a silent skip).
 */

export interface KBIngestReceipt {
  run_at: string;
  collection: string;
  added: number | null;
  updated: number | null;
  skipped: number | null;
  errored: number | null;
  duration_ms: number;
  exit_code: number;
  status: 'ok' | 'error' | 'timeout';
  error?: string;
}

/** Partial counts parsed out of the mmrag.py stdout receipt line. */
export interface KBIngestCounts {
  added: number | null;
  updated: number | null;
  skipped: number | null;
  errored: number | null;
}

const RECEIPT_LINE_PREFIX = 'MMRAG_INGEST_RECEIPT ';

function kbStateDir(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId, 'state', 'kb');
}

/** Path of the latest-receipt file (single JSON object, atomically replaced). */
export function lastKBIngestReceiptPath(instanceId: string): string {
  return join(kbStateDir(instanceId), 'last-ingest-receipt.json');
}

/** Path of the append-only receipt history (one JSON object per line). */
export function kbIngestReceiptsLogPath(instanceId: string): string {
  return join(kbStateDir(instanceId), 'ingest-receipts.jsonl');
}

function toCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Scan captured mmrag.py stdout for the LAST line starting with
 * `MMRAG_INGEST_RECEIPT ` and JSON.parse the remainder into counts.
 *
 * Tolerant by design: returns null when the line is absent or its JSON is
 * malformed — callers then record null counts rather than fabricating
 * numbers. A missing receipt line must never turn a completed run into a
 * failure; only real child exit codes / timeouts do that.
 */
export function parseMmragReceiptLine(stdout: string): KBIngestCounts | null {
  if (!stdout) return null;
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith(RECEIPT_LINE_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(RECEIPT_LINE_PREFIX.length)) as Record<string, unknown>;
      return {
        added: toCount(parsed.added),
        updated: toCount(parsed.updated),
        skipped: toCount(parsed.skipped),
        errored: toCount(parsed.errored),
      };
    } catch {
      // The LAST receipt line is authoritative; if it is malformed we do not
      // fall back to older lines from earlier (possibly stale) output.
      return null;
    }
  }
  return null;
}

/**
 * Persist a receipt: atomically replace `state/kb/last-ingest-receipt.json`
 * and append one JSON line to `state/kb/ingest-receipts.jsonl`.
 */
export function writeKBIngestReceipt(
  instanceId: string,
  org: string,
  receipt: KBIngestReceipt,
): void {
  const dir = kbStateDir(instanceId);
  mkdirSync(dir, { recursive: true });
  const record = { org, ...receipt };
  atomicWriteSync(lastKBIngestReceiptPath(instanceId), JSON.stringify(record, null, 2));
  appendFileSync(kbIngestReceiptsLogPath(instanceId), JSON.stringify(record) + '\n', 'utf-8');
}

/**
 * Read the most recent receipt, or null when none exists / it is unreadable.
 */
export function readLastKBIngestReceipt(instanceId: string): KBIngestReceipt | null {
  const path = lastKBIngestReceiptPath(instanceId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as KBIngestReceipt;
  } catch {
    return null;
  }
}
