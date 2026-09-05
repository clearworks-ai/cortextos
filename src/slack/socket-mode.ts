/**
 * Slack Socket Mode client — inbound event delivery over a persistent
 * WebSocket, no public Request URL needed. Uses Node's native global
 * `WebSocket` (stable, unflagged since Node 22 — see package.json's
 * engines.node bump alongside this file). No external dependency: Slack's
 * wss:// URL from apps.connections.open is a one-time ticketed URL, so no
 * custom auth header is needed on the socket itself (unlike the REST calls
 * in api.ts, which do need the Bearer app-level token).
 *
 * Protocol shape (Slack's Socket Mode docs):
 *   1. POST apps.connections.open with the app-level (xapp-) token → a
 *      short-lived wss:// URL. Must be re-requested on every reconnect; the
 *      URL is single-use and expires.
 *   2. Server sends a `hello` frame once connected.
 *   3. Server sends `events_api` envelopes: `{envelope_id, type, payload}`.
 *      The client MUST ack by sending `{envelope_id}` back within ~3s or
 *      Slack redelivers the event (possibly over a new connection) — this is
 *      a transport-layer requirement, independent of whether the event was
 *      actually processed successfully downstream.
 *   4. Server may send a `disconnect` frame (reason: "warning" |
 *      "refresh_requested" | ...) before closing — the client should open a
 *      NEW connection proactively rather than wait for the close to avoid a
 *      gap in delivery.
 *   5. Ping/pong and dead-transport detection are handled at the WebSocket
 *      protocol level by the runtime. Inactivity alone is not a failure;
 *      actual close/error signals drive recovery.
 */

