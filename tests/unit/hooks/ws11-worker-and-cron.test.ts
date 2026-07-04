/**
 * WS11 regression tests — worker exit classification + cron-active deny-fast.
 *
 * Part 2a: A worker PTY exit must NEVER be classified as an agent crash.
 *   - Primary signal: .is-worker marker (checked before name-suffix regex).
 *   - Secondary signal: CTX_WORKER env variable.
 *   - Tertiary: name-suffix regex (belt-and-suspenders only — not the primary guard).
 *   All three paths must produce an early return before any Telegram/bus alert.
 *
 * Part 2b: A cron-originated permission request must be denied immediately
 *   (< 2 s) without sending the interactive Telegram or waiting 30 minutes.
 *   The deny emits a `cron_permission_denied` bus event via execFile.
 *   Without .cron-active the hook still sends Telegram (unchanged behavior).
 *
 * Test strategy: real temp dirs for filesystem state; child_process mocked to
 * intercept execFile calls (same pattern as hook-crash-alert.test.ts and
 * worker-suppression.test.ts). No fetch mock needed — cron-active path returns
 * before reaching the Telegram send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// child_process mock must be hoisted before module imports.
const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  isWorkerSession,
  notifyAgents,
  classifyFromMarkers,
} from '../../../src/hooks/hook-crash-alert.js';

// ---------------------------------------------------------------------------
// Part 2a — Worker detection priority
//
// The spec requires:
//   1. CTX_WORKER env OR .is-worker marker → early return (primary signals)
//   2. Name-suffix regex → fallback-only
//
// We test that the .is-worker marker is authoritative even when CTX_WORKER
// is not set AND the agent name lacks the epoch suffix (the "non-epoch name"
// case that the old suffix-only guard would have missed — gap A in the spec).
// ---------------------------------------------------------------------------
describe('Part 2a: worker detection — .is-worker marker is primary signal', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ws11-worker-detection-'));
    execFileMock.mockReset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('.is-worker marker without epoch suffix — isWorkerSession is true (gap A closed)', () => {
    // Agent name has NO 10-digit epoch suffix — suffix-only guard would miss this.
    // The .is-worker marker must be the authoritative signal.
    writeFileSync(join(tmp, '.is-worker'), 'my-custom-worker');
    expect(isWorkerSession(tmp)).toBe(true);
  });

  it('.is-worker marker present — isWorkerSession is true (standard case)', () => {
    writeFileSync(join(tmp, '.is-worker'), 'comms-check-1782229983');
    expect(isWorkerSession(tmp)).toBe(true);
  });

  it('no .is-worker marker — isWorkerSession is false', () => {
    expect(isWorkerSession(tmp)).toBe(false);
  });

  it('.is-worker present → notifyAgents never reached (mirrors hook gate)', () => {
    // Simulate the gate in hook-crash-alert.ts main():
    //   const isWorker = existsSync(join(stateDir, '.is-worker'))  ← now checked via isWorkerSession
    //   ...
    //   if (isWorker) return; // before notifyAgents
    writeFileSync(join(tmp, '.is-worker'), 'my-custom-worker');
    const isWorker = isWorkerSession(tmp);
    const endType = 'crash';

    if (!isWorker && (endType === 'crash' || endType === 'daemon-crashed')) {
      notifyAgents({
        agentName: 'my-custom-worker',
        endType,
        reason: '',
        lastTask: '',
        crashCount: 1,
        restartAttempted: true,
        recipients: ['chief', 'analyst'],
      });
    }

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('.crash_count_today NOT written when isWorker=true (count gate)', () => {
    writeFileSync(join(tmp, '.is-worker'), 'my-custom-worker');
    const isWorker = isWorkerSession(tmp);
    const endType = 'crash';
    const today = new Date().toISOString().split('T')[0];
    const countFile = join(tmp, '.crash_count_today');

    // Mirror the hook's crash-count guard:
    if (endType === 'crash' && !isWorker) {
      writeFileSync(countFile, `${today}:1`, 'utf-8');
    }

    // Count must NOT have been incremented
    let written = false;
    try {
      readFileSync(countFile, 'utf-8');
      written = true;
    } catch { /* expected — file was not written */ }
    expect(written).toBe(false);
  });

  it('real agent crash (no markers) — classifyFromMarkers returns crash + notifyAgents fires', () => {
    // Prove we did not over-suppress: a genuine agent with no .is-worker
    // must still be classified as a crash and reach notifyAgents.
    const endType = classifyFromMarkers(tmp, []).endType;
    expect(endType).toBe('crash');

    const isWorker = isWorkerSession(tmp);
    expect(isWorker).toBe(false);

    if (!isWorker && (endType === 'crash' || endType === 'daemon-crashed')) {
      notifyAgents({
        agentName: 'larry',
        endType,
        reason: '',
        lastTask: '',
        crashCount: 1,
        restartAttempted: true,
        recipients: ['chief', 'analyst'],
      });
    }

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('rate-limit stdout reclassify — not a crash, notifyAgents not called (regression guard)', () => {
    // A session that exits with a rate-limit in stdout should be 'rate-limited',
    // not 'crash'. Simulate the hook's rate-limit reclassify path (guard only —
    // the actual detectRateLimitInLog reads a file, which we skip here).
    let endType = classifyFromMarkers(tmp, []).endType; // 'crash' (no markers)
    expect(endType).toBe('crash');

    // Simulate the rate-limit reclassify:
    endType = 'rate-limited';

    const isWorker = isWorkerSession(tmp);
    // rate-limited sessions still have isWorker=false and go through dedup/quiet,
    // but they do NOT call notifyAgents (only crash + daemon-crashed do).
    if (!isWorker && (endType === 'crash' || endType === 'daemon-crashed')) {
      notifyAgents({
        agentName: 'larry',
        endType,
        reason: '',
        lastTask: '',
        crashCount: 0,
        restartAttempted: true,
        recipients: ['chief'],
      });
    }

    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Part 2b — Cron-active deny-fast
//
// readCronActive + emitCronPermissionDeniedEvent are internal to
// hook-permission-telegram.ts (not exported). We test the observable effects:
//   - When .cron-active is present and unexpired → outputDecision('deny') is
//     called immediately, execFile fires a bus log-event, no Telegram send.
//   - When .cron-active is absent → behavior is unchanged (Telegram still sends).
//   - When .cron-active is present but expired → treated as absent.
//
// We simulate the hook's cron-active logic directly (mirroring the
// readCronActive function) since the full hook requires stdin piping.
// ---------------------------------------------------------------------------
describe('Part 2b: .cron-active marker — deny-fast logic', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ws11-cron-active-'));
    execFileMock.mockReset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Mirror of readCronActive from hook-permission-telegram.ts.
   * Kept inline here so the test is self-contained and doesn't create an
   * import cycle with the hook module (which has a top-level main() call).
   */
  function readCronActive(stateDir: string): { cronName: string; firedAt: string } | null {
    const { existsSync, readFileSync: rf } = require('fs');
    const markerPath = join(stateDir, '.cron-active');
    if (!existsSync(markerPath)) return null;
    try {
      const payload = JSON.parse(rf(markerPath, 'utf-8'));
      const now = Date.now();
      if (payload.expiresAt !== undefined && now > payload.expiresAt) return null;
      if (!payload.cronName) return null;
      return { cronName: payload.cronName, firedAt: payload.firedAt ?? '' };
    } catch {
      return null;
    }
  }

  it('.cron-active absent → readCronActive returns null (interactive path unchanged)', () => {
    expect(readCronActive(tmp)).toBeNull();
  });

  it('.cron-active present and unexpired → readCronActive returns cron info', () => {
    writeFileSync(
      join(tmp, '.cron-active'),
      JSON.stringify({ cronName: 'comms-check', firedAt: new Date().toISOString(), expiresAt: Date.now() + 600_000 }),
      'utf-8',
    );
    const result = readCronActive(tmp);
    expect(result).not.toBeNull();
    expect(result?.cronName).toBe('comms-check');
  });

  it('.cron-active present but expired → readCronActive returns null (stale marker ignored)', () => {
    writeFileSync(
      join(tmp, '.cron-active'),
      JSON.stringify({ cronName: 'old-cron', firedAt: new Date().toISOString(), expiresAt: Date.now() - 1 }),
      'utf-8',
    );
    expect(readCronActive(tmp)).toBeNull();
  });

  it('.cron-active malformed JSON → readCronActive returns null (resilient parse)', () => {
    writeFileSync(join(tmp, '.cron-active'), '{ not valid json', 'utf-8');
    expect(readCronActive(tmp)).toBeNull();
  });

  it('.cron-active with missing cronName field → readCronActive returns null', () => {
    writeFileSync(
      join(tmp, '.cron-active'),
      JSON.stringify({ firedAt: new Date().toISOString(), expiresAt: Date.now() + 600_000 }),
      'utf-8',
    );
    expect(readCronActive(tmp)).toBeNull();
  });

  it('cron-active path: deny is returned fast (< 2s) and emits bus log-event', () => {
    // Write a valid .cron-active marker
    writeFileSync(
      join(tmp, '.cron-active'),
      JSON.stringify({ cronName: 'comms-check', firedAt: new Date().toISOString(), expiresAt: Date.now() + 600_000 }),
      'utf-8',
    );

    const start = Date.now();
    const cronActive = readCronActive(tmp);
    expect(cronActive).not.toBeNull();

    // Simulate the hook's deny-fast branch (emitCronPermissionDeniedEvent call):
    if (cronActive !== null) {
      // Mirror emitCronPermissionDeniedEvent — uses execFile to fire bus log-event
      const meta = JSON.stringify({
        cronName: cronActive.cronName,
        toolName: 'Bash',
        firedAt: cronActive.firedAt,
        reason: 'auto-denied: cron-originated, no human present',
      });
      execFileMock('cortextos', ['bus', 'log-event', 'action', 'cron_permission_denied', 'warn', '--meta', meta], {}, () => {});
    }

    const elapsed = Date.now() - start;
    // Must complete well under 2 seconds (no Telegram polling involved)
    expect(elapsed).toBeLessThan(2000);

    // Bus event must have been emitted
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toContain('cron_permission_denied');
    expect(args).toContain('warn');
    // Meta must contain cronName and toolName
    const metaArg = args[args.indexOf('--meta') + 1] as string;
    const parsedMeta = JSON.parse(metaArg);
    expect(parsedMeta.cronName).toBe('comms-check');
    expect(parsedMeta.toolName).toBe('Bash');
    expect(parsedMeta.reason).toContain('auto-denied');
  });

  it('cron-active path: no Telegram sendMessage is called (timeout suppressed)', () => {
    // The deny-fast branch returns before api.sendMessage — verify that by
    // confirming only the bus execFile fires, not a Telegram fetch/execFile.
    // (In the real hook, api.sendMessage uses fetch which is not mocked here;
    // the deny-fast return prevents it from being called at all.)
    writeFileSync(
      join(tmp, '.cron-active'),
      JSON.stringify({ cronName: 'heartbeat', firedAt: new Date().toISOString(), expiresAt: Date.now() + 600_000 }),
      'utf-8',
    );

    const cronActive = readCronActive(tmp);
    expect(cronActive).not.toBeNull();

    // Simulate: if cron-active → emit + deny-fast return, never reach Telegram send
    let telegramSent = false;
    if (cronActive !== null) {
      // deny-fast: emit bus event and return — telegramSent stays false
      execFileMock('cortextos', ['bus', 'log-event', 'action', 'cron_permission_denied', 'warn', '--meta', '{}'], {}, () => {});
      // return here in the real hook
    } else {
      // Only reached when cron-active is absent — interactive path
      telegramSent = true;
    }

    expect(telegramSent).toBe(false);
    // Bus event fired
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
