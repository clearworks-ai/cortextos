/**
 * PTY fd leak regression gate — darwin-only.
 *
 * Verifies that spawning N pty sessions via the child-process host leaves
 * ≤4 residual /dev/ptmx or (revoked) fds held by this process.
 *
 * On an UNPATCHED build (node-pty allocated in-process) the delta grows at
 * ~2 per spawn; N=20 produces delta ≈ 40, which causes this test to FAIL.
 * On the patched build (pty-host-client.ts / child-process host) the child
 * exits after each session and the kernel reclaims the devices, leaving
 * delta ≤ 4 (noise from the test runner itself).
 */

import { describe, it, expect } from 'vitest';
import { execSync, fork } from 'child_process';
import { join } from 'path';
import { platform } from 'os';
import { existsSync, readFileSync } from 'fs';

const N = 20;
const DELTA_THRESHOLD = 4;

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

/**
 * Spawn a single pty session via the child-process host and wait for it to
 * exit. The host child must have already been built to dist/ for this to work.
 * If the dist entry is missing we fall back to spawning node-pty directly so
 * that the test is red-on-main (in-process leak is demonstrable).
 */
async function spawnOnePtySession(): Promise<void> {
  const distEntry = join(__dirname, '../../../dist/pty/pty-host-entry.js');
  const useHost = existsSync(distEntry);

  if (useHost) {
    // Patched path: fork the host child, send a spawn command, wait for exit
    await new Promise<void>((resolve, reject) => {
      const child = fork(distEntry, [], { silent: true });
      const msg = {
        type: 'pty-spawn',
        file: 'echo',
        args: ['hi'],
        options: { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: {} },
      };
      child.once('message', (reply: unknown) => {
        if (typeof reply === 'object' && reply !== null && (reply as Record<string, unknown>).type === 'pty-ready') {
          child.send({ type: 'pty-exit-when-done' });
        }
      });
      child.on('exit', () => resolve());
      child.on('error', reject);
      child.send(msg);
      // Safety timeout
      setTimeout(() => { try { child.kill(); } catch { /* already gone */ } resolve(); }, 5000);
    });
  } else {
    // Unpatched fallback: spawn node-pty in-process so the leak is visible
    const nodePty = require('node-pty') as {
      spawn(file: string, args: string[], opts: Record<string, unknown>): {
        onExit(cb: () => void): void;
        kill(): void;
        destroy?(): void;
      };
    };
    await new Promise<void>((resolve) => {
      const p = nodePty.spawn('echo', ['hi'], {
        name: 'xterm-256color', cols: 80, rows: 24,
        cwd: '/tmp', env: process.env,
      });
      p.onExit(() => {
        try { p.kill(); } catch { /* ignore */ }
        try { p.destroy?.(); } catch { /* ignore */ }
        setTimeout(resolve, 100);
      });
    });
  }
}

describe('pty fd leak gate', () => {
  it('GATE: darwin-only — after N pty sessions the ptmx/revoked fd delta is ≤ 4', async () => {
    if (platform() !== 'darwin') {
      // Non-macOS: ptmx device limit is not kern.tty.ptmx_max; skip.
      return;
    }

    const pid = process.pid;
    const before = countPtmxFds(pid);

    for (let i = 0; i < N; i++) {
      await spawnOnePtySession();
    }

    // Give the OS a moment to close the fds after the last child exits
    await new Promise((r) => setTimeout(r, 300));

    const after = countPtmxFds(pid);
    const delta = after - before;

    // Record delta in test output for the commit message
    process.stdout.write(`[pty-leak-gate] before=${before} after=${after} delta=${delta} threshold=${DELTA_THRESHOLD}\n`);

    expect(delta).toBeLessThanOrEqual(DELTA_THRESHOLD);
  }, 120_000);
});

/**
 * D3 — NO-LEAK source invariant covering EVERY runtime spawn path.
 *
 * The generic gate above proves hostSpawn is leak-safe; this gate proves every
 * runtime adapter (agent, codex, opencode) actually ROUTES through it and no one
 * has reverted to in-process `require('node-pty')` on the daemon — the exact
 * regression that reintroduced the codex leak during the re-baseline (2026-07-28).
 * Only pty-host-entry.ts (the sanctioned forked host) may require node-pty.
 */
describe('pty no-leak source invariant (all runtimes)', () => {
  const ptyDir = join(__dirname, '..', '..', '..', 'src', 'pty');
  const read = (f: string) => readFileSync(join(ptyDir, f), 'utf-8');
  // Strip line/block comments so a documented `require('node-pty')` in prose
  // doesn't trip the gate — we only care about executable requires.
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('only pty-host-entry.ts requires node-pty (no in-process daemon spawn)', () => {
    for (const f of ['agent-pty.ts', 'codex-app-server-pty.ts', 'opencode-pty.ts']) {
      const code = stripComments(read(f));
      expect(code, `${f} must NOT require('node-pty') in-process`).not.toMatch(
        /require\(\s*['"]node-pty['"]\s*\)/,
      );
    }
    // The host itself IS allowed to (it's the forked child that reclaims fds).
    expect(stripComments(read('pty-host-entry.ts'))).toMatch(
      /require\(\s*['"]node-pty['"]\s*\)/,
    );
  });

  it('agent + codex spawn paths wire through hostSpawn', () => {
    expect(stripComments(read('agent-pty.ts'))).toMatch(/hostSpawn/);
    expect(stripComments(read('codex-app-server-pty.ts'))).toMatch(/hostSpawn/);
  });
});
