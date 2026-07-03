import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from './atomic.js';

/**
 * Verify-receipt store.
 *
 * A verify-receipt is machine-recorded proof that a verification command was
 * actually run (and exited 0) before an agent claims something is live /
 * fixed / deployed over Telegram. Receipts live at
 * `<ctxRoot>/state/<agent>/verify-receipts/<epochms>-<slug(target)>.json`
 * and expire after DEFAULT_RECEIPT_MAX_AGE_MS (15 minutes) — a stale check
 * is not proof of the current state.
 *
 * Consumed by src/utils/send-telegram-validator.ts (the claim gate) and
 * written by `cortextos bus verify-receipt` in src/cli/bus.ts.
 */

export type VerifyReceiptKind = 'deploy' | 'url' | 'log' | 'generic';

export const VERIFY_RECEIPT_KINDS: readonly VerifyReceiptKind[] = [
  'deploy',
  'url',
  'log',
  'generic',
] as const;

export interface VerifyReceipt {
  kind: VerifyReceiptKind;
  /** URL, artifact path, or claim subject the verification targeted. */
  target: string;
  /** The command that was executed to verify. */
  command: string;
  /** Captured command output, truncated to MAX_OUTPUT_BYTES. */
  output: string;
  /** ISO timestamp of when the verification ran. */
  created_at: string;
}

export interface FindFreshReceiptOpts {
  kind?: VerifyReceiptKind;
  target?: string;
  /** Maximum receipt age in milliseconds. Default: 15 minutes. */
  maxAgeMs?: number;
}

/** Receipts older than this are not proof of anything. */
export const DEFAULT_RECEIPT_MAX_AGE_MS = 15 * 60_000;

/** Command output stored on a receipt is capped at 2KB. */
export const MAX_OUTPUT_BYTES = 2048;

export function verifyReceiptsDir(ctxRoot: string, agentName: string): string {
  return join(ctxRoot, 'state', agentName, 'verify-receipts');
}

function slugify(target: string): string {
  const slug = target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'receipt';
}

function isVerifyReceipt(value: unknown): value is VerifyReceipt {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.kind === 'string' &&
    (VERIFY_RECEIPT_KINDS as readonly string[]).includes(r.kind) &&
    typeof r.target === 'string' &&
    typeof r.command === 'string' &&
    typeof r.output === 'string' &&
    typeof r.created_at === 'string'
  );
}

/**
 * Persist a verify-receipt atomically. Output is truncated to 2KB.
 * Returns the absolute path of the written receipt file.
 */
export function writeVerifyReceipt(
  ctxRoot: string,
  agentName: string,
  receipt: VerifyReceipt
): string {
  const stored: VerifyReceipt = {
    ...receipt,
    output: receipt.output.slice(0, MAX_OUTPUT_BYTES),
  };
  const epochMs = Date.parse(receipt.created_at);
  const stamp = Number.isFinite(epochMs) ? epochMs : Date.now();
  const filePath = join(
    verifyReceiptsDir(ctxRoot, agentName),
    `${stamp}-${slugify(receipt.target)}.json`
  );
  atomicWriteSync(filePath, JSON.stringify(stored, null, 2));
  return filePath;
}

/**
 * Return the newest non-expired receipt matching the filters, or null.
 *
 * - `maxAgeMs` defaults to 15 minutes.
 * - `kind` filters by receipt kind.
 * - `target` requires an exact match. For kind:'url' the target MUST be the
 *   exact URL that was verified — a receipt for a different URL is not proof.
 */
export function findFreshReceipt(
  ctxRoot: string,
  agentName: string,
  opts: FindFreshReceiptOpts = {}
): VerifyReceipt | null {
  const dir = verifyReceiptsDir(ctxRoot, agentName);
  if (!existsSync(dir)) return null;

  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RECEIPT_MAX_AGE_MS;
  const now = Date.now();

  let newest: VerifyReceipt | null = null;
  let newestTs = -1;

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
    } catch {
      continue; // Malformed receipts are simply not proof.
    }
    if (!isVerifyReceipt(parsed)) continue;

    const ts = Date.parse(parsed.created_at);
    if (!Number.isFinite(ts)) continue;
    if (now - ts > maxAgeMs) continue; // Expired.

    if (opts.kind !== undefined && parsed.kind !== opts.kind) continue;
    if (opts.target !== undefined && parsed.target !== opts.target) continue;

    if (ts > newestTs) {
      newestTs = ts;
      newest = parsed;
    }
  }

  return newest;
}
