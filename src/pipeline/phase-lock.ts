import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { LedgerRow } from './ledger.js';
import { atomicWriteSync } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

export interface PhaseHistoryEntry {
  phase: number;
  markedAt: number;
  by: string;
}

export interface PhaseLockState {
  current_phase: number;
  completed_phases: number[];
  history: PhaseHistoryEntry[];
}

export type PhaseCheckResult =
  | { ok: true }
  | { ok: false; code: 'PHASE_SKIPPED'; detail: string };

const PHASE_PREFIX_RE = /^p([1-9])-/;

function defaultState(): PhaseLockState {
  return { current_phase: 1, completed_phases: [], history: [] };
}

/**
 * Extract the build-phase number from a slug of the form `p<N>-...` where N is a
 * single digit 1-9. Returns null for any slug without that exact prefix.
 */
export function extractPhase(slug: string): number | null {
  const match = PHASE_PREFIX_RE.exec(slug);
  return match ? Number(match[1]) : null;
}

/**
 * Location of the phase-lock file: next to the ledger it guards. Taking the ledger
 * path (not a project root) means overriding `--ledger` in tests relocates the lock
 * file with it.
 */
export function defaultPhaseLockPath(ledgerPath: string): string {
  return join(dirname(resolve(ledgerPath)), 'build-phase-lock.json');
}

function sanitizeCompletedPhases(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 1 && entry <= 9) {
      seen.add(entry);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

function sanitizeHistory(value: unknown): PhaseHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PhaseHistoryEntry[] = [];
  for (const entry of value) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as PhaseHistoryEntry).phase === 'number' &&
      typeof (entry as PhaseHistoryEntry).markedAt === 'number' &&
      typeof (entry as PhaseHistoryEntry).by === 'string'
    ) {
      const e = entry as PhaseHistoryEntry;
      out.push({ phase: e.phase, markedAt: e.markedAt, by: e.by });
    }
  }
  return out;
}

/**
 * Read + parse the phase-lock file. On ANY failure (missing, unreadable,
 * unparseable, non-object) returns the fail-open default state. Never throws — it
 * runs inside main()'s uncaught `--verify` branch. Happy-path fields are sanitized.
 */
export function readPhaseLock(lockPath: string): PhaseLockState {
  try {
    if (!existsSync(lockPath)) return defaultState();
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaultState();
    }
    const obj = parsed as Record<string, unknown>;
    const completed_phases = sanitizeCompletedPhases(obj.completed_phases);
    const history = sanitizeHistory(obj.history);
    const rawCurrent = obj.current_phase;
    const current_phase =
      typeof rawCurrent === 'number' && Number.isInteger(rawCurrent) && rawCurrent >= 1
        ? rawCurrent
        : 1;
    return { current_phase, completed_phases, history };
  } catch {
    return defaultState();
  }
}

/**
 * Gate a `p<N>-` build dispatch against every lower phase M (1..N-1). Phase M is
 * satisfied iff it is listed in completed_phases OR at least one `true-verify`
 * ledger row has a slug prefixed `p<M>-`. No signature verification on rows (locked
 * design decision — this is a sequencing safety net, not a forgery defense; the
 * dispatched slug's own chain is signature-verified elsewhere). `exempt` rows do not
 * count. Never throws.
 */
export function checkPhaseSequence(opts: {
  slug: string;
  rows: LedgerRow[];
  lockPath: string;
}): PhaseCheckResult {
  const n = extractPhase(opts.slug);
  if (n === null) return { ok: true };
  if (n === 1) return { ok: true };

  const lock = readPhaseLock(opts.lockPath);
  const unsatisfied: number[] = [];
  for (let m = 1; m < n; m++) {
    const satisfied =
      lock.completed_phases.includes(m) ||
      opts.rows.some((r) => r.stage === 'true-verify' && r.slug.startsWith(`p${m}-`));
    if (!satisfied) unsatisfied.push(m);
  }

  if (unsatisfied.length === 0) return { ok: true };

  const list = unsatisfied.join(', ');
  const detail =
    `cannot dispatch phase ${n} build '${opts.slug}' — phase(s) ${list} unsatisfied: ` +
    `no true-verify ledger row with slug prefix 'p<M>-' and not listed in ` +
    `completed_phases (${opts.lockPath}). If a phase legitimately shipped outside ` +
    `the ledger, run: pipeline-stage-emit --mark-phase-complete <M> --by <agent>`;
  return { ok: false, code: 'PHASE_SKIPPED', detail };
}

/**
 * Mark a phase complete. Read-modify-write under a file lock (RMW is not atomic via
 * atomicWriteSync alone). Idempotent on completed_phases (dedupe + sort) but always
 * appends a history entry. Throws on a non-integer / out-of-range phase — the `Invalid `
 * prefix is mapped to exit 5 by the CLI.
 */
export function markPhaseComplete(opts: {
  phase: number;
  by: string;
  lockPath: string;
  nowSeconds?: number;
}): PhaseLockState {
  if (!Number.isInteger(opts.phase) || opts.phase < 1 || opts.phase > 9) {
    throw new Error('Invalid --mark-phase-complete: expected integer 1-9');
  }

  const lockDir = join(dirname(opts.lockPath), '.locks', 'build-phase-lock');
  mkdirSync(lockDir, { recursive: true });

  return withFileLockSync(lockDir, () => {
    const state = readPhaseLock(opts.lockPath);
    const completed = new Set(state.completed_phases);
    completed.add(opts.phase);
    const completed_phases = [...completed].sort((a, b) => a - b);
    const markedAt = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    const history = [...state.history, { phase: opts.phase, markedAt, by: opts.by }];
    const next: PhaseLockState = {
      current_phase: Math.max(...completed_phases) + 1,
      completed_phases,
      history,
    };
    atomicWriteSync(opts.lockPath, JSON.stringify(next, null, 2));
    return next;
  });
}
