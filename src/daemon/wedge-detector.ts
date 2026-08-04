/**
 * Wedge detector — the general safety net for a WEDGED agent.
 *
 * A wedge is distinct from every restart path the daemon already has
 * (crash-restart, clean-exit-restart, context-handoff-restart). Those all fire
 * off an OBSERVABLE event: the PTY exited, or the context monitor crossed a
 * threshold. A wedge is the SILENT failure — the Claude/codex REPL is stuck
 * mid-turn and stops processing its inbox/injections, but nothing crashes and
 * no threshold trips, so from the daemon's view the process is "running". Worse,
 * the idle-session heartbeat watchdog (fast-checker.ts start()) keeps stamping
 * heartbeat.json every 50min regardless of REPL state, and any cron the agent
 * owns also stamps it — so the dashboard shows the agent green while it does
 * nothing. larry did this repeatedly (2026-08-04): looked alive, processed no
 * work for hours.
 *
 * The tell: the agent's CONVERSATION buffer
 * (state/<agent>/conversation-buffer.jsonl) records every Josh<->agent turn and
 * bus exchange the agent actually PROCESSES. A wedged REPL writes no new turns,
 * so the buffer's mtime goes stale — WHILE heartbeat.json stays fresh. Stale
 * buffer + fresh heartbeat + pending inbox work = WEDGED.
 *
 * This module is a pure decision function so it is unit-testable in isolation
 * from the FastChecker's PTY/Telegram side effects. fast-checker.ts calls it
 * on every poll cycle and routes a WEDGED verdict to a dedicated
 * forceWedgeRestart() — a recovery restart (like a planned handoff), NOT a crash:
 * it must not count toward the crash/context limiters and must not Telegram-spam.
 */

export interface WedgeDetectorInput {
  /** Now, in ms since epoch. Injectable for tests. */
  nowMs: number;
  /**
   * mtime (ms) of state/<agent>/conversation-buffer.jsonl, or null if the file
   * does not exist yet (first boot — never wedged, there is simply no history).
   */
  conversationBufferMtimeMs: number | null;
  /**
   * mtime (ms) of state/<agent>/heartbeat.json, or null if it does not exist.
   * A missing heartbeat is NOT a wedge — that is the crash/dead path, handled
   * elsewhere. Wedge specifically requires a FRESH heartbeat masking a dead REPL.
   */
  heartbeatMtimeMs: number | null;
  /**
   * Whether the agent has pending inbox work right now (messages waiting in its
   * inbox or inflight). A stale buffer with an EMPTY inbox is a legitimately idle
   * agent with nothing to do — not a wedge. We only force a restart when there is
   * actual work the wedged REPL is failing to pick up.
   */
  hasPendingWork: boolean;
  /**
   * Whether the agent process is currently 'running'. A non-running agent is
   * already handled by the crash/exit restart paths; the wedge watchdog only
   * governs the "looks running but isn't processing" case.
   */
  agentRunning: boolean;
  /**
   * Whether a restart is already in flight for this agent (the #269 single-flight
   * guard is engaged). If so we skip — never stack a second restart.
   */
  restartInFlight: boolean;
  /**
   * Timestamp (ms) of the last wedge-restart this watchdog fired for this agent,
   * or 0 if none. Storm guard: we refuse to wedge-restart the same agent more
   * than once per cooldown window.
   */
  lastWedgeRestartAtMs: number;
  /**
   * Buffer-staleness threshold in ms. Derived from config.wedge_restart_min
   * (default 15min). The conversation buffer must be older than this to qualify.
   */
  bufferStaleThresholdMs: number;
  /**
   * Heartbeat-freshness threshold in ms (default 5min). The heartbeat must be
   * fresher than this — a stale heartbeat means the agent is genuinely down, not
   * wedged, and belongs to the crash/exit path.
   */
  heartbeatFreshThresholdMs: number;
  /**
   * Storm-guard cooldown in ms. We will not wedge-restart the same agent again
   * until this long after the last wedge-restart.
   */
  restartCooldownMs: number;
}

