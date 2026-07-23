/**
 * pty-host-client.test.ts — 8 cross-platform IPC protocol tests.
 *
 * These tests fork pty-stub-host.cjs instead of the real pty-host-entry so
 * they run on all platforms (no /dev/ptmx required) and exercise the
 * PtyHostProxy / hostSpawn contract in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fork } from 'child_process';
import { join } from 'path';

const STUB = join(__dirname, '../../fixtures/pty-stub-host.cjs');

/**
 * Spawn a PtyHostProxy backed by the stub host.
 * We bypass hostSpawn's resolveHostEntry() by pointing fork at the stub
 * directly and constructing the proxy by hand via the module's internals.
 *
 * The exported `hostSpawn` function resolves the host path from __dirname,
 * which in tests points to the source tree (no dist/). We therefore test
 * the proxy class directly by monkey-patching the fork target.
 */

// We need to import the actual module — but its resolveHostEntry() will look
// for dist/pty/pty-host-entry.js relative to the compiled __dirname.
// Instead of building just for tests, we test protocol compliance by forking
// the stub ourselves and constructing a proxy through the private class.
//
// Since the class is not exported, we test the PUBLIC hostSpawn function but
// override the module resolver via vi.mock so fork gets the stub path.

vi.mock('child_process', async () => {
  const real = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...real,
    fork: (path: string, args: string[], opts: Record<string, unknown>) => {
      // Redirect any fork of a pty-host-entry to the stub
      const target = path.includes('pty-host-entry') ? STUB : path;
      return (real.fork as typeof fork)(target, args ?? [], opts ?? {});
    },
  };
});

// Patch __dirname resolution inside pty-host-client so resolveHostEntry()
// returns a path that includes 'pty-host-entry' (triggering the fork mock)
vi.mock('../../../src/pty/pty-host-client.js', async () => {
  const real = await vi.importActual<typeof import('../../../src/pty/pty-host-client.js')>(
    '../../../src/pty/pty-host-client.js',
  );
  return real;
});

const { hostSpawn } = await import('../../../src/pty/pty-host-client.js');

// Helper: spawn via stub and get the proxy
async function spawnStub(): Promise<Awaited<ReturnType<typeof hostSpawn>>> {
  return hostSpawn('echo', ['hi'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: {} });
}

// ─── 8 Protocol cases ────────────────────────────────────────────────────────

describe('pty-host-client protocol', () => {
  it('1. hostSpawn resolves with an IPty whose pid is the value from pty-ready', async () => {
    const pty = await spawnStub();
    // stub always replies with pid=9999
    expect(pty.pid).toBe(9999);
    pty.kill();
  });

  it('2. onData listener receives pty-data echoes from the stub', async () => {
    const pty = await spawnStub();
    const received: string[] = [];
    const d = pty.onData((chunk) => received.push(chunk));
    pty.write('hello');
    await new Promise((r) => setTimeout(r, 100));
    d.dispose();
    pty.kill();
    expect(received).toContain('hello');
  });

  it('3. onData disposable removes the listener so no further data fires', async () => {
    const pty = await spawnStub();
    const received: string[] = [];
    const d = pty.onData((chunk) => received.push(chunk));
    pty.write('first');
    await new Promise((r) => setTimeout(r, 80));
    d.dispose();
    pty.write('second');
    await new Promise((r) => setTimeout(r, 80));
    pty.kill();
    expect(received).toContain('first');
    expect(received).not.toContain('second');
  });

  it('4. onExit fires when pty-kill is sent', async () => {
    const pty = await spawnStub();
    let exitCode: number | undefined;
    const d = pty.onExit((e) => { exitCode = e.exitCode; });
    pty.kill();
    await new Promise((r) => setTimeout(r, 200));
    d.dispose();
    expect(exitCode).toBe(0);
  });

  it('5. onExit disposable removes the listener', async () => {
    const pty = await spawnStub();
    let fired = false;
    const d = pty.onExit(() => { fired = true; });
    d.dispose();
    pty.kill();
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(false);
  });

  it('6. write after kill does not throw', async () => {
    const pty = await spawnStub();
    pty.kill();
    await new Promise((r) => setTimeout(r, 100));
    expect(() => pty.write('late')).not.toThrow();
  });

  it('7. multiple onData listeners all receive data independently', async () => {
    const pty = await spawnStub();
    const a: string[] = [];
    const b: string[] = [];
    const dA = pty.onData((c) => a.push(c));
    const dB = pty.onData((c) => b.push(c));
    pty.write('ping');
    await new Promise((r) => setTimeout(r, 100));
    dA.dispose();
    dB.dispose();
    pty.kill();
    expect(a).toContain('ping');
    expect(b).toContain('ping');
  });

  it('8. destroy() kills the child process without throwing', async () => {
    const pty = await spawnStub();
    expect(() => pty.destroy?.()).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
  });
});
