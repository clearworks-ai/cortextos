import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { homedir } from 'os';
import type { AgentConfig, AgentStatus, CtxEnv } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { CodexAppServerPTY } from '../pty/codex-app-server-pty.js';
import { HermesPTY, hermesDbExists } from '../pty/hermes-pty.js';
import { OpencodePTY, opencodeSessionExists } from '../pty/opencode-pty.js';
import { MessageDedup, injectMessage as injectMessageIntoPty } from '../pty/inject.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir } from '../utils/atomic.js';
import { writeCortextosEnv } from '../utils/env.js';
import { getOverdueReminders } from '../bus/reminders.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { loadBuffer } from './conversation-buffer.js';
import { ensureMissionAnchorFromBuffer } from './restart-context.js';
import { readEnabledAgentsMap } from '../bus/enabled-agents-io.js';

type LogFn = (msg: string) => void;

// ---------------------------------------------------------------------------
// WS8 Layer A — fleet-degrade marker support
// ---------------------------------------------------------------------------

/**
 * Shape of state/fleet-degrade.json written by credential-preflight.py on
 * a debounced Anthropic DEPLETED / sustained RATE_LIMITED event.
 */
interface FleetDegradeMarker {
  anthropic?: string;
  since?: string;
  degrade_map?: {
    reasoning?: string;
    mechanical?: string;
  };
  failover_runtime?: string;
}

/**
 * Read the fleet-degrade marker from the larry agent's state directory.
 * Returns null when the marker is absent, unreadable, or malformed — the
 * default (no-degrade) path is ALWAYS safe: this function never throws.
 */
