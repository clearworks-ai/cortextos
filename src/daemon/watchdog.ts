/**
 * watchdog.ts — Commit-stability watchdog and git rollback.
 *
 * Ports the two-layer crash-recovery pattern from claude-code-thyself
 * (robman/claude-code-thyself) into the cortextos daemon.
 *
 * How it works:
 * - Each time an agent crashes, the watchdog records a failure against the
 *   current git commit hash in a per-agent stability file.
 * - If the same commit accumulates ROLLBACK_THRESHOLD failures, the watchdog
 *   performs a git rollback: stash uncommitted work, reset hard to the last
 *   known-healthy commit (or origin/main if none), and write a recovery note
 *   for the agent to read on its next boot.
 * - After the agent runs for at least MIN_HEALTHY_SECONDS without crashing,
 *   the current commit is marked healthy so normal restarts don't trigger
 *   rollbacks.
 * - If the agent's directory is not inside a git repository, all git
 *   operations degrade gracefully — the watchdog logs a warning and the
 *   daemon continues with its normal crash-backoff behaviour.
 *
 * Stability state is stored in:
 *   {ctxRoot}/state/{agentName}/watchdog.json
 *
 * Recovery note (written on rollback, cleared after first read):
 *   {ctxRoot}/state/{agentName}/watchdog-recovery.txt
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { atomicWriteSync } from '../utils/atomic.js';

// Number of failures on the same commit before triggering a rollback.
export const ROLLBACK_THRESHOLD = 3;

// Minimum uptime in seconds for a session to be considered healthy.
export const MIN_HEALTHY_SECONDS = 60;

export interface CommitStability {
  /** Maps commit hash → number of crash-only exits recorded. */
  restart_counts: Record<string, number>;
  /** The last commit hash that ran cleanly for ≥ MIN_HEALTHY_SECONDS. */
  last_healthy: string;
  /** ISO timestamp of the last rollback (informational). */
  last_rollback_at?: string;
}

