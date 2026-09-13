import { describe, it, expect } from 'vitest';
import { findStateDirOrphans, type OrphanScanInput } from '../../../src/daemon/orphan-scan.js';

/**
 * knox-codex, 2026-09-08 — finding a squatter that no ledger knows about.
 *
 * A leaked runtime process reparents to launchd and keeps writing its agent's
 * state dir: heartbeat.json stays fresh, the thread file keeps updating, turns
 * keep being billed, and the daemon believes the agent was replaced. knox had
 * two generations of these at once:
 *
 *   knox-codex pid=75727 ppid=1 up=1d16h   <-- orphan
 *   knox-codex pid=82036 ppid=1 up=19m     <-- orphan
 *   knox-codex pid=77105 ppid=77103 up=5m  <-- the live agent
 *   knox-codex pid=77106 ppid=77105 up=5m  <-- its child
 *
 * WHY THIS ONLY REPORTS, AND NEVER KILLS. The pty-host ledger records hostPid
 * and ptyPid — it does NOT record the ptyPid's own child, which is exactly what
 * leaks. So nothing in the ledger can identify one of these, and an automatic
 * reaper would have to fall back on "SIGKILL any ppid=1 process that looks like
 * a runtime binary". On this machine that heuristic would also match Josh's own
 * detached `codex` sessions. Detection is cheap and safe; the kill stays a human
 * decision. Prevention lives at the source instead, in AgentProcess.stop().
 *
 * The cwd test is what makes this precise rather than heuristic: a fleet agent's
 * runtime process runs in that agent's state dir. Nothing else does.
 */

const input = (over: Partial<OrphanScanInput> = {}): OrphanScanInput => ({
  stateRoot: '/Users/j/.cortextos/ctx1/state',
  psList: () => [],
  cwdOf: () => null,
  liveAgentPids: new Set<number>(),
  ...over,
});

describe('findStateDirOrphans', () => {
  it('reports a reparented runtime process squatting an agent state dir', () => {
    const found = findStateDirOrphans(input({
      psList: () => [{ pid: 75727, ppid: 1, command: 'codex app-server --enable goals' }],
      cwdOf: (pid) => (pid === 75727 ? '/Users/j/.cortextos/ctx1/state/knox-codex' : null),
    }));

    expect(found).toEqual([{
      pid: 75727,
      ppid: 1,
      command: 'codex app-server --enable goals',
      cwd: '/Users/j/.cortextos/ctx1/state/knox-codex',
      agent: 'knox-codex',
    }]);
  });

  it('ignores the live agent and its child — they are not reparented', () => {
    const found = findStateDirOrphans(input({
      psList: () => [
        { pid: 77105, ppid: 77103, command: 'codex app-server' },
        { pid: 77106, ppid: 77105, command: 'codex app-server' },
      ],
      cwdOf: () => '/Users/j/.cortextos/ctx1/state/knox-codex',
    }));

    expect(found).toEqual([]);
  });

  it('ignores a ppid=1 process running somewhere else entirely', () => {
    // Josh's own detached codex CLI. Reparented, same binary, NOT ours.
    const found = findStateDirOrphans(input({
      psList: () => [{ pid: 999, ppid: 1, command: 'codex app-server' }],
      cwdOf: () => '/Users/j/code/some-other-project',
    }));

    expect(found).toEqual([]);
  });

  it('ignores a pid the daemon still tracks, even if reparented', () => {
    // Belt and braces: a tracked pid is never reported, whatever its ppid says.
    const found = findStateDirOrphans(input({
      psList: () => [{ pid: 77105, ppid: 1, command: 'codex app-server' }],
      cwdOf: () => '/Users/j/.cortextos/ctx1/state/knox-codex',
      liveAgentPids: new Set([77105]),
    }));

    expect(found).toEqual([]);
  });

  it('attributes each orphan to the agent whose state dir it holds', () => {
    const found = findStateDirOrphans(input({
      psList: () => [
        { pid: 100, ppid: 1, command: 'codex app-server' },
        { pid: 200, ppid: 1, command: 'claude' },
      ],
      cwdOf: (pid) => pid === 100
        ? '/Users/j/.cortextos/ctx1/state/knox-codex'
        : '/Users/j/.cortextos/ctx1/state/pa-codex',
    }));

    expect(found.map(o => [o.pid, o.agent])).toEqual([[100, 'knox-codex'], [200, 'pa-codex']]);
  });

  it('reports a nested cwd under the state dir, not just the dir itself', () => {
    const found = findStateDirOrphans(input({
      psList: () => [{ pid: 100, ppid: 1, command: 'codex app-server' }],
      cwdOf: () => '/Users/j/.cortextos/ctx1/state/knox-codex/goal-runs/abc',
    }));

    expect(found.map(o => o.agent)).toEqual(['knox-codex']);
  });

  it('does not treat the state root itself as an agent', () => {
    const found = findStateDirOrphans(input({
      psList: () => [{ pid: 100, ppid: 1, command: 'codex app-server' }],
      cwdOf: () => '/Users/j/.cortextos/ctx1/state',
    }));

    expect(found).toEqual([]);
  });

  it('skips processes whose cwd cannot be read', () => {
    // lsof fails on foreign-uid or already-exited pids. Unknown is not orphaned.
    const found = findStateDirOrphans(input({
      psList: () => [{ pid: 100, ppid: 1, command: 'codex app-server' }],
      cwdOf: () => null,
    }));

    expect(found).toEqual([]);
  });

  it('never reports pid 1 or the scanning process itself', () => {
    const found = findStateDirOrphans(input({
      psList: () => [
        { pid: 1, ppid: 0, command: '/sbin/launchd' },
        { pid: process.pid, ppid: 1, command: 'codex app-server' },
      ],
      cwdOf: () => '/Users/j/.cortextos/ctx1/state/knox-codex',
    }));

    expect(found).toEqual([]);
  });

  it('matches through a symlinked state root — the bug fixture paths cannot show', () => {
    // macOS reports a process cwd canonically: a process started in /tmp/x
    // reports /private/tmp/x, because /tmp is a symlink. Raw string comparison
    // silently missed every such orphan. Found by scanning a REAL reparented
    // process, not by a fixture.
    const found = findStateDirOrphans(input({
      stateRoot: '/tmp/ctx1/state',
      psList: () => [{ pid: 100, ppid: 1, command: 'codex app-server' }],
      cwdOf: () => '/private/tmp/ctx1/state/knox-codex',
      realpath: (p) => p.replace(/^\/tmp\//, '/private/tmp/'),
    }));

    expect(found.map(o => o.agent)).toEqual(['knox-codex']);
  });

  it('returns nothing when the process table is unreadable', () => {
    expect(findStateDirOrphans(input({ psList: () => [] }))).toEqual([]);
  });
});
