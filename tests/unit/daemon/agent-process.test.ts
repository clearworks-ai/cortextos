import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the PTY exit handler so tests can simulate exits at controlled times
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

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
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

const mockReadEnabledAgentsMap = vi.fn().mockReturnValue({});
vi.mock('../../../src/bus/enabled-agents-io.js', () => ({
  readEnabledAgentsMap: (...args: unknown[]) => mockReadEnabledAgentsMap(...args),
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
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  // Getter-based exposure of the fsMocks vi.fn()s. Two consumer patterns
  // need to coexist on this file:
  //   (1) `fsMocks.X.mockReset()` — used by the BUG-040 / restarts.log
  //       tests added by this patch
  //   (2) `vi.mocked(fs.X).mockImplementation(...)` — used by the
  //       verifyCronsAfterIdle tests + BUG-048 reschedule tests
  // For (2) to work, `fs.X` MUST resolve to the same vi.fn() instance as
  // `fsMocks.X`. Naive direct reference (`existsSync: fsMocks.existsSync`)
  // breaks because vi.mock factories are hoisted + executed BEFORE the
  // `const fsMocks = {...}` initializer — so the lookup captures
  // `undefined`. Arrow wrappers (`(...args) => fsMocks.X(...args)`) keep
  // (1) working but break (2) because `fs.X` is no longer a vi.fn — it's
  // a plain arrow function, and `vi.mocked()` does not recognize it as
  // mockable. Getters thread the needle: the lookup is deferred until
  // call time (after fsMocks is initialized), and the value returned IS
  // the underlying vi.fn so `vi.mocked()` recognizes it.
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
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

beforeEach(() => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.isAlive.mockClear();
  mockPty.isAlive.mockReturnValue(true);
  mockPty.onExit.mockClear();
  mockInjectMessage.mockClear();
  mockReadEnabledAgentsMap.mockReset().mockReturnValue({});
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('AgentProcess - BUG-011 fix (stop awaits PTY exit)', () => {
  it('stop() awaits the PTY exit handler before resolving', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(capturedOnExit).not.toBeNull();
    expect(ap.getStatus().status).toBe('running');

    let stopResolved = false;
    const stopPromise = ap.stop().then(() => { stopResolved = true; });

    // Give stop() a moment to enter its kill phase. The 4s of internal sleeps
    // (1s after Ctrl-C + 3s after /exit) plus the awaitExit will keep stop()
    // in flight. After 100ms, it should NOT have resolved.
    await new Promise(r => setTimeout(r, 100));
    expect(stopResolved).toBe(false);

    // Now simulate the PTY exit firing
    capturedOnExit!(0, 0);

    // After the exit fires, stop() should be able to resolve
    // (after its internal sleeps finish — wait long enough)
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('stop() does NOT trigger crash recovery on intentional stop (the BUG-011 regression)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Stop and have the exit fire DURING the await window
    const stopPromise = ap.stop();
    await new Promise(r => setTimeout(r, 100));
    capturedOnExit!(0, 0);
    await stopPromise;

    // The agent should be 'stopped', NOT 'crashed'.
    // Before the fix, the exit handler could fire after stopping=false and
    // call into the crash recovery branch, leaving status='crashed'.
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('handleExit DOES trigger crash recovery on UNINTENTIONAL exit (regression check)', async () => {
    // Make sure we didn't accidentally break the real crash recovery path
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire the exit handler WITHOUT calling stop() first — simulates a real crash
    capturedOnExit!(1, 0);

    // The agent should be in 'crashed' state (crash recovery scheduled)
    expect(ap.getStatus().status).toBe('crashed');
  });

  it('clean exit (code 0) restarts to continue WITHOUT counting as a crash', async () => {
    // opencode is a TUI that exits 0 after each turn (100+/day); counting each
    // toward max_crashes_per_day falsely HALTs it. A code-0 exit is normal
    // lifecycle, not a crash — it schedules a restart (status 'crashed' = pending
    // restart) but must NOT write .crash_count_today.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    capturedOnExit!(0, 0);

    // Restart scheduled, but the daily crash counter was NOT written.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
    // restarts.log records it as CLEAN_EXIT (not counted), not CRASH.
    const restartLines = fsMocks.appendFileSync.mock.calls
      .map((c: any[]) => String(c[1]))
      .filter((l: string) => l.includes('restarts.log') === false);
    const logged = fsMocks.appendFileSync.mock.calls.map((c: any[]) => String(c[1])).join('');
    expect(logged).toMatch(/CLEAN_EXIT: exit_code=0/);
    expect(logged).not.toMatch(/\] CRASH: exit_code=0/);
    void restartLines;
  });

  it('opencode runtime clean exit (code 0, AFTER ready) is NOT counted as a crash (completes #242)', async () => {
    // opencode is a TUI that completes a turn and exits 0 by design. Once the
    // agent has reached 'running', a code-0 exit is a normal turn completion —
    // it must restart-to-continue WITHOUT charging the daily crash counter and
    // WITHOUT the startup-failure circuit breaker firing.
    const ap = new AgentProcess('alice', mockEnv, { runtime: 'opencode', model: 'openrouter/z-ai/glm-4.7' });
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    capturedOnExit!(0, 0);

    // No daily crash-count write.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
    const logged = fsMocks.appendFileSync.mock.calls.map((c: any[]) => String(c[1])).join('');
    // Logged as a benign CLEAN_EXIT, never a CRASH and never a startup failure.
    expect(logged).toMatch(/CLEAN_EXIT: exit_code=0/);
    expect(logged).not.toMatch(/CLEAN_EXIT_STARTUP_FAIL/);
    expect(logged).not.toMatch(/\] CRASH: exit_code=0/);
    // Restart pending (status 'crashed' = scheduled restart), not halted.
    expect(ap.getStatus().status).toBe('crashed');
  });

  it('opencode runtime real error exit (code 1) STILL counts as a crash (completes #242)', async () => {
    // The #242 completion must not over-reach: a genuine non-zero exit from the
    // opencode runtime is still a crash — it charges the counter and logs CRASH.
    const ap = new AgentProcess('alice', mockEnv, { runtime: 'opencode', model: 'openrouter/z-ai/glm-4.7' });
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    const logged = fsMocks.appendFileSync.mock.calls.map((c: any[]) => String(c[1])).join('');
    expect(logged).toMatch(/\] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
    expect(logged).not.toMatch(/CLEAN_EXIT/);
  });

  it('opencode exit-0 BEFORE ready trips the startup-failure circuit breaker + alerts (does not silently loop)', async () => {
    // A real startup fault (bad config/model/env) makes opencode print an error
    // and exit 0 BEFORE the session ever becomes ready. #242 alone would treat
    // this as a normal turn and silently retry until a bare CRASH_LOOP halt.
    // The completion surfaces it LOUDLY: 3 such exits-before-ready in 60s trip a
    // circuit breaker (halted + Telegram alert), distinct from a benign turn.
    const telegramApi = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const ap = new AgentProcess('alice', mockEnv, { runtime: 'opencode', model: 'openrouter/z-ai/glm-4.7' });
    ap.setTelegramHandle(telegramApi as any, '999');
    await ap.start();

    // Simulate three consecutive exit-0-before-ready events: the agent never
    // reaches 'running' between them (status forced back to a pre-ready state),
    // and each exit fires immediately after the spawn stamp (spawnAgeMs < 8s).
    for (let i = 0; i < 3; i++) {
      ap['status'] = 'starting';
      ap['spawnStartedAtMs'] = Date.now();
      ap['handleExit'](0);
    }

    // Breaker tripped: halted, NOT an infinite silent restart loop.
    expect(ap.getStatus().status).toBe('halted');
    // Loud + distinct log line, not the benign CLEAN_EXIT.
    const logged = fsMocks.appendFileSync.mock.calls.map((c: any[]) => String(c[1])).join('');
    expect(logged).toMatch(/CLEAN_EXIT_STARTUP_FAIL: exit_code=0/);
    // Telegram alert fired so the failure is not silent.
    expect(telegramApi.sendMessage).toHaveBeenCalled();
    expect(String(telegramApi.sendMessage.mock.calls[0][1])).toMatch(/STARTUP FAILURE/);
    // The daily crash counter was NOT charged (still a code-0 exit).
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('unexpected PTY exit persists a CRASH line to restarts.log', async () => {
    // Default fs mocks: no .daemon-stop marker, no .crash_count_today file.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire exit handler WITHOUT calling stop() first — simulates a real crash.
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    // restarts.log must have received a CRASH entry with the exit code and
    // crash counter. Before the fix, daemon-classified crashes only wrote
    // to stdout and left restarts.log empty.
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toMatch(/\] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
    expect(String(logLine).endsWith('\n')).toBe(true);
  });

  it('PTY exit during daemon shutdown is NOT classified as a crash', async () => {
    // Simulate agent-manager.ts:stopAll() having written a fresh .daemon-stop
    // marker moments ago. handleExit should recognize the shutdown-in-progress
    // signal and bail out before touching the crash counter or restarts.log.
    fsMocks.existsSync.mockImplementation((p: any) => {
      const path = String(p);
      return path.endsWith('/state/alice/.daemon-stop');
    });
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 2_000 }));

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // PM2 SIGTERM propagated to the PTY's Claude Code child: it exits
    // cleanly with code 0 before its own stopAgent() call has a chance to
    // set stopRequested. Before the fix, this produced a phantom crash
    // and incremented .crash_count_today.
    capturedOnExit!(0, 0);

    // Agent state is 'running' still — handleExit returned early without
    // toggling status. No crash write, no log append, no restart scheduled.
    expect(ap.getStatus().status).toBe('running');
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('stale .daemon-stop marker (>60s old) does NOT mask a real crash', async () => {
    // Regression guard: if a prior shutdown failed to clean up its marker,
    // we do NOT want it to silently swallow genuine crashes hours later.
    // The 60s window in isDaemonShuttingDown() is the load-bearing check.
    fsMocks.existsSync.mockImplementation((p: any) =>
      String(p).endsWith('/state/alice/.daemon-stop'),
    );
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 3_600_000 })); // 1h old

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toMatch(/\] CRASH: /);
  });

  it('planned context-handoff restart (fresh .restart-planned) is NOT counted as a crash', async () => {
    // A busy agent context-handoffs 15-25x/day; each writes a fresh
    // .restart-planned marker (src/bus/system.ts hardRestart) then exits to
    // reload. Counting these toward max_crashes_per_day falsely HALTs the
    // agent — observed live: larry hit 15 planned-restarts, 0 real crashes,
    // HALTED at the default limit of 10.
    fsMocks.existsSync.mockImplementation((p: any) =>
      String(p).endsWith('/state/alice/.restart-planned'),
    );
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 2_000 }));

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Agent exits to reload after writing its handoff doc.
    capturedOnExit!(0, 0);

    // handleExit returned early: no crash write, no crash-count increment.
    expect(ap.getStatus().status).toBe('running');
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('stale .restart-planned marker (>60s old) does NOT mask a real crash', async () => {
    // Regression guard mirroring the .daemon-stop stale case: an old planned
    // marker must not swallow a genuine crash later.
    fsMocks.existsSync.mockImplementation((p: any) =>
      String(p).endsWith('/state/alice/.restart-planned'),
    );
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 3_600_000 })); // 1h old

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toMatch(/\] CRASH: /);
  });

  it('sessionRefresh() delegates to stop() then start() (in order)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Spy on stop and start so we can verify the delegation
    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();

    await ap.sessionRefresh();

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
    // Verify call order: stop must complete before start
    const stopOrder = stopSpy.mock.invocationCallOrder[0];
    const startOrder = startSpy.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);
  });

  it('sessionRefresh() writes .session-refresh marker before stop (false-crash FP fix)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    vi.spyOn(ap, 'start').mockResolvedValue();
    fsMocks.writeFileSync.mockReset();

    await ap.sessionRefresh();

    const writeIdx = fsMocks.writeFileSync.mock.calls.findIndex(
      (call) => String(call[0]).endsWith('.session-refresh'),
    );
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(String(fsMocks.writeFileSync.mock.calls[writeIdx][0])).toBe('/tmp/test-ctx/state/alice/.session-refresh');
    // The marker must be written BEFORE stop() — a SessionEnd hook firing as
    // the PTY dies must already see the marker, or it classifies a false crash.
    const markerWriteOrder = fsMocks.writeFileSync.mock.invocationCallOrder[writeIdx];
    expect(markerWriteOrder).toBeLessThan(stopSpy.mock.invocationCallOrder[0]);
  });
});

