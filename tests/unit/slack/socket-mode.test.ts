import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackSocketModeClient, openConnectionUrl } from '../../../src/slack/socket-mode';

/**
 * Minimal fake matching the subset of the native WebSocket API socket-mode.ts
 * uses (addEventListener for open/message/close/error, send, close). Each
 * `new WebSocket(url)` call in the client under test produces one of these;
 * tests drive its lifecycle explicitly via the emit* helpers.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static lifecycle: string[] = [];
  readonly id: number;
  url: string;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.id = FakeWebSocket.instances.length;
    this.url = url;
    FakeWebSocket.instances.push(this);
    FakeWebSocket.lifecycle.push(`construct:${this.id}`);
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  send(data: string): void {
    if (this.closed) throw new Error('socket is closed');
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    FakeWebSocket.lifecycle.push(`close:${this.id}`);
    this.emit('close', {});
  }

  emit(type: string, ev: unknown): void {
    for (const h of this.listeners[type] ?? []) h(ev);
  }

  emitMessage(data: unknown): void {
    this.emit('message', { data: JSON.stringify(data) });
  }
}

function resetFakes(): void {
  FakeWebSocket.instances = [];
  FakeWebSocket.lifecycle = [];
}

/** Flush the pending microtask chain (a real macrotask tick flushes all queued microtasks first). */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('openConnectionUrl', () => {
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  it('POSTs to apps.connections.open with the app-level token and returns the url', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ ok: true, url: 'wss://example.com/link' }),
    });
    const url = await openConnectionUrl('xapp-1');
    expect(url).toBe('wss://example.com/link');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://slack.com/api/apps.connections.open',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer xapp-1' },
      }),
    );
  });

  it('throws when Slack returns ok:false', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ ok: false, error: 'invalid_auth' }),
    });
    await expect(openConnectionUrl('xapp-bad')).rejects.toThrow(/invalid_auth/);
  });
});

