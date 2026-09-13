/**
 * tests/integration/lifecycle-ingress.test.ts
 *
 * Task 3.7: Transport and cron ingress ownership.
 *
 * Exercises the real `AgentLifecycleSupervisor` + `LifecycleStateStore` (a
 * temp-fixture-backed ledger, not a mock) together with a real `FastChecker`
 * (Buzz) and a real `CronScheduler` (cron retry backoff), proving:
 *
 *   1. Buzz ingress now gets the same durable-acceptance treatment as
 *      Telegram/Slack (Step 1/5) — a real `NostrEvent.id`-derived sourceKey
 *      produces a durable `WorkRecord` strictly before dispatch, and a
 *      failed dispatch leaves it queued for retry rather than losing it.
 *   2. A dispatch failure (not a crash) on redelivery resolves to the SAME
 *      `WorkRecord`, never a duplicate (sourceKey-based dedup).
 *   3. The exact Step 3 interleaving scenario: a cron retry suspended
 *      mid-backoff and a Telegram batch durably accepted but not yet
 *      dispatched, both suspended when a stop lands and a successor
 *      generation starts — released afterward, neither injects into the
 *      successor, and the accepted-but-undispatched work stays durably
 *      owned rather than silently dropped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { BusPaths } from '../../src/types/index';
import { FastChecker } from '../../src/daemon/fast-checker';
import { LifecycleStateStore } from '../../src/daemon/lifecycle/state-store';
import { AgentLifecycleSupervisor, type RuntimeAdapter } from '../../src/daemon/lifecycle/supervisor';
import type { EffectToken, OwnedResource } from '../../src/daemon/lifecycle/types';
import { dispatchCronFire, CronDispatchError } from '../../src/daemon/cron-dispatch';

// ---------------------------------------------------------------------------
// Mock crons.ts I/O for the CronScheduler-driving portion of this file — same
// pattern as tests/unit/daemon/cron-scheduler.test.ts / lifecycle-dispatch.test.ts.
// ---------------------------------------------------------------------------

const mockReadCrons = vi.fn();
const mockUpdateCron = vi.fn();
const mockReadCronsWithStatus = vi.fn();
const mockAppendCronOutcome = vi.fn();
const mockGetActiveCronOutcome = vi.fn();
const mockCronsFileMtimeMs = vi.fn();

vi.mock('../../src/bus/crons.js', () => ({
  readCrons: (...args: unknown[]) => mockReadCrons(...args),
  readCronsWithStatus: (...args: unknown[]) => mockReadCronsWithStatus(...args),
  updateCron: (...args: unknown[]) => mockUpdateCron(...args),
  cronsFileMtimeMs: (...args: unknown[]) => mockCronsFileMtimeMs(...args),
}));

vi.mock('../../src/bus/cron-outcome.js', () => ({
  appendCronOutcome: (...args: unknown[]) => mockAppendCronOutcome(...args),
  cronRunId: () => 'cron_v1_0123456789abcdef0123456789abcdef',
  getActiveCronOutcome: (...args: unknown[]) => mockGetActiveCronOutcome(...args),
}));

// eslint-disable-next-line import/first
import { CronScheduler } from '../../src/daemon/cron-scheduler';
// eslint-disable-next-line import/first
import type { CronDefinition } from '../../src/types/index';

function makeCronDef(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'test-cron',
    prompt: 'Do something.',
    schedule: '1m',
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const TICK = CronScheduler.TICK_INTERVAL_MS;

function createTestPaths(testDir: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

function createMockAgent(name = 'test-agent') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
  } as any;
}

/** Immediate fake RuntimeAdapter — real start/retire bookkeeping happens in
 * the ledger via the supervisor itself; this only needs to resolve without
 * throwing so `request()` can commit past 'starting'/'retiring'. */
function makeImmediateRuntime(): RuntimeAdapter {
  return {
    async startGeneration(): Promise<{ ok: true; resources: OwnedResource[] }> {
      return { ok: true, resources: [] };
    },
    async retireGeneration(_token, resources) {
      return { status: 'retired', released: resources };
    },
    async deliver() {
      return { ok: true, workIds: [], batchId: 'unused' };
    },
  };
}

