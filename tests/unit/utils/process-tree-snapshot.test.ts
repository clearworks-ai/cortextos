import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'child_process';
import {
  snapshotDescendants,
  killSnapshotSurvivors,
  type ProcessSnapshotEntry,
} from '../../../src/utils/process-tree.js';

/** Real (non-mocked) liveness probe, for the real-OS verification test below. */
function isRealPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * WHY THIS FILE EXISTS — the knox-codex incident, 2026-09-08.
 *
 * AgentProcess.stop() signalled ONLY the direct PTY child. For the
 * codex-app-server runtime that child spawns an inner `codex app-server` of its
 * own, and that grandchild survived every stop: it reparented to launchd
 * (ppid=1) and went on writing the agent's heartbeat.json, thread file and
 * inbox — and went on emitting billable turns — while the daemon believed the
 * agent had been replaced. Two restarts failed to displace it.
 *
 * THE ORDERING IS THE WHOLE POINT. A descendant walk rooted at the child is
 * worthless AFTER the child dies: the kernel has already reparented the
 * survivors to pid 1, so the walk returns nothing and the sweep is a no-op on
 * exactly the process it exists to kill. The snapshot must be taken while the
 * parent is still alive; the kill happens afterwards, against that recorded set.
 *
 * These tests pin both halves: snapshotDescendants() records the set (with
 * command lines), killSnapshotSurvivors() kills only what is still alive AND
 * still the same program — never a recycled pid.
 */

const table = (rows: Array<[number, number, string]>): ProcessSnapshotEntry[] =>
  rows.map(([pid, ppid, command]) => ({ pid, ppid, command }));

describe('snapshotDescendants', () => {
  it('records the transitive descendant set with command lines, excluding the roots', () => {
    const t = table([
      [1, 0, '/sbin/launchd'],
      [100, 1, 'pty-host-entry'],
      [200, 100, 'codex app-server --enable goals'],
      [300, 200, 'codex app-server (inner)'],
      [400, 999, 'unrelated process'],
    ]);

    const snap = snapshotDescendants([200], t);

    expect(snap).toEqual([{ pid: 300, ppid: 200, command: 'codex app-server (inner)' }]);
  });

  it('walks more than one level deep', () => {
    const t = table([
      [200, 100, 'parent'],
      [300, 200, 'child'],
      [400, 300, 'grandchild'],
      [500, 400, 'great-grandchild'],
    ]);

    expect(snapshotDescendants([200], t).map(e => e.pid)).toEqual([300, 400, 500]);
  });

  it('returns an empty set for a childless root', () => {
    expect(snapshotDescendants([200], table([[200, 100, 'lonely']]))).toEqual([]);
  });
});

