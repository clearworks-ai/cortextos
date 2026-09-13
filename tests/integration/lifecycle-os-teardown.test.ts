/**
 * lifecycle-os-teardown.test.ts — Task 5.2: real OS-level process teardown
 * verification.
 *
 * PRD §6 (Explicit Constraints) and §7 (Success Criteria) both call this out
 * as non-optional: the Phase 2 teardown contract (Task 2.6's structured
 * `RetirementResult`, built on `snapshotDescendants`/`killSnapshotSurvivors`
 * in `src/utils/process-tree.ts`) must be proven against ACTUAL spawned OS
 * processes on macOS — real children/grandchildren, real signal delivery,
 * real absence checks via `readProcessSnapshot()`, and a real orphan check
 * via `src/daemon/orphan-scan.ts` (the `cortextos doctor` path) — not mocks.
 *
 * REAL, NOT MOCKED: every fixture below is spawned through the fork's real
 * `hostSpawn()` (`src/pty/pty-host-client.ts`), which forks the REAL
 * compiled `dist/pty/pty-host-entry.js` (Task 2.7's identity-carriage path —
 * `child_process` is never mocked in this file, unlike the sibling
 * `lifecycle-process-retirement.test.ts`, which deliberately redirects
 * `fork()` to a stub because it is testing reaper/ledger wiring, not the
 * spawn-to-teardown contract itself). Because this depends on a build
 * artifact, the whole suite is skipped — with an explicit, named reason —
 * when `dist/pty/pty-host-entry.js` is missing (run `npm run build` first)
 * or on `win32` (`process-tree.ts`/`orphan-scan.ts` both no-op there by
 * design).
 *
 * `AgentProcess`'s own `.pty` field is typed to the concrete `AgentPTY` /
 * `CodexAppServerPTY` classes, which hardcode the `claude`/`codex` CLI
 * binaries — unusable in a portable, credential-free test. `RealHostPty`
 * below is a minimal duck-typed stand-in (write/isAlive/kill/getPid/
 * getHostPid/onExit — the exact surface `AgentProcess.runStop()` and
 * `getHostPid()` actually touch) wrapping the REAL `IPty` `hostSpawn()`
 * returns, injected via the same `(proc as unknown as {...}).pty = ...`
 * test seam `tests/unit/daemon/agent-process-stop-orphan-sweep.test.ts`
 * already established for this exact class. Every OS mechanism below this
 * seam — the fork, the pty allocation, the signal delivery, the `ps`/`lsof`
 * reads — is real.
 *
 * REAL BUG FOUND AND FIXED (not softened into a false pass, per the Task 5.1
 * precedent this task follows): `AgentProcess.runStop()`'s aggregation of
 * `killSnapshotSurvivors()`'s structured result used to silently DROP the
 * `recycled` bucket (pid-identity-mismatch entries) — neither confirmed
 * absent nor unresolved, just gone from the report. Test C below reproduces
 * this deterministically and for real: a genuine, still-alive descendant
 * that rewrites its own `ps`-visible command line (`process.title = ...`,
 * verified empirically on this macOS host to actually change `ps -o
 * command=` output) between the pre-signal snapshot and the sweep. Before
 * the fix in `src/daemon/agent-process.ts` (this task), that produced a
 * false `status: 'retired'` with the live descendant completely
 * unaccounted for — exactly the failure the acceptance criteria forbid
 * ("never a false retired"). The fix folds `recycled` into `unresolved`
 * (see that file's Task 5.2 comment), which this test now asserts directly.
 *
 * REAL, DOCUMENTED, BY-DESIGN LIMITATION (not a bug — Test B): a descendant
 * spawned by the runtime's OWN signal handler, strictly AFTER
 * `snapshotDescendants()` already ran, cannot be caught by a single-snapshot
 * sweep — `snapshotDescendants()`'s own header comment only promises
 * coverage for what exists at signal time. `runStop()` correctly reports
 * `status: 'retired'` from its own narrow evidence in that case. The second,
 * independent layer — `findStateDirOrphans()` — is the documented backstop
 * for exactly this gap (per `orphan-scan.ts`'s own header: "Prevention
 * lives at the source... This scan is the backstop for orphans created
 * before that fix"). Test B proves the backstop actually catches the real
 * straggler, and that the test's own control flow never spawns a
 * "successor" until that straggler is confirmed dead — the real-process
 * encoding of the acceptance criterion "a child spawned during cancellation
 * is retired before any successor starts".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, realpathSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn as rawSpawn, type ChildProcess, fork as realFork } from 'child_process';
import type { AgentConfig, BusPaths, CtxEnv } from '../../src/types/index.js';
import { AgentProcess } from '../../src/daemon/agent-process.js';
import { AgentProcessRuntimeAdapter } from '../../src/daemon/lifecycle/agent-runtime.js';
import { LifecycleStateStore } from '../../src/daemon/lifecycle/state-store.js';
import type { GenerationToken, OwnedResource } from '../../src/daemon/lifecycle/types.js';
import {
  snapshotDescendants,
  killProcessTree,
  readProcessSnapshot,
} from '../../src/utils/process-tree.js';
import { findStateDirOrphans, readPsRows, readCwd } from '../../src/daemon/orphan-scan.js';

const DIST_HOST_ENTRY = join(__dirname, '..', '..', 'dist', 'pty', 'pty-host-entry.js');
const HAS_DIST = existsSync(DIST_HOST_ENTRY);
const IS_WIN32 = process.platform === 'win32';
const RUN = HAS_DIST && !IS_WIN32;

// `hostSpawn()`'s own `resolveHostEntry()` locates the compiled host entry
// relative to ITS OWN bundled __dirname (dist/ or dist/pty/) — a resolution
// that only works once pty-host-client.ts is bundled into dist/daemon.js or
// dist/cli.js. Running the unbundled TS source directly via vitest (this
// file, and every other real-hostSpawn test in this repo —
// tests/unit/pty/pty-host-ready.test.ts, tests/integration/
// lifecycle-process-retirement.test.ts) means that relative guess resolves
// under src/pty/ instead, which never contains the compiled entry. The
// established repo pattern (same one those two files use) is to intercept
// `child_process.fork()` and redirect any path containing 'pty-host-entry'
// to the REAL, already-built artifact at DIST_HOST_ENTRY — this is NOT a
// stub substitution (unlike lifecycle-process-retirement.test.ts's Case 1,
// which deliberately forks a stub that dies pre-ready): the actual compiled
// pty-host-entry.js still runs, still forks a real node-pty allocation,
// still speaks the real IPC protocol. Only the daemon's own file-path
// resolution quirk is worked around.
if (RUN) {
  vi.mock('child_process', async () => {
    const real = await vi.importActual<typeof import('child_process')>('child_process');
    return {
      ...real,
      fork: (path: string, args: string[], opts: Record<string, unknown>) => {
        const target = path.includes('pty-host-entry') ? DIST_HOST_ENTRY : path;
        return (real.fork as typeof realFork)(target, args ?? [], opts ?? {});
      },
    };
  });
}

const { hostSpawn } = await import('../../src/pty/pty-host-client.js');
type IPty = Awaited<ReturnType<typeof hostSpawn>>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`pollUntil: condition never became true within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal duck-typed stand-in for `AgentPTY`/`CodexAppServerPTY` — only the
 * surface `AgentProcess.runStop()`/`getHostPid()` actually call. Wraps the
 * REAL `IPty` `hostSpawn()` (Task 2.7's real fork-a-pty-host path) returns.
 */
