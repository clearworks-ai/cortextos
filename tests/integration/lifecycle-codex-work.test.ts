import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CtxEnv } from '../../src/types/index.js';
import type { BusPaths } from '../../src/types/index.js';
import type { GenerationToken, LifecycleRequest, OwnedResource, RetirementResult, WorkRecord } from '../../src/daemon/lifecycle/types.js';
import { LifecycleStateStore } from '../../src/daemon/lifecycle/state-store.js';
import { AgentLifecycleSupervisor, type RuntimeAdapter } from '../../src/daemon/lifecycle/supervisor.js';

vi.mock('../../src/bus/event.js', () => ({ logEvent: vi.fn() }));

const { CodexAppServerPTY } = await import('../../src/pty/codex-app-server-pty.js');
type WorkCorrelationEvent = import('../../src/pty/codex-app-server-pty.js').WorkCorrelationEvent;

/**
 * Task 3.4: Codex work/turn correlation.
 *
 * These tests deliberately bypass `spawn()`/`startAppServer()` (the real
 * app-server process + WsUnixJsonRpcClient socket) entirely -- the private
 * turn-queue/RPC-message-handling mechanics under test do not depend on how
 * the adapter got into a "ready" state, only on `_alive`/`_threadId`/`_rpc`
 * being populated and `handleRpcMessage`/`queueTurn`/`kill` being reachable.
 * This mirrors `tests/unit/pty/codex-app-server-pty.test.ts`'s own
 * `makeReadyPty()` helper (private-field casts, no PTY/socket mocking).
 *
 * Real fs is used against a scratch temp `ctxRoot` (not mocked) -- exactly
 * one write path (`appendCodexTokenLog`/`writeContextStatus`/
 * `signalContextFull`'s marker) touches disk, and this mirrors the pattern
 * `tests/unit/daemon/lifecycle-supervisor.test.ts` already uses for the
 * lifecycle store itself.
 */

let ctxRoot: string;

function makeEnv(agentName: string): CtxEnv {
  return {
    instanceId: 'default',
    ctxRoot,
    frameworkRoot: ctxRoot,
    agentName,
    agentDir: join(ctxRoot, 'agents', agentName),
    org: 'clearworks',
    projectRoot: ctxRoot,
  };
}

