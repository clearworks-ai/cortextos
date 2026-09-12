import type { GenerationToken, LifecycleSnapshot, RequestCause, StartMode } from './types.js';

/**
 * Task 2.3: pure recovery-policy classifier extracted from
 * `AgentProcess.handleExit()` (agent-process.ts, verified at L933 against
 * HEAD `922d0673` — PHASES.md's stale L847 citation does not match the
 * current file; re-verified per Task 2.2's line-drift note).
 *
 * `classifyExit` performs ONLY classification + budget arithmetic. It does
 * no I/O, sets no timers, and writes no files — every fact it needs (gate
 * results, spawn timing, runtime, prior spawn mode, whether the agent was
 * ever ready, and the per-agent configured limits) is handed in by the
 * caller (`AgentProcess.handleExit()` today; the supervisor from Task 2.4/
 * 2.5 onward) as `ExitObservation`. The caller remains responsible for:
 *   - computing the four gates (reads `.daemon-stop` / `.restart-planned`
 *     markers, config.json / enabled-agents.json, `stopRequested`/`stopping`)
 *   - tailing stdout for `recentOutput`
 *   - persisting `RecoveryProposal.updatedBudgets` into the durable
 *     `LifecycleSnapshot.recoveryBudgets` record
 *   - acting on the proposal (scheduling `setTimeout`, flipping `status`,
 *     calling `notifyStatusChange()`, sending the Telegram alert)
 *
 * Every exit — including the four gated-out cases — returns a
 * `RecoveryProposal`. `action: 'none'` proposals still carry a `cause` and
 * `evidence` so the owner can record the observation even when nothing is
 * charged to a recovery budget.
 */

/** A single budget's persisted counter shape — matches
 * `LifecycleSnapshot['recoveryBudgets']`'s value type exactly. */
export type RecoveryBudgetEntry = LifecycleSnapshot['recoveryBudgets'][string];

export interface ExitObservation {
  token: GenerationToken;
  exitCode: number;
  signal: number | null;
  /** Last ~16KB of stdout captured BEFORE the PTY reference was nulled —
   * used only for the image-poison signature check. */
  recentOutput: string;
  runtime: string;
  /** Wall-clock ms when THIS spawn attempt began (`spawnStartedAtMs` /
   * `lastStartAtMs` in agent-process.ts — the two are stamped within the
   * same `start()` call and are interchangeable for this purpose). */
  startedAtMs: number;
  /** Wall-clock ms when the exit was observed. */
  exitedAtMs: number;
  /** The spawn mode used for THIS attempt (`lastSpawnMode` in
   * agent-process.ts) — needed to detect the opencode `--continue`
   * fast-exit wedge, which only fires for `mode === 'continue'`. */
  spawnMode: StartMode | null;
  /** Whether the agent's status had ever reached `'running'` before this
   * exit fired (i.e. `this.status === 'running'` at the top of
   * `handleExit()`, negated becomes the "exited before ready" condition). */
  wasReady: boolean;
  /** The four early-exit gates `handleExit()` checks in this exact order,
   * computed by the caller (all are file/marker reads, i.e. I/O, which this
   * pure module must not perform). */
  gates: {
    daemonShuttingDown: boolean;
    disabled: boolean;
    /** `stopRequested || stopping` (BUG-040) — an intentional stop's exit. */
    intentional: boolean;
    /** Fresh `.restart-planned` marker — a planned context-handoff restart. */
    planned: boolean;
  };
  /** Per-agent configured thresholds (`AgentConfig.max_crashes_per_day`,
   * `AgentConfig.crash_window`) — static config the caller already holds;
   * reading it is not I/O, so it is passed in rather than re-derived here. */
  limits: {
    maxCrashesPerDay: number;
    crashWindowMs: number;
    crashWindowMax: number;
  };
}

export interface RecoveryProposal {
  cause: RequestCause;
  action: 'none' | 'restart' | 'halt' | 'pause-and-alert';
  mode: StartMode;
  delayMs: number;
  /** Which budget key this classification's action/limit is centered on
   * (informational — one of the keys also present in `updatedBudgets`, or a
   * `gate:*` tag for `action: 'none'` proposals that charge nothing). */
  budgetKey: string;
  budgetLimit: number;
  evidence: Record<string, string | number | boolean | null>;
  /**
   * Every budget-counter entry this classification touched (increments,
   * resets, and window rolls alike) — the caller merges these into its
   * persisted `LifecycleSnapshot.recoveryBudgets` record. May contain more
   * than one key (e.g. a genuine crash updates both `crash-window`, if
   * configured, and `crash-daily`; a clean exit that clears an accumulated
   * failure streak also resets that streak's key to zero here).
   */
  updatedBudgets: Record<string, RecoveryBudgetEntry>;
}

