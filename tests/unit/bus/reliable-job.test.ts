import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runReliableJob,
  runWrappedCommand,
  writeHeartbeat,
  readJobState,
  checkMissedFires,
  bareSpawn,
} from '../../../src/bus/reliable-job.js';

describe('reliable-job', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'rj-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('success path commits watermarks and clears failures', async () => {
    const result = await runReliableJob(
      {
        jobName: 't1',
        stateDir,
        expectedIntervalMs: 60_000,
        sleepFn: async () => undefined,
      },
      async (ctx) => {
        expect(ctx.isUnchanged('k', 'h1')).toBe(false);
        ctx.commit('k', 'h1');
      },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    const state = readJobState(stateDir, 't1');
    expect(state?.last_success_at).toBeTruthy();
    expect(state?.consecutive_failures).toBe(0);
    expect(state?.watermarks.k).toBe('h1');
  });

  it('retries with backoff then succeeds', async () => {
    const delays: number[] = [];
    let n = 0;
    const result = await runReliableJob(
      {
        jobName: 't2',
        stateDir,
        expectedIntervalMs: 60_000,
        maxRetries: 3,
        backoffBaseMs: 10,
        sleepFn: async (ms) => {
          delays.push(ms);
        },
      },
      async () => {
        n += 1;
        if (n < 3) throw new Error('fail');
      },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('failure exhaustion does not persist staged watermarks', async () => {
    const result = await runReliableJob(
      {
        jobName: 't3',
        stateDir,
        expectedIntervalMs: 60_000,
        maxRetries: 2,
        backoffBaseMs: 1,
        sleepFn: async () => undefined,
      },
      async (ctx) => {
        ctx.commit('k', 'should-not-stick');
        throw new Error('always');
      },
    );
    expect(result.ok).toBe(false);
    const state = readJobState(stateDir, 't3');
    expect(state?.last_success_at).toBeNull();
    expect(state?.last_error).toContain('always');
    expect(state?.watermarks.k).toBeUndefined();
  });

  it('isUnchanged true only after successful commit', async () => {
    await runReliableJob(
      {
        jobName: 't4',
        stateDir,
        expectedIntervalMs: 60_000,
        sleepFn: async () => undefined,
      },
      async (ctx) => {
        ctx.commit('k', 'abc');
      },
    );
    await runReliableJob(
      {
        jobName: 't4',
        stateDir,
        expectedIntervalMs: 60_000,
        sleepFn: async () => undefined,
      },
      async (ctx) => {
        expect(ctx.isUnchanged('k', 'abc')).toBe(true);
        expect(ctx.isUnchanged('k', 'zzz')).toBe(false);
      },
    );
  });

  it('skipUnchanged skips run and heartbeats success', async () => {
    const f = join(stateDir, 'in.txt');
    writeFileSync(f, 'data');
    const first = await runWrappedCommand({
      jobName: 'skip',
      stateDir,
      expectedIntervalMs: 60_000,
      command: process.execPath,
      args: ['-e', "console.log('ran'); process.exit(0)"],
      watermarkFiles: [f],
      captureStdout: true,
      sleepFn: async () => undefined,
    });
    expect(first.ok).toBe(true);
    expect(first.attempts).toBe(1);

    const second = await runWrappedCommand({
      jobName: 'skip',
      stateDir,
      expectedIntervalMs: 60_000,
      command: process.execPath,
      args: ['-e', "console.log('ran2'); process.exit(0)"],
      watermarkFiles: [f],
      skipUnchanged: true,
      captureStdout: true,
      sleepFn: async () => undefined,
    });
    expect(second.ok).toBe(true);
    expect(second.attempts).toBe(0);
    expect(readJobState(stateDir, 'skip')?.last_success_at).toBeTruthy();
  });

  it('key rotation: work fails on k1, rotates, succeeds on k2', async () => {
    const seen: Array<string | undefined> = [];
    const result = await runReliableJob(
      {
        jobName: 'rot',
        stateDir,
        expectedIntervalMs: 60_000,
        maxRetries: 3,
        backoffBaseMs: 1,
        apiKeys: ['k1', 'k2'],
        sleepFn: async () => undefined,
      },
      async (ctx) => {
        seen.push(ctx.currentApiKey());
        if (ctx.currentApiKey() === 'k1') {
          ctx.rotateApiKey();
          throw new Error('auth');
        }
      },
    );
    expect(result.ok).toBe(true);
    expect(seen[0]).toBe('k1');
    expect(seen).toContain('k2');
  });

  it('runWrappedCommand auto-rotates api key pool on non-zero exit', async () => {
    const script = join(stateDir, 'rot.js');
    writeFileSync(
      script,
      `const k=process.env.RELIABLE_JOB_API_KEY; if(k==='k1') process.exit(2); console.log('ok-'+k);`,
    );
    const result = await runWrappedCommand({
      jobName: 'wrap-rot',
      stateDir,
      expectedIntervalMs: 60_000,
      maxRetries: 3,
      backoffBaseMs: 1,
      command: process.execPath,
      args: [script],
      apiKeys: ['k1', 'k2'],
      captureStdout: true,
      sleepFn: async () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('ok-k2');
  });

  it('transparency: stdout and exit parity with bare spawnSync', async () => {
    const bareOk = bareSpawn(process.execPath, ['-e', "process.stdout.write('hi'); process.exit(0)"]);
    const wrapOk = await runWrappedCommand({
      jobName: 'tp-ok',
      stateDir,
      expectedIntervalMs: 60_000,
      command: process.execPath,
      args: ['-e', "process.stdout.write('hi'); process.exit(0)"],
      captureStdout: true,
      maxRetries: 1,
      sleepFn: async () => undefined,
    });
    expect(wrapOk.stdout).toBe(bareOk.stdout);
    expect(wrapOk.exitCode).toBe(bareOk.status);

    const bareFail = bareSpawn(process.execPath, ['-e', 'process.exit(3)']);
    const wrapFail = await runWrappedCommand({
      jobName: 'tp-fail',
      stateDir,
      expectedIntervalMs: 60_000,
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      captureStdout: true,
      maxRetries: 1,
      sleepFn: async () => undefined,
    });
    expect(wrapFail.ok).toBe(false);
    expect(wrapFail.exitCode).toBe(bareFail.status);
  });

  it('checkMissedFires: never-succeeded, healthy, stale', () => {
    writeHeartbeat(stateDir, 'failed-once', {
      success: false,
      intervalMs: 60_000,
      error: 'x',
    });
    writeHeartbeat(stateDir, 'healthy', { success: true, intervalMs: 3_600_000 });
    writeHeartbeat(stateDir, 'stale', { success: true, intervalMs: 60_000 });
    const stale = readJobState(stateDir, 'stale')!;
    stale.last_success_at = new Date(Date.now() - 200_000).toISOString();
    writeFileSync(join(stateDir, 'stale.json'), JSON.stringify(stale, null, 2) + '\n');

    const now = new Date();
    const alerts = checkMissedFires(stateDir, now);
    const names = alerts.map((a) => a.jobName);
    expect(names).toContain('failed-once');
    expect(names).toContain('stale');
    expect(names).not.toContain('healthy');
    const staleAlert = alerts.find((a) => a.jobName === 'stale')!;
    expect(staleAlert.overdueMs).toBeGreaterThan(0);
  });

  it('writeHeartbeat atomic round-trip produces parseable JSON', () => {
    writeHeartbeat(stateDir, 'hb', { success: true, intervalMs: 1000 });
    const p = join(stateDir, 'hb.json');
    expect(existsSync(p)).toBe(true);
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    expect(parsed.job_name).toBe('hb');
    expect(parsed.last_success_at).toBeTruthy();
  });
});
