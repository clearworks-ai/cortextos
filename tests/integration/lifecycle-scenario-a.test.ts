import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths, CtxEnv, InboxMessage } from '../../src/types/index.js';
import type { GenerationToken, WorkRecord } from '../../src/daemon/lifecycle/types.js';
import { LifecycleStateStore } from '../../src/daemon/lifecycle/state-store.js';
import { AgentLifecycleSupervisor, type RuntimeAdapter } from '../../src/daemon/lifecycle/supervisor.js';
import { canonicalAgentId } from '../../src/daemon/lifecycle/types.js';

/**
 * Task 3.9: permanent regression test for deep-dive Scenario A — "it is
 * running and healthy, but my work vanished" — proven to FAIL against the
 * pre-supervisor code path and to PASS against the code Tasks 3.1-3.6
 * produced. Mirrors Task 2.10's `lifecycle-scenario-b.test.ts` structure.
 *
 * ---------------------------------------------------------------------------
 * (a) THE MEASURED PRE-SUPERVISOR FINDING this test's control case must
 *     reproduce (DEEPDIVE-lifecycle-recurrence-2026-09-11.md, section 3A):
 *
 *       After poll:
 *         acked=[task-1], pendingOnDisk=0, adapterExecuting=true
 *         wedge={wedged:false, reason:no-pending-work}
 *       After firing that timeout, with a second queued input:
 *         alive=true, executing=false, remainingQueue=1
 *         log="turn queue failed: Error: Timed out waiting for turn/completed"
 *
 *     The mechanism (deep-dive section 3A, steps 1-3): `pollCycle()` removes
 *     the consumed Telegram/inbox message and ACKs it as soon as
 *     `injectMessage()` returns a bare `true` — it never awaits RPC
 *     acceptance or a completed turn. By the time the wedge check runs later
 *     in the SAME cycle, the transport copy is already gone
 *     (`pendingOnDisk=0`) and nothing else records the runtime's own
 *     in-flight turn, so `hasPendingWork` reads false and the wedge detector
 *     returns `{wedged:false, reason:'no-pending-work'}` — even though the
 *     runtime is still genuinely executing (`adapterExecuting=true`) and
 *     later silently times out with nothing durable ever having tracked it.
 *
 * (b) THE PRE-FIX CODE BEING REPLAYED is still live today, byte-for-byte,
 *     behind `if (this.supervised)` in `fast-checker.ts`'s `pollCycle()` —
 *     confirmed by that method's own doc comment: "An unsupervised agent's
 *     behavior below is byte-for-byte the pre-Task-3.3 body." (Verified
 *     against `git show 8fdb3e11^:src/daemon/fast-checker.ts`, Task 3.3's
 *     parent commit — the pre-fix inject branch there is exactly: inject,
 *     and ONLY if truthy, immediately splice the queues and `ackInbox()`
 *     every id, with no acceptance/ledger step of any kind in between.) The
 *     CONTROL case below therefore does not need to monkey-patch or
 *     duplicate an old implementation inline — constructing the `FastChecker`
 *     with `supervised: false` (the default) exercises the real pre-fix code
 *     path directly, exactly as Task 2.10's own CONTROL case does for
 *     Scenario B.
 *
 * (c) Deliberately uses the REAL `FastChecker.pollCycle()` /
 *     `checkWedgeInner()` method bodies, the REAL `AgentLifecycleSupervisor`
 *     (`acceptBatch`/`outstandingWork`/`observe`) backed by a REAL
 *     `LifecycleStateStore` over a temp `ctxRoot`, the REAL pure
 *     `detectWedge()` decision function (spied on, not reimplemented, to
 *     capture its exact return value), and a REAL `CodexAppServerPTY`
 *     turn-queue/completion adapter constructed the same way Task 3.4's own
 *     `tests/integration/lifecycle-codex-work.test.ts` does (private-field
 *     casts to reach "ready", a stubbed `_rpc.request` — no real subprocess,
 *     no real socket). Only three things are faked: the PTY subprocess
 *     itself (there is no real `AgentProcess`; a minimal stand-in agent
 *     plays that role, per this task's own file's explicit allowance for "a
 *     minimal real-enough stand-in"), the OS clock (`vi.useFakeTimers()`,
 *     needed to cross Codex's real 30-minute completion timeout without the
 *     test taking 30 minutes), and Telegram (no `telegramApi`/`chatId` wired
 *     at all — the wedge alert's `reportWedge()` degrades to a log-only
 *     branch, already covered by Task 3.6's own test file).
 *
 *     One documented, PRE-EXISTING wiring gap this test bridges rather than
 *     works around silently: `fast-checker.ts`'s `dispatchViaSupervisor()`
 *     shim (Task 3.3, explicitly still unmigrated per its own doc comment —
 *     "Task 3.5's injectMessageDetailed → DispatchResult migration has not
 *     landed") calls the bare `agent.injectMessage(messageBlock)` boolean and
 *     discards the `workIds` it already has in scope. Separately,
 *     `CodexAppServerPTY`'s own write()-based inject path
 *     (`agent-process.ts`'s `injectMessageDetailed()` `else` branch, used for
 *     Codex) calls `this.queueTurn(input)` with NO workIds either — the
 *     SAME documented gap `agent-process.ts` itself calls out ("Real workIds
 *     only ever arrive once a caller threads them into queueTurn()/
 *     injectMessage (Task 3.5) ... this wiring is inert in production
 *     today"). Neither gap is Phase 3 Task 3.1-3.6 scope to close (Task 3.9
 *     depends only on 3.3/3.4/3.6). This test's stand-in agent's
 *     `injectMessage` therefore looks up the just-`accept`ed `WorkRecord`'s
 *     real `workId` from the REAL `supervisor.outstandingWork()` (exactly
 *     the same durable read a real caller with `workIds` in hand would use)
 *     and threads it into the REAL `CodexAppServerPTY.queueTurn()` — the
 *     only way to exercise Task 3.4's real turn-correlation machinery
 *     together with Task 3.3's real `pollCycle()` dispatch given that
 *     pre-existing, out-of-scope gap. Nothing about `acceptBatch`, ledger
 *     phase transitions, `detectWedge`, or `checkWedgeInner` is reimplemented
 *     or mocked anywhere in this file.
 * ---------------------------------------------------------------------------
 */