// ---- Preserved exact constants (grepped from agent-process.ts HEAD 922d0673) ----

/** agent-process.ts L32 */
export const OPENCODE_CONTINUE_WEDGE_THRESHOLD = 3;
/** agent-process.ts L33 */
export const OPENCODE_CONTINUE_WEDGE_FAST_EXIT_MS = 60_000;
/** Fixed backoff for both the image-poison and opencode-wedge force-fresh
 * restarts (agent-process.ts L1059/L1066, L1098/L1106) — NOT derived from
 * the exponential crash formula. */
export const FORCE_FRESH_BACKOFF_MS = 5000;

export const IMAGE_POISON_WINDOW_MS = 15 * 60_000;
export const IMAGE_POISON_THRESHOLD = 3;

export const STARTUP_FAILURE_WINDOW_MS = 60_000;
export const STARTUP_FAILURE_THRESHOLD = 3;
/** agent-process.ts L1124-1125 — spawn must be younger than this AND the
 * agent must never have reached 'running' for the exit to count as
 * "before ready". */
export const STARTUP_FAILURE_SPAWN_AGE_MS = 8_000;

export const CLEAN_EXIT_WINDOW_MS = 60_000;
export const CLEAN_EXIT_HALT_THRESHOLD = 8;
export const CLEAN_EXIT_BACKOFF_OPENCODE_MS = 2000;
export const CLEAN_EXIT_BACKOFF_DEFAULT_MS = 3000;

export const CRASH_BACKOFF_BASE_MS = 5000;
export const CRASH_BACKOFF_CAP_MS = 300_000;
/** agent-process.ts L125 default field initializer. */
export const CRASH_DAILY_LIMIT_DEFAULT = 10;

const MS_PER_DAY = 86_400_000;

function detectImagePoisonSignature(recentOutput: string): boolean {
  if (!recentOutput) return false;
  if (recentOutput.includes('API Error: 400') && recentOutput.includes('image.source.base64')) {
    return true;
  }
  return /image format image\/[a-z]+ not supported/i.test(recentOutput);
}

/** Fixed-window rate counter: rolls over to count=1 once the window has
 * elapsed since it was last opened, otherwise increments in place. This is
 * the closest counter shape the `{count, windowStartMs, pausedUntilMs}`
 * budget record (locked by Task 1.1) can express for what the original
 * implementation tracked as a filtered array of timestamps — it preserves
 * the exact threshold and window duration even though it is a fixed window
 * rather than a true sliding one. */
function bumpFixedWindowCounter(
  prev: RecoveryBudgetEntry | undefined,
  nowMs: number,
  windowMs: number,
): { count: number; windowStartMs: number } {
  if (!prev || nowMs - prev.windowStartMs > windowMs) {
    return { count: 1, windowStartMs: nowMs };
  }
  return { count: prev.count + 1, windowStartMs: prev.windowStartMs };
}

function zeroEntry(nowMs: number): RecoveryBudgetEntry {
  return { count: 0, windowStartMs: nowMs, pausedUntilMs: null };
}

function noneProposal(
  cause: RequestCause,
  budgetKey: string,
  evidence: Record<string, string | number | boolean | null>,
): RecoveryProposal {
  return {
    cause,
    action: 'none',
    mode: 'continue',
    delayMs: 0,
    budgetKey,
    budgetLimit: 0,
    evidence,
    updatedBudgets: {},
  };
}

/**
 * Classify one exit and propose the recovery action. Mirrors
 * `handleExit()`'s exact branch order:
 *   1. daemon-shutdown gate
 *   2. disabled gate
 *   3. intentional-stop gate (BUG-040: `stopRequested || stopping`)
 *   4. planned-restart gate
 *   5. image-poison (exit 0 only)
 *   6. opencode `--continue` fast-exit wedge (exit 0 only)
 *   7. exit-before-ready startup-failure (exit 0 only, non-wedge)
 *   8. fallthrough clean-exit (exit 0 only, non-wedge, ready)
 *   9. genuine crash (exit !== 0): crash-window halt, else daily-limit halt
 *      or exponential-backoff restart
 *
 * Steps 5-9 are mutually exclusive — exactly one cause is emitted per exit;
 * no exit is double-classified or double-charged across budget keys other
 * than the documented cross-cutting resets (e.g. a ready non-wedge clean
 * exit both resets the startup-failure streak AND advances the clean-exit
 * window in one call).
 */
