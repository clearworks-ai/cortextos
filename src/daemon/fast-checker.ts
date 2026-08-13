import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { execFile } from 'child_process';
import { join } from 'path';
import { createHash } from 'crypto';
import { hardRestart } from '../bus/system.js';
import type { InboxMessage, BusPaths, TelegramMessage, TelegramCallbackQuery } from '../types/index.js';
import { checkInbox, ackInbox } from '../bus/message.js';
import { updateApproval } from '../bus/approval.js';
import { AgentProcess } from './agent-process.js';
import type { TelegramAPI } from '../telegram/api.js';
import { KEYS } from '../pty/inject.js';
import { stripControlChars, sanitizeForPtyInjection, wrapFenceSafe } from '../utils/validate.js';
import { agentHoldsContextHandoffLease, releaseContextHandoffLease, requestContextHandoffLease } from './context-handoff-lease.js';
import {
  detectWedge,
  DEFAULT_WEDGE_HEARTBEAT_FRESH_MS,
  DEFAULT_WEDGE_RESTART_COOLDOWN_MS,
} from './wedge-detector.js';

type LogFn = (msg: string) => void;

/**
 * Post-boot grace window (ms) during which soft context-handoff actions are
 * suppressed. Runtime-aware: codex-app-server and opencode briefly report
 * inflated prior prompt-cache context tokens, and that spurious spike can land
 * ~6-8min after a fresh boot (observed double-handoffs ~6-8min apart on a codex
 * agent), OUTSIDE a short grace. Those runtimes get a 10min window; all others
 * keep the original 2min.
 */
export function handoffGraceMs(runtime: string | undefined): number {
  if (runtime === 'codex-app-server' || runtime === 'opencode') return 600_000;
  return 120_000;
}

/**
 * Real context-window size (tokens) for a model id.
 *
 * ROOT-CAUSE FIX for restart churn: Claude Code's statusLine payload reports
 * `context_window_size = 200000` and computes `used_percentage = tokens / 200000`
 * EVEN ON 1M-context models. The daemon read that `used_percentage` and fired
 * warn/handoff/force-restart against it, so a 60% handoff threshold tripped at
 * ~120K real tokens (~12% of a real 1M window) → premature handoff → restart →
 * churn, while also fighting Claude Code's own native compaction of the real
 * window. We instead compute the percentage from the RAW token count against the
 * REAL model window resolved here.
 *
 * 1M-context models (and their `[1m]` variants) → 1_000_000. Everything else —
 * haiku-class and any model whose window we can't positively identify —
 * conservatively → 200_000 (matches CC's reported size, so behaviour is unchanged
 * for those). An absent model id (config.model unset → CC default) is treated as
 * 200_000 so we never OVER-estimate a window and suppress a genuine backstop.
 */
export function realContextWindow(model: string | undefined): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  // 1M-context generation. Match the family stems so `[1m]` suffixes, provider
  // prefixes (e.g. `us.anthropic.`), and date/point revisions all resolve.
  if (
    m.includes('sonnet-5')
    || m.includes('opus-5')
    || m.includes('opus-4-8')
    || m.includes('fable-5')
  ) {
    return 1_000_000;
  }
  // Haiku-class and everything else: keep CC's 200K assumption.
  return 200_000;
}

/**
 * Dedup hash TTL and count cap. TTL is the primary eviction rule — a hash
 * older than this is no longer treated as a duplicate. The count cap is a
 * backstop against unbounded growth if TTL alone lets too many live hashes
 * accumulate inside the window (was a bare count-1000 cap with no TTL at all,
 * which let count-based eviction re-enable duplicate sends on high-volume
 * days regardless of how fresh the evicted hash actually was).
 */
export const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEDUP_MAX_ENTRIES = 5000;

/**
 * Fast message checker for a single agent.
 * Replaces fast-checker.sh: polls Telegram and inbox, injects into PTY.
 */
export class FastChecker {
  private agent: AgentProcess;
  private paths: BusPaths;
  private running: boolean = false;
  private pollInterval: number;
  private log: LogFn;
  private typingLastSent: number = 0;
  // Hook-based typing: track when we last injected a Telegram message (ms)
  private lastMessageInjectedAt: number = 0;
  // Track outbound message log size to detect when agent sends a reply
  private outboundLogSize: number = 0;
  // Track stdout log size to detect when agent is actively producing output
  private stdoutLogSize: number = -1;
  private frameworkRoot: string;
  private telegramApi?: TelegramAPI;
  private chatId?: string;
  private allowedUserId?: number;

  // External Telegram handler (set by daemon)
  private telegramMessages: Array<{ formatted: string; ackIds: string[] }> = [];
  // Disk copy of the pending Telegram queue. Telegram advances its server-side
  // offset the instant a message is queued (the poller handler just pushes into
  // telegramMessages and returns), so Telegram never redelivers — this file is
  // the ONLY surviving copy of a not-yet-injected message across a daemon restart.
  private pendingTelegramFilePath: string = '';

  // External Slack handler (set by daemon's Slack dispatcher). Deliberately
  // a separate queue from telegramMessages, not a shared one: draining it
  // must NOT touch lastMessageInjectedAt, which drives the Telegram typing
  // indicator — Slack traffic has no equivalent indicator and mixing the
  // two would restart/extend a Telegram typing indicator for Slack-only
  // activity.
  private slackMessages: string[] = [];

  // Persistent dedup: message hashes to prevent duplicate delivery
  // Persistent dedup: message hash -> last-seen timestamp (ms)
  private seenHashes: Map<string, number> = new Map();
  private dedupFilePath: string = '';

  // SIGUSR1 wake: resolve to immediately wake from sleep
  private wakeResolve: (() => void) | null = null;

  // Idle-session heartbeat watchdog
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Wedge watchdog: timestamp (ms) of the last wedge-restart we fired for this
  // agent. Storm guard — we refuse to wedge-restart the same agent more than
  // once per DEFAULT_WEDGE_RESTART_COOLDOWN_MS. 0 = never fired.
  private wedgeLastRestartAt: number = 0;

  // Context monitor state
  private ctxConfigMtime: number = 0;
  private ctxWarningFiredAt: number = 0;    // dedup: 15min cooldown between warnings
  private ctxHandoffFiredAt: number = 0;    // fires once per session (0 = not yet)
  private ctxHandoffDeadlineAt: number = 0; // timestamp after which force-restart fires
  private ctxLastSessionId: string | null = null; // detects new session → clears stale deadline
  private ctxSessionStartedAt: number = 0; // when current session_id was first observed — handoff grace window anchor
  private ctxHandoffLeaseId: string | null = null;
  private ctxHandoffQueuedLogAt: number = 0;
  private ctxCircuitRestarts: number[] = []; // timestamps of recent context-triggered restarts
  private ctxHandoffFires: number[] = [];    // timestamps of recent Tier-2 handoff fires (cooperative-restart loop backstop)
  private ctxCircuitBrokenAt: number | null = null; // when circuit tripped (null = healthy)
  // Persisted to disk so --continue restarts don't reset the circuit breaker
  private ctxCircuitFile: string = '';

