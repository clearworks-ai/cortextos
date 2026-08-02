import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import type { CtxEnv, WorkerStatus, WorkerStatusValue } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { injectMessage } from '../pty/inject.js';

/**
 * WorkerProcess — ephemeral Claude Code session for parallelized tasks.
 *
 * Differences from AgentProcess:
 * - No crash recovery (exit = done, success or failure)
 * - Hard max-lifetime cap (MAX_WORKER_LIFETIME_MS): hung workers are reaped
 *   with a distinct 'reaped' status. Interim guard until the PTY wedge
 *   root causes (RW-4/RW-5) hold, then the cap can be retired.
 * - No Telegram integration
 * - No fast-checker or inbox polling
 * - Working directory is the project dir, not the agent dir
 * - Status is exposed for IPC list-workers queries
 */
export class WorkerProcess {
  private static readonly MAX_WORKER_LIFETIME_MS = 10 * 60_000;
  /** How long terminate() waits for a graceful exit after Ctrl-C before escalating to kill(). */
  private static readonly GRACEFUL_EXIT_TIMEOUT_MS = 2_000;
  /** Poll interval while waiting for a graceful exit. */
  private static readonly GRACEFUL_POLL_MS = 50;

  readonly name: string;
  readonly dir: string;
  readonly parent: string | undefined;

  private pty: AgentPTY | null = null;
  private status: WorkerStatusValue = 'starting';
  private spawnedAt: string;
  private exitCode: number | undefined;
  private onDoneCallback: ((name: string, exitCode: number) => void) | null = null;
  private doneFired = false;
  private log: (msg: string) => void;
  private maxLifetimeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    name: string,
    dir: string,
    parent: string | undefined,
    log?: (msg: string) => void,
  ) {
    this.name = name;
    this.dir = dir;
    this.parent = parent;
    this.spawnedAt = new Date().toISOString();
    this.log = log || ((msg) => console.log(`[worker:${name}] ${msg}`));
  }

  /**
   * Spawn the worker Claude Code session with the given task prompt.
   */
  async spawn(env: CtxEnv, prompt: string, config: { model?: string } = {}): Promise<void> {
    // Ensure bus dirs exist so the worker can use cortextos bus commands
    try {
      mkdirSync(join(env.ctxRoot, 'inbox', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'state', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'logs', this.name), { recursive: true });
      // Write a marker so the crash-alert hook can identify this as a worker
      // session and suppress Telegram/bus alerts on normal exit. Workers are
      // designed to have no Telegram integration (see class doc above).
      writeFileSync(join(env.ctxRoot, 'state', this.name, '.is-worker'), this.name);
    } catch { /* ignore */ }

    const logPath = join(env.ctxRoot, 'logs', this.name, 'stdout.log');
    this.pty = new AgentPTY(env, config, logPath);

    this.pty.onExit((code) => {
      this.clearMaxLifetimeTimer();
      this.exitCode = code;
      this.status = code === 0 ? 'completed' : 'failed';
      this.log(`Exited with code ${code} → ${this.status}`);
      this.pty = null;
      this.fireDone(code);
    });

    await this.pty.spawn('fresh', prompt);
    this.status = 'running';
    this.log(`Running (pid: ${this.pty.getPid()}, dir: ${this.dir})`);
    this.maxLifetimeTimer = setTimeout(() => {
      if (!this.isFinished()) {
        this.log(`Max lifetime (${WorkerProcess.MAX_WORKER_LIFETIME_MS}ms) exceeded — reaping`);
        void this.terminate('reap');
      }
    }, WorkerProcess.MAX_WORKER_LIFETIME_MS);
    this.maxLifetimeTimer.unref?.();
  }

  /**
   * Terminate the worker session.
   *
   * Graceful-then-escalate: send Ctrl-C, wait up to GRACEFUL_EXIT_TIMEOUT_MS
   * for the session to exit on its own (onExit fires normally), and only
   * escalate to AgentPTY.kill() if it doesn't. This avoids the
   * dispose-listeners-then-SIGKILL path whenever the session cooperates.
   *
   * When escalation strips the exit listener (AgentPTY.kill() calls
   * disposeListeners() before killing), onExit never fires — so terminate()
   * itself finalizes status and fires the onDone callback. Without this, a
   * self-reap left the worker permanently registered in AgentManager's
   * workers Map and spawnWorker threw "already running" forever for that
   * name (RW-10).
   *
   * @param reason 'terminate' = explicit stop (status 'completed', upstream
   *               semantics); 'reap' = max-lifetime self-reap (distinct
   *               status 'reaped' so a shot worker never reports as
   *               completed).
   */
  async terminate(reason: 'terminate' | 'reap' = 'terminate'): Promise<void> {
    this.clearMaxLifetimeTimer();
    const pty = this.pty;
    if (!pty) return;
    this.log(reason === 'reap' ? 'Reaping...' : 'Terminating...');
    try {
      pty.write('\x03'); // Ctrl-C — give the session a chance to exit cleanly
      let waited = 0;
      while (!this.isFinished() && waited < WorkerProcess.GRACEFUL_EXIT_TIMEOUT_MS) {
        await sleep(WorkerProcess.GRACEFUL_POLL_MS);
        waited += WorkerProcess.GRACEFUL_POLL_MS;
      }
      if (!this.isFinished()) {
        pty.kill(); // escalate — strips exit listeners, so finalize below
      }
    } catch { /* ignore */ }
    if (!this.isFinished()) {
      this.status = reason === 'reap' ? 'reaped' : 'completed';
      this.pty = null;
      this.fireDone(this.exitCode ?? (reason === 'reap' ? 1 : 0));
    }
  }

  /**
   * Inject text into the worker's PTY (equivalent to tmux send-keys).
   * Use to nudge a stuck worker without restarting it.
   */
  inject(text: string): boolean {
    if (!this.pty || this.status !== 'running') return false;
    injectMessage((data) => this.pty?.write(data), text);
    return true;
  }

  /**
   * Get current worker status snapshot.
   */
  getStatus(): WorkerStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() ?? undefined,
      dir: this.dir,
      parent: this.parent,
      spawnedAt: this.spawnedAt,
      exitCode: this.exitCode,
    };
  }

  isFinished(): boolean {
    return this.status === 'completed' || this.status === 'failed' || this.status === 'reaped';
  }

  /**
   * Register a callback that fires when the worker exits.
   */
  onDone(cb: (name: string, exitCode: number) => void): void {
    this.onDoneCallback = cb;
  }

  private clearMaxLifetimeTimer(): void {
    if (this.maxLifetimeTimer) {
      clearTimeout(this.maxLifetimeTimer);
      this.maxLifetimeTimer = null;
    }
  }

  /** Fire the onDone callback exactly once, regardless of which path finished the worker. */
  private fireDone(exitCode: number): void {
    if (this.doneFired) return;
    this.doneFired = true;
    if (this.onDoneCallback) {
      this.onDoneCallback(this.name, exitCode);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