describe('Buzz ingress durable acceptance (Task 3.7 Step 1/5)', () => {
  let testDir: string;
  let paths: BusPaths;
  const agentId = 'test-instance/test-org/buzz-agent';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-ingress-buzz-'));
    paths = createTestPaths(testDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeSupervisedChecker() {
    const agent = createMockAgent('buzz-agent');
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeImmediateRuntime());
    const checker = new FastChecker(agent, paths, '/tmp/framework', { supervisor, supervised: true });
    return { agent, supervisor, checker };
  }

  it('a real NostrEvent.id-derived sourceKey produces one durable WorkRecord before dispatch, and drains the queue only after dispatch succeeds', async () => {
    const { agent, supervisor, checker } = makeSupervisedChecker();
    const formatted = FastChecker.formatBuzzTextMessage('sender-pubkey', 'chan-1', 'hello from buzz');
    const sourceKey = 'buzz/chan-1/nostr-event-id-abc123';
    (checker as any).queueBuzzMessage(formatted, sourceKey);

    await (checker as any).pollCycle();

    expect(agent.injectMessage).toHaveBeenCalledTimes(1);
    expect(String(agent.injectMessage.mock.calls[0][0])).toContain('hello from buzz');
    expect((checker as any).buzzMessages).toHaveLength(0);

    const records = supervisor.outstandingWork();
    expect(records).toHaveLength(1);
    expect(records[0].sourceKey).toBe(sourceKey);
    expect(records[0].phase).toBe('accepted');
  });

  it('a dispatch failure (agent not running) leaves the Buzz message queued and its WorkRecord in place for redelivery', async () => {
    const { agent, supervisor, checker } = makeSupervisedChecker();
    agent.injectMessage.mockReturnValue(false); // NOT_RUNNING
    const formatted = FastChecker.formatBuzzTextMessage('sender-pubkey', 'chan-1', 'will not deliver yet');
    const sourceKey = 'buzz/chan-1/nostr-event-id-def456';
    (checker as any).queueBuzzMessage(formatted, sourceKey);

    await (checker as any).pollCycle();

    // Durable acceptance still happened (accept-before-dispatch) —
    expect(supervisor.outstandingWork()).toHaveLength(1);
    // — but the queue was NOT drained, since dispatch itself failed.
    expect((checker as any).buzzMessages).toHaveLength(1);

    // Redelivery: agent comes back, same queued message, same sourceKey.
    agent.injectMessage.mockReturnValue(true);
    await (checker as any).pollCycle();

    expect((checker as any).buzzMessages).toHaveLength(0);
    const records = supervisor.outstandingWork();
    // Exactly ONE WorkRecord total — the redelivery resolved to the SAME
    // record via acceptBatch's sourceKey/payloadDigest dedup, not a new one.
    expect(records).toHaveLength(1);
    expect(records[0].sourceKey).toBe(sourceKey);
  });
});

describe('Telegram redelivery after a durable-write failure resolves to the SAME WorkRecord (Task 3.7)', () => {
  let testDir: string;
  let paths: BusPaths;
  const agentId = 'test-instance/test-org/telegram-agent';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-ingress-telegram-'));
    paths = createTestPaths(testDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('a dispatch failure after successful acceptance does not drain the queue; the next cycle\'s acceptBatch resolves to the same workId', async () => {
    const agent = createMockAgent('telegram-agent');
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeImmediateRuntime());
    const checker = new FastChecker(agent, paths, '/tmp/framework', { supervisor, supervised: true });

    agent.injectMessage.mockReturnValue(false); // simulate NOT_RUNNING on the first attempt
    const sourceKey = 'telegram/chat1/999';
    checker.queueTelegramMessage('=== TELEGRAM redelivery test ===\n', sourceKey);

    await (checker as any).pollCycle();
    const firstPassRecords = supervisor.outstandingWork();
    expect(firstPassRecords).toHaveLength(1);
    const firstWorkId = firstPassRecords[0].workId;
    // Queue was not drained — dispatch failed.
    expect((checker as any).telegramMessages).toHaveLength(1);

    // Now the agent is back — redelivery of the SAME still-queued message.
    agent.injectMessage.mockReturnValue(true);
    await (checker as any).pollCycle();

    expect((checker as any).telegramMessages).toHaveLength(0);
    const secondPassRecords = supervisor.outstandingWork();
    expect(secondPassRecords).toHaveLength(1); // not two — same record, not a duplicate
    expect(secondPassRecords[0].workId).toBe(firstWorkId);
    expect(secondPassRecords[0].sourceKey).toBe(sourceKey);
  });
});

