import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

export interface JobState {
  job_name: string;
  expected_interval_ms: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_exit_code: number | null;
  last_error: string | null;
  consecutive_failures: number;
  total_runs: number;
  watermarks: Record<string, string>;
}

export interface ReliableJobOptions {
  jobName: string;
  stateDir: string;
  expectedIntervalMs: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  apiKeys?: string[];
  /** Test seam — default real sleep */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface JobContext {
  attempt: number;
  isUnchanged(key: string, contentHash: string): boolean;
  commit(key: string, contentHash: string): void;
  currentApiKey(): string | undefined;
  rotateApiKey(): string | undefined;
}

export interface JobRunResult {
  ok: boolean;
  attempts: number;
  error?: string;
  /** Present when captureStdout was requested on wrap */
  stdout?: string;
  exitCode?: number;
}

export interface WrapCommandOptions extends ReliableJobOptions {
  command: string;
  args: string[];
  cwd?: string;
  watermarkFiles?: string[];
  skipUnchanged?: boolean;
  /** Capture stdout for tests (default inherit). */
  captureStdout?: boolean;
}

export interface MissedFireAlert {
  jobName: string;
  lastSuccessAt: string | null;
  overdueMs: number;
  consecutiveFailures: number;
}

function emptyState(jobName: string, expectedIntervalMs: number): JobState {
  return {
    job_name: jobName,
    expected_interval_ms: expectedIntervalMs,
    last_attempt_at: null,
    last_success_at: null,
    last_exit_code: null,
    last_error: null,
    consecutive_failures: 0,
    total_runs: 0,
    watermarks: {},
  };
}

function jobStatePath(stateDir: string, jobName: string): string {
  return join(stateDir, `${jobName}.json`);
}

function truncateError(msg: string): string {
  return msg.length <= 2000 ? msg : msg.slice(0, 2000);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readJobState(stateDir: string, jobName: string): JobState | null {
  const p = jobStatePath(stateDir, jobName);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as JobState;
    if (!raw || typeof raw.job_name !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

function writeJobState(stateDir: string, state: JobState): void {
  ensureDir(stateDir);
  atomicWriteSync(jobStatePath(stateDir, state.job_name), JSON.stringify(state, null, 2));
}

export function writeHeartbeat(
  stateDir: string,
  jobName: string,
  opts: { success: boolean; intervalMs: number; error?: string },
): void {
  const existing = readJobState(stateDir, jobName) ?? emptyState(jobName, opts.intervalMs);
  const now = new Date().toISOString();
  existing.expected_interval_ms = opts.intervalMs;
  existing.last_attempt_at = now;
  existing.total_runs += 1;
  if (opts.success) {
    existing.last_success_at = now;
    existing.last_exit_code = 0;
    existing.last_error = null;
    existing.consecutive_failures = 0;
  } else {
    existing.last_exit_code = 1;
    existing.last_error = truncateError(opts.error ?? 'failure');
    existing.consecutive_failures += 1;
  }
  writeJobState(stateDir, existing);
}

export async function runReliableJob(
  opts: ReliableJobOptions,
  work: (ctx: JobContext) => Promise<void>,
): Promise<JobRunResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const backoffBaseMs = opts.backoffBaseMs ?? 5000;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const keys = opts.apiKeys ? [...opts.apiKeys] : [];
  let keyIndex = 0;

  const prior = readJobState(opts.stateDir, opts.jobName);
  const base: JobState = prior
    ? { ...prior, watermarks: { ...prior.watermarks } }
    : emptyState(opts.jobName, opts.expectedIntervalMs);
  base.job_name = opts.jobName;
  base.expected_interval_ms = opts.expectedIntervalMs;

  const committedWatermarks = { ...base.watermarks };
  const stagedWatermarks: Record<string, string> = {};
  let attempts = 0;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    const now = new Date().toISOString();
    base.last_attempt_at = now;
    base.total_runs += 1;
    // Do not persist staged watermarks yet
    base.watermarks = { ...committedWatermarks };
    writeJobState(opts.stateDir, base);

    const ctx: JobContext = {
      attempt,
      isUnchanged(key: string, contentHash: string): boolean {
        return committedWatermarks[key] !== undefined && committedWatermarks[key] === contentHash;
      },
      commit(key: string, contentHash: string): void {
        stagedWatermarks[key] = contentHash;
      },
      currentApiKey(): string | undefined {
        return keys[keyIndex];
      },
      rotateApiKey(): string | undefined {
        if (keyIndex + 1 >= keys.length) return undefined;
        keyIndex += 1;
        return keys[keyIndex];
      },
    };

    try {
      await work(ctx);
      base.last_success_at = new Date().toISOString();
      base.last_exit_code = 0;
      base.last_error = null;
      base.consecutive_failures = 0;
      Object.assign(committedWatermarks, stagedWatermarks);
      base.watermarks = { ...committedWatermarks };
      writeJobState(opts.stateDir, base);
      return { ok: true, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      base.last_exit_code = 1;
      base.last_error = truncateError(lastError);
      base.consecutive_failures += 1;
      // staged watermarks discarded
      base.watermarks = { ...committedWatermarks };
      writeJobState(opts.stateDir, base);
      if (attempt < maxRetries) {
        const delay = backoffBaseMs * 2 ** (attempt - 1);
        await sleepFn(delay);
      }
    }
  }

  return { ok: false, attempts, error: lastError };
}

export function hashFileContents(paths: string[]): string {
  const h = createHash('sha256');
  for (const p of paths) {
    h.update(p);
    h.update('\0');
    if (existsSync(p)) {
      h.update(readFileSync(p));
    } else {
      h.update('MISSING');
    }
    h.update('\0');
  }
  return h.digest('hex');
}

export async function runWrappedCommand(opts: WrapCommandOptions): Promise<JobRunResult> {
  const watermarkKey = 'cmd-inputs';
  const maxRetries = opts.maxRetries ?? 3;
  const backoffBaseMs = opts.backoffBaseMs ?? 5000;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const keys = opts.apiKeys ? [...opts.apiKeys] : [];
  let keyIndex = 0;

  if (opts.skipUnchanged && opts.watermarkFiles && opts.watermarkFiles.length > 0) {
    const hash = hashFileContents(opts.watermarkFiles);
    const existing = readJobState(opts.stateDir, opts.jobName);
    if (existing?.watermarks[watermarkKey] === hash && existing.last_success_at) {
      writeHeartbeat(opts.stateDir, opts.jobName, {
        success: true,
        intervalMs: opts.expectedIntervalMs,
      });
      const state = readJobState(opts.stateDir, opts.jobName);
      if (state) {
        state.watermarks = { ...state.watermarks, [watermarkKey]: hash };
        writeJobState(opts.stateDir, state);
      }
      return { ok: true, attempts: 0, exitCode: 0 };
    }
  }

  let lastError: string | undefined;
  let lastStdout = '';
  let lastCode = 1;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    const now = new Date().toISOString();
    const state =
      readJobState(opts.stateDir, opts.jobName) ??
      emptyState(opts.jobName, opts.expectedIntervalMs);
    state.expected_interval_ms = opts.expectedIntervalMs;
    state.last_attempt_at = now;
    state.total_runs += 1;
    writeJobState(opts.stateDir, state);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (keys.length > 0) {
      env.RELIABLE_JOB_API_KEY = keys[keyIndex];
    }

    const result = spawnSync(opts.command, opts.args, {
      cwd: opts.cwd,
      env,
      encoding: 'utf-8',
      stdio: opts.captureStdout ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    lastStdout = typeof result.stdout === 'string' ? result.stdout : '';
    if (!opts.captureStdout && lastStdout === '' && process.stdout) {
      // inherit mode — no capture
    }
    lastCode = result.status ?? (result.error ? 1 : 0);

    if (lastCode === 0) {
      const okState =
        readJobState(opts.stateDir, opts.jobName) ??
        emptyState(opts.jobName, opts.expectedIntervalMs);
      okState.last_success_at = new Date().toISOString();
      okState.last_exit_code = 0;
      okState.last_error = null;
      okState.consecutive_failures = 0;
      if (opts.watermarkFiles && opts.watermarkFiles.length > 0) {
        okState.watermarks = {
          ...okState.watermarks,
          [watermarkKey]: hashFileContents(opts.watermarkFiles),
        };
      }
      writeJobState(opts.stateDir, okState);
      return {
        ok: true,
        attempts,
        stdout: opts.captureStdout ? lastStdout : undefined,
        exitCode: 0,
      };
    }

    lastError =
      result.error?.message ??
      (typeof result.stderr === 'string' && result.stderr.trim()
        ? result.stderr.trim()
        : `exit ${lastCode}`);

    const failState =
      readJobState(opts.stateDir, opts.jobName) ??
      emptyState(opts.jobName, opts.expectedIntervalMs);
    failState.last_exit_code = lastCode;
    failState.last_error = truncateError(lastError);
    failState.consecutive_failures += 1;
    writeJobState(opts.stateDir, failState);

    // Auto-rotate on non-zero when pool provided
    if (keys.length > 0 && keyIndex + 1 < keys.length) {
      keyIndex += 1;
    }

    if (attempt < maxRetries) {
      await sleepFn(backoffBaseMs * 2 ** (attempt - 1));
    }
  }

  return {
    ok: false,
    attempts,
    error: lastError,
    stdout: opts.captureStdout ? lastStdout : undefined,
    exitCode: lastCode,
  };
}

export function bareSpawn(
  command: string,
  args: string[],
  cwd?: string,
): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  };
}

export function checkMissedFires(stateDir: string, now: Date = new Date()): MissedFireAlert[] {
  if (!existsSync(stateDir)) return [];
  const alerts: MissedFireAlert[] = [];
  let files: string[];
  try {
    files = readdirSync(stateDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  for (const file of files) {
    const jobName = file.replace(/\.json$/, '');
    const state = readJobState(stateDir, jobName);
    if (!state) continue;
    const interval = state.expected_interval_ms;
    if (!(interval > 0)) continue;

    const threshold = interval * 1.5;
    if (!state.last_success_at) {
      if (state.last_attempt_at) {
        const attempted = new Date(state.last_attempt_at).getTime();
        const overdueMs = now.getTime() - attempted;
        if (overdueMs >= 0) {
          alerts.push({
            jobName: state.job_name,
            lastSuccessAt: null,
            overdueMs,
            consecutiveFailures: state.consecutive_failures,
          });
        }
      }
      continue;
    }

    const lastSuccess = new Date(state.last_success_at).getTime();
    const elapsed = now.getTime() - lastSuccess;
    if (elapsed > threshold) {
      alerts.push({
        jobName: state.job_name,
        lastSuccessAt: state.last_success_at,
        overdueMs: elapsed - interval,
        consecutiveFailures: state.consecutive_failures,
      });
    }
  }

  return alerts.sort((a, b) => a.jobName.localeCompare(b.jobName));
}
