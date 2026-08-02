/**
 * pty-host-ready.test.ts — RW-5 spawn-wedge regression tests.
 *
 * Root wound RW-5 (state/v9-fleet-incident/UPSTREAM-ROOT-WOUND.md): hostSpawn's
 * waitReady() had no timeout and child exit never rejected _ready, so a
 * pty-host child that died pre-ready (OOM, module-load failure, posix_spawnp
 * refusal) wedged the spawn path forever — "spawn failed → retry" silently
 * became "spawn wedged permanently".
 *
 * These tests prove the three fix legs:
 *   1. child exits pre-ready → hostSpawn REJECTS (and reaps the child)
 *   2. child alive but silent → waitReady() deadline fires → hostSpawn REJECTS
 *   3. pty-host-entry exits(1) on its own if no pty-spawn arrives in time
 *
 * Same stub-fork pattern as pty-host-client.test.ts (cross-platform, no
 * /dev/ptmx needed). Test 3 forks the REAL built entry from dist/, the same
 * way rebaseline-runtime-gates.test.ts does.
 */

import { describe, it, expect, vi } from 'vitest';
import { fork, type ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const DEAD_STUB = join(__dirname, '../../fixtures/pty-stub-dead-host.cjs');
const SILENT_STUB = join(__dirname, '../../fixtures/pty-stub-silent-host.cjs');
const DIST_HOST_ENTRY = join(__dirname, '..', '..', '..', 'dist', 'pty', 'pty-host-entry.js');

// Short deadline so the timeout test completes fast. Must be set BEFORE the
// module import below — READY_TIMEOUT_MS is read at module load.
process.env.CTX_PTY_READY_TIMEOUT_MS = '400';

// Mutable redirect target + last-forked child capture, so each test picks its
// stub and can assert the child was reaped after a failed spawn.
let stubTarget = DEAD_STUB;
let lastChild: ChildProcess | null = null;

vi.mock('child_process', async () => {
  const real = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...real,
    fork: (path: string, args: string[], opts: Record<string, unknown>) => {
      const target = path.includes('pty-host-entry') ? stubTarget : path;
      const child = (real.fork as typeof fork)(target, args ?? [], opts ?? {});
      if (path.includes('pty-host-entry')) lastChild = child;
      return child;
    },
  };
});

const { hostSpawn } = await import('../../../src/pty/pty-host-client.js');

function spawnStub(): ReturnType<typeof hostSpawn> {
  return hostSpawn('echo', ['hi'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: {} });
}

async function waitForChildExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

describe('RW-5: hostSpawn never wedges', () => {
  it('rejects when the host child exits before pty-ready', async () => {
    stubTarget = DEAD_STUB;
    await expect(spawnStub()).rejects.toThrow(/exited before pty-ready/);
  });

  it('rejects via the waitReady deadline when the host child is alive but silent', async () => {
    stubTarget = SILENT_STUB;
    lastChild = null;
    const started = Date.now();
    await expect(spawnStub()).rejects.toThrow(/did not report pty-ready within/);
    // Deadline (400ms) fired, not some multi-second hang.
    expect(Date.now() - started).toBeLessThan(5000);
    // The failed spawn must not leave the forked host lingering (RW-6 feeder).
    expect(lastChild).not.toBeNull();
    expect(await waitForChildExit(lastChild!, 2000)).toBe(true);
  });

  it.skipIf(!existsSync(DIST_HOST_ENTRY))('pty-host-entry exits(1) on its own when no pty-spawn arrives in time', async () => {
    // Forks the REAL built entry (dist/) — requires `npm run build` first,
    // same loud-fail contract as rebaseline-runtime-gates.test.ts.
    const real = await vi.importActual<typeof import('child_process')>('child_process');
    const child = (real.fork as typeof fork)(DIST_HOST_ENTRY, [], {
      silent: true,
      execArgv: [],
      env: { ...process.env, CTX_PTY_SPAWN_WAIT_MS: '300' },
    });

    const errors: Array<{ type?: string; message?: string }> = [];
    child.on('message', (m) => { if (m && typeof m === 'object') errors.push(m as { type?: string }); });

    const exitCode = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 5000);
      child.once('exit', (code) => { clearTimeout(t); resolve(code); });
    });

    // Never send pty-spawn — the entry must self-terminate with code 1
    // instead of lingering as an idle orphan.
    expect(exitCode).toBe(1);
    expect(errors.some((m) => m.type === 'pty-error' && /no pty-spawn received/.test(m.message ?? ''))).toBe(true);
  });
});
