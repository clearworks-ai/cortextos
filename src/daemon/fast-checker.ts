import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { basename, join } from 'path';
import { createHash } from 'crypto';
import type { InboxMessage, BusPaths, TelegramMessage, TelegramCallbackQuery, AgentConfig } from '../types/index.js';
import { checkInbox, ackInbox } from '../bus/message.js';
import { updateApproval } from '../bus/approval.js';
import { detectDayNightMode } from '../bus/heartbeat.js';
import { AgentProcess } from './agent-process.js';
import type { TelegramAPI } from '../telegram/api.js';
import { KEYS, isValidInboxMsgId } from '../pty/inject.js';
import { atomicWriteSync } from '../utils/atomic.js';
import { stripControlChars } from '../utils/validate.js';

type LogFn = (msg: string) => void;

interface OutboundMessageLogEntry {
  timestamp?: string;
}

interface NarrationInjectState {
  timestamp?: string;
}

export const NARRATION_INJECT_PROMPT = '\nPlease send a Telegram progress update about what you are currently doing. Format: italic, 1-2 sentences. This is a mandatory narration check.\n';

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
  // Frozen-stdout + context-exhaustion watchdog state
  private bootstrappedAt: number = 0;
  private lastHardRestartAt: number = 0;
  private stdoutLastSize: number = 0;
  private stdoutLastChangeAt: number = 0;
  private watchdogTriggered: boolean = false;
  // BUG-065: track last watchdog reason to detect repeated identical failures
  private lastWatchdogReason: string = '';
  // BUG-064: bootstrap grace is configurable via bootstrap_grace_seconds in
  // the agent's config.json. Falls back to 2 minutes (the previous hard-coded
  // value) when the field is absent. Set in the constructor from the supplied
  // config option (readonly after construction so the hot-path watchdogCheck
  // never touches the filesystem).
  private readonly BOOTSTRAP_GRACE_MS: number;
  private readonly HARD_RESTART_COOLDOWN_MS = 15 * 60 * 1000;
  // BUG-061: max age for .pending-user-input marker before we ignore it
  private readonly PENDING_USER_INPUT_MAX_AGE_MS = 30 * 60 * 1000;
  // 3 min — TUI always emits ANSI codes while healthy; 3min silence = dead PTY
  private readonly STDOUT_FROZEN_MS = 3 * 60 * 1000;
  // 6 hours — idle agents (no active Telegram message being processed) produce no
  // stdout naturally. Only restart if silent this long — cron work resets the clock.
  private readonly IDLE_FROZEN_MS = 6 * 60 * 60 * 1000;
  // "Continue / Exit and fix manually" dialog auto-dismiss
  private dialogAutoResumeAt: number = 0;
  private dialogAutoResumeCount: number = 0;
  private readonly DIALOG_AUTO_RESUME_COOLDOWN_MS = 30 * 1000;
  private frameworkRoot: string;
  private telegramApi?: TelegramAPI;
  private chatId?: string;
  private allowedUserId?: number;
  private readonly config?: AgentConfig;
  private readonly instanceId: string;

  // External Telegram handler (set by daemon)
  private telegramMessages: Array<{ formatted: string; ackIds: string[] }> = [];

  // Persistent dedup: message hashes to prevent duplicate delivery
  private seenHashes: Set<string> = new Set();
  private dedupFilePath: string = '';

  // SIGUSR1 wake: resolve to immediately wake from sleep
  private wakeResolve: (() => void) | null = null;

  // Idle-session heartbeat watchdog
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // BUG-068: parse-failure watcher — detect failed_both entries and alert agent
  private parseFallbackCheckedAt: number = 0;

  private readonly NARRATION_SILENCE_THRESHOLD_MS: number;
  private readonly NARRATION_INJECT_COOLDOWN_MS: number;

  // BUG-066: Telegram unreachable fallback — alert agent, replay on recovery
  private telegramUnreachableAlertedAt: number = 0;
  private readonly TELEGRAM_UNREACHABLE_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

  // BUG-062: Stuck-with-pending detector — agent has unread inbox messages
  // but has not sent a Telegram message in >4h
  private stuckPendingAlertedAt: number = 0;
  private readonly STUCK_PENDING_SILENCE_MS = 4 * 60 * 60 * 1000; // 4 hours
  private readonly STUCK_PENDING_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // re-alert at most once/hour

  constructor(
    agent: AgentProcess,
    paths: BusPaths,
    frameworkRoot: string,
    options: { pollInterval?: number; log?: LogFn; telegramApi?: TelegramAPI; chatId?: string; allowedUserId?: number; config?: AgentConfig } = {},
  ) {
    this.agent = agent;
    this.paths = paths;
    this.frameworkRoot = frameworkRoot;
    this.pollInterval = options.pollInterval || 1000;
    this.log = options.log || ((msg) => console.log(`[fast-checker/${agent.name}] ${msg}`));
    this.telegramApi = options.telegramApi;
    this.chatId = options.chatId;
    this.allowedUserId = options.allowedUserId;
    this.config = options.config;
    this.instanceId = basename(paths.ctxRoot);

    // BUG-064: derive bootstrap grace from agent config, fall back to 2 min
    const DEFAULT_BOOTSTRAP_GRACE_S = 2 * 60;
    const graceSeconds =
      typeof options.config?.bootstrap_grace_seconds === 'number' && options.config.bootstrap_grace_seconds > 0
        ? options.config.bootstrap_grace_seconds
        : DEFAULT_BOOTSTRAP_GRACE_S;
    this.BOOTSTRAP_GRACE_MS = graceSeconds * 1000;

    const narrationSilenceThresholdMinutes =
      typeof options.config?.narration_silence_threshold_minutes === 'number' &&
      options.config.narration_silence_threshold_minutes > 0
        ? options.config.narration_silence_threshold_minutes
        : 2;
    this.NARRATION_SILENCE_THRESHOLD_MS = narrationSilenceThresholdMinutes * 60 * 1000;

    const narrationInjectCooldownMinutes =
      typeof options.config?.narration_inject_cooldown_minutes === 'number' &&
      options.config.narration_inject_cooldown_minutes > 0
        ? options.config.narration_inject_cooldown_minutes
        : 5;
    this.NARRATION_INJECT_COOLDOWN_MS = narrationInjectCooldownMinutes * 60 * 1000;

    // Initialize persistent dedup
    this.dedupFilePath = join(paths.stateDir, '.message-dedup-hashes');
    this.loadDedupHashes();
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
    this.bootstrappedAt = Date.now();
    this.stdoutLastChangeAt = Date.now();

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
        this.watchdogCheck();
        this.checkNarrationSilence(this.agent, this.config, this.instanceId);
        this.parseFallbackCheck();
        await this.telegramUnreachableCheck();
        await this.stuckPendingCheck();
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
  }

  /**
   * Single poll cycle: check inbox + queued Telegram messages.
   */
  private async pollCycle(): Promise<void> {
    let messageBlock = '';
    const ackIds: string[] = [];

    // Process queued Telegram messages
    let hasTelegramMessage = false;
    while (this.telegramMessages.length > 0) {
      const msg = this.telegramMessages.shift()!;
      messageBlock += msg.formatted;
      hasTelegramMessage = true;
    }

    // Check agent inbox
    const inboxMessages = checkInbox(this.paths);
    for (const msg of inboxMessages) {
      // BUG-079: Validate message ID before injecting. IDs that don't match the
      // expected pattern ({epochMs}-{agent}-{rand5}) could indicate a tampered
      // or corrupted message file — skip and log, but still ACK to prevent
      // re-delivery loops.
      if (!isValidInboxMsgId(msg.id)) {
        this.log(`SECURITY: dropping inbox message with invalid ID pattern: ${msg.id.slice(0, 40)}`);
        ackIds.push(msg.id);
        continue;
      }
      // BUG-079: Strip control chars from message body before formatting for injection.
      // The formatInboxMessage output goes into the PTY via injectMessage, which also
      // strips, but we strip here too so the log line captures the sanitized text.
      const sanitized: InboxMessage = { ...msg, text: stripControlChars(msg.text) };
      messageBlock += this.formatInboxMessage(sanitized);
      ackIds.push(msg.id);
    }

    // Inject if there's anything
    if (messageBlock) {
      const injected = this.agent.injectMessage(messageBlock);
      if (injected) {
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
    }

    // Typing indicator: send while Claude is actively working
    if (this.chatId && this.telegramApi && this.isAgentActive()) {
      await this.sendTyping(this.telegramApi, this.chatId);
    }
  }

  /**
   * Format an inbox message for injection.
   * Matches bash fast-checker.sh format exactly.
   */
  private formatInboxMessage(msg: InboxMessage): string {
    const replyNote = msg.reply_to ? ` [reply_to: ${msg.reply_to}]` : '';
    return `=== AGENT MESSAGE from ${msg.from}${replyNote} [msg_id: ${msg.id}] ===
\`\`\`
${msg.text}
\`\`\`
Reply using: cortextos bus send-message ${msg.from} normal '<your reply>' ${msg.id}

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
  ): string {
    let replyCx = '';
    if (replyToText) {
      replyCx = `[Replying to: "${replyToText.slice(0, 500)}"]\n`;
    }

    let lastSentCtx = '';
    if (lastSentText) {
      lastSentCtx = `[Your last message: "${lastSentText.slice(0, 500)}"]\n`;
    }

    // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
    // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
    // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
    const isSlashCommand = /^\/[a-zA-Z]/.test(text.trim());
    const body = isSlashCommand
      ? text.trim()
      : `\`\`\`\n${text}\n\`\`\``;
    return `=== TELEGRAM from [USER: ${from}] (chat_id:${chatId}) ===
${replyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

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
  ): string {
    return `=== TELEGRAM PHOTO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
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
  ): string {
    return `=== TELEGRAM DOCUMENT from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram voice/audio message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVoiceMessage(
    from: string,
    chatId: string | number,
    filePath: string,
    duration: number | undefined,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VOICE from ${from} (chat_id:${chatId}) ===
duration: ${dur}s
local_file: ${filePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

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
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VIDEO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
duration: ${dur}s
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
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

    this.log(`Unhandled callback data: ${data}`);
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

        // Inject the urgent message
        if (content) {
          const urgentMsg = `=== URGENT SIGNAL ===\n\`\`\`\n${content}\n\`\`\`\n\n`;
          this.agent.injectMessage(urgentMsg);
        }
      } catch (err) {
        this.log(`Error processing urgent signal: ${err}`);
      }
    }
  }

  /**
   * Compute a hash for message dedup. Uses SHA-256 to avoid collision attacks.
   */
  private hashMessage(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if message has been seen (dedup). Returns true if duplicate.
   */
  isDuplicate(text: string): boolean {
    const hash = this.hashMessage(text);
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    this.saveDedupHashes();
    return false;
  }

  /**
   * Load dedup hashes from persistent file.
   */
  private loadDedupHashes(): void {
    try {
      if (existsSync(this.dedupFilePath)) {
        const content = readFileSync(this.dedupFilePath, 'utf-8');
        const hashes = content.trim().split('\n').filter(Boolean);
        // Keep only last 1000 hashes to prevent file bloat
        const recent = hashes.slice(-1000);
        this.seenHashes = new Set(recent);
      }
    } catch {
      // Start fresh on error
      this.seenHashes = new Set();
    }
  }

  /**
   * Save dedup hashes to persistent file.
   */
  private saveDedupHashes(): void {
    try {
      const hashes = Array.from(this.seenHashes).slice(-1000);
      writeFileSync(this.dedupFilePath, hashes.join('\n') + '\n', 'utf-8');
    } catch {
      // Non-critical - dedup will still work in memory
    }
  }

  private readPendingUserInputAgeMs(now: number): number | null {
    const pendingInputPath = join(this.paths.stateDir, '.pending-user-input');
    if (!existsSync(pendingInputPath)) return null;
    try {
      return now - statSync(pendingInputPath).mtimeMs;
    } catch {
      return null;
    }
  }

  private hasFreshPendingUserInput(now: number): boolean {
    const markerAgeMs = this.readPendingUserInputAgeMs(now);
    return markerAgeMs !== null && markerAgeMs < this.PENDING_USER_INPUT_MAX_AGE_MS;
  }

  private readLastNonEmptyLine(filePath: string): string | null {
    if (!existsSync(filePath)) return null;

    let fd: number | null = null;
    try {
      const size = statSync(filePath).size;
      if (size === 0) return null;

      fd = openSync(filePath, 'r');
      const chunkSize = 1024;
      let position = size;
      let tail = '';

      while (position > 0) {
        const bytesToRead = Math.min(chunkSize, position);
        position -= bytesToRead;

        const buffer = Buffer.alloc(bytesToRead);
        readSync(fd, buffer, 0, bytesToRead, position);
        tail = buffer.toString('utf-8') + tail;

        const trimmedTail = tail.replace(/\n+$/, '');
        if (!trimmedTail) continue;

        const lastNewlineIndex = trimmedTail.lastIndexOf('\n');
        if (lastNewlineIndex !== -1) {
          return trimmedTail.slice(lastNewlineIndex + 1).replace(/\r$/, '');
        }
      }

      const trimmedTail = tail.replace(/\n+$/, '');
      return trimmedTail ? trimmedTail.replace(/\r$/, '') : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  private readLastOutboundTelegramTimestamp(agent: AgentProcess, instanceId: string): number {
    const outboundPath = join(this.paths.ctxRoot, 'logs', agent.name, 'outbound-messages.jsonl');
    void instanceId;

    const lastLine = this.readLastNonEmptyLine(outboundPath);
    if (!lastLine) return 0;

    try {
      const entry = JSON.parse(lastLine) as OutboundMessageLogEntry;
      if (typeof entry.timestamp !== 'string') return 0;
      const parsedTimestamp = new Date(entry.timestamp).getTime();
      return Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0;
    } catch {
      return 0;
    }
  }

  private readLastNarrationInjectTimestamp(agent: AgentProcess, instanceId: string): number {
    const injectStatePath = join(this.paths.ctxRoot, 'state', agent.name, 'last-narration-inject.json');
    void instanceId;

    if (!existsSync(injectStatePath)) return 0;

    try {
      const state = JSON.parse(readFileSync(injectStatePath, 'utf-8')) as NarrationInjectState;
      if (typeof state.timestamp !== 'string') return 0;
      const parsedTimestamp = new Date(state.timestamp).getTime();
      return Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0;
    } catch {
      return 0;
    }
  }

  private writeLastNarrationInjectTimestamp(agent: AgentProcess, instanceId: string, timestamp: string): void {
    const injectStatePath = join(this.paths.ctxRoot, 'state', agent.name, 'last-narration-inject.json');
    void instanceId;
    atomicWriteSync(injectStatePath, JSON.stringify({ timestamp }));
  }

  private isStdoutActive(agent: AgentProcess, instanceId: string): boolean {
    const stdoutPath = join(this.paths.ctxRoot, 'logs', agent.name, 'stdout.log');
    void instanceId;

    try {
      if (!existsSync(stdoutPath)) {
        this.stdoutLogSize = 0;
        return false;
      }

      const { size } = statSync(stdoutPath);
      const previousSize = this.stdoutLogSize;
      this.stdoutLogSize = size;
      return previousSize >= 0 && size > previousSize;
    } catch {
      return false;
    }
  }

  private isQuietHours(config: AgentConfig | undefined): boolean {
    return detectDayNightMode(config?.timezone ?? 'UTC') === 'night';
  }

  private checkNarrationSilence(agent: AgentProcess, config: AgentConfig | undefined, instanceId: string): void {
    if (this.bootstrappedAt === 0) return;

    const now = Date.now();
    const stdoutActive = this.isStdoutActive(agent, instanceId);
    if (!stdoutActive) return;
    if (this.hasFreshPendingUserInput(now)) return;
    if (this.isQuietHours(config)) return;

    const lastOutboundTimestamp = this.readLastOutboundTelegramTimestamp(agent, instanceId);
    const silenceReferenceTimestamp = Math.max(lastOutboundTimestamp, this.bootstrappedAt);
    if (now - silenceReferenceTimestamp <= this.NARRATION_SILENCE_THRESHOLD_MS) return;

    const lastInjectTimestamp = this.readLastNarrationInjectTimestamp(agent, instanceId);
    if (lastInjectTimestamp > 0 && now - lastInjectTimestamp <= this.NARRATION_INJECT_COOLDOWN_MS) return;

    if (!agent.injectMessage(NARRATION_INJECT_PROMPT)) return;

    const injectedAt = new Date(now).toISOString();
    this.writeLastNarrationInjectTimestamp(agent, instanceId, injectedAt);
    this.log(`NARRATION-WATCHDOG: injected narration check after ${Math.round((now - silenceReferenceTimestamp) / 1000)}s of Telegram silence`);

    execFile(
      'cortextos',
      ['bus', 'log-event', 'action', 'narration_inject', 'info', '--agent', agent.name],
      (err) => {
        if (err) this.log(`NARRATION-WATCHDOG: log-event failed: ${err.message}`);
      },
    );
  }

  /**
   * Detect frozen stdout or context-exhaustion and trigger a hard-restart.
   * Two signals:
   *   1. Claude Code's "How is Claude doing this session?" survey — ctx exhausted.
   *   2. stdout unchanged for STDOUT_FROZEN_MS (active) or IDLE_FROZEN_MS (idle).
   */
  private watchdogCheck(): void {
    const now = Date.now();
    if (this.bootstrappedAt === 0 || now - this.bootstrappedAt < this.BOOTSTRAP_GRACE_MS) return;

    // BUG-065: when in cooldown, check if the same failure class is being
    // triggered again (indicating a stuck restart loop) and escalate.
    if (this.watchdogTriggered) {
      // Determine current failure signals so we can compare against lastWatchdogReason
      const stdoutPath = join(this.paths.logDir, 'stdout.log');
      if (existsSync(stdoutPath)) {
        try {
          const sz = statSync(stdoutPath).size;
          const tailBytes = Math.min(20000, sz);
          if (tailBytes > 0) {
            const fd = openSync(stdoutPath, 'r');
            const buf = Buffer.alloc(tailBytes);
            readSync(fd, buf, 0, tailBytes, sz - tailBytes);
            closeSync(fd);
            const tail = buf.toString('utf-8');
            if (/How is Claude doing this session\?/.test(tail)) {
              this.watchdogRepeatCheck('ctx exhaustion: session survey prompt in stdout');
            } else if (now - this.stdoutLastChangeAt > this.STDOUT_FROZEN_MS) {
              const stalledSec = Math.round((now - this.stdoutLastChangeAt) / 1000);
              this.watchdogRepeatCheck(`frozen: stdout unchanged ${stalledSec}s`);
            }
          }
        } catch { /* non-critical */ }
      }
      return;
    }

    if (this.lastHardRestartAt > 0 && now - this.lastHardRestartAt < this.HARD_RESTART_COOLDOWN_MS) return;

    const stdoutPath = join(this.paths.logDir, 'stdout.log');
    if (!existsSync(stdoutPath)) return;

    let size: number;
    try { size = statSync(stdoutPath).size; } catch { return; }

    if (size !== this.stdoutLastSize) {
      this.stdoutLastSize = size;
      this.stdoutLastChangeAt = now;
    }

    // Signal 1: ctx-exhaustion survey prompt in last 20KB of stdout
    try {
      const tailBytes = Math.min(20000, size);
      if (tailBytes > 0) {
        const fd = openSync(stdoutPath, 'r');
        const buf = Buffer.alloc(tailBytes);
        readSync(fd, buf, 0, tailBytes, size - tailBytes);
        closeSync(fd);
        if (/How is Claude doing this session\?/.test(buf.toString('utf-8'))) {
          this.log('WATCHDOG: ctx-exhaustion survey detected — hard-restarting');
          this.triggerHardRestart('ctx exhaustion: session survey prompt in stdout');
          return;
        }
      }
    } catch { /* non-critical */ }

    // Signal 2: "Continue / Exit and fix manually" error-recovery dialog — auto-dismiss
    try {
      const dialogTailBytes = Math.min(4000, size);
      if (dialogTailBytes > 0) {
        const dfd = openSync(stdoutPath, 'r');
        const dbuf = Buffer.alloc(dialogTailBytes);
        readSync(dfd, dbuf, 0, dialogTailBytes, size - dialogTailBytes);
        closeSync(dfd);
        if (/Exit and fix manually/.test(dbuf.toString('utf-8'))) {
          const nowD = Date.now();
          if (nowD - this.dialogAutoResumeAt > this.DIALOG_AUTO_RESUME_COOLDOWN_MS) {
            this.dialogAutoResumeAt = nowD;
            this.dialogAutoResumeCount++;
            if (this.dialogAutoResumeCount <= 3) {
              this.log(`WATCHDOG: dialog auto-dismiss (attempt ${this.dialogAutoResumeCount}) — pressing Enter to continue`);
              this.agent.write(KEYS.ENTER);
              this.stdoutLastChangeAt = nowD;
            } else {
              this.log('WATCHDOG: dialog auto-dismiss exceeded 3 attempts — hard-restarting');
              this.triggerHardRestart('dialog loop: "Exit and fix manually" repeated >3 times');
            }
          }
          return;
        }
      }
    } catch { /* non-critical */ }

    // Signal 3: stdout frozen — hard restart.
    // Active agents (processing a Telegram message): restart after STDOUT_FROZEN_MS (3 min).
    // Idle agents (no active message): stdout is naturally silent. Use IDLE_FROZEN_MS (6h)
    // so idle sessions survive overnight without looping. Cron work produces stdout and
    // resets the clock, so any real freeze during a cron is still caught at 3 min.
    const frozenThresholdMs = this.isAgentActive() ? this.STDOUT_FROZEN_MS : this.IDLE_FROZEN_MS;
    if (now - this.stdoutLastChangeAt > frozenThresholdMs) {
      const stalledSec = Math.round((now - this.stdoutLastChangeAt) / 1000);

      // BUG-061: skip frozen restart if agent is waiting for an AskUserQuestion response.
      // Check for .pending-user-input marker in the agent's state directory.
      // If it exists and is <30 minutes old, the agent is legitimately blocked on
      // user input — do NOT hard-restart or we'll kill the pending question.
      const markerAgeMs = this.readPendingUserInputAgeMs(now);
      if (markerAgeMs !== null) {
        if (markerAgeMs < this.PENDING_USER_INPUT_MAX_AGE_MS) {
          const markerAgeSec = Math.round(markerAgeMs / 1000);
          this.log(`WATCHDOG: stdout frozen ${stalledSec}s but .pending-user-input is ${markerAgeSec}s old — skipping restart, waiting on user input`);
          return;
        }
        // Marker is stale (>=30 min) — ignore it and proceed with restart
        this.log(`WATCHDOG: .pending-user-input exists but is stale (${Math.round(markerAgeMs / 60000)}min old) — proceeding with restart`);
      }

      this.log(`WATCHDOG: stdout frozen ${stalledSec}s — hard-restarting`);
      this.triggerHardRestart(`frozen: stdout unchanged ${stalledSec}s`);
    }
  }

  private triggerHardRestart(reason: string): void {
    this.watchdogTriggered = true;
    this.lastHardRestartAt = Date.now();
    this.lastWatchdogReason = reason;
    if (this.telegramApi && this.chatId) {
      this.telegramApi
        .sendMessage(this.chatId, `Got stuck (${reason}). Hard-restarting now.`)
        .catch(() => { /* non-critical */ });
    }
    this.agent.hardRestartSelf(reason).catch(e => this.log(`hardRestartSelf failed: ${e}`));
    // Reset so the watchdog can fire again after cooldown
    setTimeout(() => { this.watchdogTriggered = false; }, this.HARD_RESTART_COOLDOWN_MS);
  }

  /**
   * BUG-065: Called at the top of watchdogCheck() when watchdogTriggered is true.
   * If the same failure reason fires again within the cooldown window, escalate:
   * log at ERROR severity and send a Telegram alert. Different reasons (e.g. a new
   * ctx-exhaustion after a frozen-stdout) are normal and silently ignored as before.
   */
  private watchdogRepeatCheck(currentReason: string): void {
    if (!this.lastWatchdogReason) return;
    // Normalize: compare the type prefix only (before the colon) so minor
    // variations like different stall durations ("frozen: stdout unchanged 620s"
    // vs "frozen: stdout unchanged 660s") still count as the same failure class.
    const typeOf = (r: string) => r.split(':')[0].trim();
    if (typeOf(currentReason) === typeOf(this.lastWatchdogReason)) {
      this.log(`WATCHDOG-ESCALATION: same failure class "${typeOf(currentReason)}" repeated within cooldown window — agent may be stuck in a restart loop`);
      if (this.telegramApi && this.chatId) {
        this.telegramApi
          .sendMessage(this.chatId, `ALERT: ${this.agent.name} has failed with the same reason ("${typeOf(currentReason)}") again within the cooldown window. It may be stuck in a restart loop. Manual intervention may be needed.`)
          .catch(() => { /* non-critical */ });
      }
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
        const { size } = require('fs').statSync(outboundPath);
        if (this.outboundLogSize === 0) {
          // First check: seed baseline, don't trigger yet
          this.outboundLogSize = size;
        } else if (size > this.outboundLogSize) {
          // New reply sent — clear typing state
          this.outboundLogSize = size;
          this.lastMessageInjectedAt = 0;
          return false;
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

  /**
   * BUG-068: Poll telegram-parse-failures.jsonl for failed_both entries since
   * last check. On detection, inject a system alert to the PTY so the agent
   * knows it is fully dark (not just format-degraded).
   */
  private parseFallbackCheck(): void {
    if (this.bootstrappedAt === 0) return;

    const failurePath = join(this.paths.logDir, 'telegram-parse-failures.jsonl');
    if (!existsSync(failurePath)) return;

    try {
      const content = readFileSync(failurePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const now = Date.now();
      let foundFailedBoth = false;
      let lastError = '';

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { ts?: string; final_status?: string; error_message?: string };
          const entryTs = entry.ts ? new Date(entry.ts).getTime() : 0;
          if (entryTs > this.parseFallbackCheckedAt && entry.final_status === 'failed_both') {
            foundFailedBoth = true;
            lastError = entry.error_message ?? 'unknown error';
          }
        } catch { /* skip malformed lines */ }
      }

      this.parseFallbackCheckedAt = now;

      if (foundFailedBoth) {
        this.log('PARSE-FAILURE-WATCHER: failed_both detected — injecting alert to agent');
        const alert = `=== SYSTEM ALERT ===\nYour last Telegram message failed to send (both Markdown and plain text attempts failed). Error: ${lastError}. Telegram may be unreachable. Use plain text only and check connectivity, or notify Josh via another channel if available.\n\n`;
        this.agent.injectMessage(alert);
      }
    } catch { /* non-critical */ }
  }

  /**
   * BUG-066: Telegram unreachable fallback.
   * If the agent wrote a .telegram-unreachable sentinel (set by bus send-telegram on
   * network failure), inject a PTY alert so the agent knows messages weren't delivered.
   * When Telegram recovers (we can reach getUpdates), replay any pending fallback
   * entries and clear the sentinel.
   */
  async telegramUnreachableCheck(): Promise<void> {
    if (!this.paths.stateDir) return;
    const sentinelPath = join(this.paths.stateDir, '.telegram-unreachable');
    if (!existsSync(sentinelPath)) return;

    const now = Date.now();

    // Try to reach Telegram — if telegramApi is available, check connectivity
    if (this.telegramApi) {
      let reachable = false;
      try {
        await this.telegramApi.getMe();
        reachable = true;
      } catch { /* still unreachable */ }

      if (reachable) {
        // Replay pending fallback entries
        const fallbackPath = join(this.paths.logDir, 'narration-fallback.jsonl');
        if (existsSync(fallbackPath)) {
          try {
            const lines = readFileSync(fallbackPath, 'utf-8').split('\n').filter(Boolean);
            const pending = lines
              .map((l) => { try { return JSON.parse(l); } catch { return null; } })
              .filter((e) => e && e.final_status === 'pending');

            if (pending.length > 0) {
              this.log(`TELEGRAM-RECOVERY: replaying ${pending.length} fallback message(s)`);
              for (const entry of pending) {
                try {
                  await this.telegramApi.sendMessage(entry.chat_id, `[Recovered] ${entry.text}`);
                } catch { /* best-effort — don't block on replay failure */ }
              }
              // Clear fallback log after replay attempt
              try { unlinkSync(fallbackPath); } catch { /* ignore */ }
            }
          } catch { /* non-critical */ }
        }

        // Remove sentinel — connectivity restored
        try { unlinkSync(sentinelPath); } catch { /* ignore */ }
        this.log('TELEGRAM-RECOVERY: connectivity restored, sentinel cleared');
        return;
      }
    }

    // Still unreachable — inject PTY alert once per cooldown
    if (now - this.telegramUnreachableAlertedAt < this.TELEGRAM_UNREACHABLE_ALERT_COOLDOWN_MS) return;

    this.telegramUnreachableAlertedAt = now;
    this.log('TELEGRAM-UNREACHABLE: Telegram unreachable — injecting alert to agent');
    const alert = `=== SYSTEM ALERT ===\nTelegram is unreachable. Your recent send-telegram calls have failed and messages were queued in narration-fallback.jsonl. Do NOT keep trying to send — the daemon will replay queued messages automatically when connectivity is restored. Log notes internally until connectivity is confirmed.\n\n`;
    this.agent.injectMessage(alert);
  }

  /**
   * BUG-062: Stuck-with-pending detector.
   *
   * An agent is considered "stuck" when:
   *   1. There are >0 unread inbox messages pending delivery, AND
   *   2. The agent has not sent a Telegram message in >4h
   *      (measured by outbound-messages.jsonl last-modified time)
   *
   * When detected: log a warning event and send a Telegram alert to the
   * orchestrator (uses this.telegramApi + this.chatId, which for worker
   * agents are wired to the orchestrator's bot for alerting).
   *
   * Alert is rate-limited to once per STUCK_PENDING_ALERT_COOLDOWN_MS.
   */
  async stuckPendingCheck(): Promise<void> {
    if (this.bootstrappedAt === 0) return;
    const now = Date.now();
    if (now - this.bootstrappedAt < this.BOOTSTRAP_GRACE_MS) return;
    if (now - this.stuckPendingAlertedAt < this.STUCK_PENDING_ALERT_COOLDOWN_MS) return;

    // Count unread inbox messages (files in inbox dir, not yet moved to inflight)
    let pendingCount = 0;
    try {
      const files = readdirSync(this.paths.inbox).filter(
        (f) => f.endsWith('.json') && !f.startsWith('.'),
      );
      pendingCount = files.length;
    } catch { /* inbox dir may not exist yet — treat as 0 */ }

    if (pendingCount === 0) return;

    // Check last outbound Telegram send time via outbound-messages.jsonl mtime
    const outboundPath = join(this.paths.logDir, 'outbound-messages.jsonl');
    let lastOutboundMs = 0;
    try {
      if (existsSync(outboundPath)) {
        lastOutboundMs = statSync(outboundPath).mtimeMs;
      }
    } catch { /* non-critical */ }

    const silentMs = lastOutboundMs > 0 ? now - lastOutboundMs : now - this.bootstrappedAt;
    if (silentMs < this.STUCK_PENDING_SILENCE_MS) return;

    // Agent is stuck: has pending inbox messages and hasn't sent Telegram in >4h
    const silentHours = (silentMs / 1000 / 3600).toFixed(1);
    this.stuckPendingAlertedAt = now;
    this.log(
      `STUCK-PENDING: ${pendingCount} unread inbox message(s), no Telegram output for ${silentHours}h — alerting orchestrator`,
    );

    // Log a warning event for fleet monitoring visibility
    execFile(
      'cortextos',
      [
        'bus', 'log-event', 'error', 'agent_stuck', 'warning',
        '--meta', JSON.stringify({ agent: this.agent.name, pending_count: pendingCount, silent_hours: parseFloat(silentHours) }),
      ],
      (err) => { if (err) this.log(`STUCK-PENDING: log-event failed: ${err.message}`); },
    );

    // Send Telegram alert to orchestrator if configured
    if (this.telegramApi && this.chatId) {
      try {
        await this.telegramApi.sendMessage(
          this.chatId,
          `ALERT: Agent ${this.agent.name} appears stuck. It has ${pendingCount} unread inbox message(s) but has not sent a Telegram message in ${silentHours}h. Check the agent or run a soft-restart.`,
        );
      } catch (err) {
        this.log(`STUCK-PENDING: Telegram alert failed: ${err}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