type ReadyAdapter = InstanceType<typeof CodexAppServerPTY> & {
  _alive: boolean;
  _threadId: string | null;
  _rpc: { request: ReturnType<typeof vi.fn>; respondError: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
  _activeTurnId: string | null;
  _activeTurnWorkIds: string[];
  _turnQueue: Array<{ input: unknown[]; workIds: string[] }>;
  _turnCompletion: unknown;
  queueTurn(input: unknown[], workIds?: string[]): void;
  enqueueTurn(input: unknown[], workIds?: string[]): void;
  handleRpcMessage(message: unknown): void;
};

const requestDefault = vi.fn().mockResolvedValue({ result: {} });

function makeReadyAdapter(agentName: string, threadId: string): ReadyAdapter {
  const pty = new CodexAppServerPTY(makeEnv(agentName), {});
  const inner = pty as unknown as ReadyAdapter;
  inner._alive = true;
  inner._threadId = threadId;
  inner._rpc = {
    request: vi.fn().mockImplementation((...args: unknown[]) => requestDefault(...args)),
    respondError: vi.fn(),
    close: vi.fn(),
    notify: vi.fn(),
  };
  return inner;
}

/** Flush a handful of microtask ticks -- enough for the queueTurn/enqueueTurn
 * -> drainQueue -> startTurn -> request()-await chain to settle up to (but
 * not past) whatever RPC push message the test still needs to fire. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function captureEvents(pty: ReadyAdapter): WorkCorrelationEvent[] {
  const events: WorkCorrelationEvent[] = [];
  pty.onWorkCorrelation((event) => events.push(event));
  return events;
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-codex-work-test-'));
  requestDefault.mockClear();
  requestDefault.mockResolvedValue({ result: {} });
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('CodexAppServerPTY work correlation events', () => {
  it('happy path: runtime-accepted (turn/started) -> progress (agentMessage delta) -> completed (turn/completed), as three separate events', async () => {
    const pty = makeReadyAdapter('codex-agent', 'thread-1');
    const events = captureEvents(pty);

    pty.queueTurn([{ type: 'text', text: 'hello', text_elements: [] }], ['work-1']);
    await flush();

    expect(events).toHaveLength(0); // nothing fires until turn/started
    pty.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    expect(events).toEqual([{ type: 'runtime-accepted', workIds: ['work-1'], turnId: 'turn-1' }]);

    pty.handleRpcMessage({ method: 'item/agentMessage/delta', params: { delta: 'working...' } });
    expect(events[1]).toEqual({ type: 'progress', workIds: ['work-1'], turnId: 'turn-1' });

    pty.handleRpcMessage({ method: 'turn/completed', params: {} });
    expect(events[2]).toEqual({ type: 'completed', workIds: ['work-1'], turnId: 'turn-1' });
    expect(events).toHaveLength(3);
    expect(pty._activeTurnWorkIds).toEqual([]);
  });

  it('thread/tokenUsage/updated never fires runtime-accepted/progress/completed/failed/needs-review/cancelled -- it is explicitly not terminal completion', async () => {
    const pty = makeReadyAdapter('codex-agent', 'thread-1');
    const events = captureEvents(pty);

    pty.queueTurn([{ type: 'text', text: 'hello', text_elements: [] }], ['work-1']);
    await flush();
    pty.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    expect(events).toHaveLength(1); // runtime-accepted only, so far

    for (let i = 0; i < 5; i += 1) {
      pty.handleRpcMessage({
        method: 'thread/tokenUsage/updated',
        params: {
          turnId: 'turn-1',
          tokenUsage: { total: { inputTokens: 100 * (i + 1), outputTokens: 20, cachedInputTokens: 0 } },
        },
      });
    }

    // Still exactly the one runtime-accepted event -- no completed/failed/
    // needs-review ever fired from the tokenUsage handler, no matter how
    // many times it is called.
    expect(events).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['runtime-accepted']);
    // The turn is genuinely still outstanding: the completion promise this
    // adapter is awaiting has neither resolved nor rejected.
    expect(pty._turnCompletion).not.toBeNull();

    pty.handleRpcMessage({ method: 'turn/completed', params: {} });
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('completed');
  });

  it('30-minute completion timeout with a second input already queued -> both the timed-out turn and the queued input reach explicit needs-review outcomes', async () => {
    vi.useFakeTimers();
    const pty = makeReadyAdapter('codex-agent', 'thread-1');
    const events = captureEvents(pty);

    pty.enqueueTurn([{ type: 'text', text: 'first', text_elements: [] }], ['work-1']);
    pty.enqueueTurn([{ type: 'text', text: 'second', text_elements: [] }], ['work-2']);
    await flush();
    pty.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    expect(pty._turnQueue).toHaveLength(1); // 'second' still queued behind 'first'

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await flush();

    const byWorkId = Object.fromEntries(events.map((e) => [e.workIds[0], e]));
    expect(byWorkId['work-1']).toMatchObject({ type: 'needs-review', turnId: 'turn-1', reason: expect.stringContaining('Timed out') });
    expect(byWorkId['work-2']).toMatchObject({ type: 'needs-review', turnId: null, reason: expect.stringContaining('queue drained after a prior turn failed') });
    expect(pty._turnQueue).toHaveLength(0); // nothing left stranded
    expect(pty.isAlive()).toBe(true); // Task 3.4: a generic timeout does not flip _alive
  });

  it('kill() mid-turn with one queued input behind it -> both the active turn and the queued input reach explicit cancelled outcomes', async () => {
    const pty = makeReadyAdapter('codex-agent', 'thread-1');
    const events = captureEvents(pty);

    pty.enqueueTurn([{ type: 'text', text: 'first', text_elements: [] }], ['work-1']);
    pty.enqueueTurn([{ type: 'text', text: 'second', text_elements: [] }], ['work-2']);
    await flush();
    pty.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });

    pty.kill();
    await flush();

    const byWorkId = Object.fromEntries(events.map((e) => [e.workIds[0], e]));
    expect(byWorkId['work-1']).toMatchObject({ type: 'cancelled', turnId: 'turn-1' });
    expect(byWorkId['work-2']).toMatchObject({ type: 'cancelled', turnId: null });
    expect(pty.isAlive()).toBe(false);
    // runtime-accepted(work-1) + cancelled(work-1) + cancelled(work-2) --
    // and no DUPLICATE needs-review/cancelled emission from drainQueue's own
    // catch racing behind kill()'s already-emptied queue.
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(['runtime-accepted', 'cancelled', 'cancelled']);
  });

  it('generic RPC error mid-turn with a queued input behind it -> both reach explicit outcomes (failed + needs-review)', async () => {
    const pty = makeReadyAdapter('codex-agent', 'thread-1');
    const events = captureEvents(pty);

    pty.enqueueTurn([{ type: 'text', text: 'first', text_elements: [] }], ['work-1']);
    pty.enqueueTurn([{ type: 'text', text: 'second', text_elements: [] }], ['work-2']);
    await flush();
    pty.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });

    pty.handleRpcMessage({ method: 'error', params: { message: 'boom' } });
    await flush();

    const byWorkId = Object.fromEntries(events.map((e) => [e.workIds[0], e]));
    expect(byWorkId['work-1']).toMatchObject({ type: 'failed', turnId: 'turn-1' });
    expect((byWorkId['work-1'] as { error: string }).error).toContain('boom');
    expect(byWorkId['work-2']).toMatchObject({ type: 'needs-review', turnId: null });
    expect(pty._turnQueue).toHaveLength(0);
  });

  it('context-full: an error matching the overflow pattern still calls signalContextFull unchanged (regression)', async () => {
    const pty = makeReadyAdapter('codex-agent', 'thread-1');
    captureEvents(pty);

    pty.enqueueTurn([{ type: 'text', text: 'first', text_elements: [] }], ['work-1']);
    await flush();
    pty.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });

    pty.handleRpcMessage({
      method: 'error',
      params: { message: 'Codex ran out of room in the model\'s context window. Start a new thread' },
    });
    await flush();

    const markerPath = join(ctxRoot, 'state', 'codex-agent', '.codex-context-full');
    expect(existsSync(markerPath)).toBe(true);
    const statusPath = join(ctxRoot, 'state', 'codex-agent', 'context_status.json');
    expect(existsSync(statusPath)).toBe(true);
  });
});

describe('Codex work correlation wired through AgentLifecycleSupervisor.observe()', () => {
  let paths: BusPaths;
  const agentId = 'default/clearworks/codex-agent';

  function fakeBusPaths(agentName: string): BusPaths {
    return {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox', agentName),
      inflight: join(ctxRoot, 'inflight', agentName),
      processed: join(ctxRoot, 'processed', agentName),
      logDir: join(ctxRoot, 'logs', agentName),
      stateDir: join(ctxRoot, 'state', agentName),
      taskDir: join(ctxRoot, 'orgs', 'x', 'tasks'),
      approvalDir: join(ctxRoot, 'orgs', 'x', 'approvals'),
      analyticsDir: join(ctxRoot, 'orgs', 'x', 'analytics'),
      deliverablesDir: join(ctxRoot, 'orgs', 'x', 'deliverables'),
    };
  }

  function unusedRuntime(): RuntimeAdapter {
    return {
      async startGeneration(): Promise<{ ok: boolean; resources: OwnedResource[]; error?: string }> {
        throw new Error('unused in this test suite');
      },
      async retireGeneration(): Promise<RetirementResult> {
        throw new Error('unused in this test suite');
      },
      async deliver() {
        return { ok: true as const, workIds: [], batchId: 'unused' };
      },
    };
  }

  /** Mirrors exactly what `agent-process.ts`'s Task 3.4 Step 5 wiring does:
   * `CodexAppServerPTY.onWorkCorrelation` -> `owner.observe({ kind:
   * `work-${event.type}`, token, atMs, evidence: {...} })`. */
  function wireCorrelation(pty: ReadyAdapter, supervisor: AgentLifecycleSupervisor, token: GenerationToken): void {
    pty.onWorkCorrelation((event) => {
      const evidence: Record<string, string | number | boolean | null> = {
        workIds: JSON.stringify(event.workIds),
        turnId: event.turnId,
      };
      if ('error' in event) evidence.error = event.error;
      if ('reason' in event) evidence.reason = event.reason;
      supervisor.observe({ kind: `work-${event.type}`, token, atMs: Date.now(), evidence });
    });
  }

  beforeEach(() => {
    paths = fakeBusPaths('codex-agent');
  });

  it('full happy path: accept -> dispatch -> runtime-accepted -> executing -> completed, all through the real ledger', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, unusedRuntime());

    const accepted = await supervisor.acceptBatch([{ sourceKey: 'telegram:msg-1', payload: 'hello', payloadDigest: 'digest-1' }]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const [workId] = accepted.workIds;

    const before = supervisor.outstandingWork().find((r) => r.workId === workId);
    expect(before?.phase).toBe('accepted');

    const token: GenerationToken = { agentId, supervisorEpoch: 0, generation: 1 };
    const pty = makeReadyAdapter('codex-agent', 'thread-1');
    wireCorrelation(pty, supervisor, token);

    pty.queueTurn([{ type: 'text', text: 'hello', text_elements: [] }], [workId]);
    await flush();
    pty.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });

    const midFlight = supervisor.outstandingWork().find((r) => r.workId === workId);
    expect(midFlight?.phase).toBe('executing');
    expect(midFlight?.runtimeTurnId).toBe('turn-1');

    pty.handleRpcMessage({ method: 'turn/completed', params: {} });

    const after = supervisor.outstandingWork().find((r) => r.workId === workId);
    expect(after).toBeUndefined(); // completed -> no longer outstanding
    const reloaded = store.load();
    expect('corrupt' in reloaded).toBe(false);
    if ('corrupt' in reloaded) return;
    const finalRecord = reloaded.outstandingWork.find((r: WorkRecord) => r.workId === workId);
    expect(finalRecord?.phase).toBe('completed');
  });

  it('session refresh: a stale late completion from the OLD generation cannot resolve the NEW generation\'s work', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, unusedRuntime());

    const accepted = await supervisor.acceptBatch([
      { sourceKey: 'telegram:msg-old', payload: 'old', payloadDigest: 'digest-old' },
      { sourceKey: 'telegram:msg-new', payload: 'new', payloadDigest: 'digest-new' },
    ]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const [workIdOld, workIdNew] = accepted.workIds;

    // Old generation: dispatched, runtime-accepted, but never completed
    // before the refresh happens (still genuinely mid-flight).
    const tokenOld: GenerationToken = { agentId, supervisorEpoch: 0, generation: 1 };
    const ptyOld = makeReadyAdapter('codex-agent', 'thread-old');
    wireCorrelation(ptyOld, supervisor, tokenOld);
    ptyOld.queueTurn([{ type: 'text', text: 'old', text_elements: [] }], [workIdOld]);
    await flush();
    ptyOld.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-old' } } });
    expect(supervisor.outstandingWork().find((r) => r.workId === workIdOld)?.phase).toBe('executing');

    // New generation (session refresh creates a fresh CodexAppServerPTY --
    // Issue #330's own comment in agent-process.ts): a completely separate
    // instance, own threadId, own private turn state.
    const tokenNew: GenerationToken = { agentId, supervisorEpoch: 0, generation: 2 };
    const ptyNew = makeReadyAdapter('codex-agent', 'thread-new');
    wireCorrelation(ptyNew, supervisor, tokenNew);
    ptyNew.queueTurn([{ type: 'text', text: 'new', text_elements: [] }], [workIdNew]);
    await flush();
    ptyNew.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-new' } } });
    ptyNew.handleRpcMessage({ method: 'turn/completed', params: {} });

    const newRecordAfterOwnCompletion = supervisor.outstandingWork().find((r) => r.workId === workIdNew);
    expect(newRecordAfterOwnCompletion).toBeUndefined(); // legitimately completed already

    // The stale message: the OLD instance's OWN turn/completed "somehow
    // arrives" late (PHASES.md's own phrasing). It can only ever correlate
    // to workIdOld (baked into ptyOld's own _activeTurnWorkIds at dispatch
    // time) -- there is no code path by which it could touch workIdNew.
    expect(ptyOld._activeTurnWorkIds).toEqual([workIdOld]);
    ptyOld.handleRpcMessage({ method: 'turn/completed', params: {} });

    const oldRecord = supervisor.outstandingWork().find((r) => r.workId === workIdOld);
    expect(oldRecord).toBeUndefined(); // workIdOld legitimately completes via its OWN generation's message

    const reloaded = store.load();
    expect('corrupt' in reloaded).toBe(false);
    if ('corrupt' in reloaded) return;
    const finalNew = reloaded.outstandingWork.find((r: WorkRecord) => r.workId === workIdNew);
    // workIdNew's record is exactly what ITS OWN generation produced --
    // runtimeTurnId is 'turn-new', never touched by the old generation's
    // 'turn-old'/late message.
    expect(finalNew?.phase).toBe('completed');
    expect(finalNew?.runtimeTurnId).toBe('turn-new');
  });
});
