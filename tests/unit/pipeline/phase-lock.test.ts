import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkPhaseSequence,
  defaultPhaseLockPath,
  extractPhase,
  readPhaseLock,
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

    it('does NOT satisfy a phase via completed_phases (override removed 2026-08-03)', () => {
      // A hand-written or legacy completed_phases entry must not count — the only
      // satisfaction is a real p<M>- true-verify row.
      writeFileSync(lockPath, JSON.stringify({ completed_phases: [1] }));
      const result = checkPhaseSequence({ slug: 'p2-foo', rows: [], lockPath });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected block');
      expect(result.code).toBe('PHASE_SKIPPED');
      expect(result.detail).toContain('NO override');
      expect(result.detail).not.toContain('--mark-phase-complete');
    });

    it('blocks the correct unsatisfied phase in a mixed scenario (ledger-only)', () => {
      // p1 satisfied via ledger, p2/p3 have no true-verify rows → dispatch p4 blocks on 2,3.
      const result = checkPhaseSequence({
        slug: 'p4-x',
        rows: [row('p1-x', 'true-verify'), row('p3-x', 'review')],
        lockPath,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected block');
      expect(result.code).toBe('PHASE_SKIPPED');
      expect(result.detail).toContain('2, 3');
      expect(result.detail).not.toContain('phase(s) 1');
      expect(result.detail).toContain('p4-x');
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

  // The markPhaseComplete describe block was removed 2026-08-03 alongside the
  // function it tested — phase completion is now earned only by a true-verify
  // ledger row (covered by the checkPhaseSequence tests above).
});