export interface RollbackResult {
  success: boolean;
  rolledBackTo: string;
  stashRef: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Stability state helpers
// ---------------------------------------------------------------------------

function stabilityPath(stateDir: string): string {
  return join(stateDir, 'watchdog.json');
}

function recoveryNotePath(stateDir: string): string {
  return join(stateDir, 'watchdog-recovery.txt');
}

export function loadStability(stateDir: string): CommitStability {
  const path = stabilityPath(stateDir);
  if (!existsSync(path)) {
    return { restart_counts: {}, last_healthy: '' };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CommitStability>;
    return {
      restart_counts: parsed.restart_counts && typeof parsed.restart_counts === 'object'
        ? parsed.restart_counts
        : {},
      last_healthy: typeof parsed.last_healthy === 'string' ? parsed.last_healthy : '',
      last_rollback_at: parsed.last_rollback_at,
    };
  } catch {
    return { restart_counts: {}, last_healthy: '' };
  }
}

function saveStability(stateDir: string, data: CommitStability): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stabilityPath(stateDir), JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort — never throw from the watchdog
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `dir` to find the enclosing git repository root.
 * Returns null if `dir` is not inside a git repo.
 */
export function findGitRoot(dir: string): string | null {
  try {
    const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Return the HEAD commit hash in `repoRoot`, or null on failure.
 */
export function getCurrentCommit(repoRoot: string): string | null {
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return hash.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public watchdog API
// ---------------------------------------------------------------------------

/**
 * Record one crash failure for the current HEAD commit.
 * Called by AgentProcess.handleExit() on every unintentional crash.
 *
 * @param stateDir  Agent's state directory ({ctxRoot}/state/{agentName})
 * @param repoRoot  Git repository root for the agent's working directory.
 *                  Pass null if the agent is not inside a git repo.
 */
export function recordFailure(
  stateDir: string,
  repoRoot: string | null,
): void {
  if (!repoRoot) return;

  const commit = getCurrentCommit(repoRoot);
  if (!commit) return;

  const data = loadStability(stateDir);
  data.restart_counts[commit] = (data.restart_counts[commit] ?? 0) + 1;
  saveStability(stateDir, data);
}

/**
 * Mark the current HEAD commit as healthy. Resets its failure count and
 * updates last_healthy. Called after MIN_HEALTHY_SECONDS of uptime.
 *
 * @param stateDir  Agent's state directory.
 * @param repoRoot  Git repository root, or null if not in a git repo.
 */
export function markHealthy(
  stateDir: string,
  repoRoot: string | null,
): void {
  if (!repoRoot) return;

  const commit = getCurrentCommit(repoRoot);
  if (!commit) return;

  const data = loadStability(stateDir);
  delete data.restart_counts[commit];
  data.last_healthy = commit;
  saveStability(stateDir, data);
}

/**
 * Returns true if the current HEAD commit has accumulated enough failures
 * to warrant a rollback.
 *
 * @param stateDir  Agent's state directory.
 * @param repoRoot  Git repository root, or null if not in a git repo.
 */
export function shouldRollback(
  stateDir: string,
  repoRoot: string | null,
): boolean {
  if (!repoRoot) return false;

  const commit = getCurrentCommit(repoRoot);
  if (!commit) return false;

  const data = loadStability(stateDir);
  return (data.restart_counts[commit] ?? 0) >= ROLLBACK_THRESHOLD;
}

/**
 * Perform a git rollback:
 *   1. Stash uncommitted work (preserving it for the agent to review).
 *   2. Determine rollback target — last_healthy commit, or origin/main.
 *   3. git reset --hard <target> on the current branch.
 *   4. Write a recovery note the agent reads on next boot.
 *
 * Returns a RollbackResult describing what happened. On any git error the
 * result has success=false and the daemon falls back to normal restart.
 */
export function performRollback(
  stateDir: string,
  repoRoot: string,
): RollbackResult {
  const failedCommit = getCurrentCommit(repoRoot) ?? 'unknown';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Step 1: stash uncommitted work
  let stashRef: string | null = null;
  try {
    execFileSync(
      'git',
      ['stash', 'push', '-u', '-m', `cct-recovery-${ts}`],
      { cwd: repoRoot, stdio: 'pipe' },
    );
    // Confirm the stash was created (git stash push is silent on nothing-to-stash)
    const stashList = execFileSync('git', ['stash', 'list', '--max-count=1'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (stashList.trim().includes('cct-recovery')) {
      stashRef = 'stash@{0}';
    }
  } catch {
    // Nothing to stash or stash failed — continue with rollback
  }

  // Step 2: determine rollback target
  const stability = loadStability(stateDir);
  let target = stability.last_healthy;

  if (!target) {
    // No healthy commit on record — fetch and use origin/main
    try {
      execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
      const originMain = execFileSync('git', ['rev-parse', 'origin/main'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      target = originMain.trim();
    } catch {
      return {
        success: false,
        rolledBackTo: '',
        stashRef,
        reason: 'Could not determine rollback target (no healthy commit, fetch failed)',
      };
    }
  }

  // Step 3: tag failed commit and reset to target
  try {
    // Tag the failed commit for post-mortem reference
    try {
      execFileSync(
        'git',
        ['tag', `failed-${ts}-${failedCommit.slice(0, 7)}`],
        { cwd: repoRoot, stdio: 'pipe' },
      );
    } catch {
      // Tagging is best-effort — tag may already exist
    }

    execFileSync('git', ['reset', '--hard', target], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch (err) {
    return {
      success: false,
      rolledBackTo: target,
      stashRef,
      reason: `git reset failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 4: write recovery note for the agent to read on next boot
  const stashNote = stashRef
    ? `\nUncommitted work was stashed as ${stashRef}. Review with: git stash show -p`
    : '';
  const note = [
    `WATCHDOG ROLLBACK — ${ts}`,
    ``,
    `The agent crashed ${ROLLBACK_THRESHOLD} times on commit ${failedCommit.slice(0, 12)}.`,
    `The daemon rolled back to: ${target.slice(0, 12)}`,
    stashNote,
    ``,
    `ACTION REQUIRED:`,
    `1. Run \`git log --oneline -10\` to review the rollback point.`,
    `2. If a stash exists, run \`git stash show -p\` to inspect what was stashed.`,
    `3. Identify what change on ${failedCommit.slice(0, 12)} caused the crash loop.`,
    `4. Write your findings to memory and notify the operator before resuming normal work.`,
    `5. Do NOT re-apply the stash until the root cause is understood.`,
  ].join('\n');

  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(recoveryNotePath(stateDir), note, 'utf-8');
  } catch {
    // Best-effort
  }

  // Update stability: clear failed commit's count, record rollback time
  stability.last_rollback_at = new Date().toISOString();
  delete stability.restart_counts[failedCommit];
  saveStability(stateDir, stability);

  return { success: true, rolledBackTo: target, stashRef, reason: '' };
}

/**
 * Read the recovery note without deleting it. Returns the note text if one
 * exists, null otherwise. Use deleteRecoveryNote() to remove it after the
 * note has been successfully delivered to the agent.
 */
export function readRecoveryNote(stateDir: string): string | null {
  const path = recoveryNotePath(stateDir);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8') || null;
  } catch {
    return null;
  }
}

/**
 * Delete the recovery note. Called after the note has been injected into a
 * prompt that was successfully delivered to the agent.
 */
export function deleteRecoveryNote(stateDir: string): void {
  const path = recoveryNotePath(stateDir);
  try {
    unlinkSync(path);
  } catch {
    // Best-effort — file may not exist
  }
}

/**
 * Read and consume the recovery note. Returns the note text if one exists,
 * null otherwise. The file is deleted after reading so it surfaces only once.
 *
 * @deprecated Prefer readRecoveryNote() + deleteRecoveryNote() so the note
 * is only deleted after the prompt that contains it has been delivered.
 */
export function consumeRecoveryNote(stateDir: string): string | null {
  const note = readRecoveryNote(stateDir);
  if (note) deleteRecoveryNote(stateDir);
  return note;
}

// ---------------------------------------------------------------------------
// Clean-exit flag (daemon-idle-flag)
// ---------------------------------------------------------------------------
// Durable marker written when handleExit classifies a PTY exit as clean (not
// a crash). The flag persists across daemon restarts, letting external
// tooling — bus watchdog CLI, Frank2 fleet health, post-mortem inspection —
// distinguish "agent intentionally stopped" from "agent crashed" even after
// the in-memory state (stopRequested, .daemon-stop marker) is gone.
//
// Writers: AgentProcess.handleExit() short-circuit branches.
// Reader: AgentProcess.start() — consumes once per lifecycle for boot log.
//
// Per Sage audit 2026-04-20: kept as a standalone file (not consolidated
// into state.json) because atomic-write semantics are per-file; a shared
// state.json would open read-modify-write races during crash windows.

export type CleanExitReason =
  | 'intentional-stop'    // stop() was called (operator or programmatic)
  | 'daemon-shutdown'     // PM2/daemon-going-down cascade
  | 'rate-limit-pause';   // Anthropic rate-limit signature detected

export interface CleanExitRecord {
  exit_code: number;
  reason: CleanExitReason;
  ts: number;
  commit?: string;
}

function cleanExitPath(stateDir: string): string {
  return join(stateDir, 'clean_exit.flag');
}

/**
 * Atomically write a clean-exit marker. Called from handleExit() short-circuit
 * branches. Best-effort — never throws (watchdog must not surface errors
 * from inside an already-failing exit path).
 *
 * @param stateDir  Agent's state directory ({ctxRoot}/state/{agentName}).
 * @param exitCode  The PTY exit code (may be non-zero for rate-limit cases).
 * @param reason    Classification tag for external tooling.
 * @param repoRoot  Git repo root (optional) — if provided, current HEAD
 *                  is recorded alongside the flag for post-mortem context.
 */
export function recordCleanExit(
  stateDir: string,
  exitCode: number,
  reason: CleanExitReason,
  repoRoot: string | null = null,
): void {
  const record: CleanExitRecord = {
    exit_code: exitCode,
    reason,
    ts: Math.floor(Date.now() / 1000),
  };
  if (repoRoot) {
    const commit = getCurrentCommit(repoRoot);
    if (commit) record.commit = commit;
  }
  try {
    atomicWriteSync(cleanExitPath(stateDir), JSON.stringify(record));
  } catch {
    // Best-effort — never throw from the watchdog
  }
}

/**
 * Read the clean-exit flag without deleting it. Returns { clean: true, ... }
 * if a valid flag exists; { clean: false } otherwise.
 *
 * A corrupt or partial-write flag returns clean:false rather than throwing.
 * Silently claiming "everything was fine" from an unreadable marker is worse
 * than ignoring it and letting the watchdog run normally.
 */
export function readCleanExit(stateDir: string): {
  clean: boolean;
  reason: CleanExitReason | null;
  ts: number | null;
  exit_code: number | null;
} {
  const path = cleanExitPath(stateDir);
  if (!existsSync(path)) {
    return { clean: false, reason: null, ts: null, exit_code: null };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CleanExitRecord>;
    if (
      typeof parsed.reason === 'string' &&
      typeof parsed.ts === 'number' &&
      typeof parsed.exit_code === 'number'
    ) {
      return {
        clean: true,
        reason: parsed.reason as CleanExitReason,
        ts: parsed.ts,
        exit_code: parsed.exit_code,
      };
    }
  } catch {
    // Corrupt flag — fall through to clean:false
  }
  return { clean: false, reason: null, ts: null, exit_code: null };
}

/**
 * Delete the clean-exit flag. Called from AgentProcess.start() after the
 * flag has been read, so it surfaces only once per lifecycle.
 *
 * Edge case: if start() deletes the flag but the boot itself fails before
 * the agent runs, the clean marker is gone and no crash has occurred yet.
 * Low risk — the watchdog 3-failure threshold absorbs this rare case.
 */
export function deleteCleanExit(stateDir: string): void {
  const path = cleanExitPath(stateDir);
  try {
    unlinkSync(path);
  } catch {
    // Best-effort — ENOENT is common and safe
  }
}
