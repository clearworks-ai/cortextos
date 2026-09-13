/**
 * tests/unit/daemon/lifecycle-dispatch.test.ts
 *
 * Task 3.7: Transport and cron ingress ownership.
 *
 * Two things live in this file:
 *
 * 1. `dispatchCronFire` (`src/daemon/cron-dispatch.ts`) — the extracted,
 *    dependency-injected cron dispatch body. Pure unit tests with fake
 *    `acceptBatch`/`injectDetailed` deps, no real supervisor/store/PTY
 *    needed: proves cron dispatch now durably accepts BEFORE ever
 *    attempting delivery, and that every failure mode (durable-write
 *    failure, NOT_RUNNING, REVOKED, DUPLICATE) surfaces as a structured
 *    `CronDispatchError` (real `.code`/`.retryable`) rather than the old
 *    generic thrown `Error`.
 *
 * 2. `CronScheduler`'s retry-backoff cancellation (Task 3.7 Step 2) — the
 *    "surviving cron-retry-injects-into-successor hole" PHASES.md names:
 *    stopping the scheduler (or aborting an externally-supplied `signal`)
 *    while a fire's retry backoff is in flight must stop that fire cycle
 *    from making any further dispatch attempt, rather than running the
 *    backoff out to completion after the interval/schedule are already
 *    gone. Verified with fake timers — no real 1s/4s/16s wait.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock crons.ts I/O BEFORE importing CronScheduler — same pattern as
// tests/unit/daemon/cron-scheduler.test.ts.
// ---------------------------------------------------------------------------

const mockReadCrons = vi.fn();
const mockUpdateCron = vi.fn();
const mockReadCronsWithStatus = vi.fn();
const mockAppendCronOutcome = vi.fn();
const mockGetActiveCronOutcome = vi.fn();
const mockCronsFileMtimeMs = vi.fn();

vi.mock('../../../src/bus/crons.js', () => ({
  readCrons: (...args: unknown[]) => mockReadCrons(...args),
  readCronsWithStatus: (...args: unknown[]) => mockReadCronsWithStatus(...args),
  updateCron: (...args: unknown[]) => mockUpdateCron(...args),
  cronsFileMtimeMs: (...args: unknown[]) => mockCronsFileMtimeMs(...args),
}));

vi.mock('../../../src/bus/cron-outcome.js', () => ({
  appendCronOutcome: (...args: unknown[]) => mockAppendCronOutcome(...args),
  cronRunId: () => 'cron_v1_0123456789abcdef0123456789abcdef',
  getActiveCronOutcome: (...args: unknown[]) => mockGetActiveCronOutcome(...args),
}));

import { CronScheduler } from '../../../src/daemon/cron-scheduler';
import { dispatchCronFire, CronDispatchError } from '../../../src/daemon/cron-dispatch';
import type { CronDefinition } from '../../../src/types/index';
import type { DispatchResult, EffectToken } from '../../../src/daemon/lifecycle/types';

function makeCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
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

const fakeEffect: EffectToken = {
  agentId: 'default/clearworks/knox',
  supervisorEpoch: 1,
  generation: 1,
  intentRevision: 0,
  effectId: 'effect-1',
};

describe('dispatchCronFire', () => {
  it('resolves without throwing when acceptBatch and dispatch both succeed', async () => {
    const acceptBatch = vi.fn().mockResolvedValue({ ok: true, workIds: ['work-1'], batchId: 'batch-1' });
    const injectDetailed = vi.fn().mockResolvedValue({ ok: true, workIds: ['work-1'], batchId: 'batch-1' } as DispatchResult);

    await expect(
      dispatchCronFire('cron/agent/x/run1:1', 'injection text', 'digest-1', {
        acceptBatch,
        mintEffect: () => fakeEffect,
        injectDetailed,
      }),
    ).resolves.toBeUndefined();

    expect(acceptBatch).toHaveBeenCalledWith([
      { sourceKey: 'cron/agent/x/run1:1', payload: 'injection text', payloadDigest: 'digest-1' },
    ]);
    expect(injectDetailed).toHaveBeenCalledWith('injection text', fakeEffect, ['work-1']);
  });

  it('throws a structured, retryable ACCEPT_FAILED CronDispatchError when the durable write fails — never attempts dispatch', async () => {
    const acceptBatch = vi.fn().mockResolvedValue({ ok: false, reason: 'disk full' });
    const injectDetailed = vi.fn();

    let caught: unknown;
    try {
      await dispatchCronFire('k', 'p', 'd', { acceptBatch, mintEffect: () => fakeEffect, injectDetailed });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CronDispatchError);
    const err = caught as CronDispatchError;
    expect(err.code).toBe('ACCEPT_FAILED');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('disk full');
    expect(injectDetailed).not.toHaveBeenCalled();
  });

  it('throws a structured, retryable NOT_RUNNING CronDispatchError when the agent is stopped — replaces the old generic thrown Error', async () => {
    const acceptBatch = vi.fn().mockResolvedValue({ ok: true, workIds: ['work-1'], batchId: 'batch-1' });
    const injectDetailed = vi.fn().mockResolvedValue({
      ok: false,
      code: 'NOT_RUNNING',
      retryable: true,
      message: 'agent "x" is registered but not running',
    } as DispatchResult);

    let caught: unknown;
    try {
      await dispatchCronFire('k', 'p', 'd', { acceptBatch, mintEffect: () => fakeEffect, injectDetailed });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CronDispatchError);
    const err = caught as CronDispatchError;
    expect(err.code).toBe('NOT_RUNNING');
    expect(err.retryable).toBe(true);
  });

  it('throws a structured, non-retryable REVOKED CronDispatchError when a fire lands mid-teardown', async () => {
    const acceptBatch = vi.fn().mockResolvedValue({ ok: true, workIds: ['work-1'], batchId: 'batch-1' });
    const injectDetailed = vi.fn().mockResolvedValue({
      ok: false,
      code: 'REVOKED',
      retryable: false,
      message: 'inject revoked — generation/intent no longer current',
    } as DispatchResult);

    let caught: unknown;
    try {
      await dispatchCronFire('k', 'p', 'd', { acceptBatch, mintEffect: () => fakeEffect, injectDetailed });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CronDispatchError);
    const err = caught as CronDispatchError;
    expect(err.code).toBe('REVOKED');
    expect(err.retryable).toBe(false);
  });

  it('throws a structured, non-retryable DUPLICATE CronDispatchError rather than silently treating it as delivered', async () => {
    const acceptBatch = vi.fn().mockResolvedValue({ ok: true, workIds: ['work-1'], batchId: 'batch-1' });
    const injectDetailed = vi.fn().mockResolvedValue({
      ok: false,
      code: 'DUPLICATE',
      retryable: false,
      existingWorkIds: ['work-0'],
      message: 'duplicate of existing dispatch',
    } as DispatchResult);

    let caught: unknown;
    try {
      await dispatchCronFire('k', 'p', 'd', { acceptBatch, mintEffect: () => fakeEffect, injectDetailed });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CronDispatchError);
    const err = caught as CronDispatchError;
    expect(err.code).toBe('DUPLICATE');
    expect(err.retryable).toBe(false);
  });
});

describe('CronScheduler retry-backoff cancellation (Task 3.7 Step 2)', () => {
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    logs = [];
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
  });

  it('an externally-supplied signal aborted mid-backoff stops further dispatch attempts', async () => {
    const onFire = vi.fn().mockRejectedValue(new Error('agent stopped'));
    // Catch-up fire: schedule is far overdue, so the first tick fires immediately.
    mockReadCrons.mockReturnValue([
      makeCron({ schedule: '24h', last_fired_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }),
    ]);

    const controller = new AbortController();
    const scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire,
      logger: (msg) => logs.push(msg),
      signal: controller.signal,
    });
    scheduler.start();

    // Let the first tick fire and the first attempt fail — it is now
    // sleeping in the 1s backoff (RETRY_DELAYS_MS[0]).
    await vi.advanceTimersByTimeAsync(TICK + 500);
    expect(onFire).toHaveBeenCalledTimes(1);

    // Simulate the owning agent's teardown landing mid-backoff.
    controller.abort();

    // Advance well past every remaining backoff (1s+4s+16s) — if the abort
    // were not honored, this would produce 3 more onFire calls (4 total).
    await vi.advanceTimersByTimeAsync(1_000 + 4_000 + 16_000 + 1_000);

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('aborted'))).toBe(true);

    scheduler.stop();
    vi.useRealTimers();
  });

  it('stop() aborts its own signal even with no external signal supplied — an in-flight backoff is still cancelled', async () => {
    const onFire = vi.fn().mockRejectedValue(new Error('agent stopped'));
    mockReadCrons.mockReturnValue([
      makeCron({ schedule: '24h', last_fired_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }),
    ]);

    const scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire,
      logger: (msg) => logs.push(msg),
      // No `signal` option — this is the pre-Task-3.7 call shape.
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK + 500);
    expect(onFire).toHaveBeenCalledTimes(1);

    // stop() (called here the same way agent-manager.ts's teardown calls it)
    // must cancel the in-flight backoff on its own, with no external signal.
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(1_000 + 4_000 + 16_000 + 1_000);

    expect(onFire).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('without any abort, the full 4-attempt retry/give-up behavior is unchanged (no regression)', async () => {
    const onFire = vi.fn().mockRejectedValue(new Error('transient'));
    mockReadCrons.mockReturnValue([
      makeCron({ schedule: '24h', last_fired_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }),
    ]);

    const scheduler = new CronScheduler({
      agentName: 'test-agent',
      onFire,
      logger: (msg) => logs.push(msg),
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(TICK + 1_000 + 4_000 + 16_000 + 1_000);

    expect(onFire).toHaveBeenCalledTimes(4);
    expect(logs.some((l) => l.includes('giving up'))).toBe(true);

    scheduler.stop();
    vi.useRealTimers();
  });
});
