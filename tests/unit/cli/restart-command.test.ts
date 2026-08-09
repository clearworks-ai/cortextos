/**
 * Unit-test parity for the `cortextos restart <agent>` subcommand
 * (issue #328). Companion to lifecycle-markers.test.ts which already
 * covers writeStopMarker — restart re-uses that helper, so this file
 * pins the command-level wiring (name, required argument, --instance
 * option, description) instead of duplicating the marker-write tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sentRequests: Array<Record<string, unknown>> = [];
vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    constructor(_instance: string) { /* no-op */ }
    async isDaemonRunning() { return true; }
    async send(req: Record<string, unknown>) {
      sentRequests.push(req);
      return { success: true, data: `ok:${req.type}` };
    }
  },
}));
vi.mock('../../../src/cli/stop.js', () => ({
  writeStopMarker: vi.fn(),
}));

import { restartCommand } from '../../../src/cli/restart';

describe('issue #328: cortextos restart <agent>', () => {
  it('is registered as `restart`', () => {
    expect(restartCommand.name()).toBe('restart');
  });

  it('requires the <agent> positional argument', () => {
    // commander stores arg metadata on _args / registeredArguments depending on
    // version; both expose .required on the registered argument.
    const args = (restartCommand as unknown as { registeredArguments: { required: boolean; name: () => string }[] }).registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].required).toBe(true);
    expect(args[0].name()).toBe('agent');
  });

  it('leaves --instance unset so marker/env resolution can win', () => {
    // Instance-resolution hardening: the command must NOT carry a commander
    // "default" 3rd-arg — that would shadow the ACTIVE_INSTANCE marker and
    // CTX_INSTANCE_ID. Resolution happens in the action via resolveInstanceId.
    // (See instance-resolution.test.ts for the full precedence contract.)
    const opts = restartCommand.opts();
    expect(opts.instance).toBeUndefined();
  });

  it('describes itself as a stop+start (not a daemon restart)', () => {
    // The description must make clear this does NOT bounce the daemon —
    // operator-facing UX guard so users don't reach for this when they
    // actually need `pm2 restart cortextos-daemon`.
    const desc = restartCommand.description().toLowerCase();
    expect(desc).toContain('stop');
    expect(desc).toContain('start');
    expect(desc).toContain('daemon');
  });
});

describe('disable-resurrection fix: restart stop-half is not user-initiated', () => {
  beforeEach(() => { sentRequests.length = 0; });

  it('sends userInitiated:false and then a follow-up start-agent', async () => {
    await restartCommand.parseAsync(['alice'], { from: 'user' });

    const stopReq = sentRequests.find(r => r.type === 'stop-agent');
    expect(stopReq).toBeDefined();
    expect(stopReq?.agent).toBe('alice');
    expect(stopReq?.userInitiated).toBe(false);
    expect(sentRequests.some(r => r.type === 'start-agent' && r.agent === 'alice')).toBe(true);
  });
});
