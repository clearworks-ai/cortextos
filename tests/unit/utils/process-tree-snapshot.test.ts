import { describe, it, expect, vi } from 'vitest';
import {
  snapshotDescendants,
  killSnapshotSurvivors,
  type ProcessSnapshotEntry,
} from '../../../src/utils/process-tree.js';

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
  it('kills a survivor that is still alive and still the same program', () => {
    // The knox case: the recorded grandchild outlived its parent and has been
    // reparented to launchd. Its ppid changed; its identity did not.
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);
    const after = table([[300, 1, 'codex app-server (inner)']]);

    const killFn = vi.fn();
    const killed = killSnapshotSurvivors(snapshot, { table: after, killFn });

    expect(killed).toEqual([300]);
    expect(killFn).toHaveBeenCalledWith(300, 'SIGKILL');
  });

  it('SKIPS a recycled pid whose command no longer matches', () => {
    // Up to ~21s can elapse between snapshot and sweep. If the OS handed that
    // pid to something else in the meantime, killing it would murder an
    // unrelated process. Identity, not liveness, is the guard.
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);
    const after = table([[300, 1, '/usr/bin/somebody-elses-program']]);

    const killFn = vi.fn();
    const killed = killSnapshotSurvivors(snapshot, { table: after, killFn });

    expect(killed).toEqual([]);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('skips pids that already exited cleanly', () => {
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);

    const killFn = vi.fn();
    const killed = killSnapshotSurvivors(snapshot, { table: [], killFn });

    expect(killed).toEqual([]);
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
    const killed = killSnapshotSurvivors(snapshot, { table: after, killFn });

    expect(killed).toEqual([]);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('swallows ESRCH/EPERM from the kill itself and reports only real kills', () => {
    const snapshot = table([
      [300, 200, 'a'],
      [301, 200, 'b'],
    ]);
    const killFn = vi.fn((pid: number) => {
      if (pid === 300) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    const killed = killSnapshotSurvivors(snapshot, { table: snapshot, killFn });

    expect(killed).toEqual([301]);
  });

  it('logs a single line naming what it swept, for post-incident audit', () => {
    const snapshot = table([[300, 200, 'codex app-server (inner)']]);
    const log = vi.fn();

    killSnapshotSurvivors(snapshot, { table: snapshot, killFn: vi.fn(), log });

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('300');
  });

  it('says nothing when there was nothing to sweep', () => {
    const log = vi.fn();
    killSnapshotSurvivors([], { table: [], killFn: vi.fn(), log });
    expect(log).not.toHaveBeenCalled();
  });
});