  constructor(
    agent: AgentProcess,
    paths: BusPaths,
    frameworkRoot: string,
    options: { pollInterval?: number; log?: LogFn; telegramApi?: TelegramAPI; chatId?: string; allowedUserId?: number } = {},
  ) {
    this.agent = agent;
    this.paths = paths;
    this.frameworkRoot = frameworkRoot;
    this.pollInterval = options.pollInterval || 1000;
    this.log = options.log || ((msg) => console.log(`[fast-checker/${agent.name}] ${msg}`));
    this.telegramApi = options.telegramApi;
    this.chatId = options.chatId;
    this.allowedUserId = options.allowedUserId;

    // Initialize persistent dedup
    this.dedupFilePath = join(paths.stateDir, '.message-dedup-hashes');
    this.loadDedupHashes();

    // Replay any Telegram messages that were queued but never delivered before
    // this session started (agent-down window + daemon restart).
    this.pendingTelegramFilePath = join(paths.stateDir, '.pending-telegram-queue.json');
    this.loadPendingTelegram();

    // Load persisted circuit breaker state so --continue restarts don't reset it
    this.ctxCircuitFile = join(paths.stateDir, '.ctx-circuit.json');
    this.loadCtxCircuit();
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.log('Starting. Waiting for bootstrap...');

    // Register SIGUSR1 handler for immediate wake
    const sigusr1Handler = () => {
      this.log('SIGUSR1 received - waking immediately');
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
    };
    if (process.platform !== 'win32') {
      process.on('SIGUSR1', sigusr1Handler);
    }

    // Wait for bootstrap
    await this.waitForBootstrap();
    this.log('Bootstrap complete. Beginning poll loop.');

    // Idle-session heartbeat watchdog: fires every 50 min regardless of REPL state
    const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1000;
    const agentName = this.agent.name;
    this.heartbeatTimer = setInterval(() => {
      const ts = new Date().toISOString();
      execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      });
    }, HEARTBEAT_INTERVAL_MS);

    while (this.running) {
      try {
        // Check for urgent signal file
        this.checkUrgentSignal();
        await this.pollCycle();
      } catch (err) {
        this.log(`Poll error: ${err}`);
      }
      await this.sleepInterruptible(this.pollInterval);
    }

    if (process.platform !== 'win32') {
      process.removeListener('SIGUSR1', sigusr1Handler);
    }
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Trigger immediate wake from sleep.
   * Cross-platform alternative to SIGUSR1, called by IPC 'wake' command.
   */
  wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /**
   * Queue a formatted Telegram message for injection.
   * Called by the daemon's Telegram handler.
   */
  queueTelegramMessage(formatted: string): void {
    this.telegramMessages.push({ formatted, ackIds: [] });
    this.savePendingTelegram();
  }

  /**
   * Queue a formatted Slack message for injection.
   * Called by the daemon's Slack Socket Mode dispatcher.
   */
  queueSlackMessage(formatted: string): void {
    this.slackMessages.push(formatted);
  }

  /**
   * Single poll cycle: check inbox + queued Telegram messages.
   */
  private async pollCycle(): Promise<void> {
    let messageBlock = '';
    const ackIds: string[] = [];

    // Process queued Telegram messages — PEEK, do not drain here.
    // A destructive shift() dropped messages permanently whenever injection
    // failed (agent NOT_RUNNING mid-restart): there was no else branch and no
    // re-queue, so the loss happened in-process, no daemon restart required.
    // Build the block from a snapshot of the current queue and only remove those
    // entries AFTER injection is confirmed (below). Anything queued during the
    // inject stays past `pendingCount` and is preserved.
    const pendingCount = this.telegramMessages.length;
    let hasTelegramMessage = false;
    for (let i = 0; i < pendingCount; i++) {
      messageBlock += this.telegramMessages[i].formatted;
      hasTelegramMessage = true;
    }

    // Process queued Slack messages. Deliberately does NOT set
    // hasTelegramMessage / lastMessageInjectedAt — see slackMessages'
    // declaration for why the typing-indicator timer must stay
    // Telegram-only.
    while (this.slackMessages.length > 0) {
      messageBlock += this.slackMessages.shift()!;
    }

    // Check agent inbox
    const inboxMessages = checkInbox(this.paths);
    for (const msg of inboxMessages) {
      messageBlock += this.formatInboxMessage(msg);
      ackIds.push(msg.id);
    }

    // Inject if there's anything
    if (messageBlock) {
      const injected = this.agent.injectMessage(messageBlock);
      if (injected) {
        // Delivery confirmed — NOW drain the telegram messages we consumed
        // (only the peeked prefix) and persist the shortened queue.
        if (pendingCount > 0) {
          this.telegramMessages.splice(0, pendingCount);
          this.savePendingTelegram();
        }
        // ACK inbox messages
        for (const id of ackIds) {
          ackInbox(this.paths, id);
        }
        this.log(`Injected ${messageBlock.length} bytes`);
        // Only update typing timestamp for Telegram messages, not inbox/cron.
        // Inbox messages (agent-to-agent, session continuations) must not
        // restart the typing indicator after Stop has cleared it.
        if (hasTelegramMessage) {
          this.lastMessageInjectedAt = Date.now();
        }
        // Cooldown after injection
        await sleep(5000);
      }
      // Injection failed (agent NOT_RUNNING or DEDUPED): telegram messages stay
      // in this.telegramMessages (and on disk) and inbox stays un-ack'd — both
      // retry on the next pollCycle once the agent is back up.
    }

    // Typing indicator: send while Claude is actively working
    if (this.chatId && this.telegramApi && this.isAgentActive()) {
      await this.sendTyping(this.telegramApi, this.chatId);
    }

    // Context monitor: check usage thresholds and fire warnings/handoffs
    await this.checkContextStatus();

    // Wedge watchdog: detect a stuck REPL (stale conversation buffer while the
    // heartbeat stays fresh + pending inbox work) and force ONE recovery restart.
    this.checkWedge();
  }

  /**
   * Wedge watchdog — called on every poll cycle.
   *
   * Classifies the agent as WEDGED when its conversation buffer has gone stale
   * (no processed turns for wedge_restart_min) while heartbeat.json stays fresh
   * AND there is pending inbox work — i.e. the REPL is stuck, not idle. Routes a
   * WEDGED verdict to forceWedgeRestart(). All the file reads are best-effort;
   * any error leaves the agent untouched (fail-safe: never restart on a read
   * glitch).
   *
   * Exposed as a plain method (not folded into pollCycle) so its decision path
   * is easy to trace; the actual decision lives in the pure detectWedge().
   */
  private checkWedge(): void {
    try {
      this.checkWedgeInner();
    } catch (err) {
      // Fail-safe: any read/accessor glitch leaves the agent untouched. A wedge
      // watchdog must NEVER restart on its own error — a false wedge-restart is
      // worse than a missed one (the buffer will still be stale next cycle).
      this.log(`Wedge check error (ignored): ${err}`);
    }
  }

  private checkWedgeInner(): void {
    const config = this.agent.getConfig();
    // Resolve the buffer-staleness threshold. Unset wedge_restart_min = disabled
    // (opt-in only). An agent must explicitly set a positive value to enable the
    // watchdog — the conversation buffer is only touched on outbound Telegram
    // sends, so a long silent working stretch would otherwise be false-restarted
    // (see AgentConfig.wedge_restart_min JSDoc). An explicit <= 0 also disables.
    // detectWedge treats a non-positive bufferStaleThresholdMs as disabled, so we
    // can pass the raw computed value straight through.
    // Runtime-keyed default: codex-app-server agents get the wedge net armed at 20min
    // even when config.json omits wedge_restart_min. This is the buffer-staleness
    // backstop for the context-full silent-death (no turns completing → stale buffer,
    // while the 50-min heartbeat watchdog keeps heartbeat.json fresh → false health).
    // It catches any silent stall the primary context_full signal misses (e.g. the
    // app-server emits a differently-worded error, or stalls without an error at all).
    // An EXPLICIT wedge_restart_min in config still wins (including an explicit <= 0
    // opt-out); only an UNSET value inherits this default, and only for codex.
    const codexWedgeDefault =
      config.runtime === 'codex-app-server' && config.wedge_restart_min === undefined
        ? 20
        : 0;
    const wedgeMin = config.wedge_restart_min ?? codexWedgeDefault;
    const bufferStaleThresholdMs = wedgeMin * 60_000;
    if (bufferStaleThresholdMs <= 0) return; // disabled — skip the file reads entirely

    const now = Date.now();
    const bufferMtime = this.mtimeMsOrNull(join(this.paths.stateDir, 'conversation-buffer.jsonl'));
    const heartbeatMtime = this.mtimeMsOrNull(join(this.paths.stateDir, 'heartbeat.json'));

    const decision = detectWedge({
      nowMs: now,
      conversationBufferMtimeMs: bufferMtime,
      heartbeatMtimeMs: heartbeatMtime,
      hasPendingWork: this.hasPendingInboxWork(),
      agentRunning: this.agent.isRunning(),
      restartInFlight: this.agent.isRestartInFlight(),
      lastWedgeRestartAtMs: this.wedgeLastRestartAt,
      bufferStaleThresholdMs,
      heartbeatFreshThresholdMs: DEFAULT_WEDGE_HEARTBEAT_FRESH_MS,
      restartCooldownMs: DEFAULT_WEDGE_RESTART_COOLDOWN_MS,
    });

    if (decision.wedged) {
      this.forceWedgeRestart(
        `conversation buffer stale ${Math.round(decision.bufferAgeMs / 60_000)}min `
        + `(heartbeat fresh ${Math.round(decision.heartbeatAgeMs / 1000)}s ago) with pending inbox work`,
      );
    }
  }

  /**
   * Return a file's mtime in ms, or null if it does not exist / is unreadable.
   * A missing file is a meaningful signal for the wedge detector (no buffer yet =
   * first boot; no heartbeat = down), so null is distinguished from an mtime.
   */
  private mtimeMsOrNull(path: string): number | null {
    try {
      if (!existsSync(path)) return null;
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Non-destructive check for pending inbox work. checkInbox() MOVES messages to
   * inflight, so it cannot be used here — the wedge detector must not consume the
   * inbox. Count .json files in both the inbox and inflight dirs directly: a
   * message sitting in inflight that the wedged REPL never ack'd is exactly the
   * "pending work the agent is failing to process" signal we want.
   */
  private hasPendingInboxWork(): boolean {
    for (const dir of [this.paths.inbox, this.paths.inflight]) {
      try {
        const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
        if (files.length > 0) return true;
      } catch {
        // dir may not exist yet — treat as no work from this dir
      }
    }
    return false;
  }

  /**
   * Force a recovery restart for a WEDGED agent.
   *
   * A wedge-restart is a RECOVERY (like a planned context handoff), NOT a crash:
   *   - It does NOT touch ctxCircuitRestarts / the context circuit breaker, and
   *     does NOT go through the crash limiter — those exist to stop RESTART
   *     STORMS from repeated FAILURES, and a wedge-restart is a single deliberate
   *     recovery, storm-guarded on its own (wedgeLastRestartAt + cooldown).
   *   - It emits NO Telegram ping (silent recovery — no user-facing spam).
   *   - It goes through sessionRefresh() → start(), inheriting the #269
   *     single-flight guard, so it can never spawn a duplicate PTY. detectWedge
   *     also refuses when a restart is already in flight, a second guard layer.
   */
  private forceWedgeRestart(reason: string): void {
    const now = Date.now();
    // Stamp BEFORE kicking the restart so the storm guard is armed even if the
    // restart itself is slow — the next poll cycle sees the cooldown immediately.
    this.wedgeLastRestartAt = now;
    this.log(`WEDGE detected — force restarting (recovery, not counted as crash): ${reason}`);

    // Pre-arm a fresh session: a wedged REPL's --continue history is suspect, and
    // a clean fresh boot is the reliable recovery. hardRestart writes the planned
    // markers so the crash-alert hook classifies this as a planned restart, not a
    // crash (no false crash ping, no crash-count increment).
    hardRestart(this.paths, this.agent.name, `WEDGE-FORCE-RESTART: ${reason}`);
    try {
      writeFileSync(join(this.paths.stateDir, '.force-fresh'), '');
    } catch { /* non-fatal — restart still recovers, just may --continue */ }

    // sessionRefresh() does stop() + start(); .force-fresh makes shouldContinue()
    // false for a clean fresh session. start()'s single-flight guard ensures no
    // duplicate spawn even if another trigger races this.
    this.agent.sessionRefresh().catch(err => this.log(`Wedge restart failed: ${err}`));
  }

  /**
   * Format an inbox message for injection.
   * Matches bash fast-checker.sh format exactly.
   */
  private formatInboxMessage(msg: InboxMessage): string {
    const replyNote = msg.reply_to ? ` [reply_to: ${msg.reply_to}]` : '';
    // msg.text/from are externally influenced (a body can carry its own
    // fence/header markers; --body-stdin/--body-file made arbitrary bodies easy
    // to send). The body is wrapped with wrapFenceSafe — a dynamically-sized
    // fence the body cannot close, with the body left byte-exact so pasted code
    // blocks stay readable. The inline `from` is collapse-sanitized (it sits in
    // the header line, not a fence).
    const safeFrom = sanitizeForPtyInjection(msg.from);
    return `=== AGENT MESSAGE from ${safeFrom}${replyNote} [msg_id: ${msg.id}] ===
${wrapFenceSafe(msg.text)}
Reply using: cortextos bus send-message ${safeFrom} normal '<your reply>' ${msg.id}

`;
  }

  /**
   * Format a Telegram text message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramTextMessage(
    from: string,
    chatId: string | number,
    text: string,
    frameworkRoot: string,
    replyToText?: string,
    lastSentText?: string,
    recentHistory?: string,
  ): string {
    // Every externally-influenced field below is untrusted (the sender controls
    // text/display-name; reply-context, last-sent and recent-history are built
    // from prior external messages). Sanitize each so none can escape the fence
    // or forge a containment header. Unfenced context fields (reply/history) are
    // the weakest surface — they sit raw in [Replying to: "..."] / [Recent ...].
    const replyCx = FastChecker.formatReplyContext(replyToText);

    let lastSentCtx = '';
    if (lastSentText) {
      lastSentCtx = `[Your last message: "${sanitizeForPtyInjection(lastSentText.slice(0, 500))}"]\n`;
    }

    let historyCx = '';
    if (recentHistory) {
      historyCx = `[Recent conversation:]\n${sanitizeForPtyInjection(recentHistory)}\n`;
    }

    // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
    // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
    // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
    // Non-slash bodies use wrapFenceSafe: an unescapable dynamically-sized fence
    // that leaves the body byte-exact (legit code blocks preserved). Slash commands
    // get control-char strip + header-quote only (no fence — must stay invokable).
    const isSlashCommand = /^\/[a-zA-Z]/.test(stripControlChars(text).trim());
    const body = isSlashCommand
      ? sanitizeForPtyInjection(text).trim()
      : wrapFenceSafe(text);
    return `=== TELEGRAM from [USER: ${sanitizeForPtyInjection(from)}] (chat_id:${chatId}) ===
${replyCx}${historyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Slack text message for injection. Same sanitization posture as
   * formatTelegramTextMessage (the sender/display-name is untrusted, the
   * body is untrusted) — see that method's docblock for the reasoning,
   * unchanged here. `agentName` threads the `--as` flag so the reply
   * command posts under the correct per-agent Slack identity
   * (loadSlackIdentity).
   */
  static formatSlackTextMessage(
    from: string,
    channel: string,
    text: string,
    agentName: string,
  ): string {
    const isSlashCommand = /^\/[a-zA-Z]/.test(stripControlChars(text).trim());
    const body = isSlashCommand
      ? sanitizeForPtyInjection(text).trim()
      : wrapFenceSafe(text);
    return `=== SLACK from [USER: ${sanitizeForPtyInjection(from)}] (channel:${sanitizeForPtyInjection(channel)}) ===
${body}
Reply using: cortextos slack send ${channel} '<your reply>' --as ${agentName}

`;
  }

  /**
   * Format a Telegram message_reaction update for PTY injection.
   * Reactions are emoji additions/removals on existing messages — they
   * surface to the agent so it can follow up on positive acknowledgements
   * or clarify after a negative reaction.
   *
   * `newReaction` is the current reaction state (an empty list means the
   * user REMOVED their reaction). `oldReaction` lets the formatter
   * distinguish "added X" from "removed Y". Custom emoji (type=custom_emoji)
   * render as [custom_emoji] since we don't resolve the custom_emoji_id.
   */
  static formatTelegramReaction(
    from: string,
    chatId: string | number,
    messageId: number,
    oldReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
    newReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
  ): string {
    const render = (list: typeof newReaction): string =>
      list.length === 0
        ? '(none)'
        : list.map((r) => (r.type === 'emoji' ? r.emoji : '[custom_emoji]')).join(' ');

    const removed = newReaction.length === 0 && oldReaction.length > 0;
    const label = removed ? `removed ${render(oldReaction)}` : render(newReaction);

    // sanitizeForPtyInjection matches the 5 sibling formatTelegram* paths (#606 residual): the caller's
    // stripControlChars deliberately keeps \n/\r, so a raw display-name could forge a `=== TELEGRAM ===`
    // containment header (#592/#597 class). Sanitize at the boundary, not the caller.
    return `=== REACTION from [USER: ${sanitizeForPtyInjection(from)}] (chat_id:${chatId}) on message ${messageId}: ${label} ===

`;
  }

  /**
   * Format a Telegram photo message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramPhotoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    imagePath: string,
    replyToText?: string,
  ): string {
    return `=== TELEGRAM PHOTO from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
${FastChecker.formatReplyContext(replyToText)}caption:
${wrapFenceSafe(caption)}
local_file: ${imagePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram document message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramDocumentMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
    replyToText?: string,
  ): string {
    return `=== TELEGRAM DOCUMENT from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
${FastChecker.formatReplyContext(replyToText)}caption:
${wrapFenceSafe(caption)}
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram voice/audio message for injection.
   * Matches bash fast-checker.sh format.
   *
   * `transcript` is populated by `src/telegram/transcribe.ts` when whisper-cli
   * and the GGML model are available; otherwise it stays undefined and the
   * agent receives only the .ogg path. The codex extractor surfaces the
   * transcript block when present.
   */
  static formatTelegramVoiceMessage(
    from: string,
    chatId: string | number,
    filePath: string,
    duration: number | undefined,
    transcript?: string,
    replyToText?: string,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    const transcriptBlock = transcript && transcript.trim()
      ? `transcript:\n${wrapFenceSafe(transcript.trim())}\n`
      : '';
    return `=== TELEGRAM VOICE from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
${FastChecker.formatReplyContext(replyToText)}duration: ${dur}s
local_file: ${filePath}
${transcriptBlock}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram video/video_note message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVideoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
    duration: number | undefined,
    replyToText?: string,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VIDEO from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
${FastChecker.formatReplyContext(replyToText)}caption:
${wrapFenceSafe(caption)}
duration: ${dur}s
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  private static formatReplyContext(replyToText?: string): string {
    return replyToText
      ? `[Replying to: "${sanitizeForPtyInjection(replyToText.slice(0, 500))}"]\n`
      : '';
  }

  /**
   * Wait for the agent to finish bootstrapping.
   */
  private async waitForBootstrap(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.agent.isBootstrapped()) {
        return;
      }
      await sleep(2000);
    }
    this.log('Bootstrap timeout - proceeding anyway');
  }

  /**
   * Send typing indicator, rate-limited to once every 4 seconds.
   */
  private async sendTyping(api: TelegramAPI, chatId: string): Promise<void> {
    const now = Date.now();
    if (now - this.typingLastSent >= 4000) {
      try {
        await api.sendChatAction(chatId, 'typing');
      } catch {
        // Ignore typing indicator failures (matches bash: || true)
      }
      this.typingLastSent = now;
    }
  }

  /**
   * Read the last-sent message file for conversation context.
   * Returns the content (up to 500 chars) or null if not available.
   */
  static readLastSent(stateDir: string, chatId: string | number): string | null {
    const filePath = join(stateDir, `last-telegram-${chatId}.txt`);
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8');
      if (!content) return null;
      return content.slice(0, 500);
    } catch {
      return null;
    }
  }

  /**
   * Handle a callback from the org's activity-channel bot.
   *
   * Runs alongside the agent's primary bot callback handler when the agent
   * is the org's orchestrator (see agent-manager.ts for the wiring). Only
   * appr_(allow|deny)_<approvalId> prefixes are accepted here — the
   * activity-channel bot only ever posts approval buttons, so any other
   * callback is rejected. The responding API must be the activity-channel
   * API (not the agent's own bot) so answerCallbackQuery + editMessageText
   * target the right message on the right bot.
   */
  async handleActivityCallback(query: TelegramCallbackQuery, activityApi: TelegramAPI): Promise<void> {
    const data = stripControlChars(query.data || '');
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Identical
    // check to handleCallback — approval clicks are as sensitive as
    // permission clicks and the same gate applies.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: activity-channel callback from unauthorized user ${fromUserId} - rejecting`);
        try { await activityApi.answerCallbackQuery(callbackQueryId, 'Not authorized'); } catch { /* ignore */ }
        return;
      }
    }

    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (!apprMatch) {
      this.log(`activity-channel callback ignored (unknown prefix): ${data.slice(0, 40)}`);
      try { await activityApi.answerCallbackQuery(callbackQueryId, 'Unknown button'); } catch { /* ignore */ }
      return;
    }

    await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, activityApi);
  }

  /**
   * Shared approval-callback resolution path. Called by both handleCallback
   * (agent's own bot) and handleActivityCallback (activity-channel bot).
   *
   * Resolves the approval via updateApproval (which moves the file from
   * pending/ to resolved/ and notifies the requesting agent via inbox),
   * answers the Telegram callback so the spinner stops, and edits the
   * original message to show who approved/denied for the audit trail.
   *
   * `api` is the TelegramAPI that owns the bot the callback came from —
   * answerCallbackQuery and editMessageText must target the same bot.
   */
  private async routeApprovalCallback(
    decision: 'allow' | 'deny',
    approvalId: string,
    query: TelegramCallbackQuery,
    api: TelegramAPI | undefined,
  ): Promise<void> {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;
    const status = decision === 'allow' ? 'approved' : 'rejected';

    // Build a friendly audit-trail suffix: "by Alice (@alice)" or just
    // "by Alice" if no username. Falls back to the Telegram user id if
    // both are missing (shouldn't happen in practice but guards edge).
    const firstName = query.from?.first_name;
    const username = query.from?.username;
    const auditWho = firstName && username
      ? `${firstName} (@${username})`
      : firstName ?? (username ? `@${username}` : `user ${query.from?.id ?? 'unknown'}`);
    const auditNote = `via Telegram activity channel by ${auditWho}`;

    try {
      updateApproval(this.paths, approvalId, status, auditNote);
    } catch (err) {
      this.log(`Approval callback: updateApproval failed for ${approvalId}: ${err}`);
      if (api) {
        try { await api.answerCallbackQuery(callbackQueryId, 'Approval not found or already resolved'); } catch { /* ignore */ }
      }
      return;
    }

    if (api) {
      try { await api.answerCallbackQuery(callbackQueryId, decision === 'allow' ? 'Approved' : 'Denied'); } catch { /* ignore */ }
      if (chatId && messageId) {
        const label = decision === 'allow' ? `✅ Approved by ${auditWho}` : `❌ Denied by ${auditWho}`;
        try { await api.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
      }
    }
    this.log(`Approval callback: ${decision} for ${approvalId} by ${auditWho}`);
  }

  /**
   * Handle a Telegram inline button callback query.
   * Routes to permission, restart, or AskUserQuestion handlers.
   */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const data = stripControlChars(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Without this,
    // anyone who sees a button (forwarded message, group, etc.) could click it.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: callback from unauthorized user ${fromUserId} - rejecting`);
        return;
      }
    }

    // Approval callbacks: appr_(allow|deny)_{approvalId}
    // These originate from the org's activity channel bot (see
    // handleActivityCallback) but may also arrive here if an operator
    // ever routes an approval button through the agent's own bot. The
    // prefix check is cheap and routing-agnostic.
    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (apprMatch) {
      await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, this.telegramApi);
      return;
    }

    // Permission callbacks: perm_(allow|deny|continue)_{hexId}
    const permMatch = data.match(/^perm_(allow|deny|continue)_([a-f0-9]+)$/);
    if (permMatch) {
      const [, decision, hexId] = permMatch;
      const hookDecision = decision === 'continue' ? 'deny' : decision;
      const responseFile = join(this.paths.stateDir, `hook-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision: hookDecision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const labelMap: Record<string, string> = { allow: 'Approved', deny: 'Denied', continue: 'Continue in Chat' };
          try { await this.telegramApi.editMessageText(chatId, messageId, labelMap[decision] || decision); } catch { /* ignore */ }
        }
      }
      this.log(`Permission callback: ${decision} for ${hexId}`);
      return;
    }

    // Restart callbacks: restart_(allow|deny)_{hexId}
    const restartMatch = data.match(/^restart_(allow|deny)_([a-f0-9]+)$/);
    if (restartMatch) {
      const [, decision, hexId] = restartMatch;
      const responseFile = join(this.paths.stateDir, `restart-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const label = decision === 'allow' ? 'Restart Approved' : 'Restart Denied';
          try { await this.telegramApi.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
        }
      }
      this.log(`Restart callback: ${decision} for ${hexId}`);
      return;
    }

    // AskUserQuestion single-select: askopt_{questionIdx}_{optionIdx}
    const askoptMatch = data.match(/^askopt_(\d+)_(\d+)$/);
    if (askoptMatch) {
      const qIdx = parseInt(askoptMatch[1], 10);
      const oIdx = parseInt(askoptMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Answered'); } catch { /* ignore */ }
        }
      }

      // Navigate TUI: Down * oIdx, then Enter
      for (let k = 0; k < oIdx; k++) {
        this.agent.write(KEYS.DOWN);
        await sleep(50);
      }
      await sleep(100);
      this.agent.write(KEYS.ENTER);

      this.log(`AskUserQuestion: Q${qIdx} selected option ${oIdx}`);

      // Check for more questions
      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // AskUserQuestion multi-select toggle: asktoggle_{questionIdx}_{optionIdx}
    const toggleMatch = data.match(/^asktoggle_(\d+)_(\d+)$/);
    if (toggleMatch) {
      const qIdx = parseInt(toggleMatch[1], 10);
      const oIdx = parseInt(toggleMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Toggled'); } catch { /* ignore */ }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          if (!state.multi_select_chosen) state.multi_select_chosen = [];

          const idx = state.multi_select_chosen.indexOf(oIdx);
          if (idx === -1) {
            state.multi_select_chosen.push(oIdx);
          } else {
            state.multi_select_chosen.splice(idx, 1);
          }
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Update Telegram message with current selections
          if (this.telegramApi && chatId && messageId) {
            const chosen = [...state.multi_select_chosen].sort((a: number, b: number) => a - b);
            const chosenDisplay = chosen.map((i: number) => i + 1).join(', ');
            const question = state.questions?.[qIdx];
            const options: string[] = question?.options || [];

            // Build keyboard with toggle buttons + submit
            const keyboard: Array<Array<{ text: string; callback_data: string }>> = options.map((opt: string, i: number) => [{
              text: opt || `Option ${i + 1}`,
              callback_data: `asktoggle_${qIdx}_${i}`,
            }]);
            keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${qIdx}` }]);

            const text = chosenDisplay
              ? `Selected: ${chosenDisplay}\nTap more options or Submit`
              : 'Tap options to toggle, then tap Submit';

            try {
              await this.telegramApi.editMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
            } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      this.log(`AskUserQuestion: Q${qIdx} toggled option ${oIdx}`);
      return;
    }

    // AskUserQuestion multi-select submit: asksubmit_{questionIdx}
    const submitMatch = data.match(/^asksubmit_(\d+)$/);
    if (submitMatch) {
      const qIdx = parseInt(submitMatch[1], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Submitted'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Submitted'); } catch { /* ignore */ }
        }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const chosenIndices: number[] = [...(state.multi_select_chosen || [])].sort((a, b) => a - b);
          const question = state.questions?.[qIdx];
          const totalOpts = question?.options?.length || 4;

          // Navigate TUI: for each chosen index, move Down from current position, press Space
          let currentPos = 0;
          for (const idx of chosenIndices) {
            const moves = idx - currentPos;
            for (let k = 0; k < moves; k++) {
              this.agent.write(KEYS.DOWN);
              await sleep(50);
            }
            this.agent.write(KEYS.SPACE);
            await sleep(50);
            currentPos = idx;
          }

          // Navigate to Submit button (past all options + 1 for "Other")
          const submitPos = totalOpts + 1;
          const remaining = submitPos - currentPos;
          for (let k = 0; k < remaining; k++) {
            this.agent.write(KEYS.DOWN);
            await sleep(50);
          }
          await sleep(100);
          this.agent.write(KEYS.ENTER);

          this.log(`AskUserQuestion: Q${qIdx} submitted multi-select`);

          // Reset multi_select_chosen
          state.multi_select_chosen = [];
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Check for more questions
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // Inject unhandled callbacks as a Telegram message so the agent can process custom button flows.
    // senderName (Telegram first_name) and callback_data are untrusted: sanitize both against
    // PTY-injection before interpolating, matching the text path (sanitizeForPtyInjection at the
    // `=== TELEGRAM from [USER: ...]` header). This block predates #592; #592's hardening was never
    // retrofitted here, leaving forged `=== AGENT MESSAGE`/fence-breakout headers un-neutralized.
    if (chatId && this.agent) {
      const senderName = sanitizeForPtyInjection(query.from?.first_name || 'User');
      const safeData = sanitizeForPtyInjection(data);
      const msg = [
        `=== TELEGRAM from [USER: ${senderName}] (chat_id:${chatId}) ===`,
        `callback_data: ${safeData}`,
        `message_id: ${messageId}`,
        `Reply using: cortextos bus send-telegram ${chatId} '<your reply>'`,
      ].join('\n');
      const injected = this.agent.injectMessage(msg);
      if (injected && this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
      }
      this.log(`Injected unhandled callback to agent: ${data.slice(0, 60)}`);
    } else {
      this.log(`Unhandled callback data (no agent/chatId): ${data}`);
    }
  }

  /**
   * Send the next AskUserQuestion to Telegram.
   * Reads ask-state.json and builds the question message and inline keyboard.
   */
  async sendNextQuestion(questionIdx: number): Promise<void> {
    if (!this.telegramApi || !this.chatId) {
      this.log('sendNextQuestion: no Telegram API or chatId configured');
      return;
    }

    const askStatePath = join(this.paths.stateDir, 'ask-state.json');
    if (!existsSync(askStatePath)) {
      this.log('sendNextQuestion: state file not found');
      return;
    }

    try {
      const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
      const totalQ = state.total_questions || 1;
      const question = state.questions?.[questionIdx];
      if (!question) {
        this.log(`sendNextQuestion: question ${questionIdx} not found`);
        return;
      }

      const qText = question.question || 'Question';
      const qHeader = question.header || '';
      const qMulti = question.multiSelect === true;
      const qOptions: string[] = question.options || [];

      // Build message text
      let msg = `QUESTION (${questionIdx + 1}/${totalQ}) - ${this.agent.name}:`;
      if (qHeader) msg += `\n${qHeader}`;
      msg += `\n${qText}\n`;
      if (qMulti) {
        msg += '\n(Multi-select: tap options to toggle, then tap Submit)';
      }
      for (let i = 0; i < qOptions.length; i++) {
        msg += `\n${i + 1}. ${qOptions[i] || `Option ${i + 1}`}`;
      }

      // Build inline keyboard
      let keyboard: Array<Array<{ text: string; callback_data: string }>>;
      if (qMulti) {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `asktoggle_${questionIdx}_${i}`,
        }]);
        keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${questionIdx}` }]);
      } else {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `askopt_${questionIdx}_${i}`,
        }]);
      }

      await this.telegramApi.sendMessage(this.chatId, msg, { inline_keyboard: keyboard });
      this.log(`Sent question ${questionIdx + 1}/${totalQ} to Telegram`);
    } catch (err) {
      this.log(`sendNextQuestion error: ${err}`);
    }
  }

  /**
   * Sleep that can be interrupted by SIGUSR1.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Check for .urgent-signal file and process it.
   */
  private checkUrgentSignal(): void {
    const urgentPath = join(this.paths.stateDir, '.urgent-signal');
    if (existsSync(urgentPath)) {
      try {
        const content = readFileSync(urgentPath, 'utf-8').trim();
        this.log(`Urgent signal detected: ${content}`);
        unlinkSync(urgentPath);

        // Inject the urgent message — fence the body unescapably (#592 follow-up)
        // so a signal payload carrying its own fence can't break out and forge
        // daemon containment headers.
        if (content) {
          const urgentMsg = `=== URGENT SIGNAL ===\n${wrapFenceSafe(content)}\n\n`;
          this.agent.injectMessage(urgentMsg);
        }
      } catch (err) {
        this.log(`Error processing urgent signal: ${err}`);
      }
    }
  }

  /**
   * Read ctx thresholds from config.json with mtime-based caching (BUG-048 pattern).
   * Re-reads from disk only when the file has changed so dashboard updates take effect
   * within one poll cycle without a daemon restart.
   */
  private getCtxThresholds(): { warn: number; handoff: number } {
    try {
      const configPath = join(this.agent.getAgentDir(), 'config.json');
      const mtime = statSync(configPath).mtimeMs;
      if (mtime !== this.ctxConfigMtime) {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        const config = this.agent.getConfig();
        config.ctx_warning_threshold = cfg.ctx_warning_threshold;
        config.ctx_handoff_threshold = cfg.ctx_handoff_threshold;
        this.ctxConfigMtime = mtime;
      }
    } catch { /* keep stale values */ }
    const config = this.agent.getConfig();
    return {
      // Context-handoff is ON by default for every runtime/agent: an unset
      // threshold falls back to 30% warning / 60% handoff (a percentage of the
      // ACTIVE model's context window, so it adapts to window size). An explicit
      // ctx_handoff_threshold <= 0 is the deliberate opt-out (see checkContextStatus).
      warn: config.ctx_warning_threshold ?? 30,
      handoff: config.ctx_handoff_threshold ?? 60,
    };
  }

  /**
   * Context monitor — called on every poll cycle.
   * Reads context_status.json written by the statusLine bridge hook and takes
   * action when thresholds are crossed.
   */
  private async checkContextStatus(): Promise<void> {
    const now = Date.now();

    // Circuit breaker: check if we should pause auto-restarts
    if (this.ctxCircuitBrokenAt !== null) {
      if (now - this.ctxCircuitBrokenAt >= 30 * 60_000) {
        this.ctxCircuitBrokenAt = null;
        this.ctxCircuitRestarts = [];
        this.ctxHandoffFires = [];
        this.saveCtxCircuit();
        this.log('Context circuit breaker reset after 30min pause');
      } else {
        return; // still paused
      }
    }

    // Read the bridge file written by hook-context-status
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    if (!existsSync(statusPath)) return;

    let pct: number | null = null;
    let exceeds200k = false;
    let rawTokens: number | null = null;
    let reportedWindow: number | null = null;
    try {
      const raw = readFileSync(statusPath, 'utf-8');
      const data = JSON.parse(raw);
      const age = now - new Date(data.written_at || 0).getTime();
      if (age > 10 * 60_000) return; // stale file — skip

      // ── Codex context-full: recover on the FAILURE SIGNAL, never on the token
      // number ──────────────────────────────────────────────────────────────────
      // A context-full codex thread fails every turn BEFORE emitting token usage, so
      // used_percentage stays frozen at the false 0% a prior reset wrote. The adapter
      // detects the "ran out of room" error at the source and writes context_full:true
      // here (codex-app-server-pty.ts signalContextFull). Act on that flag directly,
      // BEFORE any token/percent math — running it through realPct would divide by the
      // 1.05M window and read ~0%, defeating recovery. This is the one line that all six
      // prior measure-better attempts were missing. Gated to the codex runtime; exempt
      // from the handoff grace window (a genuine "ran out of room" is never a transient
      // boot spike); routed through forceContextRestart so it counts toward the ≤3/15min
      // circuit breaker and can never storm. The .force-fresh forceContextRestart writes
      // → shouldContinue() false → a genuinely FRESH thread/start, not a resume.
      if (
        data.context_full === true
        && this.agent.getConfig().runtime === 'codex-app-server'
      ) {
        this.log('Codex context-full signal detected — force restarting (bypassing token math)');
        this.forceContextRestart('codex context-full');
        return;
      }

      pct = typeof data.used_percentage === 'number' ? data.used_percentage : null;
      exceeds200k = Boolean(data.exceeds_200k_tokens);

      // RAW token count from the statusLine bridge (hook-context-status writes
      // current_usage verbatim from Claude Code). This is the KEY signal that lets
      // us measure against the REAL model window instead of CC's fixed 200K. Sum
      // the four occupancy components CC itself counts toward the window: fresh
      // input, both cache tiers, and generated output. Absent/malformed → null,
      // and we fall back to CC's used_percentage below.
      const cu = data.current_usage;
      if (cu && typeof cu === 'object') {
        const sum =
          (typeof cu.input_tokens === 'number' ? cu.input_tokens : 0)
          + (typeof cu.cache_creation_input_tokens === 'number' ? cu.cache_creation_input_tokens : 0)
          + (typeof cu.cache_read_input_tokens === 'number' ? cu.cache_read_input_tokens : 0)
          + (typeof cu.output_tokens === 'number' ? cu.output_tokens : 0);
        if (sum > 0) rawTokens = sum;
      }

      // The ACTUAL context window the runtime reported for this session. The codex
      // pty writes the true cap here (codex_context_cap, ~1M); Claude Code writes its
      // own. This is ground truth — prefer it over the realContextWindow(model) guess
      // table, which does not know codex model ids and would return 200K for them.
      if (typeof data.context_window_size === 'number' && data.context_window_size > 0) {
        reportedWindow = data.context_window_size;
      }

      // Detect new session: if session_id changed, clear stale per-session ctx state.
      // This handles the case where the agent self-restarts (voluntary handoff) and the
      // 5-min deadline timer would otherwise fire on the fresh low-context session.
      const incomingSessionId = typeof data.session_id === 'string' ? data.session_id : null;
      if (incomingSessionId && incomingSessionId !== this.ctxLastSessionId) {
        // Release any context-handoff lease held by this agent on a fresh session.
        // This MUST be unconditional — released by agent name, not gated on
        // ctxLastSessionId or the in-memory ctxHandoffLeaseId. A handoff restart can
        // reset this monitor's per-agent state (both fields back to null), so gating
        // release on either leaks the lease until its 10-min TTL and starves the fleet
        // handoff queue: completed handoffs never free their slot, and queued agents
        // above threshold wait up to a full TTL for a slot. A fresh session never needs
        // a lease acquired by a prior session of the same agent; release-by-name is a
        // no-op when none is held and also clears any stale queue entry.
        releaseContextHandoffLease(this.paths.ctxRoot, this.agent.name);
        this.ctxHandoffLeaseId = null;
        if (this.ctxLastSessionId !== null) {
          this.ctxHandoffFiredAt = 0;
          this.ctxHandoffDeadlineAt = 0;
          this.ctxWarningFiredAt = 0;
          this.log(`New session detected (${incomingSessionId.slice(0, 8)}…) — per-session ctx state reset`);
        }
        this.ctxLastSessionId = incomingSessionId;
        // Anchor the handoff grace window. A freshly-started session begins at low
        // context, so context-handoff actions are suppressed for HANDOFF_GRACE_MS to
        // avoid acting on a transient/stale high reading (observed on fresh codex
        // app-server threads that briefly report prior prompt-cache tokens) that
        // would otherwise fire an immediate handoff → restart → fresh-session loop.
        this.ctxSessionStartedAt = now;
      }
    } catch { return; }

    // Measure context % against the REAL model window, not CC's fixed 200K.
    // realPct = rawTokens / realWindow(model). Fall back to CC's used_percentage
    // ONLY when the raw token count is absent (older CC, or a malformed payload) —
    // and log that degrade so the churn regression is visible if CC ever stops
    // providing current_usage. On a 1M model this makes a 60% handoff fire at
    // ~600K real tokens (a genuine backstop that lets CC compact along the way)
    // rather than at ~120K, which is what caused the restart churn.
    const model = this.agent.getConfig().model;
    // Prefer the window the runtime actually reported (codex writes its true ~1M cap;
    // codex model ids are unknown to realContextWindow and would wrongly map to 200K,
    // over-reporting ~5x → premature handoff → restart treadmill). Fall back to the
    // model guess only when the reported window is absent or the untrustworthy 200K
    // that Claude Code reports even on 1M models (the original reason this override
    // exists — the guess upgrades known Claude 1M models above that 200K floor).
    const realWindow = (reportedWindow !== null && reportedWindow > 200_000)
      ? reportedWindow
      : realContextWindow(model);
    let realPct: number | null;
    if (rawTokens !== null) {
      realPct = (rawTokens / realWindow) * 100;
    } else {
      realPct = pct;
      if (pct !== null) {
        this.log(
          `Context: current_usage absent — falling back to CC used_percentage (${Math.round(pct)}%, `
          + `200K-based). Real-window measurement disabled this tick.`,
        );
      }
    }

    // Check PTY output for hard API overflow errors (always act regardless of threshold config).
    // Guard: only treat the banner phrase as a *live* overflow when context usage actually
    // corroborates it (exceeds 200k on the real window, or realPct genuinely high). The same
    // phrase appears as benign text in memory files, source, and chat that *document* this
    // mechanism — without this guard a fresh boot re-reading those at low context force-restarts
    // on every boot, producing a loop. exceeds_200k_tokens is only a real near-limit signal on a
    // 200K-window model; on a 1M model 200K is ~20% and NOT near the limit, so require realPct to
    // corroborate there instead of trusting the 200K banner alone.
    const exceedsRealBackstop = realWindow <= 200_000 ? exceeds200k : false;
    const ctxCorroboratesOverflow = exceedsRealBackstop || (realPct !== null && realPct >= 85);
    const recentOutput = this.agent.getOutputBuffer()?.getRecent(8000) ?? '';
    if (ctxCorroboratesOverflow && /extra usage.*?1[Mm] context|conversation too long.*?compaction/i.test(recentOutput)) {
      this.log('Context overflow error detected in PTY output at high context — force restarting');
      this.forceContextRestart('API overflow error in PTY output');
      return;
    }

    const { warn, handoff } = this.getCtxThresholds();

    // Default-ON: an UNSET ctx_handoff_threshold uses the 60% default from
    // getCtxThresholds (handoff on for every agent with no config). An explicit
    // ctx_handoff_threshold <= 0 is the deliberate opt-out (observe-only: log,
    // never act). This is the only disable path now that default is on.
    const configuredHandoff = this.agent.getConfig().ctx_handoff_threshold;
    if (configuredHandoff !== undefined && configuredHandoff <= 0) return;

    // Drive all warn/handoff/force-restart decisions off the REAL-window percentage.
    // The exceeds_200k backstop only forces 101 on a genuine 200K-window model
    // (haiku-class); on a 1M model 200K is ~20% and must not trip a handoff, so it
    // is excluded from exceedsRealBackstop above.
    const effectivePct = realPct ?? (exceedsRealBackstop ? 101 : null);
    if (effectivePct === null) return;

    // Session-id-independent leaked-lease release (the Claude null-session_id edge).
    // The new-session detection above only releases a leaked lease when the bridge
    // reports a non-null session_id. hook-context-status writes `session_id ?? null`,
    // so a fresh Claude session reports session_id:null, that block is skipped, and a
    // lease leaked by the agent's prior session sits in `active` until its 10-min TTL —
    // starving the fleet handoff queue on the majority (Claude) path. Release it by name
    // here, gated on the precise safety condition rather than the session_id proxy:
    //   (1) effectivePct < handoff — the agent is NOT mid-handoff, so it cannot
    //       legitimately need a handoff lease this tick; and
    //   (2) ctxHandoffLeaseId === null — this monitor did not itself acquire the live
    //       lease. A lease acquired by the CURRENT session always sets ctxHandoffLeaseId
    //       synchronously at the Tier 2 acquire below (and resets context_status to 0%,
    //       so the very next tick is below-threshold-but-lease-held). The only way to
    //       hold a lease with this field null is that a prior session acquired it and a
    //       full respawn recreated this monitor with null state — i.e. the leaked lease.
    //       This is exactly the guarantee the original non-null-session_id gate gave,
    //       without the proxy. A read-only existence check runs first so idle ticks
    //       never pay the lease-file write.
    if (
      effectivePct < handoff
      && this.ctxHandoffLeaseId === null
      && agentHoldsContextHandoffLease(this.paths.ctxRoot, this.agent.name, now)
    ) {
      releaseContextHandoffLease(this.paths.ctxRoot, this.agent.name);
      this.log('Released leaked context-handoff lease by name (fresh below-threshold session)');
    }

    // Grace window after a fresh session start: suppress soft context actions
    // (warning + handoff) while the session is younger than HANDOFF_GRACE_MS. A
    // just-started session cannot legitimately be at genuine overflow, so a high
    // reading inside this window is a transient/stale spike (e.g. a fresh codex
    // app-server thread briefly reporting prior prompt-cache tokens). Without this,
    // such a spike fired an immediate handoff → cooperative hard-restart → fresh
    // session, repeating every ~1-2min. The window is runtime-aware: codex-app-server
    // and opencode can emit that spurious spike ~6-8min after boot (observed
    // double-handoffs ~6-8min apart on a codex agent), so they get a 10min grace
    // while all other runtimes keep 2min — see handoffGraceMs(). Hard API-overflow
    // detection above is NOT gated by grace, so a genuine overflow is still caught
    // immediately.
    const HANDOFF_GRACE_MS = handoffGraceMs(this.agent.getConfig().runtime);
    const withinHandoffGrace =
      this.ctxSessionStartedAt > 0 && now - this.ctxSessionStartedAt < HANDOFF_GRACE_MS;

    // Tier 3: deadline exceeded — force restart if agent ignored handoff prompt
    if (this.ctxHandoffDeadlineAt > 0 && now > this.ctxHandoffDeadlineAt) {
      this.log(`Handoff deadline exceeded (${Math.round(effectivePct)}%) — force restarting`);
      this.ctxHandoffDeadlineAt = 0;
      this.forceContextRestart(`ctx ${Math.round(effectivePct)}% — handoff not completed within 5min`);
      return;
    }

    // Tier 1: warning — PTY injection only, no Telegram ping (context management is internal)
    if (effectivePct >= warn && !withinHandoffGrace && now - this.ctxWarningFiredAt > 15 * 60_000) {
      this.ctxWarningFiredAt = now;
      const pctRound = Math.round(effectivePct);
      const statusSuffix = effectivePct >= handoff ? 'Handoff in progress.' : `Handoff triggers at ${handoff}%.`;
      this.agent.injectMessage(`[CONTEXT] Window at ${pctRound}%. ${statusSuffix}`);
      this.log(`Context warning fired at ${pctRound}%`);
    }

    // Tier 2: handoff (fires once per session lifecycle)
    if (effectivePct >= handoff && this.ctxHandoffFiredAt === 0 && !withinHandoffGrace) {
      const lease = requestContextHandoffLease({
        ctxRoot: this.paths.ctxRoot,
        agentName: this.agent.name,
      });
      if (lease.status === 'queued') {
        if (now - this.ctxHandoffQueuedLogAt > 60_000) {
          this.ctxHandoffQueuedLogAt = now;
          this.log(
            `Context handoff queued at ${Math.round(effectivePct)}% `
            + `(position ${lease.position}, active ${lease.activeCount}, queued ${lease.queuedCount}, wait ~${Math.ceil(lease.waitMs / 1000)}s)`,
          );
        }
        return;
      }
      this.ctxHandoffLeaseId = lease.leaseId;
      this.ctxHandoffFiredAt = now;

      // Cooperative-restart loop backstop. A handoff normally fires ONCE per session and
      // the fresh session drops well below threshold, so legitimate usage never re-fires
      // soon. If a runtime fails to reset context on the handoff restart (e.g. a
      // thread-persistence regression), the fresh session immediately re-crosses the
      // threshold and re-fires every cycle — a self-sustaining treadmill the restart
      // circuit breaker misses because these are COOPERATIVE handoff restarts, not Tier-3
      // force-restarts. Count handoff fires in a persisted 15min window (survives the
      // restart); if they reach the cap, trip the circuit breaker (30min pause) instead of
      // handing off again, so any handoff loop self-limits regardless of cause. Cap 3 is
      // above the benign 1-2 fires a single very-large turn can produce before settling.
      this.ctxHandoffFires = this.ctxHandoffFires.filter(t => now - t < 15 * 60_000);
      this.ctxHandoffFires.push(now);
      this.saveCtxCircuit();
      if (this.ctxHandoffFires.length >= 3) {
        this.ctxCircuitBrokenAt = now;
        this.saveCtxCircuit();
        // Release the lease we just acquired — we are pausing, not handing off.
        releaseContextHandoffLease(this.paths.ctxRoot, this.agent.name);
        this.ctxHandoffLeaseId = null;
        this.ctxHandoffFiredAt = 0;
        const msg = `Context handoff loop detected for ${this.agent.name}: ${this.ctxHandoffFires.length} handoffs in 15min — a runtime may not be resetting context on restart. Auto-handoff paused 30min. Check logs/${this.agent.name}/restarts.log.`;
        this.log(msg);
        if (this.telegramApi && this.chatId) {
          this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
        }
        return;
      }

      this.ctxHandoffDeadlineAt = now + 5 * 60_000; // 5min grace for agent to cooperate
      // Reset context_status.json so the new session doesn't re-trigger immediately
      const statusPath = join(this.paths.stateDir, 'context_status.json');
      try {
        writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
      } catch { /* non-fatal */ }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
      const handoffPrompt = `[CONTEXT HANDOFF REQUIRED] Context is at ${Math.round(effectivePct)}%. FIRST append a durable checkpoint to your daily memory file memory/$(date -u +%Y-%m-%d).md — a "## Handoff HH:MM" block with COMPLETED (what you FINISHED this session, so a future you does NOT redo it), IN PROGRESS, and NEXT. This durable layer is what 'recall-facts' reads on your next boot; the handoff doc below is only for the immediate next restart and rolls off. THEN write a handoff document to memory/handoffs/handoff-${ts}.md with sections: ## Current Tasks, ## Next Actions, ## Active Crons, ## Key Context, ## Files Modified This Session. THEN run: cortextos bus hard-restart --reason "context handoff at ${Math.round(effectivePct)}%" --handoff-doc <absolute path to the handoff doc you just wrote>. Do this NOW before the context window is exhausted.`;
      this.agent.injectMessage(handoffPrompt);
      this.log(`Handoff prompt injected at ${Math.round(effectivePct)}%`);
      // Pre-arm .force-fresh so the next restart is always a clean fresh session.
      // If the agent cooperates and calls hard-restart, it also writes .force-fresh — no-op.
      // If context exhausts naturally before the agent acts, .force-fresh is already set,
      // preventing a --continue restart that would loop at the same high context level.
      try {
        writeFileSync(join(this.paths.stateDir, '.force-fresh'), '');
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Force a fresh hard restart for context exhaustion reasons.
   * Writes .force-fresh + .restart-planned, then triggers sessionRefresh().
   * The circuit breaker prevents runaway restart loops.
   */
  private forceContextRestart(reason: string): void {
    const now = Date.now();

    // Update and check circuit breaker window (persisted to disk — survives --continue restarts)
    this.ctxCircuitRestarts = this.ctxCircuitRestarts.filter(t => now - t < 15 * 60_000);
    if (this.ctxCircuitRestarts.length >= 3) {
      this.ctxCircuitBrokenAt = now;
      this.saveCtxCircuit();
      const msg = `Context circuit breaker TRIPPED for ${this.agent.name}: 3 restarts in 15min. Watchdog paused 30min. Check logs/${this.agent.name}/restarts.log for details.`;
      this.log(msg);
      if (this.telegramApi && this.chatId) {
        this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
      }
      return;
    }
    this.ctxCircuitRestarts.push(now);
    this.saveCtxCircuit();

    // If the agent wrote a handoff doc in the last 15 minutes but didn't get to call
    // hard-restart --handoff-doc (e.g. Tier 3 force-restart cut it short), pick it up
    // so the new session still receives handoff context.
    try {
      const handoffsDir = join(this.agent.getAgentDir(), 'memory', 'handoffs');
      if (existsSync(handoffsDir)) {
        const cutoff = now - 15 * 60_000;
        const recent = readdirSync(handoffsDir)
          .filter(f => f.startsWith('handoff-') && f.endsWith('.md'))
          .map(f => ({ f, mtime: statSync(join(handoffsDir, f)).mtimeMs }))
          .filter(({ mtime }) => mtime >= cutoff)
          .sort((a, b) => b.mtime - a.mtime);
        if (recent.length > 0) {
          const docPath = join(handoffsDir, recent[0].f);
          const markerPath = join(this.paths.stateDir, '.handoff-doc-path');
          writeFileSync(markerPath, docPath, 'utf-8');
          this.log(`Tier 3 restart: found recent handoff doc, writing marker → ${docPath}`);
        }
      }
    } catch { /* non-fatal — proceed without handoff context */ }

    // Reset per-session context state for the new session
    this.ctxHandoffFiredAt = 0;
    this.ctxHandoffDeadlineAt = 0;
    this.ctxWarningFiredAt = 0;

    // Release this dying session's context-handoff lease on teardown. This restart is
    // IN-PROCESS — sessionRefresh() below does stop()+start() on the same AgentProcess
    // and does NOT recreate this FastChecker, so ctxHandoffLeaseId survives into the
    // fresh session. The by-name cleanup in checkContextStatus is gated on
    // ctxHandoffLeaseId === null, so without this it would skip a lease this session
    // leaked when the fresh session reports session_id:null (the Tier-3 arm of the
    // Claude null-session_id leak — the agent ignored the 5-min handoff prompt and was
    // force-restarted). Release by name and clear the in-memory id HERE, before the
    // restart spawns the new session, so we free the dying session's own lease — never
    // a lease the fresh session might later acquire.
    releaseContextHandoffLease(this.paths.ctxRoot, this.agent.name);
    this.ctxHandoffLeaseId = null;

    // Write .force-fresh + .restart-planned (hardRestart from src/bus/system.ts)
    hardRestart(this.paths, this.agent.name, `CONTEXT-FORCE-RESTART: ${reason}`);

    // Reset context_status.json so the new session's FastChecker doesn't re-trigger
    // Tier 2 immediately by reading the stale high-% value from the previous session.
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    try {
      writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
    } catch { /* non-fatal */ }

    // sessionRefresh() does stop() + start(); shouldContinue() will return false
    // because .force-fresh was just written, giving us a clean fresh session.
    this.agent.sessionRefresh().catch(err => this.log(`Context restart failed: ${err}`));
  }

  /**
   * Compute a hash for message dedup. Uses SHA-256 to avoid collision attacks.
   */
  private hashMessage(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if message has been seen within the TTL window (dedup). Returns true
   * if duplicate.
   */
  isDuplicate(text: string): boolean {
    const hash = this.hashMessage(text);
    const seenAt = this.seenHashes.get(hash);
    const now = Date.now();
    if (seenAt !== undefined && now - seenAt <= DEDUP_TTL_MS) return true;
    this.seenHashes.set(hash, now);
    this.saveDedupHashes();
    return false;
  }

  /**
   * Load dedup hashes from persistent file. Drops entries older than the TTL
   * (including pre-fix lines with no timestamp, which parse as expired — safe
   * direction, they just stop being treated as duplicates one restart earlier
   * than they otherwise would).
   */
  private loadDedupHashes(): void {
    try {
      if (existsSync(this.dedupFilePath)) {
        const content = readFileSync(this.dedupFilePath, 'utf-8');
        const now = Date.now();
        const loaded = new Map<string, number>();
        for (const line of content.trim().split('\n')) {
          if (!line) continue;
          const [hash, tsStr] = line.split('|');
          const ts = Number(tsStr);
          if (!hash || !Number.isFinite(ts)) continue;
          if (now - ts > DEDUP_TTL_MS) continue;
          loaded.set(hash, ts);
        }
        this.seenHashes = loaded;
      }
    } catch {
      // Start fresh on error
      this.seenHashes = new Map();
    }
  }

  /**
   * Prune expired + over-cap entries, persist, and reassign the in-memory map
   * to the pruned result (bounds long-session memory growth, not just the file).
   */
  private saveDedupHashes(): void {
    try {
      const now = Date.now();
      let entries = Array.from(this.seenHashes.entries())
        .filter(([, ts]) => now - ts <= DEDUP_TTL_MS)
        .sort((a, b) => a[1] - b[1]); // oldest first
      if (entries.length > DEDUP_MAX_ENTRIES) {
        entries = entries.slice(entries.length - DEDUP_MAX_ENTRIES);
      }
      this.seenHashes = new Map(entries);
      const lines = entries.map(([hash, ts]) => `${hash}|${ts}`);
      writeFileSync(this.dedupFilePath, lines.join('\n') + '\n', 'utf-8');
    } catch {
      // Non-critical - dedup will still work in memory
    }
  }

  /**
   * Persist the pending Telegram delivery queue to disk. Called after every
   * enqueue and after a confirmed drain. This is the only copy of a queued-but-
   * not-yet-injected message that survives a daemon restart (Telegram's offset
   * already advanced at queue time, so its server-side redelivery is forfeited).
   * Removes the file when the queue empties so a clean fleet leaves no residue.
   */
  private savePendingTelegram(): void {
    try {
      if (this.telegramMessages.length === 0) {
        if (existsSync(this.pendingTelegramFilePath)) unlinkSync(this.pendingTelegramFilePath);
        return;
      }
      writeFileSync(this.pendingTelegramFilePath, JSON.stringify(this.telegramMessages), 'utf-8');
    } catch {
      // Non-critical — the in-memory queue still drives delivery this session.
    }
  }

  /**
   * Replay un-drained Telegram messages persisted by a prior session. Entries
   * are only ever written by queueTelegramMessage and removed after a confirmed
   * injection, so anything present here was queued but never delivered — replay
   * it into the live queue so this session delivers it.
   */
  private loadPendingTelegram(): void {
    try {
      if (!existsSync(this.pendingTelegramFilePath)) return;
      const parsed = JSON.parse(readFileSync(this.pendingTelegramFilePath, 'utf-8'));
      if (Array.isArray(parsed)) {
        this.telegramMessages = parsed
          .filter((e): e is { formatted: string; ackIds: string[] } => e && typeof e.formatted === 'string')
          .map((e) => ({ formatted: e.formatted, ackIds: Array.isArray(e.ackIds) ? e.ackIds : [] }));
      }
    } catch {
      this.telegramMessages = [];
    }
  }

  /**
   * Load circuit breaker state from disk.
   * Persisting this across --continue restarts is critical: without it,
   * the in-memory ctxCircuitRestarts array resets on every restart, making
   * the circuit breaker unable to count restarts and stop a restart loop.
   */
  private loadCtxCircuit(): void {
    try {
      if (!existsSync(this.ctxCircuitFile)) return;
      const data = JSON.parse(readFileSync(this.ctxCircuitFile, 'utf-8'));
      this.ctxCircuitRestarts = Array.isArray(data.restarts) ? data.restarts : [];
      this.ctxHandoffFires = Array.isArray(data.handoffFires) ? data.handoffFires : [];
      this.ctxCircuitBrokenAt = typeof data.brokenAt === 'number' ? data.brokenAt : null;
    } catch {
      // Start fresh on error
    }
  }

  /**
   * Persist circuit breaker state to disk after every update.
   */
  private saveCtxCircuit(): void {
    try {
      writeFileSync(this.ctxCircuitFile, JSON.stringify({
        restarts: this.ctxCircuitRestarts,
        handoffFires: this.ctxHandoffFires,
        brokenAt: this.ctxCircuitBrokenAt,
      }), 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * Check if the agent is actively working on a response (typing indicator).
   *
   * Hook-based approach:
   *   - fast-checker records when it injected a message (lastMessageInjectedAt)
   *   - Stop hook writes a Unix timestamp to state/<agent>/last_idle.flag
   *   - Typing = message was injected AND last_idle.flag is older than injection
   *     AND injection was within the last 10 minutes
   *
   * This is accurate: typing starts when user sends a message, clears the
   * moment Claude finishes its turn (Stop fires). No false positives from TUI.
   */
  isAgentActive(): boolean {
    // Hook-based approach only. Claude Code writes ANSI escape codes (spinner,
    // cursor movement) to stdout constantly even when idle, so stdout.log always
    // grows — using file size as an activity signal produces a permanent "typing"
    // indicator. Instead, rely solely on:
    //   - lastMessageInjectedAt: when fast-checker last pushed a message in
    //   - last_idle.flag: written by the Stop hook when Claude finishes a turn
    // This gives accurate per-turn typing with no false positives.

    if (this.lastMessageInjectedAt === 0) return false;

    const now = Date.now();
    const tenMinMs = 10 * 60 * 1000;
    if (now - this.lastMessageInjectedAt > tenMinMs) return false;

    // Clear typing immediately when the agent sends a reply.
    // outbound-messages.jsonl grows each time the agent calls send-telegram.
    const outboundPath = join(this.paths.logDir, 'outbound-messages.jsonl');
    try {
      if (existsSync(outboundPath)) {
        try {
          const { size } = statSync(outboundPath);
          if (this.outboundLogSize === 0) {
            // First check: seed baseline, don't trigger yet
            this.outboundLogSize = size;
          } else if (size > this.outboundLogSize) {
            // New reply sent — clear typing state
            this.outboundLogSize = size;
            this.lastMessageInjectedAt = 0;
            return false;
          }
        } catch (enoentErr) {
          // File was deleted between existsSync and statSync (log rotation)
          // Treat as "no new data this tick" — leave outboundLogSize unchanged
          if ((enoentErr as NodeJS.ErrnoException).code === 'ENOENT') {
            // Silently ignore — expected during log rotation
          } else {
            throw enoentErr; // Re-throw other errors
          }
        }
      }
    } catch { /* non-critical */ }

    // Read last_idle.flag written by the Stop hook
    const flagPath = join(this.paths.stateDir, 'last_idle.flag');
    try {
      if (!existsSync(flagPath)) {
        // No idle flag yet — hook hasn't fired, so still working
        return true;
      }
      const idleTs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10) * 1000;
      // Typing if injection happened AFTER the last idle signal
      return this.lastMessageInjectedAt > idleTs;
    } catch {
      return true; // Can't read flag — assume still active
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