describe('Cron dispatch structured outcome against a real ledger (Task 3.7 Step 4)', () => {
  let testDir: string;
  let paths: BusPaths;
  const agentId = 'test-instance/test-org/cron-agent';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-ingress-cron-'));
    paths = createTestPaths(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('a fire against a stopped agent durably accepts the payload (never lost) then throws a structured NOT_RUNNING CronDispatchError, not a generic Error', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeImmediateRuntime());

    let caught: unknown;
    try {
      await dispatchCronFire(
        `cron/${agentId}/nightly-report/run-1:1`,
        '[CRON FIRED] nightly-report: do the thing',
        'digest-nightly-1',
        {
          acceptBatch: (inputs) => supervisor.acceptBatch(inputs),
          mintEffect: () => ({
            agentId,
            supervisorEpoch: supervisor.snapshot().supervisorEpoch,
            generation: supervisor.snapshot().currentGeneration ?? 0,
            intentRevision: supervisor.snapshot().intentRevision,
            effectId: randomUUID(),
          }),
          injectDetailed: async () => ({
            ok: false,
            code: 'NOT_RUNNING',
            retryable: true,
            message: 'agent "cron-agent" is registered but not running',
          }),
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CronDispatchError);
    expect((caught as CronDispatchError).code).toBe('NOT_RUNNING');
    expect((caught as CronDispatchError).retryable).toBe(true);

    // The durable accept happened BEFORE the failed dispatch attempt — the
    // cron's payload is not lost, it stays recorded in the ledger.
    const records = supervisor.outstandingWork();
    expect(records).toHaveLength(1);
    expect(records[0].sourceKey).toBe(`cron/${agentId}/nightly-report/run-1:1`);
    expect(records[0].phase).toBe('accepted');
  });
});

describe('Step 3: suspended cron retry + accepted-but-undispatched Telegram batch, across a stop-then-successor-start (Task 3.7)', () => {
  let testDir: string;
  let paths: BusPaths;
  const agentId = 'test-instance/test-org/interleave-agent';

  beforeEach(() => {
    vi.useFakeTimers();
    mockReadCrons.mockReset();
    mockUpdateCron.mockReset();
    mockAppendCronOutcome.mockReset();
    mockGetActiveCronOutcome.mockReset();
    mockGetActiveCronOutcome.mockReturnValue(undefined);
    mockReadCronsWithStatus.mockReset();
    mockCronsFileMtimeMs.mockReset();
    mockReadCronsWithStatus.mockImplementation((agent: string) => ({
      crons: mockReadCrons(agent) ?? [],
      corrupt: false,
    }));
    mockCronsFileMtimeMs.mockReturnValue(1000);

    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-ingress-interleave-'));
    paths = createTestPaths(testDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('suspend a cron retry and an accepted Telegram batch; stop; start a successor; release both — neither injects into the successor, and the accepted work stays owned', async () => {
    const store = new LifecycleStateStore(paths, agentId);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, makeImmediateRuntime());

    // --- Bring up generation 1 ---------------------------------------------
    const startReceipt = await supervisor.request({
      requestId: randomUUID(),
      kind: 'start',
      cause: 'manual-cli',
      mode: 'continue',
      observedGeneration: null,
      userInitiated: true,
      evidence: {},
      requestedAtMs: Date.now(),
    });
    expect(startReceipt.accepted).toBe(true);
    expect(startReceipt.generation).toBe(1);

    // Capture an EffectToken exactly as a caller would mint one BEFORE the
    // stop below (mirrors mintManualEffect() / FastChecker's dispatch path).
    const preStopSnapshot = supervisor.snapshot();
    const capturedEffect: EffectToken = {
      agentId,
      supervisorEpoch: preStopSnapshot.supervisorEpoch,
      generation: preStopSnapshot.currentGeneration ?? 0,
      intentRevision: preStopSnapshot.intentRevision,
      effectId: 'captured-before-stop',
    };
    // Sanity: valid against the live (pre-stop) generation.
    expect(supervisor.isEffectLive(capturedEffect)).toBe(true);

    // --- "A received Telegram batch (accepted but not yet dispatched)" ----
    const acceptResult = await supervisor.acceptBatch([
      { sourceKey: 'telegram/chat1/1', payload: '=== TELEGRAM suspended ===\n', payloadDigest: 'digest-tg-1' },
    ]);
    expect(acceptResult.ok).toBe(true);
    if (!acceptResult.ok) throw new Error('unreachable');
    const telegramWorkId = acceptResult.workIds[0];

    // --- "Suspend a cron retry (paused mid-backoff)" -----------------------
    const cronOnFire = vi.fn().mockRejectedValue(new Error('transient — agent about to be stopped'));
    mockReadCrons.mockReturnValue([
      makeCronDef({ schedule: '24h', last_fired_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }),
    ]);
    const ingressAbort = new AbortController();
    const scheduler = new CronScheduler({
      agentName: 'interleave-agent',
      onFire: cronOnFire,
      logger: () => {},
      signal: ingressAbort.signal,
    });
    scheduler.start();
    // Let the catch-up fire happen and enter its 1s backoff.
    await vi.advanceTimersByTimeAsync(TICK + 500);
    expect(cronOnFire).toHaveBeenCalledTimes(1);

    // --- "stop the generation" ---------------------------------------------
    // Mirrors agent-manager.ts's real teardown sequence: abort ingress first,
    // then the supervisor stop request, then the scheduler's own stop().
    ingressAbort.abort();
    scheduler.stop();
    const stopReceipt = await supervisor.request({
      requestId: randomUUID(),
      kind: 'stop',
      cause: 'manual-cli',
      mode: null,
      observedGeneration: null,
      userInitiated: true,
      evidence: {},
      requestedAtMs: Date.now(),
    });
    expect(stopReceipt.accepted).toBe(true);

    // --- "start a successor" ------------------------------------------------
    const successorReceipt = await supervisor.request({
      requestId: randomUUID(),
      kind: 'start',
      cause: 'manual-cli',
      mode: 'continue',
      observedGeneration: null,
      userInitiated: true,
      evidence: {},
      requestedAtMs: Date.now(),
    });
    expect(successorReceipt.accepted).toBe(true);
    expect(successorReceipt.generation).toBe(2); // a genuinely new generation

    // --- "release both suspended operations" --------------------------------
    // (a) the cron retry: advancing past every remaining backoff must NOT
    // produce another dispatch attempt — the abort already stopped it.
    await vi.advanceTimersByTimeAsync(1_000 + 4_000 + 16_000 + 1_000);
    expect(cronOnFire).toHaveBeenCalledTimes(1);

    // (b) the captured pre-stop EffectToken must now be stale — any dispatch
    // attempt using it (AgentProcess.injectMessageDetailed's isEffectLive
    // check) would be rejected as REVOKED rather than reaching generation 2's
    // PTY.
    expect(supervisor.isEffectLive(capturedEffect)).toBe(false);

    // --- "every accepted input remains owned ... not silently dropped" -----
    const finalRecords = supervisor.outstandingWork();
    const telegramRecord = finalRecords.find((r) => r.workId === telegramWorkId);
    expect(telegramRecord).toBeDefined();
    expect(telegramRecord?.sourceKey).toBe('telegram/chat1/1');
    expect(telegramRecord?.phase).toBe('accepted'); // never silently completed or lost
  });
});
