import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EffectToken, LifecycleRequest, RequestReceipt } from '../../../src/daemon/lifecycle/types.js';

/**
 * Task 3.5: `AgentProcess.injectMessageDetailed()`'s real `DispatchResult`
 * contract — revocation-first, dedup-as-hint (correlated against a ledger
 * via the owner, never the bare `MessageDedup` hash alone when a ledger is
 * available), dispatch-intent-persisted-before-write, and the legacy
 * synchronous `injectMessage()` shim staying fully decoupled from all of
 * the above.
 *
 * Mirrors `tests/unit/daemon/agent-process.test.ts`'s mocking harness
 * (mock `AgentPTY` + the filesystem/env/paths surface `AgentProcess`
 * touches at module scope) but deliberately does NOT mock
 * `src/pty/inject.js` — the real `MessageDedup` class is exercised for
 * real, since these tests are specifically about its hash-hit behavior.
 */

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  injectMessage: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/bus/enabled-agents-io.js', () => ({
  readEnabledAgentsMap: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

function effect(overrides: Partial<EffectToken> = {}): EffectToken {
  return { agentId: 'alice', supervisorEpoch: 1, generation: 1, intentRevision: 0, effectId: 'effect-1', ...overrides };
}

/** A minimal `LifecycleRequestOwner` double — only the fields a given test needs are set. */
function fakeOwner(overrides: {
  isEffectLive?: (e: EffectToken) => boolean;
  dispatchedWorkIds?: (ids: string[]) => string[];
  beginDispatch?: (ids: string[], batchId: string) => { ok: true } | { ok: false; error: string };
} = {}) {
  return {
    request: vi.fn(async (_req: LifecycleRequest): Promise<RequestReceipt> => {
      throw new Error('request() should not be called by injectMessageDetailed tests');
    }),
    ...overrides,
  };
}

beforeEach(async () => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.injectMessage.mockClear();
  mockPty.isAlive.mockClear().mockReturnValue(true);
  mockPty.onExit.mockClear();
});

async function runningAgent(supervised = false): Promise<InstanceType<typeof AgentProcess>> {
  const ap = new AgentProcess('alice', mockEnv, {}, undefined, supervised);
  await ap.start();
  expect(ap.getStatus().status).toBe('running');
  return ap;
}

