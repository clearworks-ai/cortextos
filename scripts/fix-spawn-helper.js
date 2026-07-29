#!/usr/bin/env node
/**
 * Restore the executable bit on node-pty's `spawn-helper` binary.
 *
 * node-pty ships `spawn-helper` (the setuid-safe fork/exec helper used by
 * posix_spawnp on macOS/Linux) but npm's tarball extraction can drop its +x
 * bit. Without it, every PTY spawn fails with `posix_spawnp failed`, which
 * crash-loops the daemon and takes the whole agent fleet down — this is the
 * root cause of the 2026-07-27 cortextOS fleet outage.
 *
 * Runs on every `npm install` via the `postinstall` hook so a fresh install /
 * `npm ci` / rebuild can never leave the fleet in that state again. No-op on
 * Windows (ConPTY, no spawn-helper) and silent if node-pty isn't present.
 */
const { chmodSync, existsSync, readdirSync, statSync } = require('fs');
const { join } = require('path');

if (process.platform === 'win32') process.exit(0);

function fixUnder(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      fixUnder(p);
    } else if (name === 'spawn-helper') {
      try {
        chmodSync(p, 0o755);
        console.log('[fix-spawn-helper] +x', p);
      } catch (e) {
        console.warn('[fix-spawn-helper] could not chmod', p, '-', e.message);
      }
    }
  }
}

try {
  fixUnder(join(__dirname, '..', 'node_modules', 'node-pty'));
} catch (e) {
  console.warn('[fix-spawn-helper] non-fatal:', e.message);
}
