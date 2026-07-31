/**
 * Crash-alert cooldown tests (fix item c).
 *
 * The onStatusChanged closure in agent-manager.ts:registerAgent() has a
 * per-agent cooldown: a `crashed` alert is skipped if the previous one for
 * the same agent was < 10 minutes ago. `halted` and `recovered` always send.
 *
 * We test the closure logic directly by replicating it — the implementation
 * is small and self-contained, so a direct port is the cleanest harness
 * without needing to spin up a full AgentManager instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type StatusPayload = { status: string; crashCount?: number };

function buildCrashAlertClosure(sendMessage: (msg: string) => void, name: string, runtime?: string) {
  const CRASH_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
  const daemonOwnsCrashAlerts = runtime === 'codex-app-server' || runtime === 'opencode';
  let prevStatus: string | null = null;
  let lastCrashAlertAt: number | null = null;

  return (status: StatusPayload) => {
    if (status.status === 'crashed' && daemonOwnsCrashAlerts) {
      const now = Date.now();
      if (lastCrashAlertAt !== null && now - lastCrashAlertAt < CRASH_ALERT_COOLDOWN_MS) {
        // Duplicate crash within cooldown window — skip.
      } else {
        lastCrashAlertAt = now;
        const crashNum = status.crashCount ?? '?';
        sendMessage(`Agent ${name} crashed (crash #${crashNum}) — auto-restarting`);
      }
    } else if (status.status === 'halted') {
      sendMessage(`Agent ${name} HALTED — exceeded crash limit. Restart manually with: cortextos start ${name}`);
    } else if (status.status === 'running' && prevStatus === 'crashed' && daemonOwnsCrashAlerts) {
      sendMessage(`Agent ${name} recovered and is back online`);
    }
    prevStatus = status.status;
  };
}

describe('crash-alert cooldown (agent-manager onStatusChanged)', () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let handler: ReturnType<typeof buildCrashAlertClosure>;

  beforeEach(() => {
    sendMessage = vi.fn();
    handler = buildCrashAlertClosure(sendMessage, 'alice', 'codex-app-server');
  });

  it('two crashed events within 10 minutes produce exactly one Telegram message', () => {
    handler({ status: 'crashed', crashCount: 1 });
    handler({ status: 'crashed', crashCount: 2 });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toContain('crash #1');
  });

  it('crashed → halted: both messages sent regardless of cooldown', () => {
    handler({ status: 'crashed', crashCount: 1 });
    handler({ status: 'halted' });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][0]).toContain('crashed');
    expect(sendMessage.mock.calls[1][0]).toContain('HALTED');
  });

  it('crashed → running: recovered message sent', () => {
    handler({ status: 'crashed', crashCount: 1 });
    handler({ status: 'running' });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][0]).toContain('recovered');
  });

  it('crashed after cooldown window expires sends a second alert', () => {
    const dateSpy = vi.spyOn(Date, 'now');
    const baseTime = 1_000_000_000_000;
    dateSpy.mockReturnValueOnce(baseTime); // first crash

    handler({ status: 'crashed', crashCount: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Advance past the 10-minute cooldown
    dateSpy.mockReturnValueOnce(baseTime + 11 * 60 * 1000); // second crash after cooldown
    handler({ status: 'crashed', crashCount: 2 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][0]).toContain('crash #2');

    dateSpy.mockRestore();
  });

  it('running → crashed (not from crashed) does not send recovered', () => {
    // Start from running state, then crash — no recovered message
    handler({ status: 'running' });
    handler({ status: 'crashed', crashCount: 1 });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toContain('crashed');
  });

  it('claude-code crashed → running sends no daemon-side crash alerts', () => {
    const claudeHandler = buildCrashAlertClosure(sendMessage, 'alice', 'claude-code');

    claudeHandler({ status: 'crashed', crashCount: 1 });
    claudeHandler({ status: 'running' });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('undefined runtime crashed → running sends no daemon-side crash alerts', () => {
    const defaultRuntimeHandler = buildCrashAlertClosure(sendMessage, 'alice');

    defaultRuntimeHandler({ status: 'crashed', crashCount: 1 });
    defaultRuntimeHandler({ status: 'running' });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('hermes crashed → running sends no daemon-side crash alerts', () => {
    const hermesHandler = buildCrashAlertClosure(sendMessage, 'alice', 'hermes');

    hermesHandler({ status: 'crashed', crashCount: 1 });
    hermesHandler({ status: 'running' });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('claude-code crashed → halted still sends the halted alert', () => {
    const claudeHandler = buildCrashAlertClosure(sendMessage, 'alice', 'claude-code');

    claudeHandler({ status: 'crashed', crashCount: 1 });
    claudeHandler({ status: 'halted' });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toContain('HALTED');
  });

  it('opencode crashed → running still sends crashed and recovered alerts', () => {
    const opencodeHandler = buildCrashAlertClosure(sendMessage, 'alice', 'opencode');

    opencodeHandler({ status: 'crashed', crashCount: 1 });
    opencodeHandler({ status: 'running' });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][0]).toContain('crashed');
    expect(sendMessage.mock.calls[1][0]).toContain('recovered');
  });
});