describe('SlackSocketModeClient', () => {
  beforeEach(() => {
    resetFakes();
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, url: 'wss://example.com/link' }),
    }) as unknown as typeof fetch;
    global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  it('acks an events_api envelope immediately, before dispatching', async () => {
    const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
    const received: unknown[] = [];
    client.onMessage((e) => received.push(e));
    await client.start();

    const socket = FakeWebSocket.instances[0];
    socket.emitMessage({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: {
        team_id: 'T1',
        event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1' },
      },
    });

    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]);
    expect(received).toEqual([
      { type: 'message', team: 'T1', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1', thread_ts: undefined },
    ]);
  });

  it('excludes bot-authored messages (bot_id present)', async () => {
    const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
    const received: unknown[] = [];
    client.onMessage((e) => received.push(e));
    await client.start();

    FakeWebSocket.instances[0].emitMessage({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: {
        team_id: 'T1',
        event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1', bot_id: 'B1' },
      },
    });

    expect(received).toEqual([]);
  });

  it('excludes message subtypes (edits, joins, etc.)', async () => {
    const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
    const received: unknown[] = [];
    client.onMessage((e) => received.push(e));
    await client.start();

    FakeWebSocket.instances[0].emitMessage({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: {
        team_id: 'T1',
        event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1', subtype: 'message_changed' },
      },
    });

    expect(received).toEqual([]);
  });

  it('accepts app_mention events', async () => {
    const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
    const received: unknown[] = [];
    client.onMessage((e) => received.push(e));
    await client.start();

    FakeWebSocket.instances[0].emitMessage({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: {
        team_id: 'T1',
        event: { type: 'app_mention', channel: 'C1', user: 'U1', text: '<@BOT> hi', ts: '1.1' },
      },
    });

    expect(received).toHaveLength(1);
  });

  it('ignores non-message/app_mention event types', async () => {
    const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
    const received: unknown[] = [];
    client.onMessage((e) => received.push(e));
    await client.start();

    FakeWebSocket.instances[0].emitMessage({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: { team_id: 'T1', event: { type: 'reaction_added', channel: 'C1', user: 'U1' } },
    });

    expect(received).toEqual([]);
  });

  it('ignores a hello frame without error', async () => {
    const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
    await client.start();
    expect(() => FakeWebSocket.instances[0].emitMessage({ type: 'hello' })).not.toThrow();
  });

  it('ignores non-JSON frames without error', async () => {
    const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
    await client.start();
    const socket = FakeWebSocket.instances[0];
    expect(() => socket.emit('message', { data: 'not json' })).not.toThrow();
  });

  describe('reconnect hygiene (warden review)', () => {
    it('on a disconnect frame, opens a replacement connection', async () => {
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
      await client.start();
      expect(FakeWebSocket.instances).toHaveLength(1);

      FakeWebSocket.instances[0].emitMessage({ type: 'disconnect', reason: 'refresh_requested' });
      // connect() awaits openConnectionUrl (a resolved-immediately mock
      // here) before constructing the new socket — flush the pending
      // microtask chain via a real macrotask tick.
      await flushAsync();

      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('RED: closes the superseded socket when a disconnect opens its replacement', async () => {
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
      await client.start();

      const oldSocket = FakeWebSocket.instances[0];
      oldSocket.emitMessage({ type: 'disconnect', reason: 'too_many_websockets' });
      await flushAsync();

      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(oldSocket.closed).toBe(true);
    });

    it('strict zero-overlap: closes the superseded socket before constructing its replacement', async () => {
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
      await client.start();
      FakeWebSocket.lifecycle = [];

      FakeWebSocket.instances[0].emitMessage({ type: 'disconnect', reason: 'too_many_websockets' });
      await flushAsync();

      expect(FakeWebSocket.lifecycle).toEqual(['close:0', 'construct:1']);
    });

    it('coalesces repeated error and close signals into one reconnect attempt', async () => {
      vi.useFakeTimers();
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });

      try {
        await client.start();
        const oldSocket = FakeWebSocket.instances[0];

        oldSocket.emit('error', {});
        oldSocket.emit('error', {});
        oldSocket.emit('close', {});
        oldSocket.emit('close', {});
        await vi.advanceTimersByTimeAsync(2_000);

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(FakeWebSocket.instances).toHaveLength(2);
      } finally {
        client.stop();
        vi.useRealTimers();
      }
    });

    it('retires an errored socket and reconnects once even without a close event', async () => {
      vi.useFakeTimers();
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });

      try {
        await client.start();
        const erroredSocket = FakeWebSocket.instances[0];

        erroredSocket.emit('error', {});
        erroredSocket.emit('error', {});
        await vi.advanceTimersByTimeAsync(1_000);

        expect(erroredSocket.closed).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(FakeWebSocket.instances).toHaveLength(2);
      } finally {
        client.stop();
        vi.useRealTimers();
      }
    });

    /**
     * Live acceptance evidence: after exact 89592606 apply and the one
     * authorized restart, daemon PID 90384 completed at least two cycles of
     * "no traffic for 45000ms — forcing reconnect" followed by "connected".
     * The restart budget is consumed; this regression is transport-local.
     */
    it('post-restart regression: idle alone stays connected while transport close still recovers', async () => {
      vi.useFakeTimers();
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });

      try {
        await client.start();
        const socket = FakeWebSocket.instances[0];
        socket.emit('open', {});

        await vi.advanceTimersByTimeAsync(45_000);
        expect({
          closed: socket.closed,
          connectionOpenCalls: (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
          socketCount: FakeWebSocket.instances.length,
        }).toEqual({ closed: false, connectionOpenCalls: 1, socketCount: 1 });

        socket.close();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(FakeWebSocket.instances).toHaveLength(2);
      } finally {
        client.stop();
        vi.useRealTimers();
      }
    });

    it('does not let a stale connections.open failure replace a newer current socket', async () => {
      vi.useFakeTimers();
      let rejectStaleOpen!: (reason: Error) => void;
      const staleOpen = new Promise<never>((_resolve, reject) => {
        rejectStaleOpen = reject;
      });
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock
        .mockReset()
        .mockReturnValueOnce(staleOpen)
        .mockResolvedValue({
          json: async () => ({ ok: true, url: 'wss://example.com/current' }),
        });
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });

      try {
        const staleStart = client.start();
        client.stop();
        await client.start();
        const currentSocket = FakeWebSocket.instances[0];

        rejectStaleOpen(new Error('stale HTTP failure'));
        await staleStart;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(currentSocket.closed).toBe(false);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(FakeWebSocket.instances).toHaveLength(1);
      } finally {
        client.stop();
        vi.useRealTimers();
      }
    });

    it('keeps repeated disconnect, error, and close signals single-flight with one delivery', async () => {
      let resolveReplacement!: (response: { json: () => Promise<{ ok: boolean; url: string }> }) => void;
      const replacementOpen = new Promise<{ json: () => Promise<{ ok: boolean; url: string }> }>((resolve) => {
        resolveReplacement = resolve;
      });
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock
        .mockReset()
        .mockResolvedValueOnce({
          json: async () => ({ ok: true, url: 'wss://example.com/initial' }),
        })
        .mockReturnValueOnce(replacementOpen);
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
      const received: unknown[] = [];
      client.onMessage((event) => received.push(event));
      await client.start();

      const oldSocket = FakeWebSocket.instances[0];
      oldSocket.emitMessage({ type: 'disconnect', reason: 'too_many_websockets' });
      oldSocket.emit('error', {});
      oldSocket.emit('close', {});
      oldSocket.emitMessage({ type: 'disconnect', reason: 'too_many_websockets' });
      resolveReplacement({
        json: async () => ({ ok: true, url: 'wss://example.com/replacement' }),
      });
      await flushAsync();

      const currentSocket = FakeWebSocket.instances[1];
      const envelope = {
        envelope_id: 'one-delivery',
        type: 'events_api',
        payload: {
          team_id: 'T1',
          event: { type: 'message', channel: 'C1', user: 'U1', text: 'once', ts: '1.1' },
        },
      };
      oldSocket.emitMessage(envelope);
      currentSocket.emitMessage(envelope);

      expect({
        connectionOpenCalls: fetchMock.mock.calls.length,
        socketCount: FakeWebSocket.instances.length,
        oldClosed: oldSocket.closed,
        deliveries: received.length,
        oldAcks: oldSocket.sent.length,
        currentAcks: currentSocket.sent.length,
      }).toEqual({
        connectionOpenCalls: 2,
        socketCount: 2,
        oldClosed: true,
        deliveries: 1,
        oldAcks: 0,
        currentAcks: 1,
      });
      client.stop();
    });

    it('caps reconnect backoff at 30 seconds and cancels the pending timer on stop', async () => {
      vi.useFakeTimers();
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockRejectedValue(new Error('connections.open unavailable'));
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });

      try {
        await client.start();
        await vi.advanceTimersByTimeAsync(31_000);
        expect(fetchMock).toHaveBeenCalledTimes(6);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(fetchMock).toHaveBeenCalledTimes(6);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(7);

        client.stop();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        client.stop();
        vi.useRealTimers();
      }
    });

    it('a frame arriving on the OLD socket after a new connection is active is dropped, not processed', async () => {
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
      const received: unknown[] = [];
      client.onMessage((e) => received.push(e));
      await client.start();

      const oldSocket = FakeWebSocket.instances[0];
      oldSocket.emitMessage({ type: 'disconnect', reason: 'refresh_requested' });
      await flushAsync();
      expect(FakeWebSocket.instances).toHaveLength(2);

      // The old (now-superseded) socket receives one more frame before it
      // actually finishes closing — exactly the race warden flagged. This
      // MUST be dropped by the epoch guard, not delivered to handlers.
      oldSocket.emitMessage({
        envelope_id: 'stale-env',
        type: 'events_api',
        payload: {
          team_id: 'T1',
          event: { type: 'message', channel: 'C1', user: 'U1', text: 'stale', ts: '1.1' },
        },
      });

      expect(received).toEqual([]);
      // And it must not have even sent an ack — the frame was dropped
      // before doing anything, including the transport-level ack.
      expect(oldSocket.sent).toEqual([]);

      // The NEW socket, meanwhile, is fully live and processes normally.
      const newSocket = FakeWebSocket.instances[1];
      newSocket.emitMessage({
        envelope_id: 'live-env',
        type: 'events_api',
        payload: {
          team_id: 'T1',
          event: { type: 'message', channel: 'C1', user: 'U1', text: 'live', ts: '1.2' },
        },
      });
      expect(received).toHaveLength(1);
    });

    it("a close event on the OLD (superseded) socket does not trigger a second reconnect", async () => {
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
      await client.start();

      const oldSocket = FakeWebSocket.instances[0];
      oldSocket.emitMessage({ type: 'disconnect', reason: 'refresh_requested' });
      await flushAsync();
      expect(FakeWebSocket.instances).toHaveLength(2);

      // Slack now actually closes the old socket. Its close handler is
      // epoch-guarded and must NOT schedule yet another reconnect.
      oldSocket.close();
      // If a spurious reconnect were scheduled it would be via a real
      // setTimeout (reconnectAttempt backoff) — nothing to await
      // synchronously, but no THIRD socket should ever appear from this.
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('stop() retires the current socket and no reconnect follows its close', async () => {
      const client = new SlackSocketModeClient('xapp-1', { log: () => {} });
      await client.start();
      const socket = FakeWebSocket.instances[0];

      client.stop();
      expect(socket.closed).toBe(true);
      expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect socket appeared
    });
  });

  describe('WebSocket construction failure (analyst review — Node<22 has no global WebSocket)', () => {
    it('a throwing WebSocket constructor (e.g. ReferenceError: WebSocket is not defined) does not propagate out of start()', async () => {
      global.WebSocket = class {
        constructor() {
          throw new ReferenceError('WebSocket is not defined');
        }
      } as unknown as typeof WebSocket;

      const logs: string[] = [];
      const client = new SlackSocketModeClient('xapp-1', { log: (m) => logs.push(m) });

      // The whole point: start() must resolve, not reject/throw, even though
      // the underlying WebSocket constructor is fatal on this runtime.
      await expect(client.start()).resolves.toBeUndefined();
      expect(logs.some((l) => l.includes('WebSocket construction failed'))).toBe(true);
      expect(logs.some((l) => l.includes('Node >=22'))).toBe(true);

      // The failure path scheduled a real reconnect setTimeout — stop() so
      // it doesn't fire against a later test's global.WebSocket.
      client.stop();
    });
  });
});