describe('AgentProcess - BUG-048 fix (session timer re-reads config)', () => {
  it('fires sessionRefresh when config on disk still matches original short duration', async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }

    expect(refreshSpy).toHaveBeenCalledOnce();
  });

  it('reschedules when config.json on disk has a longer max_session_seconds', async () => {
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    // Config on disk says 1 hour — much longer than initial 1s
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3600 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      // Advance past the initial 1s timer — should reschedule, not fire refresh
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    // sessionRefresh must NOT have been called — config said 1h, not 1s
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not loop when max_session_seconds overflows int32 setTimeout (regression)', async () => {
    // Without the clamp, max_session_seconds: 3600000 (1000h = 3.6T ms) would
    // exceed Node's int32 setTimeout max (~2.147B ms), get coerced to 1ms,
    // fire immediately, re-read the same overflow value, reschedule, and loop
    // tightly — locking the daemon. Clamp at the call site prevents this.
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.fn();

    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3_600_000 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 3_600_000 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      vi.spyOn(ap as unknown as { log: (m: string) => void }, 'log').mockImplementation(logSpy);
      await ap.start();
      // Advance past the int32 setTimeout cap. Without clamp this would log
      // thousands of "rescheduling" lines as the 1ms-coerced timer keeps firing.
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    const rescheduleCount = logSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('rescheduling'),
    ).length;
    expect(rescheduleCount).toBeLessThan(5);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

// NOTE (re-baseline merge): the 'AgentProcess - F8 fresh rollover' describe block
// from origin/main was dropped here. It exercised decideSessionRefreshMode /
// nextSessionRolloverState / prepareFreshRollover / F8 hardRestart escalation —
// the planned-fresh-rollover machinery the re-baseline deliberately removed as
// daemon churn. Those symbols no longer exist in agent-process.ts, so the tests
// could not compile. Behavior legitimately changed; test removed intentionally.
describe('AgentProcess — CrashLoopPauser (instar-inspired sliding window)', () => {
  it('triggers CRASH_LOOP halt when crash_window fills', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      crash_window: { seconds: 60, max_crashes: 3 },
    });
    await ap.start();

    // Fire 3 crashes in rapid succession (well within the 60s window).
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // first crash — normal recovery

    // Reset mocks and simulate the restart + second crash
    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // second crash — still normal

    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    // Third crash in window → CRASH_LOOP → halted
    expect(ap.getStatus().status).toBe('halted');
  });

  it('does not trigger CRASH_LOOP when no crash_window is configured (backward compat)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      max_crashes_per_day: 5,
    });
    await ap.start();

    // 3 crashes — without crash_window, these are just normal crash recovery
    for (let i = 0; i < 3; i++) {
      capturedOnExit!(1, 0);
      if (ap.getStatus().status !== 'halted') {
        mockPty.spawn.mockClear();
        mockPty.onExit.mockClear();
        capturedOnExit = null;
        await ap.start();
      }
    }
    // Should be 'crashed' (recovering), NOT 'halted', because daily max is 5
    expect(ap.getStatus().status).not.toBe('halted');
  });
});

