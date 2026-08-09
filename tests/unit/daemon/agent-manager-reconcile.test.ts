/**
 * RW-3 regression tests — phantom-registry reconcile
 * (state/v9-fleet-incident/UPSTREAM-ROOT-WOUND.md §RW-3).
 *
 * Pre-fix behavior under test:
 *  1. isPidAlive returned TRUE on EPERM → a foreign-uid recycled pid kept a
 *     phantom entry alive forever: start() DEDUPED + hard-restart
 *     "not in registry" (the 2026-08-01 muse wedge).
 *  2. reconcileDeadRegistryEntry deleted the Map entry WITHOUT killing the
 *     process tree → every phantom reconcile authorized a respawn on top of
 *     live orphans (pty-host dead ≠ claude dead; the grandchild reparents).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    async start() {}
    async stop() {}
    getStatus() { return { name: 'x', status: 'stopped' }; }
    getHostPid() { return null; }
    onExit() {}
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class {} }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));

// Intercept the RW-3 tree-kill so we can assert on the kill roots without
// signaling anything real.
const killProcessTreeMock = vi.fn((_roots: number[]) => [] as number[]);
const getProcessElapsedSecondsMock = vi.fn((_pid: number): number | null => null);
vi.mock('../../../src/utils/process-tree.js', () => ({
  killProcessTree: (roots: number[], log?: (m: string) => void) => killProcessTreeMock(roots, log),
  getProcessElapsedSeconds: (pid: number) => getProcessElapsedSecondsMock(pid),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

type AgentsMap = { agents: Map<string, unknown> };

function makeEntry(opts: { pid?: number; sessionStart?: string; hostPid?: number | null }) {
  return {
    process: {
      getStatus: () => ({ name: 'muse', status: 'running', pid: opts.pid, sessionStart: opts.sessionStart }),
      getHostPid: () => opts.hostPid ?? null,
      stop: vi.fn(),
    },
    checker: { stop: vi.fn() },
    poller: { stop: vi.fn() },
    activityPoller: undefined,
  };
}

describe('RW-3: reconcileDeadRegistryEntry (via inspectAgentOp start path)', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    killProcessTreeMock.mockClear();
    getProcessElapsedSecondsMock.mockClear().mockReturnValue(null);
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-rw3-test-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('MUSE WEDGE REGRESSION: EPERM pid is treated as recycled/dead, entry is reaped, start proceeds', () => {
    const entry = makeEntry({ pid: 4242, hostPid: 4241 });
    (am as unknown as AgentsMap).agents.set('muse', entry);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const r = am.inspectAgentOp('start', 'muse');
    // Pre-fix: EPERM → "alive" → DEDUPED forever. Post-fix: entry reaped, start ok.
    expect(r.ok).toBe(true);
    expect((am as unknown as AgentsMap).agents.has('muse')).toBe(false);
    expect(entry.checker.stop).toHaveBeenCalled();
    expect(entry.poller.stop).toHaveBeenCalled();
  });

  it('EPERM (foreign-uid recycled) pid is EXCLUDED from the kill sweep; host tree still killed', () => {
    (am as unknown as AgentsMap).agents.set('muse', makeEntry({ pid: 4242, hostPid: 4241 }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    am.inspectAgentOp('start', 'muse');
    expect(killProcessTreeMock).toHaveBeenCalledTimes(1);
    const roots = killProcessTreeMock.mock.calls[0][0];
    expect(roots).toContain(4241);      // pty-host: unambiguously ours
    expect(roots).not.toContain(4242);  // recycled pid: innocent process, never signal
  });

  it('ESRCH-dead pid: full tree kill fires with BOTH roots (pty-host + inner pid) before Map delete', () => {
    (am as unknown as AgentsMap).agents.set('muse', makeEntry({ pid: 4242, hostPid: 4241 }));
    const deleteOrder: string[] = [];
    killProcessTreeMock.mockImplementation(() => {
      deleteOrder.push('kill');
      // Entry must still be present when the kill sweep runs (kill BEFORE delete)
      expect((am as unknown as AgentsMap).agents.has('muse')).toBe(true);
      return [];
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    const r = am.inspectAgentOp('start', 'muse');
    expect(r.ok).toBe(true);
    expect(deleteOrder).toEqual(['kill']);
    const roots = killProcessTreeMock.mock.calls[0][0];
    expect(roots).toContain(4241);
    expect(roots).toContain(4242);
    expect((am as unknown as AgentsMap).agents.has('muse')).toBe(false);
  });

  it('entry with NO pid at all is reaped (dead), killing the host tree if known', () => {
    (am as unknown as AgentsMap).agents.set('muse', makeEntry({ pid: undefined, hostPid: 4241 }));
    const r = am.inspectAgentOp('start', 'muse');
    expect(r.ok).toBe(true);
    expect(killProcessTreeMock).toHaveBeenCalledTimes(1);
    expect(killProcessTreeMock.mock.calls[0][0]).toEqual([4241]);
  });

  it('genuinely alive pid keeps the entry: DEDUPED, no kill sweep', () => {
    (am as unknown as AgentsMap).agents.set('muse', makeEntry({ pid: 4242, hostPid: 4241 }));
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    getProcessElapsedSecondsMock.mockReturnValue(3600); // long-lived process

    const r = am.inspectAgentOp('start', 'muse');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DEDUPED');
    expect((am as unknown as AgentsMap).agents.has('muse')).toBe(true);
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });

  it('same-uid RECYCLED pid (process much younger than the session) is reaped and excluded from the kill sweep', () => {
    const sessionStart = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2h-old session
    (am as unknown as AgentsMap).agents.set('muse', makeEntry({ pid: 4242, sessionStart, hostPid: 4241 }));
    vi.spyOn(process, 'kill').mockImplementation(() => true as never); // pid responds to signal 0
    getProcessElapsedSecondsMock.mockReturnValue(30); // but the process is 30s old → recycled

    const r = am.inspectAgentOp('start', 'muse');
    expect(r.ok).toBe(true);
    expect((am as unknown as AgentsMap).agents.has('muse')).toBe(false);
    const roots = killProcessTreeMock.mock.calls[0][0];
    expect(roots).toContain(4241);
    expect(roots).not.toContain(4242);
  });

  it('alive pid with UNKNOWN elapsed time (ps unavailable) is kept — never reconcile on uncertainty', () => {
    const sessionStart = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    (am as unknown as AgentsMap).agents.set('muse', makeEntry({ pid: 4242, sessionStart, hostPid: 4241 }));
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    getProcessElapsedSecondsMock.mockReturnValue(null);

    const r = am.inspectAgentOp('start', 'muse');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DEDUPED');
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });

  it('alive pid slightly younger than session (within 120s slack) is kept', () => {
    const sessionStart = new Date(Date.now() - 100 * 1000).toISOString(); // 100s session
    (am as unknown as AgentsMap).agents.set('muse', makeEntry({ pid: 4242, sessionStart, hostPid: 4241 }));
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    getProcessElapsedSecondsMock.mockReturnValue(60); // 60 + 120 > 100 → within slack

    const r = am.inspectAgentOp('start', 'muse');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DEDUPED');
  });

  it('fake entries without getHostPid do not crash the reconciler (typeof guard)', () => {
    (am as unknown as AgentsMap).agents.set('muse', {
      process: { getStatus: () => ({ pid: undefined }) },
      checker: { stop: vi.fn() },
    });
    expect(() => am.inspectAgentOp('start', 'muse')).not.toThrow();
    expect((am as unknown as AgentsMap).agents.has('muse')).toBe(false);
  });

  it('status snapshot marks a mapped running entry stopped when its pid is gone', () => {
    (am as unknown as AgentsMap).agents.set('muse', makeEntry({ pid: 4242, hostPid: 4241 }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    expect(am.getAllStatuses()[0].status).toBe('stopped');
  });
});