function readFleetDegradeMarker(frameworkRoot: string): FleetDegradeMarker | null {
  try {
    const markerPath = join(
      frameworkRoot,
      'orgs', 'clearworksai', 'agents', 'larry', 'state', 'fleet-degrade.json',
    );
    if (!existsSync(markerPath)) return null;
    const raw = readFileSync(markerPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as FleetDegradeMarker;
  } catch {
    // Malformed / unreadable marker — conservative: do not degrade.
    return null;
  }
}

/**
 * If the fleet-degrade marker is active AND this agent has opted in
 * (degrade_ok:true), return an override config slice with the failover
 * runtime and model substituted. Otherwise return null (no change).
 *
 * Called once per start() BEFORE the PTY is constructed so the spawn
 * picks up the degraded runtime/model automatically.
 */
function computeDegradeOverride(
  frameworkRoot: string,
  config: AgentConfig,
  log: LogFn,
): { runtime: 'opencode'; model: string } | null {
  // Guard: only agents that explicitly opt in are eligible.
  if (!config.degrade_ok) return null;

  // Guard: only claude-code agents can be degraded (non-Anthropic runtimes
  // are already off Anthropic and don't need failover).
  if (config.runtime && config.runtime !== 'claude-code') return null;

  const marker = readFleetDegradeMarker(frameworkRoot);
  if (!marker) return null;

  // Marker must signal Anthropic depletion.
  if (marker.anthropic !== 'DEPLETED') return null;

  // Resolve the cheap model from the degrade_map using the agent's tier.
  const tier = config.degrade_tier ?? 'mechanical';
  const cheapModel = marker.degrade_map?.[tier];
  if (!cheapModel) {
    log(`[degrade] marker present but no degrade_map.${tier} — skipping failover`);
    return null;
  }

  const failoverRuntime = (marker.failover_runtime ?? 'opencode') as 'opencode';
  log(`[degrade] Anthropic DEPLETED — degrading to ${failoverRuntime} / ${cheapModel} (tier: ${tier})`);
  return { runtime: failoverRuntime, model: cheapModel };
}

/**
 * Manages a single agent's lifecycle.
 * Replaces agent-wrapper.sh for one agent.
 */
export class AgentProcess {
  readonly name: string;
  private env: CtxEnv;
  private config: AgentConfig;
  private pty: AgentPTY | CodexAppServerPTY | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private crashCount: number = 0;
  private maxCrashesPerDay: number = 10;
  // CrashLoopPauser (instar-inspired): sliding-window crash detection.
  // Timestamps of recent crashes within the configured window. If the
  // window fills, the agent auto-pauses instead of retrying with backoff.
  private crashTimestamps: number[] = [];
  private crashWindowMs: number = 0;
  private crashWindowMax: number = 0;
  // Image-poison recovery circuit breaker: tracks recent recovery attempts
  // to prevent infinite loops when force-fresh fails to clear poisoned history
  private imagePoisonRecoveries: number[] = [];
  // Clean-exit (code 0) recovery: tracks recent clean restarts so a genuinely
  // broken code-0 tight-loop still halts, while normal code-0 lifecycle exits
  // (opencode TUI turn-completion) do not charge the daily crash counter.
  private cleanExitRestarts: number[] = [];
  // Startup-failure detection for code-0 exits: opencode (and any runtime) can
  // exit 0 IMMEDIATELY on a real startup failure (bad config/model/env) — it
  // prints an error and exits cleanly BEFORE the session ever became ready.
  // That is NOT a normal turn-completion; retrying it silently spins. We stamp
  // the wall-clock start of every spawn attempt here so handleExit can measure
  // how long the process lived and distinguish "exited before ready" (a real
  // startup fault, surfaced loudly) from "completed a turn" (benign).
  private spawnStartedAtMs: number = 0;
  // Timestamps of recent code-0 exits that occurred BEFORE the agent reached a
  // ready/running state. A cluster of these is a startup crashloop, not normal
  // lifecycle — the circuit breaker below trips and alerts instead of looping.
  private cleanExitStartupFailures: number[] = [];
  private sessionStart: Date | null = null;
  private status: AgentStatus['status'] = 'stopped';
  private stopping: boolean = false;
  // BUG-040 fix: persists across stop() return until handleExit clears it.
  // Required because BUG-032's CRLF + 5s wait can cause graceful shutdown to
  // exceed the 5s Promise.race timeout in stop(), which would otherwise reset
  // `stopping=false` BEFORE the PTY actually exits, then handleExit would fire
  // with stopping=false and trigger spurious crash recovery (a partial regression
  // of BUG-011). stopRequested survives the timeout and is only cleared either
  // by handleExit when an intentional exit fires, or by start() at the beginning
  // of a new lifecycle.
  private stopRequested: boolean = false;
  // BUG-040 fix: monotonic generation counter incremented on each successful
  // start(). Each PTY's onExit closure captures the generation at spawn time
  // and bails out if the generation doesn't match — i.e. a NEW PTY has been
  // spawned since this old one was created. Without this guard, a late exit
  // from an old PTY can race past stopRequested and trigger crash recovery on
  // the new agent.
  private lifecycleGeneration: number = 0;
  // BUG-011 fix: stop() awaits this promise (resolved by the onExit handler in start())
  // to guarantee the PTY exit has fired before stopping=false is reset. Without
  // this, the exit handler can fire after stopping=false and trigger spurious
  // crash recovery for an agent we just stopped intentionally.
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  // Double-fire restart fix: single-flight guard around start(). start() is an
  // async method with multiple awaits (startup_delay sleep, async env resolution,
  // pty.spawn) and is reachable from SIX independent triggers — crash-recovery
  // setTimeout, clean-exit/image-poison recovery, fast-checker context force-restart
  // (sessionRefresh), IPC restart-agent, boot reconcile, and stopAgent's queued
  // pendingRestart. The old guard `if (status === 'running')` did NOT cover the
  // window where status is 'starting'/'crashed'/'stopped': two triggers firing
  // close in time (the confirmed "15s apart" evidence) both passed the guard and
  // both awaited through to pty.spawn(), leaving TWO live PTYs for one agent —
  // the dual-larry / 5x-frank2 duplicate-process incident (2026-08-04). This
  // promise coalesces every concurrent start onto the first in-flight spawn.
  private inFlightStart: Promise<void> | null = null;
  private dedup: MessageDedup;
  private log: LogFn;
  private onStatusChange: ((status: AgentStatus) => void) | null = null;
  // Issue #330: held here so CodexAppServerPTY can be re-wired across session refresh
  // (each start() recreates the PTY, but the Telegram handle persists).
  private telegramApi: TelegramAPI | null = null;
  private telegramChatId: string | null = null;
  // Issue #392: tracks whether the most recently built startup prompt consumed
  // a handoff doc marker. start() reads this after spawn to decide whether the
  // daemon should fire runtime-owned lifecycle Telegram directly.
  private lastSpawnWasHandoff = false;

  constructor(name: string, env: CtxEnv, config: AgentConfig, log?: LogFn) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== undefined) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    if (config.crash_window?.seconds) {
      this.crashWindowMs = config.crash_window.seconds * 1000;
      this.crashWindowMax = config.crash_window.max_crashes ?? 3;
    }
    this.dedup = new MessageDedup();
    this.log = log || ((msg) => console.log(`[${name}] ${msg}`));
  }

  /**
   * Start the agent. Spawns Claude Code in a PTY.
   *
   * Single-flight: if a start is already in flight (or the agent is already
   * running), the concurrent caller COALESCES onto the existing start instead
   * of spawning a second PTY. This is the root fix for the daemon double-fire
   * restart bug — see the `inFlightStart` field comment. Without it, two
   * near-simultaneous restart triggers each raced through start()'s awaits and
   * each reached pty.spawn(), producing two live processes for one agent.
   */
  async start(): Promise<void> {
    // Already running — nothing to do. (Kept as a cheap synchronous fast-path;
    // startImpl re-checks after the guard.)
    if (this.status === 'running') {
      this.log('Already running');
      return;
    }

    // A start is already underway — coalesce. The second trigger neither spawns
    // nor throws; it simply awaits the in-flight start's outcome. This is what
    // turns two concurrent restart triggers into exactly ONE spawn.
    if (this.inFlightStart) {
      this.log('Start already in flight — coalescing concurrent start request (no second spawn).');
      return this.inFlightStart;
    }

    const startPromise = this.startImpl().finally(() => {
      // Clear the guard only if it still points at THIS start. A later start()
      // could have replaced it (it cannot, given we only set it when null — but
      // this keeps the invariant explicit and defends future refactors).
      if (this.inFlightStart === startPromise) {
        this.inFlightStart = null;
      }
    });
    this.inFlightStart = startPromise;
    return startPromise;
  }

  /**
   * Actual start work. Never call directly — always go through start() so the
   * single-flight guard is honored.
   */
  private async startImpl(): Promise<void> {
    // Re-check under the guard: a start may have completed between the
    // synchronous fast-path in start() and this body running.
    if (this.status === 'running') {
      this.log('Already running');
      return;
    }

    // Apply startup delay
    const delay = this.config.startup_delay || 0;
    if (delay > 0) {
      this.log(`Startup delay: ${delay}s`);
      await sleep(delay * 1000);
    }

    // Write .cortextos-env for backward compat (D6)
    if (this.env.agentDir) {
      writeCortextosEnv(this.env.agentDir, this.env);
    }

    // Determine start mode
    const mode = this.shouldContinue() ? 'continue' : 'fresh';
    // D4 mission-anchor restore: on a FRESH (crash) restart the --continue
    // conversation history is gone, so recover the live mission from the
    // conversation buffer into state/current-mission.txt (best-effort, no-op
    // if the anchor already exists) BEFORE the boot prompt is built, so the
    // agent picks it up when it reads its bootstrap files. Graceful/handoff
    // restarts already have an anchor, so this only ever fills the crash gap.
    if (mode === 'fresh') {
      ensureMissionAnchorFromBuffer(this.env.agentDir, this.env.ctxRoot, this.name);
    }
    const prompt = mode === 'fresh'
      ? this.buildStartupPrompt()
      : this.buildContinuePrompt();

    this.log(`Starting in ${mode} mode`);
    this.status = 'starting';

    // BUG-040 fix: clear any stale stop request from a previous lifecycle
    // (e.g. if the previous stop() timed out before the PTY actually exited).
    // We're starting fresh — the new PTY has no pending stop.
    this.stopRequested = false;
    // BUG-040 fix: bump generation. The onExit closure below captures THIS
    // value and uses it to detect "I'm an old PTY whose exit fired after a
    // new lifecycle began" — in which case it bails out without touching
    // handleExit, preventing spurious crash recovery on the new agent.
    const myGeneration = ++this.lifecycleGeneration;
    // Stamp the spawn start so handleExit can measure how long this attempt
    // lived. A code-0 exit that fires within a few seconds of this stamp is an
    // exit-BEFORE-ready (a real startup fault), not a normal turn completion.
    this.spawnStartedAtMs = Date.now();

    // Create PTY — runtime-specific subclass handles binary, args, bootstrap detection
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    ensureDir(join(this.env.ctxRoot, 'logs', this.name));
    this.log(`Log path: ${logPath}`);

    // WS8 Layer A — fleet-degrade failover: if the fleet-degrade marker is
    // active and this agent has degrade_ok:true, substitute the cheap
    // failover runtime + model for THIS spawn only. The config object is
    // never mutated; only the effective PTY construction is overridden.
    // All reads are guarded so a malformed/absent marker is a no-op.
    const degradeOverride = computeDegradeOverride(this.env.frameworkRoot, this.config, this.log);
    const effectiveConfig: AgentConfig = degradeOverride
      ? { ...this.config, runtime: degradeOverride.runtime, model: degradeOverride.model }
      : this.config;

    this.pty = effectiveConfig.runtime === 'hermes'
      ? new HermesPTY(this.env, effectiveConfig, logPath)
      : effectiveConfig.runtime === 'opencode'
        ? new OpencodePTY(this.env, effectiveConfig, logPath)
        : effectiveConfig.runtime === 'codex-app-server'
          ? new CodexAppServerPTY(this.env, effectiveConfig, logPath)
          : new AgentPTY(this.env, effectiveConfig, logPath);

    // Issue #330: re-wire the Telegram handle on every start() (session refresh
    // creates a fresh CodexAppServerPTY). Only CodexAppServerPTY uses this — Claude / Hermes
    // typing indicators flow through fast-checker.
    if (this.config.runtime === 'codex-app-server' && this.telegramApi && this.telegramChatId) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(this.telegramApi, this.telegramChatId);
    }

    // BUG-011 fix: create a fresh exit signal for this run. resolveExit is
    // called from the onExit handler below; stop() awaits exitPromise to
    // guarantee the exit handler has fired before clearing stopping.
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    // Handle exit
    this.pty.onExit((exitCode, signal) => {
      // BUG-040 fix: if the lifecycle has moved on (a new start() incremented
      // the generation since this PTY was spawned), this is an old PTY's late
      // exit. Ignore it entirely — we don't want it to trigger handleExit on
      // the current PTY's state.
      if (myGeneration !== this.lifecycleGeneration) {
        this.log(`Ignoring late exit from previous lifecycle gen ${myGeneration} (current: ${this.lifecycleGeneration})`);
        return;
      }
      this.log(`Exited with code ${exitCode} signal ${signal}`);
      this.handleExit(exitCode);
      // Signal anyone awaiting this PTY's exit (e.g. stop() — BUG-011 fix)
      this.resolveExit?.();
      this.resolveExit = null;
    });

    try {
      await this.pty.spawn(mode, prompt);
      // Codex exec-per-turn race: the new PTY's onExit can fire BEFORE this
      // line if `codex exec` completes its prompt quickly (CodexAppServerPTY's spawn
      // resolves once exec is launched, but the process may exit moments
      // later as it finishes the bootstrap turn). handleExit() nulls
      // this.pty and schedules crash recovery — we must not claim 'running'
      // or call getPid() on null in that window.
      if (!this.pty) {
        this.log('PTY exited during spawn — handleExit will recover');
        return;
      }
      this.status = 'running';
      this.sessionStart = new Date();
      this.log(`Running (pid: ${this.pty.getPid()})`);

      this.maybeSendRuntimeLifecycleNotification();

      // Start session timer
      this.startSessionTimer();

      this.notifyStatusChange();
    } catch (err) {
      this.log(`Failed to start: ${err}`);
      this.status = 'crashed';
      this.notifyStatusChange();
    }
  }

  /**
   * Stop the agent gracefully.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // BUG-040 fix: stopRequested persists ACROSS stop()'s return until
    // handleExit clears it. This is the safety net for the case where the
    // PTY exits later than the Promise.race timeout below.
    this.stopRequested = true;
    this.log('Stopping...');
    this.clearSessionTimer();

    // Capture and null out pty BEFORE any awaits so handleExit() during graceful
    // shutdown doesn't race with us and trigger crash recovery or a double-kill.
    const pty = this.pty;
    this.pty = null;
    // Capture the exit promise before any awaits — we'll wait on this AFTER
    // pty.kill() to guarantee the exit handler has run before stopping=false.
    const exitPromise = this.exitPromise;

    if (pty) {
      try {
        if (this.config.runtime === 'hermes') {
          // Hermes REPL exit: Ctrl+D is the clean exit signal.
          // Hermes has a double-tap guard on Ctrl+C (accidental exit protection),
          // so we use Ctrl+D which exits cleanly on the first press.
          pty.write('\x04'); // Ctrl+D
          await sleep(3000);
        } else if (this.config.runtime === 'codex-app-server') {
          // Codex uses an exec-per-turn model — there is no persistent REPL
          // between turns, so /exit + sleep below are no-ops on CodexAppServerPTY
          // (write() just buffers). The only meaningful stop step is
          // pty.kill(), which terminates the in-flight `codex exec` (if any)
          // and flips _alive=false. Skipping the 6s Claude-REPL dance makes
          // `bus hard-restart` feel responsive instead of appearing to do
          // nothing for several seconds.
        } else if (this.config.runtime === 'opencode') {
          // OpenCode runs as a TUI. It does not use Claude Code's `/exit`
          // command contract, so stop with Ctrl-C and then let the shared
          // liveness check below kill the PTY if it is still running.
          pty.write('\x03'); // Ctrl-C
          await sleep(1000);
        } else {
          // BUG-032 fix: use CRLF (not lone CR) so Claude Code's REPL actually
          // recognizes the /exit line as a complete command, AND wait long
          // enough (5s, was 3s) for the child to flush + exit cleanly. Without
          // these the child often dies from SIGHUP (exit code 129) when the
          // PTY is torn down before /exit has been processed. PR #11's
          // BUG-011 fix already ensured the daemon doesn't misinterpret 129
          // as a real crash, but the underlying graceful-shutdown sequence
          // still wasn't graceful — this PR makes it so.
          pty.write('\x03'); // Ctrl-C
          await sleep(1000);
          pty.write('/exit\r\n');
          await sleep(5000);
        }
      } catch {
        // Ignore write errors during shutdown
      }
      // BUG-032 follow-up: only kill the PTY if the process is still alive.
      // After /exit + 5s wait, the child has usually exited cleanly. Calling
      // pty.kill() on an already-exited PTY tears down the file descriptor,
      // which can send SIGHUP (exit code 129) to a process that was in the
      // middle of flushing. Polling first eliminates the remaining SIGHUP risk.
      if (pty.isAlive()) {
        try {
          pty.kill();
        } catch {
          // PTY may have exited between the check and the kill — ignore
        }
      }

      // BUG-011 fix: AWAIT the exit handler before resolving stop().
      // BUG-040 fix: bumped timeout from 5s to 15s to give the PTY plenty of
      // time to exit cleanly even when BUG-032's slow graceful shutdown stacks
      // on top of pty.kill() lag. The functional correctness no longer depends
      // on this timeout (stopRequested handles late exits), but a generous
      // timeout reduces "Ignoring late exit from previous lifecycle" log noise.
      if (exitPromise) {
        await Promise.race([exitPromise, sleep(15000)]);
      }
    }

    this.stopping = false;
    // NOTE: this.stopRequested is intentionally NOT cleared here. It is
    // cleared by handleExit when the intentional exit fires (or by start()
    // when a new lifecycle begins). See BUG-040 fix in handleExit().
    this.status = 'stopped';
    this.notifyStatusChange();
    this.log('Stopped');
  }

  /**
   * Restart with --continue (session refresh).
   *
   * Delegates to stop() + start() so it inherits the BUG-011 race fix
   * automatically. This also eliminates a separate bug in the previous
   * inline implementation where the OLD pty's exit handler could fire
   * AFTER the NEW pty was set up, nulling out the wrong reference.
   * `start()` will pick up `continue` mode automatically because the
   * conversation directory still has .jsonl files (shouldContinue() is true).
   */
  async sessionRefresh(): Promise<void> {
    this.log('Session refresh (--continue restart)');
    // Write .session-refresh marker so the SessionEnd crash-alert hook
    // (src/hooks/hook-crash-alert.ts) classifies the imminent PTY exit as a
    // session refresh rather than a crash. The hook's marker handler +
    // quiet-suppression set + message switch were all wired for this type,
    // but no writer existed — every --continue rollover at the session-time
    // cap surfaced as a false-positive 'crash' on chief/analyst + the
    // crashes.log file.
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
      writeFileSync(
        join(paths.stateDir, '.session-refresh'),
        'session-time-cap rollover\n',
        'utf-8',
      );
    } catch (err) {
      this.log(`Failed to write .session-refresh marker: ${err}`);
    }
    await this.stop();
    await this.start();
    this.log('Session refreshed');
  }

  /**
   * Inject a message into the agent's PTY — structured outcome.
   *
   * Distinguishes NOT_RUNNING (agent registered but no live PTY) from
   * DEDUPED (content collapsed against the in-process MessageDedup window).
   * See issue #346 — both used to surface as a bare `false` and got mistaken
   * for "agent not found" by operators investigating restart/cron failures.
   */
  injectMessageDetailed(content: string): { ok: true } | { ok: false; code: 'NOT_RUNNING' | 'DEDUPED'; message: string } {
    if (!this.pty || this.status !== 'running') {
      return { ok: false, code: 'NOT_RUNNING', message: `agent "${this.name}" is registered but not running (status: ${this.status})` };
    }

    if (this.dedup.isDuplicate(content)) {
      this.log('Dedup: skipping duplicate message');
      return { ok: false, code: 'DEDUPED', message: `inject for "${this.name}" deduped — content matches MessageDedup hash window` };
    }

    if ('injectMessage' in this.pty && typeof this.pty.injectMessage === 'function') {
      this.pty.injectMessage(content);
    } else {
      // CodexAppServerPTY intentionally models stdin writes itself and does not
      // inherit AgentPTY. Feed it through the same write path used historically.
      injectMessageIntoPty((data) => this.pty?.write(data), content);
    }
    return { ok: true };
  }

  /**
   * Inject a message into the agent's PTY (back-compat boolean wrapper).
   * New callers that need to distinguish DEDUPED from NOT_RUNNING should use
   * `injectMessageDetailed()` instead.
   */
  injectMessage(content: string): boolean {
    return this.injectMessageDetailed(content).ok;
  }

  /**
   * Check if the agent has bootstrapped (ready for messages).
   */
  isBootstrapped(): boolean {
    return this.pty?.getOutputBuffer().isBootstrapped() ?? false;
  }

  /**
   * Pid of the forked pty-host child (parent of the status pid), when known.
   * RW-3: consumed by AgentManager.reconcileDeadRegistryEntry so a phantom
   * reconcile kills the FULL tree (pty-host + claude + descendants) instead
   * of leaking whichever half of the pair is still alive.
   */
  getHostPid(): number | null {
    return this.pty?.getHostPid() ?? null;
  }

  /**
   * Forked pty-host child's PID for this agent's live pty, or null (RW-6:
   * consumed by AgentManager.getOwnedPtyHostPids for the pty-host reaper).
   */
  getPtyHostPid(): number | null {
    return this.pty?.getHostPid() ?? null;
  }

  /**
   * Get current agent status.
   */
  getStatus(): AgentStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() || undefined,
      uptime: this.sessionStart
        ? Math.floor((Date.now() - this.sessionStart.getTime()) / 1000)
        : undefined,
      sessionStart: this.sessionStart?.toISOString(),
      crashCount: this.crashCount,
      model: this.config.model,
    };
  }

  /**
   * Register a status change handler.
   */
  onStatusChanged(handler: (status: AgentStatus) => void): void {
    this.onStatusChange = handler;
  }

  /**
   * Wire the agent's Telegram bot handle. Used by CodexAppServerPTY (issue #330) to
   * fire sendChatAction directly from the JSONL stream. Safe to call before
   * or after start() — the handle is re-applied on every PTY (re)spawn.
   */
  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this.telegramApi = api;
    this.telegramChatId = chatId;
    if (this.config.runtime === 'codex-app-server' && this.pty) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(api, chatId);
    }
  }

  /**
   * Write raw data to the agent's PTY.
   * Used for TUI navigation (key sequences).
   */
  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
    }
  }

  /**
   * Get the output buffer for reading agent output.
   */
  getOutputBuffer() {
    return this.pty?.getOutputBuffer();
  }

  /**
   * Get the agent directory (where config.json and .env live).
   */
  getAgentDir(): string {
    return this.env.agentDir;
  }

  /**
   * Get the current agent config (live reference — fields may be updated in-place).
   */
  getConfig(): AgentConfig {
    return this.config;
  }

  // --- Private methods ---

  /**
   * Read the tail of this agent's stdout.log without loading the whole file.
   * Used by handleExit() to inspect recent output for known-crash signatures
   * (e.g. the image-poison API 400 pattern) so it can decide whether the
   * exit is a real crash or a recoverable upstream artifact.
   *
   * Returns an empty string if the log doesn't exist or can't be read.
   */
  private tailStdoutLog(maxBytes: number): string {
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    try {
      if (!existsSync(logPath)) return '';
      const stats = statSync(logPath);
      const start = Math.max(0, stats.size - maxBytes);
      const len = stats.size - start;
      // Synchronous read of the tail; small and bounded so the cost is fine
      // even in the exit handler.
      const fd = openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, start);
        return buf.toString('utf-8', 0, read);
      } finally {
        closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /**
   * Match the API 400 image-poison signature in recent stdout.
   *
   * Two variants observed in Anthropic's Messages API responses:
   *   `API Error: 400 messages.N.content.M.image.source.base64.data: Image format image/<fmt> not supported`
   *   `API Error: 400 ... image.source.base64.data: ...`
   *
   * Matching the prefix `image.source.base64` is robust to wording changes
   * in Anthropic's error string; matching `image format image/<fmt>` is the
   * confirmed exact wording today and gives a second signal. Either is enough.
   */
  private detectImagePoisonCrash(recentOutput: string): boolean {
    if (!recentOutput) return false;
    if (recentOutput.includes('API Error: 400') && recentOutput.includes('image.source.base64')) {
      return true;
    }
    if (/image format image\/[a-z]+ not supported/i.test(recentOutput)) {
      return true;
    }
    return false;
  }

  /**
   * Write the `.force-fresh` marker that AgentProcess.shouldContinue() reads
   * on the next start() to force a fresh Claude Code session (no --continue).
   * Used by the image-poison auto-recovery in handleExit().
   */
  private armForceFresh(reason: string): void {
    try {
      const stateDir = join(this.env.ctxRoot, 'state', this.name);
      ensureDir(stateDir);
      const markerPath = join(stateDir, '.force-fresh');
      writeFileSync(markerPath, `${new Date().toISOString()} ${reason}\n`, 'utf-8');
    } catch (err) {
      this.log(`Failed to arm .force-fresh marker: ${err}`);
    }
  }

  /**
   * Fresh check of whether this agent is user-disabled. Reads live state
   * (NOT a cached snapshot) because enabled-agents.json and config.json can
   * change while the process is running — this is the same pair of gates
   * discoverAndStart() applies at daemon boot (agent-manager.ts).
   * Default-on: absent entry / unreadable file ⇒ enabled. Fail-open on
   * reader errors so the gate can never throw inside handleExit.
   * The shared reader is lock-free and non-throwing (RW-9/M5 convergence):
   * a locked read here serialized the daemon loop for up to 5s per exit
   * during crash storms. The try/catch below stays as defense in depth.
   */
  private isDisabled(): boolean {
    if (this.config.enabled === false) {
      return true;
    }
    try {
      const entry = readEnabledAgentsMap(this.env.ctxRoot)[this.name];
      return entry?.enabled === false;
    } catch {
      return false;
    }
  }

  private handleExit(exitCode: number): void {
    // Capture last 16KB of the agent's stdout BEFORE nulling pty.
    // Used by the image-poison auto-recovery check below — reads the log
    // file so this works even if the PTY buffer has already been GC'd.
    const recentOutput = this.tailStdoutLog(16384);

    this.pty = null;
    this.clearSessionTimer();

    // When the cortextos daemon is shut down by PM2, SIGTERM propagates to
    // the whole process group and reaches each PTY's Claude Code child
    // BEFORE the daemon's stopAll() loop has a chance to call stopAgent() on
    // it. Those children exit cleanly (code 0) but arrive at handleExit with
    // stopRequested=false, which used to classify the exit as a crash and
    // inflate .crash_count_today by one per agent, per PM2 restart.
    //
    // agent-manager.ts:stopAll() already writes a `.daemon-stop` marker in
    // every agent's state dir at the START of its shutdown loop for an
    // unrelated reason (SessionEnd crash-alert hook). We reuse that marker
    // here as the authoritative "the daemon is going down" signal. If the
    // marker exists AND is recent (written within the last 60s), any PTY
    // exit is a shutdown casualty, not a real crash — swallow it.
    //
    // The 60s window guards against a stale marker from a previous shutdown
    // that wasn't cleaned up: we do NOT want an old marker to silently mask
    // a genuine crash days later. handleExit does NOT delete the marker —
    // cleanup stays with agent-manager / hook-crash-alert per the existing
    // separation of concerns.
    if (this.isDaemonShuttingDown()) {
      return;
    }

    // Disabled-agent resurrection fix: an agent disabled via config.json or
    // enabled-agents.json while running must NOT be respawned by any crash-
    // recovery path below (image-poison, exponential backoff).
    // Fresh read at exit time — the disable may have happened after start().
    // Also skips the crash-count increment: an operator-disabled agent's exit
    // is intentional-by-policy, not a crash.
    if (this.isDisabled()) {
      this.log('Exit while agent is disabled (config.json enabled:false or enabled-agents.json) — not respawning.');
      this.stopRequested = false;
      this.status = 'stopped';
      this.notifyStatusChange();
      return;
    }

    // BUG-040 fix: check stopRequested instead of (only) stopping. The
    // stopping flag is cleared inside stop() after a 15s timeout window —
    // which means a slow PTY shutdown can fire handleExit AFTER stopping is
    // already false, leading to spurious crash recovery. stopRequested is
    // set by stop() at the START of the shutdown sequence and persists across
    // stop()'s return until handleExit clears it (right here). This guarantees
    // that the FIRST exit after a stop() call is treated as intentional, no
    // matter how delayed it is.
    //
    // Also keep the legacy `stopping` check for in-progress detection during
    // the (most common) case where the exit fires while stop() is still
    // awaiting. Either flag short-circuits crash recovery.
    if (this.stopRequested || this.stopping) {
      this.stopRequested = false;
      return;
    }

    // Planned context-handoff restart: NOT a crash. When an agent's context
    // fills, the daemon (fast-checker) or `cortextos bus hard-restart` writes a
    // fresh `.restart-planned` marker (src/bus/system.ts) and the agent exits
    // to reload with a smaller context. A busy agent legitimately handoffs
    // 15-25x/day; counting each toward max_crashes_per_day (or the crash-loop
    // window) falsely HALTs it — observed live: larry hit 15 planned-restarts,
    // 0 real crashes, and was HALTED at the default limit of 10. Exempt the
    // planned exit from BOTH counters, mirroring the isDaemonShuttingDown gate
    // above. A genuine crash writes no such marker and still counts.
    if (this.isPlannedRestart()) {
      this.log('Planned context-handoff restart (fresh .restart-planned marker) — not counting as a crash.');
      return;
    }

    // Image-poison auto-recovery (companion to PR #446's photo-injection fix).
    // Checked FIRST so a poisoned-context crash neither trips the crash-loop
    // window nor charges the daily counter — it is an upstream artifact, not
    // an agent malfunction.
    //
    // Claude Code crashes with `API Error: 400 messages.N.content.M.image.source.base64.data:
    // Image format image/<fmt> not supported` when conversation history holds a
    // base64-encoded image whose claimed media_type does not match the actual
    // bytes. The poison is permanent: every `--continue` restart reloads the
    // same conversation history and re-hits the same 400, so the agent
    // crash-loops until it exhausts max_crashes_per_day and the daemon halts.
    //
    // This block covers agents that ALREADY have a poisoned context: detect
    // the 400 signature in the recent stdout, write `.force-fresh` so the next
    // start discards the saved conversation, and respawn WITHOUT charging the
    // crash counter. (The photo-suppression source fix from #446 was superseded
    // by the Track-2 byte-sniff mime reconciliation; this recovery block is the
    // independent resilience half and stands on its own.)
    //
    // Exit is always code 0 in this failure mode (Claude Code surfaces the
    // 400 to the user then exits cleanly), so we gate on both exit code and
    // the error signature to avoid false positives that would skip a real
    // crash counter increment.
    if (exitCode === 0 && this.detectImagePoisonCrash(recentOutput)) {
      const now = Date.now();
      // Filter recoveries to last 15 minutes
      this.imagePoisonRecoveries = this.imagePoisonRecoveries.filter(t => now - t < 15 * 60_000);
      this.imagePoisonRecoveries.push(now);

      // Circuit breaker: 3rd recovery within 15min → stop auto-recovery, alert
      if (this.imagePoisonRecoveries.length >= 3) {
        this.log(`Image-poison recovery circuit breaker tripped: ${this.imagePoisonRecoveries.length} recoveries in 15min. Force-fresh is failing to clear poisoned history. Auto-recovery paused. Manual intervention required.`);
        this.status = 'crashed';
        this.notifyStatusChange();

        // Send Telegram alert
        const telegramApi = this.telegramApi;
        const telegramChatId = this.telegramChatId;
        if (telegramApi && telegramChatId) {
          const alertMsg = `🚨 IMAGE-POISON RECOVERY CIRCUIT BREAKER: Agent ${this.name} has hit ${this.imagePoisonRecoveries.length} image-poison recoveries in 15min. Force-fresh is failing to clear poisoned history. Auto-recovery paused. Manual intervention required. Check logs/${this.name}/restarts.log for details.`;
          telegramApi
            .sendMessage(telegramChatId, alertMsg)
            .catch(() => { /* non-fatal: notification is observability only */ });
        }
        return;
      }

      this.log('Image-poison crash detected (API 400, unsupported image format). Arming .force-fresh and restarting without counting against max_crashes_per_day.');
      this.armForceFresh('image-poison auto-recovery');
      this.appendCrashToRestartsLog(exitCode, 5000, 'IMAGE_POISON_RECOVERY');
      this.status = 'crashed';
      this.notifyStatusChange();
      setTimeout(() => {
        if (this.status === 'crashed') {
          this.start().catch(err => this.log(`Image-poison restart failed: ${err}`));
        }
      }, 5000);
      return;
    }

    // Clean exit (code 0) is a process ending NORMALLY, not a crash. The
    // opencode runtime is a TUI that completes a turn and exits 0 by design
    // (see shouldContinue / the opencode session marker) — 100+ such exits/day
    // would otherwise exhaust max_crashes_per_day and falsely HALT it. Claude
    // can also exit 0 on a benign session end. Restart to CONTINUE without
    // charging the daily crash counter or the crash-loop window. Genuine
    // failures exit NON-zero (SIGSEGV=139, SIGHUP=129, error=1) and still count;
    // image-poison (an exit-0 crash-loop) is caught by its signature above and
    // is unaffected.
    //
    // Safety: a genuinely broken code-0 tight-loop (e.g. a runtime that fails
    // to start and instantly re-exits 0) is still caught here — >=8 clean-exit
    // restarts within 60s is not "normal turns", it is a spin, so we HALT.
    if (exitCode === 0) {
      const now = Date.now();

      // Startup-failure guard (completes #242): #242 correctly stopped charging
      // the crash counter for ALL code-0 exits, but it treats every code-0 exit
      // as a benign turn-completion. A code-0 exit that fires BEFORE the session
      // ever became ready is the opposite — a real startup fault (bad
      // config/model/env). opencode prints an error and exits 0, so it slips
      // past the crash gate, gets silently retried, and (before this) HALTed
      // with only a bare CRASH_LOOP line and no alert. Detect the
      // exit-before-ready case (short-lived spawn + agent never reached
      // 'running') and, on a cluster of them, trip a LOUD circuit breaker with a
      // Telegram alert, mirroring the image-poison breaker above. A code-0 exit
      // AFTER the agent was ready is a normal turn and skips this entirely.
      const spawnAgeMs = this.spawnStartedAtMs > 0 ? now - this.spawnStartedAtMs : Infinity;
      const exitedBeforeReady = this.status !== 'running' && spawnAgeMs < 8_000;
      if (exitedBeforeReady) {
        this.cleanExitStartupFailures = this.cleanExitStartupFailures.filter((ts) => now - ts < 60_000);
        this.cleanExitStartupFailures.push(now);
        if (this.cleanExitStartupFailures.length >= 3) {
          this.log(
            `CLEAN_EXIT_STARTUP_FAIL: ${this.cleanExitStartupFailures.length} code-0 exits BEFORE ready in 60s ` +
            `(runtime=${this.config.runtime ?? 'claude-code'}, model=${this.config.model ?? 'default'}) — ` +
            `this is a startup failure exiting 0, NOT a normal turn. Halting and alerting instead of silent retry. ` +
            `Check the agent's config/model/env and logs/${this.name}/stdout.log.`,
          );
          this.appendCrashToRestartsLog(exitCode, 0, 'CLEAN_EXIT_STARTUP_FAIL');
          this.status = 'halted';
          this.notifyStatusChange();
          const telegramApi = this.telegramApi;
          const telegramChatId = this.telegramChatId;
          if (telegramApi && telegramChatId) {
            const alertMsg = `🚨 STARTUP FAILURE: Agent ${this.name} exited cleanly (code 0) ${this.cleanExitStartupFailures.length}x within 60s BEFORE ever becoming ready (runtime=${this.config.runtime ?? 'claude-code'}, model=${this.config.model ?? 'default'}). This is a broken startup exiting 0, not a normal turn — auto-restart paused to avoid a silent crashloop. Check config/model/env and logs/${this.name}/stdout.log.`;
            telegramApi
              .sendMessage(telegramChatId, alertMsg)
              .catch(() => { /* non-fatal: notification is observability only */ });
          }
          return;
        }
      } else {
        // A code-0 exit AFTER the agent was ready is a genuine turn completion —
        // clear any accumulated startup-failure suspicion.
        this.cleanExitStartupFailures = [];
      }

      this.cleanExitRestarts = this.cleanExitRestarts.filter((ts) => now - ts < 60_000);
      this.cleanExitRestarts.push(now);
      if (this.cleanExitRestarts.length >= 8) {
        this.log(`CLEAN_EXIT_LOOP: ${this.cleanExitRestarts.length} code-0 exits in 60s — spinning, halting.`);
        this.appendCrashToRestartsLog(exitCode, 0, 'CRASH_LOOP');
        this.status = 'halted';
        this.notifyStatusChange();
        return;
      }
      const backoffMs = this.config.runtime === 'opencode' ? 2000 : 3000;
      this.log('Clean exit (code 0) — restarting to continue, not counting as a crash.');
      this.appendCrashToRestartsLog(exitCode, backoffMs, 'CLEAN_EXIT');
      this.status = 'crashed';
      this.notifyStatusChange();
      setTimeout(() => {
        if (this.status === 'crashed') {
          this.start().catch(err => this.log(`Clean-exit restart failed: ${err}`));
        }
      }, backoffMs);
      return;
    }

    // CrashLoopPauser (instar-inspired): if a sliding window is configured,
    // check whether the agent is crash-looping before falling through to
    // the legacy daily counter. The window is a more precise signal than
    // the per-day count: 3 crashes in 30 minutes is a crash loop even if
    // the daily budget of 10 is far from exhausted.
    if (this.crashWindowMs > 0) {
      const now = Date.now();
      this.crashTimestamps.push(now);
      // Prune timestamps outside the window.
      this.crashTimestamps = this.crashTimestamps.filter(
        (ts) => now - ts <= this.crashWindowMs,
      );
      if (this.crashTimestamps.length >= this.crashWindowMax) {
        this.log(
          `CRASH_LOOP: ${this.crashTimestamps.length} crashes in ${this.crashWindowMs / 1000}s window — auto-pausing`,
        );
        this.appendCrashToRestartsLog(exitCode, 0, 'CRASH_LOOP');
        this.status = 'halted';
        this.notifyStatusChange();
        return;
      }
    }

    // Legacy daily crash counter (fallback when no crash_window is configured,
    // or as a secondary gate when the window hasn't filled yet).
    this.crashCount++;
    const today = new Date().toISOString().split('T')[0];
    this.resetCrashCountIfNewDay(today);

    if (this.crashCount >= this.maxCrashesPerDay) {
      this.log(`HALTED: exceeded ${this.maxCrashesPerDay} crashes today`);
      this.appendCrashToRestartsLog(exitCode, 0, 'HALTED');
      this.status = 'halted';
      this.notifyStatusChange();
      return;
    }

    // Exponential backoff restart
    const backoff = Math.min(5000 * Math.pow(2, this.crashCount - 1), 300000);
    this.log(`Crash recovery: restart in ${backoff / 1000}s (crash #${this.crashCount})`);
    // Persist the crash to restarts.log so operators have a durable audit
    // trail. Previously only planned SELF-RESTART / HARD-RESTART from
    // bus/system.ts wrote here, which left daemon-classified crashes
    // invisible outside the rotating PM2 daemon stdout log.
    this.appendCrashToRestartsLog(exitCode, backoff, 'CRASH');
    this.status = 'crashed';
    this.notifyStatusChange();

    setTimeout(() => {
      if (this.status === 'crashed') {
        this.start().catch(err => this.log(`Restart failed: ${err}`));
      }
    }, backoff);
  }

  private shouldContinue(): boolean {
    // Hermes: session continuity is determined by whether the SQLite DB exists.
    // HERMES_HOME env var overrides the default ~/.hermes path.
    if (this.config.runtime === 'hermes') {
      const hermesHome = process.env['HERMES_HOME'];
      return hermesDbExists(hermesHome);
    }

    // Check for force-fresh marker (all runtimes honor it).
    const forceFreshPath = join(this.env.ctxRoot, 'state', this.name, '.force-fresh');
    if (existsSync(forceFreshPath)) {
      try {
        unlinkSync(forceFreshPath);
      } catch { /* ignore */ }
      return false;
    }

    // codex-app-server: session continuity is tracked by the adapter's own
    // codex-app-server-thread.json under ctxRoot/state/<agent>/. The Claude
    // JSONL check below is meaningless for the codex runtime, and a stale
    // Claude JSONL left over from a prior Claude-runtime tenure caused
    // continue-mode → thread/resume timeout → exit_code=0 crash loop
    // (testorg codex-agent crashed 3x with this signature on 2026-05-09,
    // 05-14, and 05-16 before backoff drained the pending resume RPC).
    if (this.config.runtime === 'codex-app-server') {
      const threadStatePath = join(
        this.env.ctxRoot,
        'state',
        this.name,
        'codex-app-server-thread.json',
      );
      return existsSync(threadStatePath);
    }

    // opencode: do not inspect Claude JSONL history. The OpencodePTY adapter
    // writes a lightweight marker after a successful spawn; that marker is the
    // only signal that the next boot should pass `opencode --continue`.
    if (this.config.runtime === 'opencode') {
      return opencodeSessionExists(this.env.ctxRoot, this.name);
    }

    // Default (Claude runtime): existing conversation = JSONL files present.
    const launchDir = this.config.working_directory || this.env.agentDir;
    if (!launchDir) return false;

    // Claude projects dir uses the absolute path with all separators replaced by dashes
    // e.g. /Users/foo/agents/boss -> -Users-foo-agents-boss (leading sep becomes -)
    // Use homedir() for cross-platform compatibility (HOME is not set on Windows).
    const convDir = join(
      homedir(),
      '.claude',
      'projects',
      launchDir.split(sep).join('-'),
    );

    try {
      const files = require('fs').readdirSync(convDir);
      return files.some((f: string) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
  }

  private buildStartupPrompt(): string {
    const onboardedPath = join(this.env.ctxRoot, 'state', this.name, '.onboarded');
    const onboardingPath = join(this.env.agentDir, 'ONBOARDING.md');
    let onboardingAppend = '';

    if (!existsSync(onboardedPath) && existsSync(onboardingPath)) {
      onboardingAppend = ' IMPORTANT: This is your FIRST BOOT. Before doing anything else, read ONBOARDING.md and complete the onboarding protocol.';
    }

    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    const handoffBlock = this.consumeHandoffBlock();
    const { missionBlock, liveTailBlock } = this.buildResumeContextBlocks();
    const isHandoffRestart = handoffBlock.length > 0;
    this.lastSpawnWasHandoff = isHandoffRestart;
    // HANDOFF UX: the pickup message MUST be the first action after reading the handoff doc —
    // before cron restoration, before heartbeat, before anything else. Placing this instruction
    // immediately after the handoffBlock in the prompt ensures it is not buried.
    const shouldPromptTelegram = this.shouldPromptTelegramOnlineMessage();
    const systemPingsEnabled = this.systemPingsEnabled();
    if (!systemPingsEnabled && shouldPromptTelegram) {
      this.logSystemPingSuppressed(isHandoffRestart ? 'handoff_back_ping' : 'online_message');
    }
    const handoffUxOverride = isHandoffRestart && systemPingsEnabled && shouldPromptTelegram
      ? ' HANDOFF UX: This is a context handoff restart — your memory is intact via the handoff document, but the VERBATIM LIVE TAIL below is more authoritative than the doc. If the handoff document conflicts with the newest inbound message, the newest inbound message wins. CRITICAL: After reading the handoff document and the live tail, your VERY FIRST tool call MUST be a Bash call running: cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID \'back — [what you were just working on]\' — replace the brackets with one brief plain-English sentence about your current state derived from the handoff doc plus the newest inbound message, with the newest inbound message winning. Do this BEFORE running heartbeat, BEFORE any other tool call. No cron IDs, no status report, no cold-boot phrasing. Do NOT send "Booting up... one moment" (skip AGENTS.md step 1 entirely).'
      : '';
    const onlineMessage = isHandoffRestart || !systemPingsEnabled || !shouldPromptTelegram
      ? ''
      : ' Send a Telegram message to the user saying you are back online.';
    return `You are starting a new session. Current UTC time: ${nowUtc}. Read AGENTS.md and all bootstrap files listed there. External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for cron restoration.${reminderBlock}${deliverablesBlock}${missionBlock}${handoffBlock}${liveTailBlock}${handoffUxOverride}${onlineMessage}${onboardingAppend}`;
  }

  private buildContinuePrompt(): string {
    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const deliverablesBlock = this.buildDeliverablesBlock();
    const { missionBlock, liveTailBlock } = this.buildResumeContextBlocks();
    // F3: deterministic re-read signal. Fix 2 tells --continue restarts NOT to
    // re-read bootstrap — but if a bootstrap file was edited just before this
    // restart, the agent DOES need to re-read that one. Stat the key files and
    // name only the ones modified in the last 15min, so staleness is a daemon
    // check, not a model judgment call.
    const staleReadBlock = this.buildChangedBootstrapNote();
    // Session refresh (--continue) is never a handoff restart.
    this.lastSpawnWasHandoff = false;
    const shouldPromptTelegram = this.shouldPromptTelegramOnlineMessage();
    const systemPingsEnabled = this.systemPingsEnabled();
    if (!systemPingsEnabled && shouldPromptTelegram) {
      this.logSystemPingSuppressed('continue_online_message');
    }
    const onlineMessage = systemPingsEnabled && shouldPromptTelegram
      ? ' After checking inbox, send a Telegram message to the user saying you are back online.'
      : '';
    return `SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${nowUtc}. Your full conversation history is preserved — AGENTS.md, bootstrap files, your skill list and tool registry are ALREADY in context. Do NOT re-read AGENTS.md or bootstrap files, and do NOT re-run list-skills or list-agents, unless you have specific reason to believe they changed since the last restart (re-reading them every restart is a top cause of context bloat). External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for cron restoration.${staleReadBlock}${reminderBlock}${deliverablesBlock}${missionBlock}${liveTailBlock} Check inbox. Resume normal operations.${onlineMessage}`;
  }

  /**
   * F3: return a note naming bootstrap files modified in the last 15 minutes, so
   * a --continue restart that follows a config edit re-reads ONLY the changed
   * files (deterministic, not a model guess). Empty string when nothing changed.
   */
  private buildChangedBootstrapNote(): string {
    try {
      const dir = this.env.agentDir;
      const candidates = ['AGENTS.md', 'CLAUDE.md', 'OPERATIONS.md'];
      const cutoff = Date.now() - 15 * 60_000;
      const changed: string[] = [];
      for (const f of candidates) {
        const p = join(dir, f);
        try {
          if (existsSync(p) && statSync(p).mtimeMs > cutoff) changed.push(f);
        } catch { /* unreadable — skip */ }
      }
      if (!changed.length) return '';
      return ` NOTE: ${changed.join(', ')} changed since your last restart — re-read ONLY ${changed.length === 1 ? 'that file' : 'those files'} now (they are the exception to the do-not-re-read rule above).`;
    } catch {
      return '';
    }
  }

  private buildResumeContextBlocks(): { missionBlock: string; liveTailBlock: string } {
    let missionBlock = '';
    let liveTailBlock = '';

    try {
      const missionPath = join(this.env.agentDir, 'state', 'current-mission.txt');
      if (existsSync(missionPath)) {
        const missionRaw = readFileSync(missionPath, 'utf-8').trim();
        if (missionRaw) {
          const missionText = this.normalizePromptText(missionRaw, 600);
          const missionMtimeMs = statSync(missionPath).mtimeMs;
          const writtenAt = new Date(missionMtimeMs).toISOString();
          const age = this.formatAge(missionMtimeMs);
          missionBlock = ` MISSION ANCHOR (written ${writtenAt}; age ${age}): ${missionText}. Verify against the live tail below before acting; if older than 2h treat it as possibly stale.`;
        }
      }
    } catch {
      missionBlock = '';
    }

    try {
      const { digest, verbatim } = loadBuffer(this.env.ctxRoot, this.name);
      if (digest.length > 0 || verbatim.length > 0) {
        const liveTailSections: string[] = [];
        if (digest.length > 0) {
          liveTailSections.push(` EARLIER TURNS (compressed):\n${digest.join('\n')}`);
        }
        const liveTailLines = verbatim
          .map((entry) => `${entry.ts} ${entry.sender}: ${this.normalizePromptText(entry.content, 200)}`)
          .join('\n');
        liveTailSections.push(
          ` VERBATIM LIVE TAIL (your most recent messages — the NEWEST inbound message is AUTHORITATIVE; if the handoff doc conflicts with it, the newest message wins):\n${liveTailLines}`,
        );
        liveTailBlock = liveTailSections.join('\n');
      }
    } catch {
      liveTailBlock = '';
    }

    return { missionBlock, liveTailBlock };
  }

  private normalizePromptText(text: string, maxChars: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  private formatAge(mtimeMs: number): string {
    const ageMs = Math.max(0, Date.now() - mtimeMs);
    const ageMinutes = Math.floor(ageMs / 60_000);
    if (ageMinutes < 60) {
      return `${ageMinutes}m ago`;
    }

    const ageHours = Math.floor(ageMinutes / 60);
    if (ageHours < 48) {
      return `${ageHours}h ago`;
    }

    const ageDays = Math.floor(ageHours / 24);
    return `${ageDays}d ago`;
  }

  private shouldPromptTelegramOnlineMessage(): boolean {
    return this.config.telegram_polling !== false && !!this.telegramApi && !!this.telegramChatId;
  }

  /**
   * Per-agent opt-IN gate for system-status Telegram pings (restart back/online
   * ping; the compaction notice checks the same flag in hook-compact-telegram).
   * Default absent/false = silent. A gated-off agent emits no restart ping.
   */
  private systemPingsEnabled(): boolean {
    return this.config.emit_system_telegram_pings === true;
  }

  /**
   * Best-effort bus-event record of a ping suppressed by the per-agent gate,
   * so the restart signal is preserved off-Telegram. Never throws.
   */
  private logSystemPingSuppressed(kind: string): void {
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
      logEvent(paths, this.name, this.env.org, 'agent_activity', 'system_ping_suppressed', 'info', { kind });
    } catch {
      /* best-effort — suppression logging must never affect the spawn */
    }
  }

  /**
   * Build a reminder block for the boot prompt.
   * If any pending reminders are overdue, include them so the agent handles them
   * even after a hard-restart that cleared in-memory cron state (#69).
   */
  private buildReminderBlock(): string {
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
      const overdue = getOverdueReminders(paths);
      if (overdue.length === 0) return '';
      const items = overdue.map(r =>
        `  - [${r.id}] (due ${r.fire_at}): ${r.prompt}`,
      ).join('\n');
      return ` You also have ${overdue.length} overdue persistent reminder(s) from before this restart — handle each one, then run: cortextos bus ack-reminder <id>\n${items}`;
    } catch {
      return '';
    }
  }

  /**
   * Build a deliverable-standard instruction block for the boot prompt.
   * When require_deliverables is enabled in the org's context.json, agents
   * are told that every task submitted for review must have at least one
   * file attached via save-output. The instruction is injected dynamically
   * so existing agents pick up the rule on their next boot with zero file
   * changes, and toggling it off removes it from the next startup prompt.
   */
  private buildDeliverablesBlock(): string {
    try {
      const contextPath = join(this.env.frameworkRoot, 'orgs', this.env.org, 'context.json');
      if (!existsSync(contextPath)) return '';
      const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (!ctx.require_deliverables) return '';
      return ' DELIVERABLE STANDARD: Every task you submit for review MUST have at least one file deliverable attached via the save-output bus command. A task with zero file deliverables will be sent back. Attach files with: cortextos bus save-output <task-id> <file-path> --label "<descriptive label>". Labels must be human-readable at a glance: describe WHAT it is plus enough context to understand at a glance. Good: "Traffic Growth Plan — 10 channels, 30-day launch sequence". Bad: "traffic-growth-plan.md" or "output-1". Notes are for context only, never file paths or URLs.';
    } catch {
      return '';
    }
  }

  /**
   * Consume the .handoff-doc-path marker (written by the context watchdog or the
   * agent itself via `cortextos bus hard-restart --handoff-doc <path>`).
   * Returns a boot-prompt fragment pointing the new session at the handoff doc,
   * or an empty string if no marker exists.
   * The marker is unlinked after reading so it fires only once per restart.
   */
  private consumeHandoffBlock(): string {
    const markerPath = join(this.env.ctxRoot, 'state', this.name, '.handoff-doc-path');
    if (!existsSync(markerPath)) return '';
    try {
      const docPath = readFileSync(markerPath, 'utf-8').trim();
      unlinkSync(markerPath);
      if (!docPath || !existsSync(docPath)) return '';
      return ` CONTEXT HANDOFF: Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
    } catch {
      return '';
    }
  }

  /**
   * Issue #392 / OpenCode parity: send lifecycle Telegram directly from the
   * daemon for runtimes whose startup/continue prompts are not reliable enough
   * to guarantee a user-visible notification.
   *
   * codex-app-server: the boot prompt's inline "Send a Telegram message..."
   * instruction reaches the codex thread but is not executed reliably as a tool
   * call, leaving James without the standard post-restart notification
   * claude-code peers send.
   *
   * opencode: the prompt is injected into the persistent TUI after startup.
   * Real production evidence showed an OpenCode --continue restart updated the
   * process/session markers but emitted no Telegram message, so lifecycle
   * visibility must be daemon-owned just like Codex.
   *
   * Two distinct notifications, mirroring what a claude-code agent emits:
   *  - msg1 (planned-restart lifecycle, "🔄 <agent> restarted (planned): ..."):
   *    for claude this is sent by hook-crash-alert.ts on PTY exit. codex/opencode
   *    runtimes do NOT run Claude Code hooks, so on a handoff restart the daemon
   *    emits the same notification here for parity (James saw msg1 only for
   *    claude agents otherwise). Format mirrors hook-crash-alert.ts:394-397.
   *  - msg2 (back-online / "back — ..." summary): codex reliably self-sends its
   *    own contextual reply via the boot prompt; opencode (deepseek) does NOT, so
   *    the daemon sends a handoff-flavored back-online ping for opencode only.
   *
   * Skipped when:
   *  - runtime is anything other than codex-app-server/opencode (claude-code
   *    and hermes already emit both via the hook + prompt),
   *  - Telegram is disabled or no Telegram handle has been wired.
   */
  private maybeSendRuntimeLifecycleNotification(): void {
    if (this.config.runtime !== 'codex-app-server' && this.config.runtime !== 'opencode') return;
    if (!this.shouldPromptTelegramOnlineMessage()) return;
    if (!this.systemPingsEnabled()) {
      this.logSystemPingSuppressed(this.lastSpawnWasHandoff ? 'handoff_back_ping' : 'online_message');
      return;
    }
    const telegramApi = this.telegramApi;
    const telegramChatId = this.telegramChatId;
    if (!telegramApi || !telegramChatId) return;
    const send = (text: string) =>
      telegramApi
        .sendMessage(telegramChatId, text)
        .catch(() => { /* non-fatal: notification is observability only */ });

    if (this.lastSpawnWasHandoff) {
      // msg1: planned-restart lifecycle notif, hook parity for runtimes without
      // Claude Code hooks. Both codex and opencode were missing this.
      send(this.buildPlannedRestartNotification());
      // msg2 ("back — ...") is self-sent by the agent via the handoff boot prompt
      // (agent-process.ts buildStartupPrompt handoffUxOverride) for BOTH codex and
      // opencode — opencode now reliably honors it. The daemon used to send an
      // "Agent X is back online (context handoff)" substitute for opencode, but
      // that produced a redundant 3rd message on top of the self-sent "back —".
      // Removed: msg1 (daemon) + msg2 (agent self-send) = clean 2-message pattern.
      return;
    }

    // Non-handoff restart (crash recovery / config reload): both runtimes need
    // the daemon-emitted back-online ping.
    send(`Agent ${this.name} is back online`);
  }

  /**
   * Build the planned-restart lifecycle notification (msg1) for codex/opencode,
   * reading the reason from the `.restart-planned` marker and matching the
   * hook-crash-alert.ts:394-397 format string exactly so codex/opencode parity
   * is byte-identical to what claude agents emit via the hook.
   */
  private buildPlannedRestartNotification(): string {
    let reason = '';
    try {
      const markerPath = join(this.env.ctxRoot, 'state', this.name, '.restart-planned');
      if (existsSync(markerPath)) {
        reason = readFileSync(markerPath, 'utf-8').trim();
      }
    } catch { /* non-fatal — fall through to generic reason */ }
    return reason.startsWith('CONTEXT-FORCE-RESTART')
      ? `🔄 ${this.name} restarting with memory`
      : `🔄 ${this.name} restarted (planned): ${reason || 'no reason given'}`;
  }

  private startSessionTimer(): void {
    const DEFAULT_MAX_SESSION_S = 255600;
    // Node setTimeout uses int32 ms internally. Values > 2^31-1 (~24.8d) silently
    // coerce to 1ms, which combined with the BUG-048 reschedule loop below causes
    // an infinite tight loop. Clamp at the call site so any future misconfigured
    // max_session_seconds (e.g. a stray 3600000s = 1000h) cannot wedge the daemon.
    const MAX_SETTIMEOUT_MS = 2_147_483_647;
    const startedAt = Date.now();
    const initialMs = (this.config.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;

    // BUG-048 fix: re-read max_session_seconds from config.json on each timer
    // fire so that config changes after start() take effect. Without this, a
    // briefly-low max_session_seconds baked at start time causes a fleet-wide
    // simultaneous restart when all agents hit the same stale deadline.
    const scheduleCheck = (delayMs: number): void => {
      this.sessionTimer = setTimeout(() => {
        // Re-read current config from disk
        let currentMaxMs = initialMs;
        try {
          const configPath = join(this.env.agentDir, 'config.json');
          if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
            currentMaxMs = (cfg.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;
          }
        } catch { /* use initial value on read error */ }

        const elapsedMs = Date.now() - startedAt;
        const remainingMs = currentMaxMs - elapsedMs;

        if (remainingMs > 5000) {
          // Config was updated to a longer duration — reschedule for the remaining time.
          this.log(`Session timer: config updated to ${currentMaxMs / 1000}s, rescheduling (${Math.round(remainingMs / 1000)}s remaining)`);
          scheduleCheck(remainingMs);
          return;
        }

        this.log(`Session timer fired after ${Math.round(elapsedMs / 1000)}s (limit: ${currentMaxMs / 1000}s)`);
        this.sessionRefresh().catch(err => this.log(`Session refresh failed: ${err}`));
      }, Math.min(delayMs, MAX_SETTIMEOUT_MS));
    };

    scheduleCheck(initialMs);
  }

  private clearSessionTimer(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  /**
   * Check whether the daemon is currently in its shutdown sequence.
   *
   * Returns true iff a `.daemon-stop` marker exists in this agent's state
   * dir AND was written within the last 60 seconds. The marker is written
   * by AgentManager.stopAll() before it begins iterating stopAgent() calls.
   * A stale marker older than 60s is treated as leftover from a prior
   * shutdown and ignored — real crashes must not be masked indefinitely.
   */
  private isDaemonShuttingDown(): boolean {
    const marker = join(this.env.ctxRoot, 'state', this.name, '.daemon-stop');
    try {
      if (!existsSync(marker)) return false;
      const ageMs = Date.now() - statSync(marker).mtimeMs;
      return ageMs < 60_000;
    } catch {
      return false;
    }
  }

  /**
   * True when a fresh `.restart-planned` marker exists — i.e. this exit is a
   * planned context-handoff / hard-restart (written by src/bus/system.ts on
   * `hardRestart`, or by fast-checker's context-force-restart), NOT a crash.
   * Mirrors isDaemonShuttingDown's marker-freshness pattern (60s window) so a
   * stale marker from an earlier handoff can't mask a genuine crash later.
   */
  private isPlannedRestart(): boolean {
    const marker = join(this.env.ctxRoot, 'state', this.name, '.restart-planned');
    try {
      if (!existsSync(marker)) return false;
      const ageMs = Date.now() - statSync(marker).mtimeMs;
      return ageMs < 60_000;
    } catch {
      return false;
    }
  }

  /**
   * Append an unplanned-exit entry to restarts.log. Complements the planned
   * SELF-RESTART / HARD-RESTART entries written by src/bus/system.ts so that
   * a single file gives the complete restart history for an agent.
   *
   * Format matches bus/system.ts: `[ISO] <KIND>: <details>`. appendFileSync
   * uses write(2) with O_APPEND on Linux, which is atomic for writes under
   * PIPE_BUF (~4KB) — each CRASH line fits comfortably. All errors are
   * swallowed: logging must never break crash recovery.
   */
  private appendCrashToRestartsLog(
    exitCode: number,
    backoffMs: number,
    kind: 'CRASH' | 'HALTED' | 'CRASH_LOOP' | 'IMAGE_POISON_RECOVERY' | 'CLEAN_EXIT' | 'CLEAN_EXIT_STARTUP_FAIL',
  ): void {
    try {
      const logDir = join(this.env.ctxRoot, 'logs', this.name);
      ensureDir(logDir);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const details =
        kind === 'HALTED'
          ? `exit_code=${exitCode} crash_count=${this.crashCount} max_crashes=${this.maxCrashesPerDay}`
          : kind === 'CLEAN_EXIT_STARTUP_FAIL'
            ? `exit_code=${exitCode} startup_failures=${this.cleanExitStartupFailures.length} (exited before ready — auto-restart paused, alerted)`
            : kind === 'IMAGE_POISON_RECOVERY' || kind === 'CLEAN_EXIT'
              ? `exit_code=${exitCode} backoff_s=${backoffMs / 1000} (not counted toward max_crashes)`
              : `exit_code=${exitCode} crash_count=${this.crashCount} backoff_s=${backoffMs / 1000}`;
      const logLine = `[${timestamp}] ${kind}: ${details}\n`;
      appendFileSync(join(logDir, 'restarts.log'), logLine, 'utf-8');
    } catch {
      /* swallow — never break crash recovery on a logging failure */
    }
  }

  private resetCrashCountIfNewDay(today: string): void {
    const crashFile = join(this.env.ctxRoot, 'logs', this.name, '.crash_count_today');
    try {
      if (existsSync(crashFile)) {
        const content = readFileSync(crashFile, 'utf-8').trim();
        const [storedDate, count] = content.split(':');
        if (storedDate === today) {
          this.crashCount = parseInt(count, 10) + 1;
        } else {
          this.crashCount = 1;
        }
      }
      ensureDir(join(this.env.ctxRoot, 'logs', this.name));
      writeFileSync(crashFile, `${today}:${this.crashCount}`, 'utf-8');
    } catch { /* ignore */ }
  }

  private notifyStatusChange(): void {
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
