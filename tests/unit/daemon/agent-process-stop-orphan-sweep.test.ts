import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * knox-codex, 2026-09-08 — stop() must not leave the runtime's own child behind.
 *
 * The codex-app-server runtime spawns an inner `codex app-server` beneath the
 * PTY child. stop() signalled only the PTY child, so that grandchild survived,
 * reparented to launchd, and went on writing the agent's heartbeat.json, thread
 * file and inbox — and emitting billable turns — while the daemon believed the
 * agent had been replaced. Two restarts failed to displace it, because each one
 * left another copy behind.
 *
 * Two properties are pinned here, and the ORDER is the load-bearing one:
 *
 *   1. The descendant set is snapshotted BEFORE anything is signalled. After the
 *      parent dies the kernel reparents its children to pid 1, so a walk rooted
 *      at the dead parent returns nothing — a sweep that snapshots afterwards is
 *      a no-op on exactly the process it exists to kill.
 *   2. The sweep runs UNCONDITIONALLY, not inside the SIGKILL-escalation branch.
 *      That branch is guarded by `isChildAlive(childPid)`, which tests only the
 *      direct child. On a clean child exit — the normal case, and the one that
 *      leaked — the branch is skipped entirely.
 */

vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: class {} }));
vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({ CodexAppServerPTY: class {} }));
vi.mock('../../../src/pty/hermes-pty.js', () => ({ HermesPTY: class {}, hermesDbExists: () => false }));
vi.mock('../../../src/pty/opencode-pty.js', () => ({ OpencodePTY: class {}, opencodeSessionExists: () => false }));

/** Call order across both helpers, so ordering is observed rather than assumed. */
const calls: string[] = [];

const snapshotDescendants = vi.fn((_roots: number[]) => {
  calls.push('snapshot');
  return [{ pid: 4242, ppid: 4241, command: 'codex app-server (inner)' }];
});
const killSnapshotSurvivors = vi.fn(() => {
  calls.push('sweep');
  return [4242];
});

vi.mock('../../../src/utils/process-tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/process-tree.js')>();
  return {
    ...actual,
    snapshotDescendants: (...args: Parameters<typeof snapshotDescendants>) => snapshotDescendants(...args),
    killSnapshotSurvivors: (...args: unknown[]) => (killSnapshotSurvivors as (...a: unknown[]) => number[])(...args),
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

/**
 * PTY stub whose child exits CLEANLY — isAlive() false, so pty.kill() and the
 * SIGKILL escalation are both skipped. This is the exact shape that leaked.
 */
function makeCleanExitPty(pid: number | undefined) {
  return {
    write() { calls.push('write'); },
    isAlive() { return false; },
    kill() { calls.push('pty.kill'); },
    getPid() { return pid; },
  };
}

function buildProcess(runtime: string, childPid: number | undefined) {
  const env = { agentName: 'alice', org: 'acme' } as never;
  const config = { name: 'alice', runtime } as never;
  const proc = new AgentProcess('alice', env, config, () => { /* silence */ });
  (proc as unknown as { pty: unknown }).pty = makeCleanExitPty(childPid);
  return proc;
}

beforeEach(() => {
  calls.length = 0;
  snapshotDescendants.mockClear();
  killSnapshotSurvivors.mockClear();
});

describe('AgentProcess.stop() — orphaned-descendant sweep', () => {
  it('sweeps the runtime grandchild even when the direct child exits cleanly', async () => {
    const proc = buildProcess('codex-app-server', 4241);

    await proc.stop();

    // The escalation branch never ran (clean exit) — the sweep must still have.
    expect(killSnapshotSurvivors).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('snapshots the descendants BEFORE signalling, and sweeps after', async () => {
    const proc = buildProcess('codex-app-server', 4241);

    await proc.stop();

    expect(snapshotDescendants).toHaveBeenCalledWith([4241]);
    expect(calls.indexOf('snapshot')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('sweep')).toBeGreaterThan(calls.indexOf('snapshot'));
  }, 30_000);

  it('hands the sweep exactly what the snapshot recorded', async () => {
    const proc = buildProcess('codex-app-server', 4241);

    await proc.stop();

    const recorded = snapshotDescendants.mock.results[0].value;
    expect(killSnapshotSurvivors.mock.calls[0][0]).toEqual(recorded);
  }, 30_000);

  it('is runtime-generic — claude-code stops sweep too', async () => {
    const proc = buildProcess('claude-code', 5151);

    await proc.stop();

    expect(snapshotDescendants).toHaveBeenCalledWith([5151]);
    expect(killSnapshotSurvivors).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('does nothing when there is no OS child to root the walk at', async () => {
    const proc = buildProcess('codex-app-server', undefined);

    await proc.stop();

    expect(snapshotDescendants).not.toHaveBeenCalled();
    expect(killSnapshotSurvivors).not.toHaveBeenCalled();
  }, 30_000);
});