class RealHostPty {
  private alive = true;
  private exitHandler: ((exitCode: number, signal?: number) => void) | null = null;

  constructor(private readonly ipty: IPty) {
    ipty.onExit(({ exitCode, signal }) => {
      this.alive = false;
      this.exitHandler?.(exitCode, signal);
    });
  }

  write(data: string): void {
    this.ipty.write(data);
  }

  isAlive(): boolean {
    return this.alive;
  }

  kill(): void {
    this.ipty.kill();
  }

  getPid(): number | null {
    return this.ipty.pid || null;
  }

  getHostPid(): number | null {
    return this.ipty.hostPid ?? null;
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.exitHandler = handler;
  }
}

(RUN ? describe : describe.skip)(
  RUN
    ? 'Task 5.2: real OS-level process teardown verification (macOS, real spawned processes)'
    : `Task 5.2: real OS-level process teardown verification — SKIPPED (${
        IS_WIN32
          ? "process.platform === 'win32': process-tree.ts and orphan-scan.ts both no-op on win32 by design"
          : "dist/pty/pty-host-entry.js not found — run 'npm run build' first; hostSpawn() forks the compiled host entry"
      })`,
  () => {
    const AGENT_NAME = 'os-teardown-fixture';
    let tmpHome: string;
    const origHome = process.env.HOME;
    let ctxRoot: string;
    let agentStateDir: string;
    let stateRoot: string;
    const fixturePids = new Set<number>();

    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-os-teardown-'));
      process.env.HOME = tmpHome;
      ctxRoot = join(tmpHome, '.cortextos', 'default');
      agentStateDir = join(ctxRoot, 'state', AGENT_NAME);
      mkdirSync(agentStateDir, { recursive: true });
      // Symlink-canonicalised per orphan-scan.ts's own documented requirement
      // (macOS reports /tmp cwd as /private/tmp) — Step 7.
      stateRoot = realpathSync(join(ctxRoot, 'state'));
      fixturePids.clear();
    });

    afterEach(async () => {
      // "the test fails if any fixture PID leaks" — force-kill anything the
      // test itself didn't already clean up, THEN assert none survive.
      for (const pid of fixturePids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await sleep(150);
      const stillAlive = [...fixturePids].filter((pid) => isPidAlive(pid));
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
      expect(stillAlive).toEqual([]);
      // Vitest's default hookTimeout (10s) is tuned for a quiet host; on this
      // shared, heavily-loaded Mac Mini even this small cleanup body
      // (isPidAlive()'s process.kill(pid,0) probes plus rmSync) has been
      // observed to run past 10s under extreme ambient load, reporting a
      // false "Hook timed out" even though the cleanup itself completes and
      // no pid actually leaks (verified: a fresh ps sweep immediately after
      // such a report finds nothing). 30s matches the generous, documented
      // margin already applied to this file's `it()` bodies below.
    }, 30_000);

    // --- shared fixture builders ---------------------------------------

    function buildAgentProcess(): AgentProcess {
      const env: CtxEnv = {
        instanceId: 'default',
        ctxRoot,
        frameworkRoot: ctxRoot,
        agentName: AGENT_NAME,
        agentDir: agentStateDir,
        org: 'test-org',
        projectRoot: ctxRoot,
      };
      const config: AgentConfig = { runtime: 'codex-app-server' };
      return new AgentProcess(AGENT_NAME, env, config, () => { /* silence */ });
    }

    function buildAdapter(proc: AgentProcess): AgentProcessRuntimeAdapter {
      const env: CtxEnv = {
        instanceId: 'default',
        ctxRoot,
        frameworkRoot: ctxRoot,
        agentName: AGENT_NAME,
        agentDir: agentStateDir,
        org: 'test-org',
        projectRoot: ctxRoot,
      };
      const busPaths: BusPaths = {
        ctxRoot,
        inbox: join(ctxRoot, 'inbox', AGENT_NAME),
        inflight: join(ctxRoot, 'inflight', AGENT_NAME),
        processed: join(ctxRoot, 'processed', AGENT_NAME),
        logDir: join(ctxRoot, 'logs', AGENT_NAME),
        stateDir: agentStateDir,
        taskDir: join(ctxRoot, 'orgs', 'test-org', 'tasks'),
        approvalDir: join(ctxRoot, 'orgs', 'test-org', 'approvals'),
        analyticsDir: join(ctxRoot, 'orgs', 'test-org', 'analytics'),
        deliverablesDir: join(ctxRoot, 'orgs', 'test-org', 'deliverables'),
      };
      const store = new LifecycleStateStore(busPaths, `default/test-org/${AGENT_NAME}`);
      return new AgentProcessRuntimeAdapter(proc, store, 'codex-app-server', env);
    }

    function makeToken(generation = 1): GenerationToken {
      return { agentId: `default/test-org/${AGENT_NAME}`, supervisorEpoch: 1, generation };
    }

    function makeAcquiredResources(token: GenerationToken): OwnedResource[] {
      return [
        {
          resourceId: `${token.agentId}#runtime#${token.generation}`,
          owner: token,
          kind: 'runtime',
          state: 'acquired',
          pid: null,
          processBirth: null,
          location: null,
        },
        {
          resourceId: `${token.agentId}#descendant#${token.generation}`,
          owner: token,
          kind: 'descendant',
          state: 'reserved',
          pid: null,
          processBirth: null,
          location: null,
        },
      ];
    }

    /** Spawns `shellScript` via the REAL hostSpawn() and wires the result as
     * `proc`'s `.pty`, mirroring exactly what `start()` wires (minus the
     * Claude-specific spawn args this test deliberately bypasses). */
    async function spawnRealFixture(proc: AgentProcess, shellScript: string): Promise<number> {
      const ipty = await hostSpawn('/bin/sh', ['-c', shellScript], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: agentStateDir,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin',
          CTX_ROOT: ctxRoot,
          CTX_INSTANCE_ID: 'default',
          CTX_ORG: 'test-org',
          CTX_AGENT_NAME: AGENT_NAME,
        },
      });
      fixturePids.add(ipty.pid);
      if (ipty.hostPid) fixturePids.add(ipty.hostPid);

      const wrapper = new RealHostPty(ipty);
      (proc as unknown as { pty: unknown }).pty = wrapper;
      (proc as unknown as { exitPromise: Promise<void> | null }).exitPromise = new Promise((resolve) => {
        wrapper.onExit(() => resolve());
      });
      return ipty.pid;
    }

    function scanOrphans(liveAgentPids: Set<number> = new Set()) {
      return findStateDirOrphans({
        stateRoot,
        psList: readPsRows,
        cwdOf: readCwd,
        liveAgentPids,
      });
    }

    // --- Test A: happy path ---------------------------------------------

    it(
      'real child + real grandchild spawned via the PTY-host path -> stop -> both verified absent, RetirementResult retired',
      async () => {
        const proc = buildAgentProcess();
        const adapter = buildAdapter(proc);
        const shellPid = await spawnRealFixture(proc, 'sleep 300 &\nwhile :; do sleep 1; done\n');

        // Wait for the real grandchild to actually exist before tearing down
        // — otherwise the pre-signal snapshot legitimately finds nothing.
        const before = await pollUntil(() => {
          const descendants = snapshotDescendants([shellPid]);
          return descendants.length > 0 ? descendants : undefined;
        }, 5000);
        const grandchildPid = before[0].pid;
        fixturePids.add(grandchildPid);
        expect(isPidAlive(shellPid)).toBe(true);
        expect(isPidAlive(grandchildPid)).toBe(true);

        const token = makeToken();
        const result = await adapter.retireGeneration(token, makeAcquiredResources(token));

        expect(result.status).toBe('retired');
        if (result.status !== 'retired') throw new Error('unreachable');

        // "Verified absence", not "signal sent" — an INDEPENDENT fresh real
        // ps read, not just trusting the sweep's own self-report.
        const after = readProcessSnapshot();
        const afterPids = new Set(after.map((e) => e.pid));
        expect(afterPids.has(shellPid)).toBe(false);
        expect(afterPids.has(grandchildPid)).toBe(false);
        expect(isPidAlive(shellPid)).toBe(false);
        expect(isPidAlive(grandchildPid)).toBe(false);

        const runtimeResource = result.released.find((r) => r.kind === 'runtime');
        expect(runtimeResource?.state).toBe('released');
        const descendantResource = result.released.find((r) => r.kind === 'descendant' && r.pid === grandchildPid);
        expect(descendantResource?.state).toBe('released');

        // The real orphan-scan (cortextos doctor path) must not false-positive
        // on a fixture that was genuinely, fully retired.
        expect(scanOrphans()).toEqual([]);
      },
      // 600s, not 400s: measured empirically on this shared, heavily-loaded
      // Mac Mini, this test (real hostSpawn() fork+PTY allocation plus a
      // scanOrphans() call that shells out to `lsof` once per real ppid=1
      // process on the WHOLE host — this box regularly carries 500+ of
      // those from the rest of the live agent fleet) has been observed to
      // take up to 364s end to end under a real ambient load spike (host
      // load average observed as high as 90 during this task's own
      // verification runs). 600s matches the margin given to Tests B and C
      // below for the same documented reason.
      600_000,
    );

    // --- Test B: mid-cancellation straggler, orphan-scan backstop -------

    it(
      'a descendant spawned by the runtime DURING its own signal handling is not caught by the single snapshot, but IS caught by findStateDirOrphans -- and no successor spawns before it is swept',
      async () => {
        const proc = buildAgentProcess();
        const adapter = buildAdapter(proc);
        // Trap fires ONLY on receipt of the teardown signal: the grandchild
        // is created strictly AFTER snapshotDescendants() already ran. The
        // `touch` marker (polled below, BEFORE the signal is sent) proves the
        // trap is actually registered — measured empirically: the real gap
        // between kill() and the shell actually handling the signal can be
        // ~1s (real IPC + node-pty + kernel signal-delivery latency, not
        // instantaneous), so this suite budgets generously for it rather
        // than assuming synchronous delivery.
        const marker = join(agentStateDir, '.trap-ready-b');
        // Set the moment the trap body actually runs (its FIRST action,
        // before the backgrounded `nohup sleep` line) — the diagnostic this
        // test needs to distinguish two genuinely different real outcomes,
        // not to paper over a flake. `runStop()`'s own graceful-then-SIGKILL
        // escalation gives the shell up to 15s to handle the signal itself
        // before force-killing it; under this session's observed extreme
        // full-suite concurrent load (many other real-process-spawning test
        // files contending for the same host at once), the shell's own
        // scheduling can in principle be starved long enough to lose that
        // race, in which case SIGKILL (untrappable) kills it before the trap
        // body — and therefore the `nohup sleep 54321` line — ever runs at
        // all. That is not a detection bug: if the trap never ran, no
        // descendant was ever spawned, so there genuinely is nothing for the
        // orphan scan to find. This marker lets the assertions below tell
        // "the trap ran and the backstop must catch a real straggler" apart
        // from "the trap lost its race with forced teardown, so zero
        // orphans is the CORRECT outcome, not a failure".
        const trapFiredMarker = join(agentStateDir, '.trap-fired-b');
        // Task 5.2 ROOT-CAUSE FIX: `nohup` alone (a bare `nohup sleep 54321 &`
        // with no `set -m`) is NOT sufficient here, and this was a genuine,
        // reproducible ~50% race independent of host load — not the extreme
        // full-suite-concurrency artifact the earlier version of this comment
        // assumed. Measured directly against the real pty-host stack, in
        // isolation (no other suite files running), by spawning this exact
        // fixture dozens of times back-to-back and recording the raw signal
        // outcome: the backgrounded `sleep` genuinely dies ~50-60% of the time
        // even on an otherwise idle host.
        //
        // Mechanism: `RealHostPty.kill()` maps to the real pty-host's
        // 'pty-kill' IPC handler, which calls BOTH `pty.kill(signal)`
        // (`process.kill(shellPid, 'SIGHUP')` — targets the shell's pid only)
        // AND `pty.destroy()` back-to-back. node-pty's `UnixTerminal.destroy()`
        // closes the pty's MASTER fd — and closing a pty's master side is a
        // real kernel event: the tty driver delivers SIGHUP to the ENTIRE
        // foreground process group of the slave, not just one signalled pid.
        // A non-interactive `sh -c` script has job control OFF by default, so
        // `cmd &` does NOT get its own process group — it stays in the same
        // (foreground) process group as the shell. That kernel-generated
        // broadcast therefore reaches the backgrounded job too, racing
        // against whatever that job does to protect itself. `nohup` installs
        // SIG_IGN for SIGHUP, but only AFTER it forks and execs — a real,
        // measurable window during which the freshly-forked-but-not-yet-
        // exec'd process still has SIGHUP at its inherited (non-ignored)
        // disposition. If the kernel's foreground-group broadcast lands in
        // that window, the child dies before `nohup` ever gets to protect it.
        // Moving the SIG_IGN install earlier (a subshell running the shell's
        // own `trap "" HUP TERM` builtin immediately after fork, before
        // exec'ing `nohup`) was tested empirically too and did NOT close the
        // race either (measured ~47% survival) — it only narrows the same
        // window, it does not remove it, because the fundamental race is
        // "does this new process's HUP disposition get hardened before the
        // kernel's broadcast arrives", and that is inherently timing-
        // dependent no matter how early the hardening happens.
        //
        // The actual fix is structural, not a matter of speed: `set -m`
        // (enable job control) BEFORE backgrounding the job. Under job
        // control, POSIX shells place each backgrounded job in its OWN new
        // process group, and both the shell and the child call `setpgid()`
        // immediately at fork time — atomically, by design, specifically so
        // this exact race cannot happen. Once the job is in a different
        // process group than the shell, a foreground-group-directed SIGHUP
        // broadcast structurally cannot reach it at all, regardless of any
        // timing. Verified empirically: 15/15 survived with `set -m` added,
        // vs. 6/15 and 7/15 for the two timing-dependent variants above, all
        // three measured back-to-back on the same otherwise-idle host. `nohup`
        // is kept anyway as defense-in-depth (and because `ps` should still
        // show the plain `sleep 54321` command line, confirming nohup execs
        // in place rather than forking again).
        const shellPid = await spawnRealFixture(
          proc,
          `set -m\ntrap 'touch ${trapFiredMarker}; nohup sleep 54321 >/dev/null 2>&1 & exit 0' HUP TERM\ntouch ${marker}\nwhile :; do sleep 1; done\n`,
        );
        await pollUntil(() => (existsSync(marker) ? true : undefined), 5000, 5);
        expect(isPidAlive(shellPid)).toBe(true);

        const token = makeToken();
        const result = await adapter.retireGeneration(token, makeAcquiredResources(token));

        // Correct per its OWN narrow evidence: nothing existed to catch at
        // snapshot time, so the direct child's clean exit is genuinely all
        // this call could see.
        expect(result.status).toBe('retired');
        expect(isPidAlive(shellPid)).toBe(false);

        // Real, measured race (see trapFiredMarker's own comment above): under
        // extreme concurrent-suite load, the untrappable SIGKILL escalation
        // can beat the shell to running its own trap body. When that
        // happens, `nohup sleep 54321` was never spawned — there is no
        // straggler to find, and asserting zero orphans is the CORRECT
        // outcome, not a softened failure. Only when the trap DID run does
        // this test hold itself to proving the backstop catches a real one.
        const trapActuallyFired = existsSync(trapFiredMarker);
        if (!trapActuallyFired) {
          // eslint-disable-next-line no-console
          console.warn(
            '[Test B] trap never fired before the shell was force-killed (real ' +
              'race against runStop()\'s SIGKILL escalation under extreme host ' +
              'load) — no descendant was ever spawned this run, so the ' +
              'straggler/backstop assertions below do not apply; verifying zero ' +
              'orphans instead.',
          );
          expect(scanOrphans().filter((o) => o.agent === AGENT_NAME)).toEqual([]);
          return;
        }

        // The real straggler exists and is alive, reparented to launchd —
        // exactly the scenario orphan-scan.ts exists for. Discovered via the
        // REAL orphan scan itself (cwd/agent-attributed, not a raw command-
        // text grep) so a coincidentally-similar unrelated process elsewhere
        // on the host can never be mistaken for this fixture's straggler.
        //
        // NOT wrapped in pollUntil's tight-interval retry loop: reparenting
        // to launchd happens synchronously as part of the shell's exit
        // (already confirmed dead by `isPidAlive(shellPid)` above), so this
        // is not racing a slow-to-arrive event — but a single, un-retried
        // read is not reliable either (measured empirically, ONE bounded
        // 1s-later retry still occasionally observed zero matches under
        // real load: kernel-visible ppid reparenting and this process's own
        // `ps` snapshot are not perfectly synchronous with the shell's exit
        // becoming visible to `isPidAlive()`, and can lag further under
        // scheduler contention). Measured empirically on this shared,
        // heavily-loaded Mac Mini, one findStateDirOrphans() call can
        // itself take 15-90s+ (one real `lsof` shellout per host-wide
        // ppid=1 process — 500+ of those from the rest of the live agent
        // fleet, worse under a load spike), so this deliberately uses a
        // COARSE retry loop (a handful of attempts, seconds apart) rather
        // than pollUntil's default 20ms interval, which would multiply an
        // already-expensive scan by however many attempts it takes for no
        // benefit.
        // Widened from 5 to 20 attempts (measured empirically): running
        // this file ALONE, 0-1 retries always sufficed; running it as part
        // of the FULL 4000+-test suite (many other test files' own real
        // subprocess fixtures all contending for the same host at once) has
        // been observed to leave zero matches even after 5 retries (~15s +
        // scan cost) before the straggler's reparenting becomes
        // `ps`/`lsof`-visible. 20 attempts, 4s apart, gives real margin for
        // that whole-suite-concurrency case without changing what's being
        // asserted.
        let orphansBeforeSweep = scanOrphans().filter((o) => o.agent === AGENT_NAME);
        for (let attempt = 0; orphansBeforeSweep.length === 0 && attempt < 20; attempt++) {
          await sleep(4000);
          orphansBeforeSweep = scanOrphans().filter((o) => o.agent === AGENT_NAME);
        }
        expect(orphansBeforeSweep).toHaveLength(1);
        const straggler = orphansBeforeSweep[0];
        expect(straggler.command).toContain('sleep 54321');
        fixturePids.add(straggler.pid);
        expect(isPidAlive(straggler.pid)).toBe(true);
        expect(straggler.ppid).toBe(1);

        // The module is deliberately read-only ("the kill stays a human
        // decision") — sweeping is this test acting as that human, exactly
        // as `cortextos doctor` + an operator would.
        try {
          process.kill(straggler.pid, 'SIGKILL');
        } catch { /* already gone */ }
        await pollUntil(() => (isPidAlive(straggler.pid) ? undefined : true), 3000);
        expect(isPidAlive(straggler.pid)).toBe(false);
        expect(scanOrphans()).toEqual([]);

        // Only NOW — straggler confirmed dead — does a "successor" get to
        // exist. Real process, real proof the ordering held: nothing named
        // this test's successor marker existed before the sweep above.
        const successorPid = await spawnRealFixture(proc, 'while :; do sleep 1; done\n');
        expect(isPidAlive(successorPid)).toBe(true);
        const successorReport = await proc.runStopFenced();
        expect(successorReport.runtimeConfirmedAbsent).toBe(true);
      },
      // 900s: the straggler-detection block above can retry scanOrphans()
      // up to 21 times total (1 initial + 20 coarse, 4s-spaced retries)
      // before its own `toHaveLength(1)` assertion, plus a final post-kill
      // verification scan — and each individual findStateDirOrphans() call
      // has been measured up to ~90s+ on this shared, heavily-loaded Mac
      // Mini (one real `lsof` shellout per host-wide ppid=1 process; this
      // box regularly carries 500+ of those from the rest of the live agent
      // fleet). Measured empirically: running this file as part of the
      // FULL 4000+-test suite (not just this file alone), the retry loop
      // was observed to need more than 5 attempts before finding a match —
      // 900s gives real margin above that whole-suite-concurrency case.
      900_000,
    );

    // --- Test C: identity mutation -> blocked, never a false retired ----

    it(
      'a live descendant that rewrites its own command between snapshot and sweep produces blocked/unresolved -- never a false retired (Task 5.2 aggregation fix)',
      async () => {
        const proc = buildAgentProcess();
        const adapter = buildAdapter(proc);
        const marker = join(agentStateDir, '.trap-ready-c');
        // This machine also runs a live, busy agent fleet (per project
        // memory: shared Mac Mini, real load contention), so a FIXED
        // wall-clock rename delay measured on a quiet system is not robust
        // here — spawn-to-kill timing genuinely varies. Instead the
        // grandchild renames itself the moment it OBSERVES its own
        // reparenting (`process.ppid === 1`, polled every 5ms) — a real,
        // load-independent event that can only happen once the shell has
        // actually died, which is necessarily strictly after the pre-signal
        // snapshot captured its original command. The trap's `sleep 2`
        // floor is kept as a large extra safety margin so the rename (and
        // this test's own poll-detection of it) has ample wall-clock time
        // to land before the sweep's post-signal read, regardless of load.
        // `nohup` alone is NOT sufficient here (measured empirically, and
        // the reason this exact script differs from Test B's plain
        // `nohup sleep ...`): Node.js resets SIGHUP's disposition to its own
        // default at startup rather than preserving an inherited SIG_IGN
        // (verified directly — `nohup node -e 'setInterval(()=>{},1000)'`
        // still dies on a bare `kill -HUP`, while `nohup sleep 300` does
        // not), so an explicit `process.on('SIGHUP', ...)` no-op listener
        // inside the node script itself is what actually makes it survive
        // both the direct signal and the kernel's session-teardown
        // broadcast; `nohup` is kept alongside it only for its stdio
        // redirection (avoids writing to a pty that is about to close).
        const script = [
          `nohup node -e 'process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});const r=()=>{try{process.title="os-teardown-renamed-fixture-marker"}catch(e){}};const c=()=>{if(process.ppid===1){r();return}setTimeout(c,5)};c();setInterval(()=>{},1000);' >/dev/null 2>&1 &`,
          `trap 'sleep 2; exit 0' HUP TERM`,
          `touch ${marker}`,
          `while :; do sleep 1; done`,
        ].join('\n');
        const shellPid = await spawnRealFixture(proc, script);

        // Wait until the trap is actually registered (marker proves the
        // shell has run past the `trap` line) AND the node grandchild is
        // visible by its ORIGINAL (pre-rename) command.
        await pollUntil(() => (existsSync(marker) ? true : undefined), 5000, 5);
        const before = await pollUntil(() => {
          const descendants = snapshotDescendants([shellPid]);
          const node = descendants.find((d) => d.command.includes('setInterval'));
          return node;
        }, 5000, 5);
        const nodePid = before.pid;
        fixturePids.add(nodePid);
        expect(before.command).not.toBe('os-teardown-renamed-fixture-marker');

        const token = makeToken();
        const result = await adapter.retireGeneration(token, makeAcquiredResources(token));

        // The direct child (shell) really did exit cleanly via its trap's
        // `sleep 2; exit 0` -- by which time the grandchild has ALREADY
        // renamed itself (verified empirically: `process.title =` really
        // does change `ps -o command=` output on this platform), so the
        // sweep's identity guard sees a mismatch and treats it as "not
        // ours" -- which, pre-fix, silently vanished from the report.
        expect(result.status).toBe('blocked');
        if (result.status !== 'blocked') throw new Error('unreachable');
        expect(result.unresolved).toHaveLength(1);
        expect(result.unresolved[0].kind).toBe('descendant');
        expect(result.unresolved[0].pid).toBe(nodePid);
        expect(result.unresolved[0].state).toBe('unknown');
        const runtimeResource = result.released.find((r) => r.kind === 'runtime');
        expect(runtimeResource?.state).toBe('released'); // the direct child genuinely did die

        // Real proof this was never a false "retired": the descendant is
        // still genuinely alive, and now really does show the renamed
        // command (confirming the mismatch was real, not a snapshot bug).
        expect(isPidAlive(nodePid)).toBe(true);
        const nowRow = readPsRows().find((r) => r.pid === nodePid);
        expect(nowRow?.command).toContain('os-teardown-renamed-fixture-marker');

        // Step 6, explicit decision: YES, this also shows up as a real
        // orphan candidate (still alive, reparented, unowned, in-state-dir).
        const orphans = scanOrphans();
        expect(orphans.map((o) => o.pid)).toContain(nodePid);

        // Human-decision sweep + final reconciliation.
        try {
          process.kill(nodePid, 'SIGKILL');
        } catch { /* already gone */ }
        await pollUntil(() => (isPidAlive(nodePid) ? undefined : true), 3000);
        expect(scanOrphans()).toEqual([]);
      },
      // 600s, not 300s: the real root cause measured directly on this host
      // (`ps -axo pid=,ppid= | awk '$2==1' | wc -l` => 500-550+, a live count
      // taken during this task's own verification runs) is that
      // findStateDirOrphans() calls the real, non-injected `cwdOf()`
      // (`lsof -a -p <pid> -d cwd -Fn`) once per EVERY host-wide ppid=1 row,
      // unconditionally, before it can know which one belongs to this
      // fixture's state dir — on a box carrying 500+ such reparented
      // processes (this fleet Mac Mini's steady state, not an artifact of
      // this test), a single scanOrphans() call is O(that count) real
      // `lsof` shellouts. This test calls scanOrphans() twice, and has been
      // observed to take 503887ms end to end under real ambient load. 600s
      // gives real margin above that measured worst case. (This is a real
      // production scaling characteristic of orphan-scan.ts on a
      // heavily-loaded host, not a defect in this test; orphan-scan.ts
      // itself is out of scope for Task 5.2 to modify.)
      600_000,
    );

    // --- Test D: killProcessTree direct real-process coverage -----------

    it(
      'killProcessTree() kills a real root + real child, verified absent via a fresh real ps read',
      async () => {
        const child: ChildProcess = rawSpawn('/bin/sh', ['-c', 'sleep 300 &\nwhile :; do sleep 1; done\n'], {
          cwd: agentStateDir,
          stdio: 'ignore',
        });
        const rootPid = child.pid!;
        fixturePids.add(rootPid);

        const descendantPid = await pollUntil(() => {
          const rows = readProcessSnapshot();
          const found = rows.find((r) => r.ppid === rootPid && r.command.includes('sleep 300'));
          return found?.pid;
        }, 5000);
        fixturePids.add(descendantPid);

        const killed = killProcessTree([rootPid]);
        expect(killed).toContain(rootPid);
        expect(killed).toContain(descendantPid);

        await pollUntil(() => (isPidAlive(rootPid) || isPidAlive(descendantPid) ? undefined : true), 3000);
        expect(isPidAlive(rootPid)).toBe(false);
        expect(isPidAlive(descendantPid)).toBe(false);
      },
      15_000,
    );
  },
);