export type WedgeDecision =
  | { wedged: false; reason: string }
  | { wedged: true; reason: string; bufferAgeMs: number; heartbeatAgeMs: number };

export const DEFAULT_WEDGE_RESTART_MIN = 15;
export const DEFAULT_WEDGE_BUFFER_STALE_MS = DEFAULT_WEDGE_RESTART_MIN * 60_000; // 15min
export const DEFAULT_WEDGE_HEARTBEAT_FRESH_MS = 5 * 60_000; // 5min
export const DEFAULT_WEDGE_RESTART_COOLDOWN_MS = 30 * 60_000; // 30min storm guard

/**
 * Decide whether the agent is WEDGED and should be force-restarted.
 *
 * All the exclusion cases return `{ wedged: false }` with a reason (for logging).
 * Only the exact conjunction — running, restart not already in flight, pending
 * work, buffer stale past threshold, heartbeat fresh within threshold, and past
 * the storm-guard cooldown — returns `{ wedged: true }`.
 */
export function detectWedge(input: WedgeDetectorInput): WedgeDecision {
  const {
    nowMs,
    conversationBufferMtimeMs,
    heartbeatMtimeMs,
    hasPendingWork,
    agentRunning,
    restartInFlight,
    lastWedgeRestartAtMs,
    bufferStaleThresholdMs,
    heartbeatFreshThresholdMs,
    restartCooldownMs,
  } = input;

  // Disabled (wedge_restart_min <= 0) — the caller passes a non-positive
  // threshold to opt out. Treat as never-wedged.
  if (bufferStaleThresholdMs <= 0) {
    return { wedged: false, reason: 'disabled' };
  }

  // Not running — the crash/exit restart paths own this case.
  if (!agentRunning) {
    return { wedged: false, reason: 'agent-not-running' };
  }

  // A restart is already coalescing (single-flight, #269). Never stack a second.
  if (restartInFlight) {
    return { wedged: false, reason: 'restart-in-flight' };
  }

  // Storm guard: at most one wedge-restart per cooldown window.
  if (lastWedgeRestartAtMs > 0 && nowMs - lastWedgeRestartAtMs < restartCooldownMs) {
    return { wedged: false, reason: 'within-restart-cooldown' };
  }

  // No pending work — a stale buffer with an empty inbox is a legitimately idle
  // agent, not a wedge. Don't restart an agent that simply has nothing to do.
  if (!hasPendingWork) {
    return { wedged: false, reason: 'no-pending-work' };
  }

  // No conversation buffer yet (first boot) — nothing to be stale.
  if (conversationBufferMtimeMs === null) {
    return { wedged: false, reason: 'no-conversation-buffer' };
  }

  // Missing heartbeat — the agent is genuinely down, not wedged. That is the
  // crash/exit path, not this one.
  if (heartbeatMtimeMs === null) {
    return { wedged: false, reason: 'no-heartbeat' };
  }

  const bufferAgeMs = nowMs - conversationBufferMtimeMs;
  const heartbeatAgeMs = nowMs - heartbeatMtimeMs;

  // Buffer must be STALE (older than threshold).
  if (bufferAgeMs < bufferStaleThresholdMs) {
    return { wedged: false, reason: 'buffer-fresh' };
  }

  // Heartbeat must be FRESH (younger than threshold). A stale heartbeat means
  // down, not wedged.
  if (heartbeatAgeMs >= heartbeatFreshThresholdMs) {
    return { wedged: false, reason: 'heartbeat-stale' };
  }

  // All conditions hold: stale conversation + fresh heartbeat + pending work +
  // running + no restart in flight + past cooldown = WEDGED.
  return {
    wedged: true,
    reason: 'stale-conversation-fresh-heartbeat-pending-work',
    bufferAgeMs,
    heartbeatAgeMs,
  };
}