describe('AgentProcess.injectMessageDetailed — Task 3.5 DispatchResult contract', () => {
  it('NOT_RUNNING: agent never started — retryable, PTY untouched', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    const result = await ap.injectMessageDetailed('hello', effect(), []);
    expect(result).toMatchObject({ ok: false, code: 'NOT_RUNNING', retryable: true });
    expect(mockPty.injectMessage).not.toHaveBeenCalled();
  });

  it('REVOKED: a stale effect never reaches the runtime', async () => {
    const ap = await runningAgent(true);
    ap.setOwner(fakeOwner({ isEffectLive: () => false }));

    const result = await ap.injectMessageDetailed('hello', effect(), ['work-1']);
    expect(result).toMatchObject({ ok: false, code: 'REVOKED', retryable: false });
    expect(mockPty.injectMessage).not.toHaveBeenCalled();
  });

  it('FAILED: a dispatch-intent persistence failure stops the write — PTY untouched', async () => {
    const ap = await runningAgent(true);
    ap.setOwner(
      fakeOwner({
        isEffectLive: () => true,
        dispatchedWorkIds: () => [],
        beginDispatch: () => ({ ok: false, error: 'store unavailable' }),
      }),
    );

    const result = await ap.injectMessageDetailed('hello', effect(), ['work-1']);
    expect(result).toMatchObject({ ok: false, code: 'FAILED', retryable: false });
    expect(result.ok === false && result.code === 'FAILED' && result.message).toMatch(/store unavailable/);
    expect(mockPty.injectMessage).not.toHaveBeenCalled();
  });

  it('ok:true — persists dispatch intent, then writes to the PTY, echoing workIds/batchId', async () => {
    const ap = await runningAgent(true);
    const beginDispatch = vi.fn().mockReturnValue({ ok: true });
    ap.setOwner(
      fakeOwner({
        isEffectLive: () => true,
        dispatchedWorkIds: () => [],
        beginDispatch,
      }),
    );

    const eff = effect({ effectId: 'effect-xyz' });
    const result = await ap.injectMessageDetailed('novel content one', eff, ['work-1', 'work-2']);
    expect(result).toEqual({ ok: true, workIds: ['work-1', 'work-2'], batchId: 'effect-xyz' });
    expect(beginDispatch).toHaveBeenCalledWith(['work-1', 'work-2'], 'effect-xyz');
    expect(mockPty.injectMessage).toHaveBeenCalledWith('novel content one');
  });

  it('DUPLICATE: a MessageDedup hash hit that correlates to already-dispatched workIds is blocked, PTY untouched', async () => {
    const ap = await runningAgent(true);
    const dispatchedWorkIds = vi.fn().mockReturnValue(['work-1']);
    const beginDispatch = vi.fn().mockReturnValue({ ok: true });
    ap.setOwner(
      fakeOwner({
        isEffectLive: () => true,
        dispatchedWorkIds,
        beginDispatch,
      }),
    );

    const content = 'repeat-me';
    // First call: genuinely new — not yet in the dedup hash window.
    const first = await ap.injectMessageDetailed(content, effect(), ['work-1']);
    expect(first.ok).toBe(true);

    // Second call: identical content, SAME workIds — dedup hits AND the
    // ledger confirms these workIds are already dispatched. Must block.
    const second = await ap.injectMessageDetailed(content, effect(), ['work-1']);
    expect(second).toMatchObject({ ok: false, code: 'DUPLICATE', retryable: false, existingWorkIds: ['work-1'] });
    // Only the first call's write should have gone through.
    expect(mockPty.injectMessage).toHaveBeenCalledTimes(1);
  });

  it('content-hash coincidence for genuinely NEW workIds is a hint, not a block — dispatch proceeds', async () => {
    const ap = await runningAgent(true);
    // dispatchedWorkIds always reports "nothing correlated" — i.e. every
    // workId this test passes is still fresh/'accepted'.
    const dispatchedWorkIds = vi.fn().mockReturnValue([]);
    const beginDispatch = vi.fn().mockReturnValue({ ok: true });
    ap.setOwner(fakeOwner({ isEffectLive: () => true, dispatchedWorkIds, beginDispatch }));

    const content = 'coincidentally identical content';
    const first = await ap.injectMessageDetailed(content, effect(), ['work-1']);
    expect(first.ok).toBe(true);

    // Second call: SAME content (dedup hash hits) but DIFFERENT workIds — a
    // genuine content coincidence for brand-new work. Must NOT be blocked.
    const second = await ap.injectMessageDetailed(content, effect(), ['work-2']);
    expect(second.ok).toBe(true);
    expect(mockPty.injectMessage).toHaveBeenCalledTimes(2);
    expect(beginDispatch).toHaveBeenCalledWith(['work-2'], 'effect-1');
  });

  it('no owner at all (legacy/unsupervised): revocation check is skipped, MessageDedup stays authoritative on its own', async () => {
    const ap = await runningAgent(false); // supervised=false, setOwner() never called

    const content = 'legacy duplicate content';
    const first = await ap.injectMessageDetailed(content, effect(), []);
    expect(first.ok).toBe(true);

    // No owner to correlate workIds against — the hash hit alone must still
    // block, exactly as it did before Task 3.5 (never silently weakened to
    // a no-op just because nothing exists to corroborate it).
    const second = await ap.injectMessageDetailed(content, effect(), []);
    expect(second).toMatchObject({ ok: false, code: 'DUPLICATE', retryable: false, existingWorkIds: [] });
    expect(mockPty.injectMessage).toHaveBeenCalledTimes(1);
  });
});

describe('AgentProcess.injectMessage — Task 3.5 legacy boolean shim', () => {
  it('stays synchronous and unaffected by an owner being wired', async () => {
    const ap = await runningAgent(true);
    const isEffectLive = vi.fn().mockReturnValue(false); // would REVOKE the detailed path
    ap.setOwner(fakeOwner({ isEffectLive }));

    const result = ap.injectMessage('hello');
    expect(result).toBe(true); // plain boolean, synchronous
    expect(isEffectLive).not.toHaveBeenCalled(); // never consults the owner at all
    expect(mockPty.injectMessage).toHaveBeenCalledWith('hello');
  });

  it('MessageDedup hash hit still blocks (own self-contained hash check, no ledger involved)', async () => {
    const ap = await runningAgent(false);
    const content = 'legacy-dup';
    expect(ap.injectMessage(content)).toBe(true);
    expect(ap.injectMessage(content)).toBe(false);
    expect(mockPty.injectMessage).toHaveBeenCalledTimes(1);
  });

  it('NOT_RUNNING collapses to false', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    expect(ap.injectMessage('hello')).toBe(false);
  });
});
