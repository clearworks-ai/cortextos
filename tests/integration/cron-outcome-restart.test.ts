import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendCronOutcome, cronRunId, getCronOutcome } from '../../src/bus/cron-outcome';
import { writeCrons } from '../../src/bus/crons';
import { CronScheduler } from '../../src/daemon/cron-scheduler';

describe('CronScheduler durable restart recovery', () => {
  let ctxRoot: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:05:00.000Z'));
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-cron-restart-'));
    previousRoot = process.env.CTX_ROOT;
    process.env.CTX_ROOT = ctxRoot;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = previousRoot;
    vi.useRealTimers();
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('does not replay a delivered run whose dispatched receipt failed before restart', async () => {
    const agent = 'restart-agent';
    const cron = 'hourly';
    const scheduledAt = '2026-08-07T00:00:00.000Z';
    const stateDir = join(ctxRoot, 'state', agent);
    const runId = cronRunId(stateDir, agent, cron, scheduledAt);
    appendCronOutcome(stateDir, { run_id: runId, attempt: 1, agent, cron, state: 'scheduled', at: scheduledAt, scheduled_at: scheduledAt });
    appendCronOutcome(stateDir, { run_id: runId, attempt: 1, agent, cron, state: 'started', at: '2026-08-07T00:00:01.000Z', scheduled_at: scheduledAt });
    writeCrons(agent, [{
      name: cron,
      prompt: 'run hourly',
      schedule: '1h',
      enabled: true,
      created_at: '2026-08-01T00:00:00.000Z',
      last_fired_at: '2026-08-07T00:00:02.000Z',
      fire_count: 1,
    }]);

    const fired: string[] = [];
    const restarted = new CronScheduler({ agentName: agent, outcomeStateDir: stateDir, onFire: (_definition, context) => { fired.push(context.runId); }, logger: () => undefined });
    restarted.start();
    await vi.advanceTimersByTimeAsync(CronScheduler.TICK_INTERVAL_MS);
    expect(fired).toEqual([]);
    expect(getCronOutcome(stateDir, runId)?.state).toBe('dispatched');

    await vi.advanceTimersByTimeAsync(60 * 60_000 + CronScheduler.TICK_INTERVAL_MS);
    restarted.stop();
    expect(fired).toHaveLength(1);
    expect(fired[0]).not.toBe(runId);
  });
});
