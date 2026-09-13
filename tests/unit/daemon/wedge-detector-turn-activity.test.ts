import { describe, it, expect } from 'vitest';
import {
  detectWedge,
  DEFAULT_WEDGE_BUFFER_STALE_MS,
  DEFAULT_WEDGE_HEARTBEAT_FRESH_MS,
  DEFAULT_WEDGE_RESTART_COOLDOWN_MS,
  type WedgeDetectorInput,
} from '../../../src/daemon/wedge-detector.js';

/**
 * knox-codex, 2026-09-08 — the staleness clock moves from "last thing said" to
 * "last turn completed".
 *
 * conversation-buffer.jsonl is touched ONLY on outbound Telegram sends, so a
 * silently-working agent and a wedged one produced the same reading. The fleet
 * was force-restarted 229 times in one daemon log on that signal, including
 * frank2 at 3412min "stale" (~57h) and larry at 2099min (~35h) — agents busily
 * working, punished for not chatting.
 *
 * codex-tokens.jsonl records one row per COMPLETED TURN. When that signal is
 * available it replaces the buffer clock entirely. When it is not (non-codex
 * runtimes, or a session that has completed no turn yet) the buffer clock
 * remains the fallback, so every pre-existing behaviour is preserved.
 */

const NOW = 1_800_000_000_000;

function base(overrides: Partial<WedgeDetectorInput> = {}): WedgeDetectorInput {
  return {
    nowMs: NOW,
    conversationBufferMtimeMs: NOW - 20 * 60_000,
    heartbeatMtimeMs: NOW - 30_000,
    hasPendingWork: true,
    agentRunning: true,
    restartInFlight: false,
    lastWedgeRestartAtMs: 0,
    bufferStaleThresholdMs: DEFAULT_WEDGE_BUFFER_STALE_MS,
    heartbeatFreshThresholdMs: DEFAULT_WEDGE_HEARTBEAT_FRESH_MS,
    restartCooldownMs: DEFAULT_WEDGE_RESTART_COOLDOWN_MS,
    ...overrides,
  };
}

describe('detectWedge — turn activity supersedes buffer staleness', () => {
  it('does NOT report wedged when turns are completing, however old the buffer is', () => {
    // The larry/frank2 false-positive class, exactly: 57 hours without an
    // outbound Telegram message, while turns complete every few seconds.
    const decision = detectWedge(base({
      conversationBufferMtimeMs: NOW - 3412 * 60_000,
      lastTurnAtMs: NOW - 20_000,
    }));

    expect(decision.wedged).toBe(false);
    expect(decision.reason).toBe('turns-recent');
  });

  it('reports wedged when turns have stopped, however fresh the buffer is', () => {
    const decision = detectWedge(base({
      conversationBufferMtimeMs: NOW - 1_000,
      lastTurnAtMs: NOW - 25 * 60_000,
    }));

    expect(decision.wedged).toBe(true);
    expect(decision.reason).toBe('stale-turns-fresh-heartbeat-pending-work');
  });

  it('measures turn staleness against the same threshold as the buffer', () => {
    const justUnder = detectWedge(base({ lastTurnAtMs: NOW - (DEFAULT_WEDGE_BUFFER_STALE_MS - 1_000) }));
    expect(justUnder.wedged).toBe(false);

    const justOver = detectWedge(base({ lastTurnAtMs: NOW - (DEFAULT_WEDGE_BUFFER_STALE_MS + 1_000) }));
    expect(justOver.wedged).toBe(true);
  });

  it('reports the turn age on a wedged verdict, for the alert text', () => {
    const decision = detectWedge(base({ lastTurnAtMs: NOW - 42 * 60_000 }));
    expect(decision.wedged).toBe(true);
    if (decision.wedged) expect(decision.activityAgeMs).toBe(42 * 60_000);
  });

  it('falls back to the buffer clock when no turn signal exists', () => {
    // null = this session has completed no turns (fresh boot) or the runtime
    // writes no token log. Pre-existing behaviour must be untouched.
    const decision = detectWedge(base({ lastTurnAtMs: null }));
    expect(decision.wedged).toBe(true);
    expect(decision.reason).toBe('stale-conversation-fresh-heartbeat-pending-work');
  });

  it('falls back to the buffer clock when the field is absent entirely', () => {
    const input = base();
    delete (input as { lastTurnAtMs?: unknown }).lastTurnAtMs;
    expect(detectWedge(input).wedged).toBe(true);
  });

  it('still honours every exclusion when running on the turn clock', () => {
    const stale = { lastTurnAtMs: NOW - 30 * 60_000 };
    expect(detectWedge(base({ ...stale, hasPendingWork: false })).reason).toBe('no-pending-work');
    expect(detectWedge(base({ ...stale, agentRunning: false })).reason).toBe('agent-not-running');
    expect(detectWedge(base({ ...stale, restartInFlight: true })).reason).toBe('restart-in-flight');
    expect(detectWedge(base({ ...stale, bufferStaleThresholdMs: 0 })).reason).toBe('disabled');
    expect(detectWedge(base({ ...stale, heartbeatMtimeMs: NOW - 10 * 60_000 })).reason).toBe('heartbeat-stale');
    expect(
      detectWedge(base({ ...stale, lastWedgeRestartAtMs: NOW - 60_000 })).reason,
    ).toBe('within-restart-cooldown');
  });
});
