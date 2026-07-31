/**
 * Daemon re-baseline RUNTIME GATES (D5).
 *
 * Three isolated integration gates that must pass before the upstream-based
 * daemon is re-baselined. Every gate runs in a TEMP sandbox (os.tmpdir() +
 * unique subdir) and NEVER touches the real ~/.cortextOS, a real daemon, or a
 * real Telegram token. Mirrors the isolation pattern in
 * tests/unit/daemon/agent-manager-session-isolation.test.ts,
 * tests/unit/daemon/degrade-spawn.test.ts, and the fd-counting approach in
 * tests/unit/pty/pty-leak.test.ts.
 *
 *   D5(a) — spawn/kill fd-flat at the daemon spawn layer.
 *   D5(b) — exactly ONE Telegram poller per bot token (mocked API, no network).
 *   D5(d) — loaded-cron count == fork-main (no silent cron drops on boot).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync, fork } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { platform, tmpdir, arch } from 'os';

// ---------------------------------------------------------------------------
// D5(a) — spawn/kill fd-flat at the daemon spawn layer.
//
// Exercises the SANCTIONED daemon spawn path (hostSpawn → forked
// pty-host-entry child) for N spawn→exit→kill cycles of /bin/echo, and
// asserts the parent process's open /dev/ptmx + (revoked) fd delta stays
// ≤ DELTA_THRESHOLD. This proves the pty-host child reclaims the pty devices
// (kern.tty.ptmx_max=511 exhaustion is the macOS crash-loop trigger).
//
// Darwin-only (ptmx fd accounting is macOS-specific); skipped elsewhere, the
// same way pty-leak.test.ts skips.
// ---------------------------------------------------------------------------

const N_SPAWNS = 8;
const DELTA_THRESHOLD = 4;

// Reuse pty-leak.test.ts's counting approach: count fds this process holds
// against /dev/ptmx or shown as "(revoked)" (a closed-but-not-yet-reclaimed
// pty master).
function countPtmxFds(pid: number): number {
  try {
    const out = execSync(`lsof -p ${pid} 2>/dev/null`, { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((l) => l.includes('(revoked)') || l.includes('/dev/ptmx'))
      .length;
  } catch {
    return 0;
  }
}

// Resolve the compiled host child the daemon forks in production. tsup emits it
// to dist/pty/pty-host-entry.js. We fork this SAME entry point directly (as
// pty-leak.test.ts does) so the gate exercises the real fd-reclaiming host path.
// Under vitest the source module runs from src/ where __dirname-based bundled
// resolution in pty-host-client is wrong, so we go straight to dist.
const DIST_HOST_ENTRY = join(__dirname, '..', '..', '..', 'dist', 'pty', 'pty-host-entry.js');
const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * Ensure node-pty's prebuilt `spawn-helper` is executable.
 *
 * node-pty ships prebuilds under node_modules/node-pty/prebuilds/<platform>/.
 * A fresh install in this worktree can extract `spawn-helper` WITHOUT its exec
 * bit (mode 0644), which makes node-pty's posix_spawnp fail for EVERY pty
 * spawn — the daemon included. The stock pty-leak gate hides this: when spawn
 * fails, no pty is allocated, the fd delta is trivially 0, and it false-passes.
 *
 * This self-heal restores the exec bit that npm should have set. It is
 * idempotent and scoped strictly to node-pty's own helper. Returns true if the
 * helper is present + executable afterwards; false if it could not be made so
 * (in which case the gate cannot honestly run — see REBASELINE-TODO in report).
 */
function ensurePtySpawnHelperExecutable(): boolean {
  const helper = join(
    REPO_ROOT,
    'node_modules',
    'node-pty',
    'prebuilds',
    `${platform()}-${arch()}`,
    'spawn-helper',
  );
  if (!existsSync(helper)) return false;
  try {
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
    }
    return (statSync(helper).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * One spawn→exit→kill cycle of /bin/echo through the forked pty-host child,
 * driven over the real pty-ipc protocol (PtySpawnMsg → pty-ready → pty-exit,
 * then the child self-exits, reclaiming its /dev/ptmx fd). Mirrors
 * spawnOnePtySession() in tests/unit/pty/pty-leak.test.ts.
 */
async function spawnOneHostSession(sandbox: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = fork(DIST_HOST_ENTRY, [], { silent: true, execArgv: [] });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      // Explicit kill exercises the daemon's spawn→exit→KILL teardown even if
      // the child already exited on its own after echo terminated.
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    };

    child.on('message', (raw: unknown) => {
      const msg = raw as { type?: string };
      if (msg?.type === 'pty-exit') {
        // Child will process.exit(0) ~50ms later; the 'exit' handler resolves.
        return;
      }
      if (msg?.type === 'pty-error') {
        reject(new Error(`pty-host reported error: ${JSON.stringify(raw)}`));
      }
    });
    child.on('exit', () => done());
    child.on('error', reject);

    child.send({
      type: 'pty-spawn',
      file: '/bin/echo',
      args: ['hi'],
      // node-pty needs a non-empty env for posix_spawnp; a minimal PATH is
      // enough for /bin/echo. We never inherit real secrets/tokens.
      options: {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: sandbox,
        env: { PATH: '/usr/bin:/bin' },
      },
    });

    // Safety net: never hang the whole suite on a single cycle.
    setTimeout(done, 5000);
  });
}