vi.mock('../../src/bus/event.js', () => ({ logEvent: vi.fn() }));
vi.mock('../../src/bus/system.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/bus/system.js')>()),
  hardRestart: vi.fn(),
}));

const { FastChecker } = await import('../../src/daemon/fast-checker.js');
const { hardRestart } = await import('../../src/bus/system.js');
const { CodexAppServerPTY } = await import('../../src/pty/codex-app-server-pty.js');
const wedgeDetectorModule = await import('../../src/daemon/wedge-detector.js');

type WorkCorrelationEvent = import('../../src/pty/codex-app-server-pty.js').WorkCorrelationEvent;

type ReadyAdapter = InstanceType<typeof CodexAppServerPTY> & {
  _alive: boolean;
  _threadId: string | null;
  _rpc: { request: ReturnType<typeof vi.fn>; respondError: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
  queueTurn(input: unknown[], workIds?: string[]): void;
  handleRpcMessage(message: unknown): void;
};

const requestDefault = vi.fn().mockResolvedValue({ result: {} });

function makeEnv(agentName: string, ctxRoot: string): CtxEnv {
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

/** Byte-for-byte the same construction Task 3.4's own test file uses. */
function makeReadyAdapter(agentName: string, threadId: string, ctxRoot: string): ReadyAdapter {
  const pty = new CodexAppServerPTY(makeEnv(agentName, ctxRoot), {});
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

/** Flush a handful of microtask ticks — same helper Task 3.4's test uses. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/** Mirrors exactly what `agent-process.ts`'s real `forwardWorkCorrelation()`
 * does — the actual production translation from a `WorkCorrelationEvent` to
 * the `LifecycleObservation` shape `AgentLifecycleSupervisor` recognizes. */
function wireCorrelation(pty: ReadyAdapter, supervisor: InstanceType<typeof AgentLifecycleSupervisor>, token: GenerationToken): void {
  pty.onWorkCorrelation((event: WorkCorrelationEvent) => {
    const evidence: Record<string, string | number | boolean | null> = {
      workIds: JSON.stringify(event.workIds),
      turnId: event.turnId,
    };
    if ('error' in event) evidence.error = event.error;
    if ('reason' in event) evidence.reason = event.reason;
    supervisor.observe({ kind: `work-${event.type}`, token, atMs: Date.now(), evidence });
  });
}

function unusedRuntime(): RuntimeAdapter {
  return {
    async startGeneration(): Promise<never> {
      throw new Error('unexpected startGeneration call — Scenario A never spawns/retires a generation');
    },
    async retireGeneration(): Promise<never> {
      throw new Error('unexpected retireGeneration call — Scenario A never spawns/retires a generation');
    },
    async deliver(): Promise<never> {
      throw new Error('unexpected deliver call — dispatch goes through the injectMessage shim, not RuntimeAdapter.deliver()');
    },
  };
}

function fakeBusPaths(ctxRoot: string, agentName: string): BusPaths {
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

function writeInboxMessage(paths: BusPaths, id: string, text = 'do the thing'): void {
  const msg: InboxMessage = {
    id,
    from: 'bob',
    to: 'codex-agent',
    priority: 'normal',
    timestamp: new Date().toISOString(),
    text,
    reply_to: null,
  } as InboxMessage;
  writeFileSync(join(paths.inbox, `${id}.json`), JSON.stringify(msg), 'utf-8');
}

/** Same shape as `fast-checker.test.ts`'s wedge fixtures: a stale
 * conversation buffer + a FRESH heartbeat, both mtimed relative to whatever
 * `Date.now()` reports right now (the fake clock's current value, if fake
 * timers are active) — models the independent 50-minute idle-heartbeat
 * watchdog stamping heartbeat.json throughout a silently stalled turn. */
function writeStaleBufferFreshHeartbeatFixture(paths: BusPaths, staleMinutes: number): void {
  mkdirSync(paths.stateDir, { recursive: true });
  const bufferPath = join(paths.stateDir, 'conversation-buffer.jsonl');
  writeFileSync(bufferPath, '{"turn":1}\n', 'utf-8');
  const staleSec = Math.floor((Date.now() - staleMinutes * 60_000) / 1000);
  utimesSync(bufferPath, staleSec, staleSec);
  const heartbeatPath = join(paths.stateDir, 'heartbeat.json');
  writeFileSync(heartbeatPath, '{"ts":1}', 'utf-8');
  const freshSec = Math.floor(Date.now() / 1000);
  utimesSync(heartbeatPath, freshSec, freshSec);
}

/** Minimal real-enough `AgentProcess` stand-in (see this file's header,
 * point (c)): reports itself running/not-restarting like a real supervised
 * codex agent, and its `injectMessage` bridges the documented, pre-existing
 * workId-threading gap by reading the real workId back out of the real
 * ledger and feeding it into the real `CodexAppServerPTY.queueTurn()`. */
function makeSupervisedStandInAgent(
  name: string,
  pty: ReadyAdapter,
  supervisor: InstanceType<typeof AgentLifecycleSupervisor>,
  /** Called synchronously, exactly at dispatch time — strictly AFTER
   * `acceptBatch` has already committed (this is invoked FROM inside the
   * real `pollCycleSupervisedDispatch`'s dispatch step) and strictly BEFORE
   * that same caller ever removes the transport copy (which only happens
   * after this whole `injectMessage` call returns `true`). This is the
   * actual seam Step 3 needs to observe — not a race against an arbitrary
   * number of awaited ticks from outside. */
  onDispatch?: (content: string) => void,
) {
  return {
    name,
    getConfig: vi.fn().mockReturnValue({ wedge_restart_min: 5, runtime: 'codex-app-server' }),
    isRunning: vi.fn().mockReturnValue(true),
    isRestartInFlight: vi.fn().mockReturnValue(false),
    sessionRefresh: vi.fn().mockResolvedValue(undefined),
    injectMessage: vi.fn().mockImplementation((content: string) => {
      onDispatch?.(content);
      const pending = supervisor.outstandingWork().find((r: WorkRecord) => r.phase === 'accepted');
      if (pending) {
        pty.queueTurn([{ type: 'text', text: content, text_elements: [] }], [pending.workId]);
      }
      return true;
    }),
  } as any;
}

let testDir: string;
let ctxRoot: string;
let paths: BusPaths;
const agentId = canonicalAgentId({ instanceId: 'default', org: 'clearworks', name: 'codex-agent' });

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-scenario-a-test-'));
  ctxRoot = join(testDir, 'instance');
  paths = fakeBusPaths(ctxRoot, 'codex-agent');
  for (const dir of [paths.inbox, paths.inflight, paths.processed, paths.logDir, paths.stateDir]) {
    mkdirSync(dir, { recursive: true });
  }
  requestDefault.mockClear();
  requestDefault.mockResolvedValue({ result: {} });
  vi.mocked(hardRestart).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe('Task 3.9: Scenario A replay — supervised (closed)', () => {
  it('durable acceptance survives a silently stalled dispatch: outstanding work + a wedge ALERT exist despite an empty inbox and a fresh heartbeat', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, unusedRuntime());
    // Task 5.4: spy on the REAL supervisor.request() across the WHOLE
    // scenario (installed before anything runs) so the closing assertions
    // below can prove, at the request-submission level (not just via the
    // hardRestart/sessionRefresh call-count proxies Task 3.9 already
    // checked), that the wedge path specifically never submits a
    // restart/start-shaped LifecycleRequest to the supervisor.
    const requestSpy = vi.spyOn(supervisor, 'request');
    const pty = makeReadyAdapter('codex-agent', 'thread-1', ctxRoot);
    const token: GenerationToken = { agentId, supervisorEpoch: 0, generation: 1 };
    wireCorrelation(pty, supervisor, token);

    // Step 3's ordering proof: populated synchronously by `onDispatch`
    // below, exactly at the moment `pollCycleSupervisedDispatch` calls
    // `agent.injectMessage()` — strictly after `acceptBatch` committed and
    // strictly before that same caller ever removes the transport copy.
    let midDispatch: { outstandingCount: number; phase: string | undefined; inflightExists: boolean; processedExists: boolean } | null = null;
    const agent = makeSupervisedStandInAgent('codex-agent', pty, supervisor, () => {
      midDispatch = {
        outstandingCount: supervisor.outstandingWork().length,
        phase: supervisor.outstandingWork()[0]?.phase,
        inflightExists: existsSync(join(paths.inflight, 'm1.json')),
        processedExists: existsSync(join(paths.processed, 'm1.json')),
      };
    });
    const logs: string[] = [];
    const checker = new FastChecker(agent, paths, ctxRoot, {
      supervisor,
      supervised: true,
      log: (m: string) => logs.push(m),
    });

    // Step 2: deliver the (last) inbox input through the real ingress path.
    writeInboxMessage(paths, 'm1', 'do the thing');

    vi.useFakeTimers();
    try {
      // Step 2 (cont'd): one real pollCycle() iteration.
      const pollPromise = (checker as any).pollCycle();

      // Drains the post-dispatch cooldown sleep(5000) so pollCycle() resolves.
      await vi.advanceTimersByTimeAsync(5000);
      await pollPromise;

      // Step 3: durable acceptance (a real WorkRecord, phase 'accepted')
      // already existed BEFORE the transport copy was removed — proven by
      // the snapshot `onDispatch` captured synchronously mid-dispatch, not
      // by a race against an arbitrary number of awaited ticks.
      expect(midDispatch).not.toBeNull();
      expect(midDispatch!.outstandingCount).toBe(1);
      expect(midDispatch!.phase).toBe('accepted');
      expect(midDispatch!.inflightExists).toBe(true);
      expect(midDispatch!.processedExists).toBe(false);

      // NOW the transport copy is gone — this is what makes the eventual
      // wedge check's "empty inbox" condition genuinely true below, not
      // avoided.
      expect(existsSync(join(paths.inflight, 'm1.json'))).toBe(false);
      expect(existsSync(join(paths.processed, 'm1.json'))).toBe(true);
      expect(readdirSync(paths.inbox).filter((f) => f.endsWith('.json'))).toHaveLength(0);
      expect(readdirSync(paths.inflight).filter((f) => f.endsWith('.json'))).toHaveLength(0);

      // Step 4a: the runtime genuinely accepted the turn (real
      // CodexAppServerPTY turn-queue machinery, real RPC message handling).
      await flush();
      pty.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });

      const midFlight = supervisor.outstandingWork()[0];
      expect(midFlight.phase).toBe('executing');
      expect(midFlight.runtimeTurnId).toBe('turn-1');

      // Step 4b: withhold turn/completed. Advance past Codex's real 30-minute
      // completion timeout (Task 3.4's `createTurnCompletion` default).
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1000);
      await flush();
    } finally {
      // Step 5's fixtures are written under the ADVANCED fake clock, right
      // before the wedge check — see writeStaleBufferFreshHeartbeatFixture's
      // doc comment for why this ordering matters (a heartbeat "written
      // once at the start" would itself read as stale 30 minutes later,
      // which is not what a real 50-minute idle watchdog does).
      writeStaleBufferFreshHeartbeatFixture(paths, 20);
    }

    // Step 5, closure assertions.

    // 1. Outstanding work is non-empty — the timed-out turn reached an
    // explicit, honest "uncertain" outcome (Task 3.4), not silent loss.
    const after = supervisor.outstandingWork();
    expect(after).toHaveLength(1);
    expect(after[0].phase).toBe('needs-review');
    expect(after[0].outcome).toContain('Timed out');

    // 2. The wedge decision is no longer `no-pending-work`, and it is an
    // ALERT, not a restart — this is the literal Scenario A closure.
    const detectWedgeSpy = vi.spyOn(wedgeDetectorModule, 'detectWedge');
    try {
      (checker as any).checkWedgeInner();
    } finally {
      vi.useRealTimers();
    }
    expect(detectWedgeSpy).toHaveBeenCalledTimes(1);
    const decision = detectWedgeSpy.mock.results[0].value as { wedged: boolean; reason: string };
    expect(decision.wedged).toBe(true);
    expect(decision.reason).not.toBe('no-pending-work');

    expect(logs.some((l) => l.includes('WEDGE suspected'))).toBe(true);
    expect(logs.some((l) => l.includes('ALERT ONLY, no automatic restart'))).toBe(true);
    expect(hardRestart).not.toHaveBeenCalled();
    expect(agent.sessionRefresh).not.toHaveBeenCalled();

    // Task 5.4: the alert is genuinely an ALERT, not a restart, at the
    // supervisor-request level — no `restart`- or `start`-shaped
    // `LifecycleRequest` was ever submitted through `supervisor.request()`
    // as a result of the wedge path, across the ENTIRE scenario (the spy was
    // installed before the first pollCycle() ran). Task 3.9's own dispatch
    // path never calls `supervisor.request()` at all (dispatch goes through
    // `acceptBatch`/`observe`, not `request` — see `unusedRuntime()`'s doc
    // comment above), so this scenario's supervisor.request() call count is
    // expected to be exactly zero end to end — a stronger, request-level
    // confirmation of the same "alert, not restart" fact the log/mock-call
    // assertions above already established.
    expect(requestSpy).not.toHaveBeenCalled();
    const restartOrStartRequests = requestSpy.mock.calls
      .map(([req]) => req)
      .filter((req) => req.kind === 'restart' || req.kind === 'start');
    expect(restartOrStartRequests).toHaveLength(0);

    // 3. The empty-inbox and fresh-heartbeat conditions genuinely hold at
    // the moment of the wedge check — the wedge fired DESPITE them, not
    // because they were avoided.
    expect(readdirSync(paths.inbox).filter((f) => f.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(paths.inflight).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('a second input queued behind the withheld-completion turn also reaches an explicit needs-review outcome, not silent loss', async () => {
    const prevSteerDisabled = process.env.CODEX_STEER_DISABLED;
    process.env.CODEX_STEER_DISABLED = '1'; // force real queueing, not steer-merge, for the second input
    let workIdOne = '';
    let workIdTwo = '';

    try {
      const store = new LifecycleStateStore(paths, agentId);
      const supervisor = new AgentLifecycleSupervisor(agentId, store, unusedRuntime());
      const pty = makeReadyAdapter('codex-agent', 'thread-1', ctxRoot);
      const token: GenerationToken = { agentId, supervisorEpoch: 0, generation: 1 };
      wireCorrelation(pty, supervisor, token);

      const agent = makeSupervisedStandInAgent('codex-agent', pty, supervisor);
      const checker = new FastChecker(agent, paths, ctxRoot, { supervisor, supervised: true });

      writeInboxMessage(paths, 'm1', 'first');

      vi.useFakeTimers();
      try {
        const firstPoll = (checker as any).pollCycle();
        await vi.advanceTimersByTimeAsync(5000);
        await firstPoll;

        await flush();
        pty.handleRpcMessage({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
        workIdOne = supervisor.outstandingWork()[0].workId;
        expect(supervisor.outstandingWork()[0].phase).toBe('executing');

        // A second input arrives BEHIND the still-executing turn — a real
        // second pollCycle() accepts and dispatches it, and (with steer
        // disabled) it lands in the real turn queue behind turn-1, exactly
        // like Task 3.4's own queued-input fixture.
        writeInboxMessage(paths, 'm2', 'second');
        const secondPoll = (checker as any).pollCycle();
        await vi.advanceTimersByTimeAsync(5000);
        await secondPoll;

        workIdTwo = supervisor.outstandingWork().find((r) => r.workId !== workIdOne)!.workId;
        expect(supervisor.outstandingWork().find((r) => r.workId === workIdTwo)?.phase).toBe('accepted');

        // Withhold turn/completed for turn-1. Advance past the 30-minute
        // completion timeout — this both times out turn-1 AND strands (and
        // resolves) the queued turn-2 entry, per `drainQueue`'s real catch
        // handling (Task 3.4).
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1000);
        await flush();
      } finally {
        vi.useRealTimers();
      }

      const records = supervisor.outstandingWork();
      expect(records).toHaveLength(2);
      const byId = new Map(records.map((r) => [r.workId, r]));

      expect(byId.get(workIdOne)?.phase).toBe('needs-review');
      expect(byId.get(workIdOne)?.outcome).toContain('Timed out');

      expect(byId.get(workIdTwo)?.phase).toBe('needs-review');
      expect(byId.get(workIdTwo)?.outcome).toContain('queue drained after a prior turn failed');
    } finally {
      if (prevSteerDisabled === undefined) delete process.env.CODEX_STEER_DISABLED;
      else process.env.CODEX_STEER_DISABLED = prevSteerDisabled;
    }
  });
});

describe('Task 3.9: Scenario A replay — CONTROL, pre-supervisor path (unsupervised)', () => {
  it('reproduces the deep dive\'s measured finding: transport copy already gone (pendingOnDisk=0) and wedge={wedged:false, reason:no-pending-work} despite the runtime never having confirmed completion', async () => {
    // supervised omitted (defaults false) — exercises the real pre-Task-3.3
    // `pollCycle()` body verbatim: inject, and only if truthy, immediately
    // splice/ACK, with no acceptance/ledger step at all. No
    // AgentLifecycleSupervisor is even constructed for this describe block —
    // there is nothing for the pre-fix path to consult.
    const agent = {
      name: 'codex-agent',
      getConfig: vi.fn().mockReturnValue({ wedge_restart_min: 5 }),
      isRunning: vi.fn().mockReturnValue(true),
      isRestartInFlight: vi.fn().mockReturnValue(false),
      sessionRefresh: vi.fn().mockResolvedValue(undefined),
      // The pre-fix contract this file's header (b) describes: a bare
      // synchronous boolean, no RPC acceptance or completed-turn awaited.
      // The runtime is modeled as genuinely still executing afterward
      // (adapterExecuting=true in the deep dive's own replay output) —
      // nothing in the pre-fix path ever finds that out.
      injectMessage: vi.fn().mockReturnValue(true),
    } as any;

    const logs: string[] = [];
    const checker = new FastChecker(agent, paths, ctxRoot, { log: (m: string) => logs.push(m) });

    writeInboxMessage(paths, 'task-1', 'do the thing');

    await (checker as any).pollCycle();

    // pendingOnDisk=0 — the transport copy is already gone the INSTANT the
    // bare boolean came back true, with no durable acceptance step ever
    // having run.
    expect(agent.injectMessage).toHaveBeenCalledTimes(1);
    expect(existsSync(join(paths.inflight, 'task-1.json'))).toBe(false);
    expect(existsSync(join(paths.processed, 'task-1.json'))).toBe(true);
    expect(readdirSync(paths.inbox).filter((f) => f.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(paths.inflight).filter((f) => f.endsWith('.json'))).toHaveLength(0);

    // Simulate the runtime silently still executing (the deep dive's
    // "adapterExecuting=true") for a good while, with the independent
    // 50-minute idle heartbeat watchdog keeping heartbeat.json fresh
    // throughout — the exact fixture shape section 3A's replay used.
    writeStaleBufferFreshHeartbeatFixture(paths, 20);

    const detectWedgeSpy = vi.spyOn(wedgeDetectorModule, 'detectWedge');
    (checker as any).checkWedgeInner();

    // wedge={wedged:false, reason:no-pending-work} — the load-bearing
    // falsification target. There is no ledger to consult in this
    // unsupervised path at all, so `hasPendingWork` is exactly the bare bus
    // inbox/inflight check, which just went empty above.
    expect(detectWedgeSpy).toHaveBeenCalledTimes(1);
    const decision = detectWedgeSpy.mock.results[0].value as { wedged: boolean; reason: string };
    expect(decision).toEqual({ wedged: false, reason: 'no-pending-work' });
    expect(logs.some((l) => l.includes('WEDGE suspected'))).toBe(false);
  });
});