describe('AgentProcess - onboarding marker (do not auto-write .onboarded on heartbeat)', () => {
  // Regression: buildStartupPrompt used to auto-write the .onboarded marker
  // whenever a heartbeat.json existed, on the assumption the agent had
  // onboarded and just forgot the marker. That silently suppressed FIRST BOOT
  // for agents that were manually scaffolded (heartbeat present) but never
  // actually ran onboarding. The marker must be explicit: a heartbeat alone
  // must NOT mark an agent onboarded. This is general daemon behavior (it was
  // surfaced via a manually-scaffolded opencode agent, but applies to any
  // runtime).
  it('does not auto-mark a heartbeat-only agent as onboarded (still routes to FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return false;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('FIRST BOOT');
    expect(prompt).toContain('read ONBOARDING.md and complete the onboarding protocol');
    // The buggy auto-write must be gone: no .onboarded written from heartbeat presence.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('/.onboarded'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('respects an existing .onboarded marker (suppresses FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return true;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).not.toContain('FIRST BOOT');
    expect(prompt).not.toContain('complete the onboarding protocol');
  });
});

describe('AgentProcess - image-poison recovery circuit breaker', () => {
  it('trips circuit breaker on 3rd image-poison recovery within 15 minutes', async () => {
    const mockTelegramApi = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    const ap = new AgentProcess('alice', mockEnv, {});
    ap.setTelegramHandle(mockTelegramApi as any, 'test-chat-id');

    // Mock tailStdoutLog to return image-poison error output
    const imagePoisonOutput = 'API Error: 400: image.source.base64 not supported for image format image/png not supported';
    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue(imagePoisonOutput);

    // First recovery - should proceed normally
    ap['handleExit'](0);
    await new Promise(resolve => setTimeout(resolve, 100)); // Allow async handlers

    // Second recovery - should proceed normally  
    ap['handleExit'](0);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Third recovery - should trip circuit breaker and send alert
    ap['handleExit'](0);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify alert was sent
    expect(mockTelegramApi.sendMessage).toHaveBeenCalledWith(
      'test-chat-id',
      expect.stringContaining('IMAGE-POISON RECOVERY CIRCUIT BREAKER')
    );
    expect(mockTelegramApi.sendMessage).toHaveBeenCalledWith(
      'test-chat-id',
      expect.stringContaining('alice')
    );
    expect(mockTelegramApi.sendMessage).toHaveBeenCalledWith(
      'test-chat-id',
      expect.stringContaining('3 image-poison recoveries in 15min')
    );

    // Verify circuit breaker prevented restart
    expect(ap['status']).toBe('crashed');
  });

  it('resets circuit breaker after 15 minutes', async () => {
    const mockTelegramApi = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    const ap = new AgentProcess('alice', mockEnv, {});
    ap.setTelegramHandle(mockTelegramApi as any, 'test-chat-id');

    // Simulate 3 recoveries, but with timestamps >15min apart
    const now = Date.now();
    ap['imagePoisonRecoveries'] = [
      now - 16 * 60 * 1000,  // 16 minutes ago
      now - 15 * 60 * 1000,  // 15 minutes ago  
      now - 14 * 60 * 1000,  // 14 minutes ago
    ];

    // Fourth recovery - should proceed normally because old timestamps filtered out
    const imagePoisonOutput = 'API Error: 400: image.source.base64 not supported for image format image/png not supported';
    vi.spyOn(ap as any, 'tailStdoutLog').mockReturnValue(imagePoisonOutput);
    ap['handleExit'](0);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should NOT send alert (circuit not tripped)
    expect(mockTelegramApi.sendMessage).not.toHaveBeenCalled();
  });
});
describe('AgentProcess — disabled-agent resurrection gate (handleExit)', () => {
  it('config.json-disabled agent does not respawn on crash exit', async () => {
    vi.useFakeTimers();

    const ap = new AgentProcess('alice', mockEnv, { enabled: false });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    // Simulate crash exit
    capturedOnExit!(1);

    // Advance past max backoff (300s) to ensure any respawns would have fired
    vi.advanceTimersByTime(300_000);

    // Agent should NOT have respawned (only initial start)
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    expect(ap.getStatus().status).toBe('stopped');
  });

  it('enabled-agents.json-disabled agent does not respawn', async () => {
    vi.useFakeTimers();

    // Mock enabled-agents.json to disable this agent
    mockReadEnabledAgentsMap.mockReturnValue({ alice: { enabled: false } });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    // Simulate crash exit
    capturedOnExit!(1);

    // Advance past max backoff
    vi.advanceTimersByTime(300_000);

    // Agent should NOT have respawned
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    expect(ap.getStatus().status).toBe('stopped');
  });

  it('enabled agent still respawns normally on crash (regression guard)', async () => {
    vi.useFakeTimers();

    // Default mocks: enabled agent
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    // Simulate crash exit
    capturedOnExit!(1);

    // Advance past first backoff (5s)
    vi.advanceTimersByTime(5000);

    // Agent SHOULD have respawned (second spawn call)
    expect(mockPty.spawn).toHaveBeenCalledTimes(2);
  });

  it('disabled agent crash exit does not increment crash count', async () => {
    vi.useFakeTimers();

    const ap = new AgentProcess('alice', mockEnv, { enabled: false });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    // Simulate crash exit
    capturedOnExit!(1);

    // No CRASH line should be appended to restarts.log
    expect(fsMocks.appendFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('restarts.log'),
      expect.stringContaining('CRASH'),
      expect.anything(),
    );

    // No .crash_count_today write
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('gate ordering: disabled check does not mask daemon-shutdown or stop paths', async () => {
    vi.useFakeTimers();

    // Simulate daemon shutdown marker
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('.daemon-stop')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, { enabled: false });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    // Mock the daemon-shutdown check to return true
    const isDaemonShuttingDownSpy = vi.spyOn(ap as any, 'isDaemonShuttingDown').mockReturnValue(true);

    // Simulate exit
    capturedOnExit!(0);

    // Should take shutdown early-return (disabled gate NOT reached)
    expect(isDaemonShuttingDownSpy).toHaveBeenCalled();
    expect(mockReadEnabledAgentsMap).not.toHaveBeenCalled();
    expect(ap.getStatus().status).not.toBe('stopped'); // status unchanged by shutdown path
  });
});

describe('AgentProcess - single-flight restart guard (double-fire dedup)', () => {
  it('two near-simultaneous start() triggers spawn exactly ONE PTY', async () => {
    // Open the race window: make spawn resolve on our signal, so both start()
    // calls are in flight through their awaits at the same time — exactly the
    // daemon double-fire condition (crash-recovery timer + fast-checker
    // force-restart / IPC restart firing 15s apart while status !== running).
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    mockPty.spawn.mockReset();
    mockPty.spawn.mockImplementation(() => spawnGate);

    const ap = new AgentProcess('alice', mockEnv, {});

    // Fire two restart triggers back-to-back with no await between them.
    const first = ap.start();
    const second = ap.start();

    // Second must NOT be the same promise-less no-op; both settle, but only one
    // spawn is ever issued.
    releaseSpawn();
    await Promise.all([first, second]);

    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    expect(ap.getStatus().status).toBe('running');
  });

  it('a start() while one is already running is a no-op (no second spawn)', async () => {
    mockPty.spawn.mockReset().mockResolvedValue(undefined);
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    expect(ap.getStatus().status).toBe('running');

    // Second trigger on a live agent — must not spawn again.
    await ap.start();
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
  });

  it('restart (stop then start) reaps the old PTY and leaves exactly ONE live', async () => {
    vi.useFakeTimers();
    mockPty.spawn.mockReset().mockResolvedValue(undefined);
    mockPty.isAlive.mockReturnValue(true);

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    const onExitAfterStart = capturedOnExit;
    expect(onExitAfterStart).not.toBeNull();

    // stop() must tear the old PTY down (kill) BEFORE the next start spawns.
    // stop() sets stopRequested synchronously BEFORE its graceful-shutdown
    // sleeps, so the PTY exit fired below hits handleExit's intentional-stop
    // early return — NO crash-recovery restart is scheduled.
    const stopPromise = ap.stop();
    onExitAfterStart!(0);
    await vi.runAllTimersAsync(); // drain stop()'s Ctrl-C / /exit sleeps
    await stopPromise;
    expect(mockPty.kill).toHaveBeenCalled();
    expect(ap.getStatus().status).toBe('stopped');
    // The intentional-stop exit must NOT have scheduled any recovery restart.
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);

    // Now a fresh start spawns exactly one new PTY — total spawns == 2, one live.
    await ap.start();
    expect(mockPty.spawn).toHaveBeenCalledTimes(2);
    expect(ap.getStatus().status).toBe('running');
    vi.useRealTimers();
  });
});