describe('killSnapshotSurvivors', () => {
  it('kills a survivor that is still alive and still the same program, and confirms it absent', () => {
    // The knox case: the recorded grandchild outlived its parent and has been
    // reparented to launchd. Its ppid changed; its identity did not.
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);
    const after = table([[300, 1, 'codex app-server (inner)']]);

    const killFn = vi.fn();
    // verifyTable: [] — the post-kill re-read confirms pid 300 is actually gone.
    const result = killSnapshotSurvivors(snapshot, { table: after, verifyTable: [], killFn });

    expect(result.signalled).toEqual([300]);
    expect(killFn).toHaveBeenCalledWith(300, 'SIGKILL');
    expect(result.confirmedAbsent).toEqual(snapshot);
    expect(result.unresolved).toEqual([]);
  });

  it('reports a signalled survivor as unresolved, never confirmed-absent, when it is still present after the kill', () => {
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);
    const after = table([[300, 1, 'codex app-server (inner)']]);

    const killFn = vi.fn();
    // verifyTable still has pid 300 — signalled but not (yet) reaped, or unkillable.
    const result = killSnapshotSurvivors(snapshot, { table: after, verifyTable: after, killFn });

    expect(result.signalled).toEqual([300]);
    expect(result.confirmedAbsent).toEqual([]);
    expect(result.unresolved).toEqual([
      { entry: snapshot[0], reason: expect.stringContaining('still present') },
    ]);
  });

  it('treats an unreliable (empty, non-injected) post-kill verification read as unresolved, never as proof of absence', () => {
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);
    const after = table([[300, 1, 'codex app-server (inner)']]);
    const killFn = vi.fn();

    // No verifyTable injected AND readProcessSnapshot() is unavailable on
    // this platform/CI shell — simulate via mocking execSync to fail is out
    // of scope here; instead assert the documented contract directly by
    // injecting an explicitly empty verifyTable is NOT the same code path as
    // "no verifyTable given" — this test exercises the real fallback by
    // temporarily stubbing process.platform to the win32 no-op path, which
    // makes the internal readProcessSnapshot() deterministically return [].
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const result = killSnapshotSurvivors(snapshot, { table: after, killFn });
      expect(result.signalled).toEqual([300]);
      expect(result.confirmedAbsent).toEqual([]);
      expect(result.unresolved).toEqual([
        { entry: snapshot[0], reason: expect.stringContaining('verification read unavailable') },
      ]);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('SKIPS a recycled pid whose command no longer matches', () => {
    // Up to ~21s can elapse between snapshot and sweep. If the OS handed that
    // pid to something else in the meantime, killing it would murder an
    // unrelated process. Identity, not liveness, is the guard.
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);
    const after = table([[300, 1, '/usr/bin/somebody-elses-program']]);

    const killFn = vi.fn();
    const result = killSnapshotSurvivors(snapshot, { table: after, killFn });

    expect(result.signalled).toEqual([]);
    expect(result.recycled).toEqual(snapshot);
    expect(result.confirmedAbsent).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('skips pids that already exited cleanly', () => {
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);

    const killFn = vi.fn();
    const result = killSnapshotSurvivors(snapshot, { table: [], killFn });

    expect(result.signalled).toEqual([]);
    expect(result.alreadyGone).toEqual(snapshot);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('never signals pid <= 1 or the daemon itself', () => {
    const snapshot = table([
      [1, 0, 'launchd'],
      [0, 0, 'kernel'],
      [process.pid, 1, 'the daemon'],
    ]);
    const after = snapshot;

    const killFn = vi.fn();
    const result = killSnapshotSurvivors(snapshot, { table: after, killFn });

    expect(result.signalled).toEqual([]);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('swallows ESRCH from the kill itself as already-gone, and reports EPERM/unexpected failures as unresolved', () => {
    const snapshot = table([
      [300, 200, 'a'],
      [301, 200, 'b'],
      [302, 200, 'c'],
    ]);
    const killFn = vi.fn((pid: number) => {
      if (pid === 300) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      if (pid === 302) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    // verifyTable: [] confirms the one real kill (301) actually died.
    const result = killSnapshotSurvivors(snapshot, { table: snapshot, verifyTable: [], killFn });

    expect(result.signalled).toEqual([301]);
    expect(result.confirmedAbsent).toEqual([snapshot[1]]);
    expect(result.alreadyGone).toEqual([snapshot[0]]);
    expect(result.unresolved).toEqual([
      { entry: snapshot[2], reason: expect.stringContaining('EPERM') },
    ]);
  });

  it('logs a single line naming what it swept, for post-incident audit', () => {
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);
    const log = vi.fn();

    killSnapshotSurvivors(snapshot, { table: snapshot, verifyTable: [], killFn: vi.fn(), log });

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('300');
  });

  it('says nothing when there was nothing to sweep', () => {
    const log = vi.fn();
    killSnapshotSurvivors([], { table: [], killFn: vi.fn(), log });
    expect(log).not.toHaveBeenCalled();
  });
});

/**
 * Task 2.6, PHASES.md's explicit "required, not optional" real-OS case:
 * mocks alone cannot prove a real SIGKILL actually lands and a real `ps`
 * read actually confirms absence. This spawns a genuine parent + grandchild
 * (mirroring the daemon -> pty-child -> inner-child shape), snapshots and
 * sweeps them with NO injected table/killFn/verifyTable anywhere, and
 * verifies against the real process table — then confirms nothing from this
 * test's own fixture is left running.
 */
describe('killSnapshotSurvivors — real OS verification (required, not optional)', () => {
  it('SIGKILLs a real spawned grandchild and confirms its absence via a genuine ps read, leaking nothing', async () => {
    const parent = spawn('sh', ['-c', 'sleep 60 & wait'], { stdio: 'ignore' });
    const parentPid = parent.pid;
    expect(typeof parentPid).toBe('number');

    try {
      // Let the shell actually fork+exec its backgrounded `sleep` grandchild
      // before we snapshot — the snapshot must be taken while the tree is
      // fully alive, per this module's whole reason for existing.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const snapshot = snapshotDescendants([parentPid as number]);
      expect(snapshot.length).toBeGreaterThan(0);
      const grandchildPid = snapshot[0].pid;
      expect(isRealPidAlive(grandchildPid)).toBe(true);

      // Real process table, real SIGKILL, real post-kill verification read —
      // no opts at all.
      const result = killSnapshotSurvivors(snapshot);
      expect(result.signalled).toContain(grandchildPid);
      expect(result.recycled).toEqual([]);

      // Independent ground-truth check: a small settle window (test-side
      // only — this is NOT inside killSnapshotSurvivors, so it changes
      // nothing about its own timing/contract), then a fresh real `ps` read
      // confirming the grandchild is actually gone.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isRealPidAlive(grandchildPid)).toBe(false);
    } finally {
      // Fixture cleanup — this test must never leak a real process, even on
      // an assertion failure above.
      if (typeof parentPid === 'number') {
        for (const e of snapshotDescendants([parentPid])) {
          try { process.kill(e.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        try { process.kill(parentPid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }, 10_000);
});