describe('D5(a) — daemon spawn layer is fd-flat across spawn/exit/kill', () => {
  it('GATE (darwin-only): N pty-host echo cycles leave ptmx/revoked fd delta ≤ 4', async () => {
    if (platform() !== 'darwin') {
      // ptmx fd accounting is macOS-specific; skip on non-darwin like pty-leak.test.ts.
      return;
    }
    // The gate requires the built host child. If dist is missing, fail loudly —
    // do NOT silently pass (that would hide a real fd-leak regression).
    expect(
      existsSync(DIST_HOST_ENTRY),
      `dist host entry missing at ${DIST_HOST_ENTRY} — run \`npm run build\` first`,
    ).toBe(true);

    // The pty toolchain must actually be able to allocate a pty, otherwise a
    // delta of 0 is meaningless (spawn silently failed). Fail loud if node-pty
    // cannot be made functional — never false-pass.
    expect(
      ensurePtySpawnHelperExecutable(),
      'node-pty spawn-helper prebuild is missing or not executable — pty spawn ' +
        'cannot be exercised; fd-leak gate would be a false pass otherwise',
    ).toBe(true);

    const sandbox = mkdtempSync(join(tmpdir(), 'cortextos-d5a-'));
    const pid = process.pid;
    const before = countPtmxFds(pid);

    try {
      for (let i = 0; i < N_SPAWNS; i++) {
        await spawnOneHostSession(sandbox);
      }

      // Give the kernel a moment to reclaim fds after the last child exits.
      await new Promise((r) => setTimeout(r, 400));

      const after = countPtmxFds(pid);
      const delta = after - before;

      process.stdout.write(
        `[d5a-spawn-fd-flat] N=${N_SPAWNS} before=${before} after=${after} ` +
          `delta=${delta} threshold=${DELTA_THRESHOLD}\n`,
      );

      expect(delta).toBeLessThanOrEqual(DELTA_THRESHOLD);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// D5(b) — exactly ONE Telegram poller per bot token.
//
// Unit-tests TelegramPoller's lifecycle with a FAKE api object injected in
// place of TelegramAPI. api.getUpdates NEVER hits api.telegram.org — hitting a
// real token/getUpdates would conflict with the live fleet's pollers (a known
// outage cause: the "ophir" orphaned-poller class). We assert that across a
// start + 3 restart cycles there is at most one live getUpdates consumer at a
// time and no orphaned poll loop survives a stop().
// ---------------------------------------------------------------------------

interface FakeApi {
  active: number; // count of currently-live poll loops touching this api
  peak: number; // max concurrent live poll loops observed
  calls: number;
  getUpdates(offset: number, limit: number): Promise<{ result: unknown[] }>;
}

describe('D5(b) — exactly one Telegram poller per bot token (mocked API)', () => {
  let sandbox: string;
  let stateDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'cortextos-d5b-'));
    stateDir = join(sandbox, 'state');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('start → stop → restart x3 leaves exactly one live poll loop; stop() is clean', async () => {
    const { TelegramPoller } = await import('../../../src/telegram/poller.js');

    // Track how many poll loops are concurrently inside getUpdates. A correctly
    // supervised poller yields peak === 1 — never a duplicate/orphaned consumer.
    const fakeApi: FakeApi = {
      active: 0,
      peak: 0,
      calls: 0,
      async getUpdates() {
        fakeApi.active += 1;
        fakeApi.peak = Math.max(fakeApi.peak, fakeApi.active);
        fakeApi.calls += 1;
        // Simulate an empty long-poll returning promptly. No network.
        await new Promise((r) => setTimeout(r, 5));
        fakeApi.active -= 1;
        return { result: [] };
      },
    };

    // Poll fast so the loop actually cycles within the test window. The poller
    // only knows about `api.getUpdates`, so the fake is a drop-in.
    const makePoller = () =>
      new TelegramPoller(
        fakeApi as unknown as import('../../../src/telegram/api.js').TelegramAPI,
        stateDir,
        5,
      );

    // Cycle: start (fire-and-forget loop), let it poll a few times, stop, repeat.
    let poller = makePoller();
    for (let cycle = 0; cycle < 4; cycle++) {
      // start() runs an infinite loop; do NOT await it — kick it off.
      void poller.start();
      // Let the loop spin through several getUpdates calls.
      await new Promise((r) => setTimeout(r, 60));

      // Exactly one poller is live right now — assert no concurrent consumers.
      expect(fakeApi.active).toBeLessThanOrEqual(1);

      poller.stop();
      // Give any in-flight getUpdates time to settle after stop().
      await new Promise((r) => setTimeout(r, 40));

      // stop() must be a clean, intentional terminate — not a crash/conflict.
      expect(poller.lastExitReason).toBe('stopped-externally');
      // No poll loop should remain live after stop().
      expect(fakeApi.active).toBe(0);

      // Fresh poller for the next restart cycle (simulates supervisor restart).
      poller = makePoller();
    }

    // Final stop for the last-created (never-started) poller.
    poller.stop();
    await new Promise((r) => setTimeout(r, 40));

    // The invariant that gates the orphaned-poller/ophir class: across ALL
    // start/stop/restart cycles, never more than ONE live getUpdates consumer.
    expect(fakeApi.peak).toBe(1);
    // And the poller actually polled (proves the loop ran, not a no-op pass).
    expect(fakeApi.calls).toBeGreaterThan(0);
    // No lingering live loop at the very end.
    expect(fakeApi.active).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// D5(d) — loaded-cron count == fork-main.
//
// Copies a representative crons.json fixture into a temp agent state dir under
// a sandbox CTX_ROOT, then loads it through the SAME code the daemon uses on
// boot — CronScheduler.start() → readCronsWithStatus() (src/bus/crons.ts) —
// and asserts the number of scheduled/registered crons equals the number of
// valid entries in the fixture. Proves the upstream-based loader does not
// silently drop crons vs the fork's cron loader.
//
// crons.json lives at: {CTX_ROOT}/.cortextOS/state/agents/{agent}/crons.json
// ---------------------------------------------------------------------------

describe('D5(d) — loaded-cron count equals fixture entry count (no silent drops)', () => {
  let sandbox: string;
  let prevCtxRoot: string | undefined;
  const AGENT = 'alice';

  // Representative fixture: K=3 valid, enabled crons with distinct
  // name+schedule (interval + 5-field forms), mirroring a real agent's file.
  const FIXTURE_CRONS = [
    {
      name: 'heartbeat',
      prompt: 'Read HEARTBEAT.md and execute the heartbeat workflow.',
      schedule: '10m',
      enabled: true,
      created_at: '2026-04-01T00:00:00.000Z',
    },
    {
      name: 'morning-briefing',
      prompt: 'Produce the morning briefing.',
      schedule: '0 13 * * *',
      enabled: true,
      created_at: '2026-04-01T00:00:00.000Z',
    },
    {
      name: 'weekly-digest',
      prompt: 'Produce the weekly digest.',
      schedule: '0 16 * * 1',
      enabled: true,
      created_at: '2026-04-01T00:00:00.000Z',
    },
  ];
  const K = FIXTURE_CRONS.length;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'cortextos-d5d-'));
    // CronScheduler resolves crons.json under process.env.CTX_ROOT — point it
    // at the sandbox so nothing touches the real ~/.cortextOS.
    prevCtxRoot = process.env.CTX_ROOT;
    process.env.CTX_ROOT = sandbox;

    const agentStateDir = join(sandbox, '.cortextOS', 'state', 'agents', AGENT);
    mkdirSync(agentStateDir, { recursive: true });
    writeFileSync(
      join(agentStateDir, 'crons.json'),
      JSON.stringify({ updated_at: '2026-04-01T00:00:00.000Z', crons: FIXTURE_CRONS }, null, 2),
      'utf-8',
    );
  });

  afterEach(() => {
    if (prevCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = prevCtxRoot;
    rmSync(sandbox, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('CronScheduler.start() registers exactly K crons from the fixture', async () => {
    const { CronScheduler } = await import('../../../src/daemon/cron-scheduler.js');

    const scheduler = new CronScheduler({
      agentName: AGENT,
      // onFire must never fire during the test window (crons are minutes/hours
      // out), but supply a no-op so a fire can't escape to a real workflow.
      onFire: async () => {
        /* no-op — must not touch any live system */
      },
      logger: () => {
        /* silence scheduler chatter */
      },
    });

    try {
      scheduler.start();

      // getNextFireTimes() enumerates every registered/scheduled cron — its
      // length is the loaded-cron count the daemon would run.
      const registered = scheduler.getNextFireTimes();

      process.stdout.write(
        `[d5d-cron-count] fixture=${K} registered=${registered.length} ` +
          `names=${registered.map((r) => r.name).sort().join(',')}\n`,
      );

      expect(registered.length).toBe(K);
      expect(registered.map((r) => r.name).sort()).toEqual(
        FIXTURE_CRONS.map((c) => c.name).sort(),
      );
    } finally {
      scheduler.stop();
    }
  }, 30_000);
});
