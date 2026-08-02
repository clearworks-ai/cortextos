/**
 * IPC message protocol between pty-host-client.ts (daemon side) and
 * pty-host-entry.ts (forked child side).
 *
 * All messages flow over child_process.fork's built-in IPC channel.
 *
 * Direction: client → child
 *   PtySpawnMsg   — allocate a pty and start the given command
 *   PtyWriteMsg   — write a string to the pty master
 *   PtyResizeMsg  — resize the pty window
 *   PtyKillMsg    — send a signal / kill the pty
 *   PtyDisposeMsg — graceful teardown request: signal the pty child, then the
 *                   host self-exits (with a hard fallback timer). The daemon
 *                   only escalates to SIGKILL of the host if it does not exit
 *                   within the dispose grace window. This closes the RW-4
 *                   race where an immediate SIGKILL of the host landed before
 *                   the async pty-kill IPC was dequeued, orphaning the
 *                   grandchild (claude) process.
 *
 * Direction: child → client
 *   PtyReadyMsg   — pty has been allocated; carries its pid
 *   PtyDataMsg    — a chunk of output from the pty
 *   PtyExitMsg    — pty process exited; child will exit shortly after
 *   PtyErrorMsg   — fatal error during spawn
 */

export interface PtySpawnMsg {
  type: 'pty-spawn';
  file: string;
  args: string[];
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  };
}

export interface PtyWriteMsg {
  type: 'pty-write';
  data: string;
}

export interface PtyResizeMsg {
  type: 'pty-resize';
  cols: number;
  rows: number;
}

export interface PtyKillMsg {
  type: 'pty-kill';
  signal?: string;
}

export interface PtyDisposeMsg {
  type: 'pty-dispose';
  signal?: string;
}

/** Messages the daemon sends TO the child */
export type PtyClientMsg = PtySpawnMsg | PtyWriteMsg | PtyResizeMsg | PtyKillMsg | PtyDisposeMsg;

export interface PtyReadyMsg {
  type: 'pty-ready';
  pid: number;
}

export interface PtyDataMsg {
  type: 'pty-data';
  data: string;
}

export interface PtyExitMsg {
  type: 'pty-exit';
  exitCode: number;
  signal?: number;
}

export interface PtyErrorMsg {
  type: 'pty-error';
  message: string;
}

/** Messages the child sends TO the daemon */
export type PtyHostMsg = PtyReadyMsg | PtyDataMsg | PtyExitMsg | PtyErrorMsg;
