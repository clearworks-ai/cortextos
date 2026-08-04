/**
 * Regression tests for handleExit crash classification (AgentProcess,
 * src/daemon/agent-process.ts). Tested via AgentProcess.handleExit() behavior.
 *
 * History: the fork used to carry a detectRateLimitCrash() reclassifier that
 * diverted rate-limit-looking exits to an uncharged RATE_LIMIT backoff path
 * (RW-1). That reclassifier was removed to converge with upstream/main, which
 * has no rate-limit special-casing: every non-image-poison, non-shutdown exit
 * charges crashCount, backs off exponentially, and halts at maxCrashesPerDay.
 *
 * These tests pin that convergence: BOTH prose mentions of rate limits AND
 * genuine Anthropic rate-limit/usage-limit signatures in recent stdout must
 * flow through the normal CRASH path — no RATE_LIMIT restarts.log entries,
 * crash_count charged.
 *
 * Test strategy: configure fs mocks so tailStdoutLog() returns specific content,
 * then fire handleExit() via capturedOnExit and assert the restarts.log entry
 * is CRASH (never RATE_LIMIT) and crashCount was incremented.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
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

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  openSync: vi.fn().mockReturnValue(1),
  readSync: vi.fn(),
  closeSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get openSync() { return fsMocks.openSync; },
    get readSync() { return fsMocks.readSync; },
    get closeSync() { return fsMocks.closeSync; },
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

/**
 * Configure fs mocks so tailStdoutLog() returns `content`.
 * tailStdoutLog reads via openSync/readSync/closeSync with the file's stat size.
 */
function mockStdoutLog(content: string): void {
  fsMocks.existsSync.mockImplementation((p: unknown) =>
    String(p).endsWith('/logs/alice/stdout.log'),
  );
  fsMocks.statSync.mockImplementation((_p: unknown) => ({ size: content.length, mtimeMs: Date.now() - 100 }));
  fsMocks.openSync.mockReturnValue(1);
  fsMocks.readSync.mockImplementation((_fd: number, buffer: Buffer) => {
    buffer.write(content, 0, 'utf-8');
    return content.length;
  });
  fsMocks.closeSync.mockReturnValue(undefined);
}

/** Assert the exit was classified as a charged CRASH (upstream behavior). */
function expectCrashPath(ap: InstanceType<typeof AgentProcess>): void {
  expect(fsMocks.appendFileSync).toHaveBeenCalled();
  // A real crash also writes a stderr-detail line to crashes.log now; the
  // restarts.log CRASH line (its existing classification behavior) is unchanged.
  const restartsCall = fsMocks.appendFileSync.mock.calls
    .find((c: unknown[]) => String(c[0]).endsWith('/restarts.log'));
  expect(restartsCall).toBeDefined();
  const logLine = String(restartsCall![1]);
  expect(logLine).not.toContain('RATE_LIMIT');
  expect(logLine).toContain('CRASH');
  expect(ap.getStatus().crashCount).toBe(1);
}

beforeEach(() => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.onExit.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.openSync.mockReset().mockReturnValue(1);
  fsMocks.readSync.mockReset();
  fsMocks.closeSync.mockReset();
});

describe('handleExit — prose mentions of rate limits take the normal CRASH path', () => {
  it('treats "Reverted comms-check Step 0 Rate Limit Guard" as a normal crash', async () => {
    mockStdoutLog('Reverted comms-check Step 0 Rate Limit Guard');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expectCrashPath(ap);
  });

  it('treats "crash loop caused by rate limiting" as a normal crash', async () => {
    mockStdoutLog('Diagnosed and fixed comms-check worker crash loop caused by rate limiting');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expectCrashPath(ap);
  });

  it('treats "Comms-check worker crash loop (rate limit) investigation" as a normal crash', async () => {
    mockStdoutLog('Comms-check worker crash loop (rate limit) investigation');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expectCrashPath(ap);
  });
});

describe('handleExit — genuine rate-limit signatures ALSO take the CRASH path (upstream convergence, no RW-1 reclassifier)', () => {
  it('treats "rate_limit_error" as a charged crash (exponential backoff, counts toward max_crashes_per_day)', async () => {
    mockStdoutLog('Anthropic API rate_limit_error: Too Many Requests');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expectCrashPath(ap);
  });

  it('treats "overloaded_error" as a charged crash', async () => {
    mockStdoutLog('API Error: overloaded_error: system overloaded. Please retry.');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expectCrashPath(ap);
  });

  it('treats "Claude usage limit reached" as a charged crash', async () => {
    mockStdoutLog('Claude usage limit reached. Please upgrade your plan.');
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expectCrashPath(ap);
  });

  it('treats "reached your weekly limit" as a charged crash', async () => {
    mockStdoutLog("You've reached your weekly limit. Resets Monday.");
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expectCrashPath(ap);
  });

  it('treats "used 95% of your limit" as a charged crash', async () => {
    mockStdoutLog("You've used 95% of your limit for this week.");
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expectCrashPath(ap);
  });
});
