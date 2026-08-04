import { describe, it, expect } from 'vitest';
import {
  detectWedge,
  DEFAULT_WEDGE_BUFFER_STALE_MS,
  DEFAULT_WEDGE_HEARTBEAT_FRESH_MS,
  DEFAULT_WEDGE_RESTART_COOLDOWN_MS,
  type WedgeDetectorInput,
} from '../../../src/daemon/wedge-detector.js';

/**
 * Unit tests for the pure wedge-detection decision function.
 *
 * A WEDGED agent = conversation buffer stale (no processed turns) WHILE the
 * heartbeat stays fresh (a cron keeps stamping it) AND there is pending inbox
 * work. That exact conjunction is the only thing that returns wedged:true; every
 * exclusion returns wedged:false with a diagnostic reason.
 */

const NOW = 1_800_000_000_000;

/** A baseline WEDGED scenario; individual tests override one field to flip it. */
function wedgedBase(overrides: Partial<WedgeDetectorInput> = {}): WedgeDetectorInput {
  return {
    nowMs: NOW,
    // buffer last touched 20min ago — stale (> 15min default)
    conversationBufferMtimeMs: NOW - 20 * 60_000,
    // heartbeat touched 30s ago — fresh (< 5min)
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

describe('detectWedge', () => {
  it('classifies WEDGED: stale conversation + fresh heartbeat + pending work → restart', () => {
    const d = detectWedge(wedgedBase());
    expect(d.wedged).toBe(true);
    if (d.wedged) {
      expect(d.reason).toBe('stale-conversation-fresh-heartbeat-pending-work');
      expect(d.bufferAgeMs).toBe(20 * 60_000);
      expect(d.heartbeatAgeMs).toBe(30_000);
    }
  });

  it('NOT wedged when the conversation buffer is fresh (agent actively processing)', () => {
    const d = detectWedge(wedgedBase({ conversationBufferMtimeMs: NOW - 60_000 }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('buffer-fresh');
  });

  it('NOT wedged when the heartbeat is ALSO stale (agent is down, not wedged → crash path owns it)', () => {
    const d = detectWedge(wedgedBase({ heartbeatMtimeMs: NOW - 10 * 60_000 }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('heartbeat-stale');
  });

  it('NOT wedged when there is no pending inbox work (legitimately idle, nothing to do)', () => {
    const d = detectWedge(wedgedBase({ hasPendingWork: false }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('no-pending-work');
  });

  it('NOT wedged when a restart is already in flight (single-flight #269 respected — no duplicate)', () => {
    const d = detectWedge(wedgedBase({ restartInFlight: true }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('restart-in-flight');
  });

  it('NOT wedged when the agent is not running (crash/exit restart paths own that case)', () => {
    const d = detectWedge(wedgedBase({ agentRunning: false }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('agent-not-running');
  });

  it('storm guard: NOT wedged again within the restart cooldown window', () => {
    // Last wedge-restart 5min ago; cooldown is 30min → still cooling down.
    const d = detectWedge(wedgedBase({ lastWedgeRestartAtMs: NOW - 5 * 60_000 }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('within-restart-cooldown');
  });

  it('storm guard: wedges again AFTER the cooldown window elapses', () => {
    // Last wedge-restart 31min ago; cooldown is 30min → past cooldown, wedge allowed.
    const d = detectWedge(wedgedBase({ lastWedgeRestartAtMs: NOW - 31 * 60_000 }));
    expect(d.wedged).toBe(true);
  });

  it('NOT wedged on first boot (no conversation buffer yet)', () => {
    const d = detectWedge(wedgedBase({ conversationBufferMtimeMs: null }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('no-conversation-buffer');
  });

  it('NOT wedged when heartbeat file is missing (down, not wedged)', () => {
    const d = detectWedge(wedgedBase({ heartbeatMtimeMs: null }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('no-heartbeat');
  });

  it('disabled: bufferStaleThresholdMs <= 0 (wedge_restart_min <= 0) never wedges', () => {
    const d = detectWedge(wedgedBase({ bufferStaleThresholdMs: 0 }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('disabled');
  });

  it('boundary: buffer exactly at threshold is treated as fresh (not yet stale)', () => {
    const d = detectWedge(wedgedBase({
      conversationBufferMtimeMs: NOW - DEFAULT_WEDGE_BUFFER_STALE_MS + 1,
    }));
    expect(d.wedged).toBe(false);
    expect((d as { reason: string }).reason).toBe('buffer-fresh');
  });

  it('honors a custom (shorter) wedge threshold', () => {
    // 6min stale buffer with a 5min custom threshold → wedged.
    const d = detectWedge(wedgedBase({
      conversationBufferMtimeMs: NOW - 6 * 60_000,
      bufferStaleThresholdMs: 5 * 60_000,
    }));
    expect(d.wedged).toBe(true);
  });
});