const CONNECTIONS_OPEN_URL = 'https://slack.com/api/apps.connections.open';
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export interface SlackSocketMessageEvent {
  type: 'message' | 'app_mention';
  /**
   * Workspace id the event belongs to (payload.team_id). Combined with
   * `user` as a composite identity key everywhere this event is checked
   * against an allowlist — Slack user ids are workspace-scoped, not
   * globally unique, so `user` alone is not a safe security key (warden
   * review, SP3b). Always present: every Socket Mode events_api envelope
   * carries team_id at the payload level.
   */
  team: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

export type SlackSocketMessageHandler = (event: SlackSocketMessageEvent) => void;

interface EventsApiEnvelope {
  envelope_id: string;
  type: 'events_api';
  payload: {
    // team_id lives on the payload, NOT nested inside payload.event — easy
    // to get wrong since every other field of interest is on payload.event.
    team_id: string;
    event: {
      type: string;
      subtype?: string;
      bot_id?: string;
      channel?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
    };
  };
}

interface DisconnectEnvelope {
  type: 'disconnect';
  reason?: string;
}

interface HelloEnvelope {
  type: 'hello';
}

type InboundFrame = EventsApiEnvelope | DisconnectEnvelope | HelloEnvelope | { type: string };

/**
 * Fetch a fresh Socket Mode WebSocket URL. Exported for tests — the real
 * connection flow always goes through this before opening a socket.
 */
export async function openConnectionUrl(appToken: string): Promise<string> {
  const res = await fetch(CONNECTIONS_OPEN_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appToken}` },
  });
  const json = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!json.ok || !json.url) {
    throw new Error(`slack apps.connections.open: ${json.error ?? 'no url returned'}`);
  }
  return json.url;
}

export class SlackSocketModeClient {
  private appToken: string;
  private messageHandlers: SlackSocketMessageHandler[] = [];
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private log: (msg: string) => void;

  /**
   * Reconnect-hygiene guard (warden review, SP3b): every socket this client
   * opens is stamped with the epoch that was current when it was created.
   * Every one of that socket's handlers re-checks `epoch === this.epoch`
   * before doing anything. When a replacement connection is opened, `epoch`
   * increments immediately — so the OLD socket's handlers become no-ops the
   * instant a newer connection exists, regardless of exactly when the old
   * socket's underlying 'message'/'close' events actually fire. This is a
   * positive invariant ("is my epoch still current"), not a "did teardown
   * run in the right order" assumption — the classic hand-rolled-reconnect
   * bug class is racing exactly that ordering.
   */
  private epoch = 0;

  constructor(appToken: string, options: { log?: (msg: string) => void } = {}) {
    if (!appToken) throw new Error('SlackSocketModeClient: appToken is required');
    this.appToken = appToken;
    this.log = options.log || ((msg) => console.log(`[slack-socket-mode] ${msg}`));
  }

  onMessage(handler: SlackSocketMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    this.epoch++; // retire whatever socket is currently open
    this.clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    this.clearReconnectTimer();
    const myEpoch = ++this.epoch; // retires any previously-open socket immediately
    const supersededSocket = this.ws;
    this.ws = null;
    supersededSocket?.close();

    let url: string;
    try {
      url = await openConnectionUrl(this.appToken);
    } catch (err) {
      this.log(`connections.open failed: ${(err as Error).message}`);
      if (myEpoch === this.epoch && this.running) this.scheduleReconnect();
      return;
    }

    // The epoch could have advanced again while awaiting the HTTP call above
    // (e.g. stop() was called, or a second reconnect raced in) — bail rather
    // than open a socket that would be immediately stale.
    if (myEpoch !== this.epoch || !this.running) return;

    let socket: WebSocket;
    try {
      // `new WebSocket(...)` throws synchronously — most notably a bare
      // `ReferenceError: WebSocket is not defined` if the runtime predates
      // Node 22 (analyst review, SP3b: the daemon's actual deployed Node
      // version isn't guaranteed to match package.json's engines floor).
      // Uncaught here, that exception propagates out of connect() and up
      // through start() to whatever awaits it — for the daemon's
      // orchestrator-only Socket Mode bootstrap, that would otherwise crash
      // agent startup entirely rather than degrade to "Slack inactive."
      socket = new WebSocket(url);
    } catch (err) {
      this.log(`WebSocket construction failed: ${(err as Error).message} — is this runtime on Node >=22?`);
      if (myEpoch === this.epoch && this.running) this.scheduleReconnect();
      return;
    }

    if (myEpoch !== this.epoch || !this.running) {
      socket.close();
      return;
    }

    socket.addEventListener('open', () => {
      if (myEpoch !== this.epoch || this.ws !== socket) return;
      this.reconnectAttempt = 0;
      this.log('connected');
    });

    socket.addEventListener('message', (ev: MessageEvent) => {
      if (myEpoch !== this.epoch || this.ws !== socket) return;
      this.handleFrame(socket, String(ev.data));
    });

    socket.addEventListener('close', () => {
      if (myEpoch !== this.epoch || this.ws !== socket) return;
      this.epoch++;
      this.ws = null;
      if (this.running) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (myEpoch !== this.epoch || this.ws !== socket) return;
      this.epoch++;
      this.ws = null;
      socket.close();
      if (this.running) this.scheduleReconnect();
    });

    this.ws = socket;
  }

  /**
   * Proactively open a replacement connection ahead of a server-initiated
   * disconnect. Bumping the epoch here (via connect()'s `++this.epoch`)
   * retires the current socket's handlers immediately — before the old
   * socket has actually closed — so a frame that arrives on the dying
   * connection in the gap between "disconnect requested" and "socket
   * actually closes" is silently dropped rather than processed twice.
   */
  private async reconnect(): Promise<void> {
    await this.connect();
  }

  private handleFrame(socket: WebSocket, raw: string): void {
    let frame: InboundFrame;
    try {
      frame = JSON.parse(raw) as InboundFrame;
    } catch {
      return; // not JSON — ignore
    }

    if (frame.type === 'hello') {
      return;
    }

    if (frame.type === 'disconnect') {
      this.log(`disconnect requested (reason: ${(frame as DisconnectEnvelope).reason ?? 'unknown'}) — opening replacement`);
      void this.reconnect();
      return;
    }

    if (frame.type === 'events_api') {
      const envelope = frame as EventsApiEnvelope;
      // Ack immediately — transport requirement, independent of downstream
      // processing outcome.
      try {
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      } catch {
        /* socket may have closed between message and ack — the event will
           be redelivered on reconnect, nothing further to do here */
      }
      this.dispatchEvent(envelope.payload.team_id, envelope.payload.event);
    }
  }

  private dispatchEvent(teamId: string, event: EventsApiEnvelope['payload']['event']): void {
    // Exclude bot-authored messages (subtype/bot_id present) to avoid the
    // bot reacting to its own or another bot's posts, and message_changed/
    // message_deleted subtypes which aren't new user input.
    if (event.subtype || event.bot_id) return;
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    if (!event.channel || !event.user || event.text === undefined || !event.ts) return;
    if (!teamId) return;

    const normalized: SlackSocketMessageEvent = {
      type: event.type,
      team: teamId,
      channel: event.channel,
      user: event.user,
      text: event.text,
      ts: event.ts,
      thread_ts: event.thread_ts,
    };
    for (const handler of this.messageHandlers) {
      try {
        handler(normalized);
      } catch (err) {
        this.log(`message handler error: ${(err as Error).message}`);
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