export function classifyExit(
  obs: ExitObservation,
  budgets: LifecycleSnapshot['recoveryBudgets'],
): RecoveryProposal {
  const now = obs.exitedAtMs;

  // ---- Gates (steps 1-4): no crash accounting, but always observed ----
  if (obs.gates.daemonShuttingDown) {
    return noneProposal('daemon-shutdown', 'gate:daemon-shutdown', { gate: 'daemon-shutting-down' });
  }
  if (obs.gates.disabled) {
    return noneProposal('clean-exit', 'gate:disabled', { gate: 'disabled' });
  }
  if (obs.gates.intentional) {
    return noneProposal('clean-exit', 'gate:intentional-stop', { gate: 'intentional-stop' });
  }
  if (obs.gates.planned) {
    return noneProposal('clean-exit', 'gate:planned-restart', { gate: 'planned-restart' });
  }

  // ---- Step 5: image-poison (exit 0 only) ----
  if (obs.exitCode === 0 && detectImagePoisonSignature(obs.recentOutput)) {
    const rolled = bumpFixedWindowCounter(budgets['image-poison'], now, IMAGE_POISON_WINDOW_MS);
    const tripped = rolled.count >= IMAGE_POISON_THRESHOLD;
    const entry: RecoveryBudgetEntry = {
      count: rolled.count,
      windowStartMs: rolled.windowStartMs,
      pausedUntilMs: tripped ? Number.MAX_SAFE_INTEGER : null,
    };
    return {
      cause: 'image-poison',
      action: tripped ? 'pause-and-alert' : 'restart',
      mode: 'fresh',
      delayMs: tripped ? 0 : FORCE_FRESH_BACKOFF_MS,
      budgetKey: 'image-poison',
      budgetLimit: IMAGE_POISON_THRESHOLD,
      evidence: { recoveriesInWindow: rolled.count, circuitBreakerTripped: tripped },
      updatedBudgets: { 'image-poison': entry },
    };
  }

  // ---- Steps 6-8: clean-exit tree (exit 0 only, survived image-poison) ----
  if (obs.exitCode === 0) {
    const ageMs = obs.exitedAtMs - obs.startedAtMs;
    const isWedgeCandidate =
      obs.runtime === 'opencode' && obs.spawnMode === 'continue' && ageMs < OPENCODE_CONTINUE_WEDGE_FAST_EXIT_MS;

    // Step 6: opencode --continue fast-exit wedge — self-contained: either
    // outcome (armed-fresh at threshold, or a normal continue-restart below
    // it) is tagged 'opencode-continuation' and does not also feed the
    // startup-failure or clean-exit-loop counters (those only ever run on
    // the non-wedge path, mirroring the `else { wedgeCount = 0 }` reset).
    if (isWedgeCandidate) {
      const prevCount = budgets['opencode-continuation']?.count ?? 0;
      const nextCount = prevCount + 1;
      const tripped = nextCount >= OPENCODE_CONTINUE_WEDGE_THRESHOLD;
      return {
        cause: 'opencode-continuation',
        action: 'restart',
        mode: tripped ? 'fresh' : 'continue',
        delayMs: tripped ? FORCE_FRESH_BACKOFF_MS : CLEAN_EXIT_BACKOFF_OPENCODE_MS,
        budgetKey: 'opencode-continuation',
        budgetLimit: OPENCODE_CONTINUE_WEDGE_THRESHOLD,
        evidence: { wedgeCount: nextCount, ageMs, runtime: obs.runtime },
        // Tripping the breaker resets the streak to 0, exactly like
        // `this.opencodeContinueWedgeCount = 0` after arming .force-fresh.
        updatedBudgets: {
          'opencode-continuation': tripped
            ? zeroEntry(now)
            : { count: nextCount, windowStartMs: now, pausedUntilMs: null },
        },
      };
    }

    const updatedBudgets: Record<string, RecoveryBudgetEntry> = {
      'opencode-continuation': zeroEntry(now),
    };

    // Step 7: exit-before-ready startup-failure.
    const exitedBeforeReady = !obs.wasReady && ageMs < STARTUP_FAILURE_SPAWN_AGE_MS;
    if (exitedBeforeReady) {
      const rolled = bumpFixedWindowCounter(budgets['startup-failure'], now, STARTUP_FAILURE_WINDOW_MS);
      updatedBudgets['startup-failure'] = { count: rolled.count, windowStartMs: rolled.windowStartMs, pausedUntilMs: null };
      if (rolled.count >= STARTUP_FAILURE_THRESHOLD) {
        return {
          cause: 'startup-failure',
          action: 'halt',
          mode: 'continue',
          delayMs: 0,
          budgetKey: 'startup-failure',
          budgetLimit: STARTUP_FAILURE_THRESHOLD,
          evidence: { startupFailuresInWindow: rolled.count, runtime: obs.runtime, ageMs },
          updatedBudgets,
        };
      }
      // Below threshold: falls through to the clean-exit fallthrough below,
      // exactly as the original `handleExit()` does not return here.
    } else {
      // Ready — clear any accumulated startup-failure suspicion.
      updatedBudgets['startup-failure'] = zeroEntry(now);
    }

    // Step 8: fallthrough clean-exit.
    const rolled = bumpFixedWindowCounter(budgets['clean-exit'], now, CLEAN_EXIT_WINDOW_MS);
    updatedBudgets['clean-exit'] = { count: rolled.count, windowStartMs: rolled.windowStartMs, pausedUntilMs: null };
    if (rolled.count >= CLEAN_EXIT_HALT_THRESHOLD) {
      return {
        cause: 'clean-exit',
        action: 'halt',
        mode: 'continue',
        delayMs: 0,
        budgetKey: 'clean-exit',
        budgetLimit: CLEAN_EXIT_HALT_THRESHOLD,
        evidence: { cleanExitsInWindow: rolled.count },
        updatedBudgets,
      };
    }
    const backoffMs = obs.runtime === 'opencode' ? CLEAN_EXIT_BACKOFF_OPENCODE_MS : CLEAN_EXIT_BACKOFF_DEFAULT_MS;
    return {
      cause: 'clean-exit',
      action: 'restart',
      mode: 'continue',
      delayMs: backoffMs,
      budgetKey: 'clean-exit',
      budgetLimit: CLEAN_EXIT_HALT_THRESHOLD,
      evidence: { cleanExitsInWindow: rolled.count },
      updatedBudgets,
    };
  }

  // ---- Step 9: genuine crash (exitCode !== 0) ----
  const updatedBudgets: Record<string, RecoveryBudgetEntry> = {};

  if (obs.limits.crashWindowMs > 0) {
    const rolled = bumpFixedWindowCounter(budgets['crash-window'], now, obs.limits.crashWindowMs);
    updatedBudgets['crash-window'] = { count: rolled.count, windowStartMs: rolled.windowStartMs, pausedUntilMs: null };
    if (rolled.count >= obs.limits.crashWindowMax) {
      return {
        cause: 'crash',
        action: 'halt',
        mode: 'continue',
        delayMs: 0,
        budgetKey: 'crash-window',
        budgetLimit: obs.limits.crashWindowMax,
        evidence: { crashesInWindow: rolled.count, windowMs: obs.limits.crashWindowMs },
        updatedBudgets,
      };
    }
  }

  // Legacy daily crash counter — UTC-day boundary, matching
  // `resetCrashCountIfNewDay`'s stored-date-string comparison exactly
  // (reset to 1 on a new day, else increment).
  const dayStartMs = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
  const prevDaily = budgets['crash-daily'];
  const dailyCount = !prevDaily || prevDaily.windowStartMs !== dayStartMs ? 1 : prevDaily.count + 1;
  updatedBudgets['crash-daily'] = { count: dailyCount, windowStartMs: dayStartMs, pausedUntilMs: null };

  if (dailyCount >= obs.limits.maxCrashesPerDay) {
    return {
      cause: 'crash',
      action: 'halt',
      mode: 'continue',
      delayMs: 0,
      budgetKey: 'crash-daily',
      budgetLimit: obs.limits.maxCrashesPerDay,
      evidence: { crashCountToday: dailyCount },
      updatedBudgets,
    };
  }

  const backoff = Math.min(CRASH_BACKOFF_BASE_MS * Math.pow(2, dailyCount - 1), CRASH_BACKOFF_CAP_MS);
  return {
    cause: 'crash',
    action: 'restart',
    mode: 'continue',
    delayMs: backoff,
    budgetKey: 'crash-daily',
    budgetLimit: obs.limits.maxCrashesPerDay,
    evidence: { crashCountToday: dailyCount, backoffMs: backoff },
    updatedBudgets,
  };
}
