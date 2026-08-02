/**
 * pty-host-entry — short-lived child process that holds one node-pty allocation.
 *
 * The daemon forks this file once per PTY session via child_process.fork.
 * On pty exit it sends PtyExitMsg to the parent then calls process.exit(0)
 * so the kernel reclaims all /dev/ptmx fds held by this process.
 *
 * Only one pty-spawn message is ever processed; subsequent messages after
 * the spawn are pty-write / pty-resize / pty-kill.
 */

import type { PtyClientMsg, PtyHostMsg } from './pty-ipc.js';

// node-pty types — require'd at runtime so tsup can mark it external
interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
  destroy?(): void;
}

interface IPtyModule {
  spawn(file: string, args: string[], options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  }): IPty;
}

function send(msg: PtyHostMsg): void {
  if (process.send) {
    process.send(msg);
  }
}

let pty: IPty | null = null;
let exited = false;
let disposing = false;

/**
 * RW-4 fix: after a graceful dispose signals the pty child, arm a fallback
 * timer so this host process ALWAYS exits even if the pty's onExit never
 * fires (child ignoring the signal, node-pty edge cases). The fallback
 * SIGKILLs the pty child before exiting so the grandchild can never be
 * orphaned by the host going away first.
 *
 * 4000ms — intentionally SHORTER than the daemon-side DISPOSE_GRACE_MS
 * (5000ms in pty-host-client.ts) so the host self-exits cleanly before the
 * daemon escalates to SIGKILL of the host.
 */
const DISPOSE_SELF_EXIT_MS = 4000;

function armDisposeFallback(): void {
  const t = setTimeout(() => {
    if (pty && !exited) {
      try { pty.kill('SIGKILL'); } catch { /* already gone */ }
      try { pty.destroy?.(); } catch { /* fd already closed */ }
    }
    process.exit(0);
  }, DISPOSE_SELF_EXIT_MS);
  t.unref();
}

/**
 * RW-5: if the parent never delivers pty-spawn (daemon wedged or died
 * mid-spawn, IPC message lost), exit instead of lingering forever as an idle
 * orphan process. Overridable for tests via CTX_PTY_SPAWN_WAIT_MS.
 */
const SPAWN_WAIT_MS = (() => {
  const raw = process.env.CTX_PTY_SPAWN_WAIT_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

const spawnDeadline = setTimeout(() => {
  if (!pty) {
    send({ type: 'pty-error', message: `no pty-spawn received within ${SPAWN_WAIT_MS}ms` });
    // Give the IPC message time to flush before exiting
    setTimeout(() => process.exit(1), 50);
  }
}, SPAWN_WAIT_MS);
spawnDeadline.unref();

function handleMessage(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const msg = raw as PtyClientMsg;

  switch (msg.type) {
    case 'pty-spawn': {
      clearTimeout(spawnDeadline);
      if (pty) {
        send({ type: 'pty-error', message: 'pty already spawned' });
        return;
      }
      try {
        const nodePty = require('node-pty') as IPtyModule;
        pty = nodePty.spawn(msg.file, msg.args, msg.options);

        send({ type: 'pty-ready', pid: pty.pid });

        pty.onData((data) => {
          send({ type: 'pty-data', data });
        });

        pty.onExit(({ exitCode, signal }) => {
          if (exited) return;
          exited = true;
          try { pty?.destroy?.(); } catch { /* fd already closed */ }
          pty = null;
          send({ type: 'pty-exit', exitCode, signal });
          // Give the IPC message time to flush before exiting
          setTimeout(() => process.exit(0), 50);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'pty-error', message });
        setTimeout(() => process.exit(1), 50);
      }
      break;
    }

    case 'pty-write': {
      try { pty?.write(msg.data); } catch { /* ignore writes after exit */ }
      break;
    }

    case 'pty-resize': {
      try { pty?.resize(msg.cols, msg.rows); } catch { /* ignore resizes after exit */ }
      break;
    }

    case 'pty-kill': {
      if (pty && !exited) {
        try { pty.kill(msg.signal); } catch { /* ignore */ }
        try { pty.destroy?.(); } catch { /* ignore */ }
      }
      break;
    }

    case 'pty-dispose': {
      // RW-4 fix: graceful teardown. Signal the pty child, then rely on the
      // normal onExit path (pty-exit + process.exit) — with a self-exit
      // fallback so this host can never linger, and never exits leaving the
      // grandchild alive un-SIGKILLed.
      if (disposing) break;
      disposing = true;
      if (pty && !exited) {
        try { pty.kill(msg.signal); } catch { /* ignore */ }
        armDisposeFallback();
      } else if (!exited) {
        // Never spawned (or already torn down) — nothing to signal, just exit.
        exited = true;
        setTimeout(() => process.exit(0), 20).unref();
      }
      // If exited is already true, pty-exit was sent and process.exit(0) is
      // already scheduled — nothing to do.
      break;
    }

    default:
      // Unknown message type — ignore silently
      break;
  }
}

process.on('message', handleMessage);

// If the parent dies, exit cleanly so the fd is reclaimed
process.on('disconnect', () => {
  if (pty && !exited) {
    try { pty.kill(); } catch { /* ignore */ }
    try { pty.destroy?.(); } catch { /* ignore */ }
  }
  process.exit(0);
});

// RW-4 fix: SIGTERM must take the pty child down WITH the host. Without this
// handler a daemon-side (or external) SIGTERM killed only the host and the
// node-pty grandchild reparented to launchd — the confirmed multi-day orphans.
process.on('SIGTERM', () => {
  if (pty && !exited) {
    try { pty.kill(); } catch { /* ignore */ }
    try { pty.destroy?.(); } catch { /* fd already closed */ }
  }
  process.exit(0);
});
