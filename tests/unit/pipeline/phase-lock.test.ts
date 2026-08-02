import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkPhaseSequence,
  defaultPhaseLockPath,
  extractPhase,
  markPhaseComplete,
  readPhaseLock,
  type PhaseLockState,
} from '../../../src/pipeline/phase-lock';
import type { LedgerRow, Stage } from '../../../src/pipeline/ledger';

function row(slug: string, stage: Stage): LedgerRow {
  return {
    slug,
    stage,
    ts: 1_785_700_000,
    artifact_sha256: 'a'.repeat(64),
    prev_sha256: '',
    sig: 'dummy-sig',
  };
}

describe('phase-lock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phase-lock-'));
    lockPath = join(dir, 'build-phase-lock.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('extractPhase', () => {
    it('parses single-digit phase prefixes', () => {
      expect(extractPhase('p5-cron-kills')).toBe(5);
      expect(extractPhase('p4-3-approval-multica-sync')).toBe(4);
      expect(extractPhase('p1-1-kb-reconcile-cron')).toBe(1);
    });

    it('returns null for non-phase slugs', () => {
      expect(extractPhase('task-bus-verify-escalate')).toBeNull();
      expect(extractPhase('p0-x')).toBeNull();
      expect(extractPhase('p10-x')).toBeNull(); // regex is single-digit 1-9
      expect(extractPhase('phase-sequencing-gate')).toBeNull(); // no false positive on 'p' word
    });
  });

  describe('defaultPhaseLockPath', () => {
    it('places the lock next to the ledger', () => {
      expect(defaultPhaseLockPath('/x/state/pipeline-ledger.jsonl')).toBe(
        '/x/state/build-phase-lock.json',
      );
    });
  });

  describe('checkPhaseSequence', () => {
    it('passes when a lower phase is satisfied via a true-verify ledger row', () => {
      const result = checkPhaseSequence({
        slug: 'p2-foo',
        rows: [row('p1-1-kb-reconcile-cron', 'true-verify')],
        lockPath,
      });
      expect(result.ok).toBe(true);
    });

    it('passes when a lower phase is satisfied via completed_phases', () => {
      writeFileSync(lockPath, JSON.stringify({ completed_phases: [1] }));
      const result = checkPhaseSequence({ slug: 'p2-foo', rows: [], lockPath });
      expect(result.ok).toBe(true);
    });

    it('blocks the correct unsatisfied phase in a mixed scenario', () => {
      // p1 via ledger, p2 via lock, p3 missing → dispatch p4 blocks on 3 only
      writeFileSync(lockPath, JSON.stringify({ completed_phases: [2] }));
      const result = checkPhaseSequence({
        slug: 'p4-x',
        rows: [row('p1-x', 'true-verify')],
        lockPath,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected block');
      expect(result.code).toBe('PHASE_SKIPPED');
      expect(result.detail).toContain('3');
      expect(result.detail).not.toContain('phase(s) 1');
      expect(result.detail).toContain('p4-x');
      expect(result.detail).toContain('--mark-phase-complete');
    });

    it('does not count exempt or review stage rows as satisfying a phase', () => {
      const result = checkPhaseSequence({
        slug: 'p2-foo',
        rows: [row('p1-x', 'exempt'), row('p1-y', 'review')],
        lockPath,
      });
      expect(result.ok).toBe(false);
    });

    it('passes through non-phase slugs without touching lock or rows', () => {
      const result = checkPhaseSequence({
        slug: 'task-bus-verify-escalate',
        rows: [],
        lockPath,
      });
      expect(result.ok).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('passes phase 1 with no lower phases', () => {
      const result = checkPhaseSequence({ slug: 'p1-anything', rows: [], lockPath });
      expect(result.ok).toBe(true);
    });

    it('treats a missing lock file as the default state', () => {
      const result = checkPhaseSequence({ slug: 'p2-foo', rows: [], lockPath });
      expect(result.ok).toBe(false);
    });

    it('treats a corrupt lock file as the default state without throwing', () => {
      writeFileSync(lockPath, 'not-json');
      const result = checkPhaseSequence({ slug: 'p2-foo', rows: [], lockPath });
      expect(result.ok).toBe(false);
    });
  });

  describe('readPhaseLock', () => {
    it('returns the default when the file is missing', () => {
      expect(readPhaseLock(lockPath)).toEqual({
        current_phase: 1,
        completed_phases: [],
        history: [],
      });
    });

    it('returns the default on corrupt JSON', () => {
      writeFileSync(lockPath, '{{{');
      expect(readPhaseLock(lockPath)).toEqual({
        current_phase: 1,
        completed_phases: [],
        history: [],
      });
    });

    it('sanitizes out-of-range and duplicate completed_phases', () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ completed_phases: [2, 2, 0, 10, 1, 'x'], current_phase: 3, history: [] }),
      );
      const state = readPhaseLock(lockPath);
      expect(state.completed_phases).toEqual([1, 2]);
    });
  });

  describe('markPhaseComplete', () => {
    it('round-trips, is idempotent, and grows history', () => {
      markPhaseComplete({ phase: 1, by: 'larry', lockPath, nowSeconds: 100 });
      let state = markPhaseComplete({ phase: 2, by: 'larry', lockPath, nowSeconds: 200 });
      expect(state.completed_phases).toEqual([1, 2]);
      expect(state.current_phase).toBe(3);
      expect(state.history).toHaveLength(2);
      expect(state.history.every((h) => h.by === 'larry')).toBe(true);

      const onDisk = JSON.parse(readFileSync(lockPath, 'utf-8')) as PhaseLockState;
      expect(onDisk.completed_phases).toEqual([1, 2]);
      expect(onDisk.current_phase).toBe(3);

      // re-mark 1 → completed_phases unchanged, history grows to 3
      state = markPhaseComplete({ phase: 1, by: 'larry', lockPath, nowSeconds: 300 });
      expect(state.completed_phases).toEqual([1, 2]);
      expect(state.history).toHaveLength(3);
    });

    it('throws on invalid phase args', () => {
      expect(() => markPhaseComplete({ phase: 0, by: 'x', lockPath })).toThrow(/Invalid/);
      expect(() => markPhaseComplete({ phase: 10, by: 'x', lockPath })).toThrow(/Invalid/);
      expect(() => markPhaseComplete({ phase: 1.5, by: 'x', lockPath })).toThrow(/Invalid/);
      expect(() => markPhaseComplete({ phase: NaN, by: 'x', lockPath })).toThrow(/Invalid/);
    });

    it('survives two sequential marks from separate reads (lock dir used)', () => {
      markPhaseComplete({ phase: 3, by: 'a', lockPath, nowSeconds: 1 });
      const state = markPhaseComplete({ phase: 4, by: 'b', lockPath, nowSeconds: 2 });
      expect(state.completed_phases).toEqual([3, 4]);
      // lock dir was used (created) and the mutex (.lock.d) released cleanly
      expect(existsSync(join(dir, '.locks', 'build-phase-lock'))).toBe(true);
      expect(existsSync(join(dir, '.locks', 'build-phase-lock', '.lock.d'))).toBe(false);
    });
  });
});
