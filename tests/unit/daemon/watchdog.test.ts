import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import {
  recordCleanExit,
  readCleanExit,
  deleteCleanExit,
  recordFailure,
  markHealthy,
  loadStability,
  type CleanExitReason,
} from '../../../src/daemon/watchdog.js';

// Tests touch the real filesystem under a unique tmp dir — watchdog.ts uses
// sync fs and has no dependency injection, so filesystem is the natural seam.
// Each test gets a fresh stateDir to isolate flag reads/writes.

function makeStateDir(): string {
  const dir = join(tmpdir(), `watchdog-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function flagPath(stateDir: string): string {
  return join(stateDir, 'clean_exit.flag');
}

describe('watchdog clean-exit flag', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeStateDir();
  });

  afterEach(() => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('recordCleanExit writes flag with exit_code, reason, ts', () => {
    recordCleanExit(stateDir, 0, 'intentional-stop', null);
    expect(existsSync(flagPath(stateDir))).toBe(true);

    const raw = readFileSync(flagPath(stateDir), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.reason).toBe('intentional-stop');
    expect(typeof parsed.ts).toBe('number');
  });

  it('recordCleanExit records non-zero exit codes for intentional-stop', () => {
    // Sage test case: intentional stop is not a crash regardless of exit code.
    recordCleanExit(stateDir, 143, 'intentional-stop', null);
    const parsed = JSON.parse(readFileSync(flagPath(stateDir), 'utf-8'));
    expect(parsed.exit_code).toBe(143);
    expect(parsed.reason).toBe('intentional-stop');
  });

  it('recordCleanExit supports all three reason tags', () => {
    const reasons: CleanExitReason[] = ['intentional-stop', 'daemon-shutdown', 'rate-limit-pause'];
    for (const reason of reasons) {
      const dir = makeStateDir();
      recordCleanExit(dir, 0, reason, null);
      const parsed = JSON.parse(readFileSync(flagPath(dir), 'utf-8'));
      expect(parsed.reason).toBe(reason);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readCleanExit returns clean:false when no flag exists', () => {
    const result = readCleanExit(stateDir);
    expect(result.clean).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.ts).toBeNull();
  });

  it('readCleanExit round-trips a well-formed flag', () => {
    recordCleanExit(stateDir, 0, 'daemon-shutdown', null);
    const result = readCleanExit(stateDir);
    expect(result.clean).toBe(true);
    expect(result.reason).toBe('daemon-shutdown');
    expect(result.exit_code).toBe(0);
    expect(typeof result.ts).toBe('number');
  });

  it('readCleanExit does NOT delete the flag — subsequent reads return the same value', () => {
    recordCleanExit(stateDir, 0, 'intentional-stop', null);
    const first = readCleanExit(stateDir);
    const second = readCleanExit(stateDir);
    expect(first.clean).toBe(true);
    expect(second.clean).toBe(true);
    expect(existsSync(flagPath(stateDir))).toBe(true);
  });

  it('readCleanExit returns clean:false for corrupt JSON (does not throw)', () => {
    // Sage test case: corrupt flag must not silently claim "everything was fine."
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(flagPath(stateDir), '{ not valid json', 'utf-8');

    const result = readCleanExit(stateDir);
    expect(result.clean).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('readCleanExit returns clean:false for valid JSON missing required fields', () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(flagPath(stateDir), JSON.stringify({ reason: 'intentional-stop' }), 'utf-8');

    const result = readCleanExit(stateDir);
    expect(result.clean).toBe(false);
  });

  it('deleteCleanExit removes the flag', () => {
    recordCleanExit(stateDir, 0, 'rate-limit-pause', null);
    expect(existsSync(flagPath(stateDir))).toBe(true);

    deleteCleanExit(stateDir);
    expect(existsSync(flagPath(stateDir))).toBe(false);
  });

  it('deleteCleanExit is a no-op when flag does not exist (no throw)', () => {
    expect(() => deleteCleanExit(stateDir)).not.toThrow();
  });

  it('clean-exit flag and watchdog stability state coexist in the same stateDir', () => {
    // Per Sage open-q #1: flag should live alongside watchdog.json (not merged
    // into state.json). Sanity check that both files live together cleanly.
    recordCleanExit(stateDir, 0, 'intentional-stop', null);
    // markHealthy requires a git root — skip that leg; just confirm independence.
    expect(existsSync(flagPath(stateDir))).toBe(true);
    expect(existsSync(join(stateDir, 'watchdog.json'))).toBe(false);

    // Load stability doesn't care whether the flag exists.
    const stability = loadStability(stateDir);
    expect(stability.restart_counts).toEqual({});
    expect(stability.last_healthy).toBe('');
  });

  it('recordCleanExit is safe to call when state dir does not exist yet', () => {
    const missingDir = join(tmpdir(), `watchdog-missing-${randomBytes(6).toString('hex')}`);
    expect(() => recordCleanExit(missingDir, 0, 'intentional-stop', null)).not.toThrow();
    // atomicWriteSync creates the parent dir, so the flag should land.
    expect(existsSync(join(missingDir, 'clean_exit.flag'))).toBe(true);
    try { rmSync(missingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('overwriting the flag preserves atomicity — last write wins, no partial state', () => {
    // Sage test case: consecutive prompts / consecutive clean exits overwrite
    // rather than stacking. One alert, not multiple.
    recordCleanExit(stateDir, 0, 'intentional-stop', null);
    const first = readCleanExit(stateDir);

    recordCleanExit(stateDir, 0, 'daemon-shutdown', null);
    const second = readCleanExit(stateDir);

    expect(first.reason).toBe('intentional-stop');
    expect(second.reason).toBe('daemon-shutdown');
  });

  it('recordFailure is independent of clean-exit flag (Sage alternative B)', () => {
    // Sage open-q #2: recordFailure() must stay context-free and unit-testable
    // in isolation. The short-circuit lives in handleExit(), not here. Verify
    // that recordFailure works the same whether a clean-exit flag is present
    // or not — no masking, no interference.
    //
    // KNOWN TEST GAP (per Sage audit 2026-04-20, non-blocking): null repoRoot
    // makes recordFailure early-return before reaching the clean-exit logic,
    // so this test does not actually exercise the decoupling under a real
    // failure path. It only confirms the API surface is independent. A
    // future test with a temp git repo would exercise the full path; held
    // for v2. Comment here so future readers are not misled.
    const fakeRepoRoot = null;
    recordCleanExit(stateDir, 0, 'intentional-stop', null);
    recordFailure(stateDir, fakeRepoRoot);

    // Clean-exit flag unaffected regardless. Decoupling holds at the
    // surface level — separate files, separate entry points.
    expect(readCleanExit(stateDir).clean).toBe(true);
  });
});
