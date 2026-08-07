/**
 * RW-4 regression gate — real pty-host-entry grandchild reaping.
 *
 * The confirmed production wound: AgentPTY.kill() queued an async pty-kill
 * IPC message and then destroy() SIGKILLed the pty-host child immediately.
 * The SIGKILL routinely landed before the host dequeued the message, so the
 * node-pty grandchild (claude) was never signaled, reparented to launchd,
 * and held its pty slave + memory for days (alloc-61-65 orphans).
 *
 * These tests fork the REAL compiled host entry (dist/pty/pty-host-entry.js,
 * real node-pty, real grandchild) and prove:
 *   1. pty-dispose → host exits AND the grandchild is dead (graceful path)
 *   2. SIGTERM to the host → grandchild is dead (host SIGTERM handler)
 *
 * Skipped on win32 and when dist/ has not been built.
 */

import { describe, it, expect } from 'vitest';
import { fork, type ChildProcess } from 'child_process';
import { join } from 'path';
import { platform } from 'os';
import { existsSync } from 'fs';

const DIST_ENTRY = join(__dirname, '../../../dist/pty/pty-host-entry.js');
const canRun = platform() !== 'win32' && existsSync(DIST_ENTRY);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface HostSession {
  child: ChildProcess;
  grandchildPid: number;
}

/** Fork the real host entry and spawn a long-lived grandchild (`cat`). */
function spawnRealHost(): Promise<HostSession> {
  return new Promise((resolve, reject) => {
    const child = fork(DIST_ENTRY, [], { silent: true });
    const timer = setTimeout(() => reject(new Error('pty-ready timeout')), 10000);
    child.on('message', (msg: unknown) => {
      const m = msg as { type?: string; pid?: number; message?: string };
      if (m?.type === 'pty-ready' && typeof m.pid === 'number') {
        clearTimeout(timer);
        resolve({ child, grandchildPid: m.pid });
      } else if (m?.type === 'pty-error') {
        clearTimeout(timer);
        reject(new Error(`pty-error: ${m.message}`));
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.send({
      type: 'pty-spawn',
      file: 'cat',
      args: [],
      options: { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: { PATH: process.env.PATH ?? '/bin:/usr/bin' } },
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

describe.skipIf(!canRun)('pty-host-entry RW-4 dispose/SIGTERM grandchild reaping (real node-pty)', () => {
  it('pty-dispose: host exits on its own and the grandchild is dead', async () => {
    const { child, grandchildPid } = await spawnRealHost();
    expect(pidAlive(grandchildPid)).toBe(true);

    child.send({ type: 'pty-dispose' });

    // Host must exit well inside its 4000ms self-exit fallback — the normal
    // path is: signal grandchild → onExit fires → pty-exit → process.exit(0).
    const exited = await waitForExit(child, 3500);
    expect(exited).toBe(true);

    // The whole point of RW-4: no orphaned grandchild.
    await new Promise((r) => setTimeout(r, 300));
    expect(pidAlive(grandchildPid)).toBe(false);
  }, 20000);

  it('SIGTERM to the host kills the node-pty grandchild too', async () => {
    const { child, grandchildPid } = await spawnRealHost();
    expect(pidAlive(grandchildPid)).toBe(true);

    child.kill('SIGTERM');

    const exited = await waitForExit(child, 3000);
    expect(exited).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    expect(pidAlive(grandchildPid)).toBe(false);
  }, 20000);

  // macOS may reap the node-pty child with its host process even after a bare
  // SIGKILL (unlike Linux). This control intentionally documents Linux's old
  // failure mode, so skip it where the kernel semantics do not apply.
  it.skipIf(platform() === 'darwin')('CONTROL — the old semantics (bare SIGKILL on the host) orphans the grandchild', async () => {
    const { child, grandchildPid } = await spawnRealHost();
    expect(pidAlive(grandchildPid)).toBe(true);

    // Exactly what the pre-fix destroy() did.
    child.kill('SIGKILL');
    await waitForExit(child, 3000);
    await new Promise((r) => setTimeout(r, 300));

    // The grandchild survives the host's SIGKILL — this is the wound the
    // graceful path exists to avoid. If this assertion ever starts failing,
    // the kernel/node-pty semantics changed and the grace machinery can be
    // revisited.
    const orphaned = pidAlive(grandchildPid);
    if (orphaned) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* cleanup */ }
    }
    expect(orphaned).toBe(true);
  }, 20000);
});
