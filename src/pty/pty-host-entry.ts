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

function handleMessage(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const msg = raw as PtyClientMsg;

  switch (msg.type) {
    case 'pty-spawn': {
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
