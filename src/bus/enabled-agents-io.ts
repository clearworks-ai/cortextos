/**
 * enabled-agents-io.ts — Single source of truth for enabled-agents.json I/O.
 *
 * Mirrors the proven crons.ts pattern:
 *   - All reads and writes go through withFileLockSync (config dir as lock dir)
 *     so concurrent daemon/CLI processes always serialize on this file.
 *   - Writes use atomicWriteSync with keepBak=true so the previous version is
 *     preserved as enabled-agents.json.bak for single-step recovery.
 *   - On parse failure, the reader falls back to the .bak file.
 *   - If both primary and .bak are corrupt, the primary is quarantined to
 *     enabled-agents.json.broken-<timestamp> and the function returns {} so the
 *     daemon defaults agents to enabled (preserving current default-on semantics).
 *   - NEVER throws — always degrades to {} on unrecoverable error.
 *
 * WS2 (CLI enable/disable commands, agent-manager) should import from this
 * module instead of reading/writing enabled-agents.json directly.
 */

import { existsSync, readFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type EnabledAgentEntry = {
  enabled?: boolean;
  org?: string;
  status?: string;
};

export type EnabledAgentsMap = Record<string, EnabledAgentEntry>;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to enabled-agents.json for a given CTX_ROOT.
 */
export function enabledAgentsPath(ctxRoot: string): string {
  return join(ctxRoot, 'config', 'enabled-agents.json');
}

/**
 * Returns the directory used as the lock root for enabled-agents.json
 * operations.  All readers and writers acquire the mutex on this directory,
 * so they serialize even when running as separate OS processes.
 */
export function enabledAgentsLockDir(ctxRoot: string): string {
  return join(ctxRoot, 'config');
}

// ---------------------------------------------------------------------------
// Internal pure parser (no lock — callers hold the lock already)
// ---------------------------------------------------------------------------

/**
 * Parse raw JSON into an EnabledAgentsMap.
 * Returns the map on success, or null if the JSON is missing, invalid, or has
 * the wrong shape (null / array / non-object).
 * Emits a warning to stderr on parse or shape failures.
 */
function parseEnabledAgentsRaw(raw: string, label: string): EnabledAgentsMap | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[enabled-agents] WARNING: failed to parse ${label}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    process.stderr.write(
      `[enabled-agents] WARNING: ${label} has unexpected shape (expected plain object).\n`,
    );
    return null;
  }

  return parsed as EnabledAgentsMap;
}

/**
 * Internal read helper — assumes the caller already holds the config-dir lock.
 * Reads and parses the primary file, falls back to .bak on failure, quarantines
 * a broken primary if both fail. Returns {} on all unrecoverable errors.
 */
function readEnabledAgentsMapLocked(ctxRoot: string): EnabledAgentsMap {
  const filePath = enabledAgentsPath(ctxRoot);

  if (!existsSync(filePath)) {
    return {};
  }

  // Attempt to read and parse the primary file.
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
    const parsed = parseEnabledAgentsRaw(raw, 'enabled-agents.json');
    if (parsed !== null) {
      return parsed;
    }
  } catch (err) {
    process.stderr.write(
      `[enabled-agents] WARNING: failed to read enabled-agents.json — ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Primary failed — attempt .bak recovery.
  const bakPath = filePath + '.bak';
  if (existsSync(bakPath)) {
    process.stderr.write(
      `[enabled-agents] WARNING: falling back to enabled-agents.json.bak\n`,
    );
    try {
      const bakRaw = readFileSync(bakPath, 'utf-8');
      const bakParsed = parseEnabledAgentsRaw(bakRaw, 'enabled-agents.json.bak');
      if (bakParsed !== null) {
        return bakParsed;
      }
    } catch (err) {
      process.stderr.write(
        `[enabled-agents] WARNING: failed to read enabled-agents.json.bak — ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // Both primary and .bak failed — quarantine the primary so operators can
  // inspect it, then degrade to an empty map (default-on for all agents).
  if (existsSync(filePath)) {
    const brokenPath = `${filePath}.broken-${Date.now()}`;
    try {
      renameSync(filePath, brokenPath);
      process.stderr.write(
        `[enabled-agents] WARNING: quarantined corrupt enabled-agents.json to ${brokenPath}\n`,
      );
    } catch {
      // Best-effort; if rename fails the caller still gets {}
    }
  }

  return {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the enabled-agents map from disk.
 *
 * Acquires the config-dir lock so no concurrent writer can be mid-rename while
 * we read (preventing observation of a half-written file).
 *
 * Returns {} when:
 *   - The file does not exist (first-run / clean state).
 *   - The file (and its .bak) cannot be parsed — the corrupt primary is
 *     quarantined and {} is returned so the daemon defaults agents to enabled.
 *
 * Never throws.
 */
export function readEnabledAgentsMap(ctxRoot: string): EnabledAgentsMap {
  const lockDir = enabledAgentsLockDir(ctxRoot);
  mkdirSync(lockDir, { recursive: true });

  return withFileLockSync(lockDir, () => readEnabledAgentsMapLocked(ctxRoot));
}

/**
 * Write the enabled-agents map to disk atomically.
 *
 * Acquires the config-dir lock, ensures the config directory exists, then
 * calls atomicWriteSync with keepBak=true so the previous version is preserved
 * as enabled-agents.json.bak before the new file is swapped in.
 */
export function writeEnabledAgentsMap(ctxRoot: string, agents: EnabledAgentsMap): void {
  const lockDir = enabledAgentsLockDir(ctxRoot);
  ensureDir(lockDir);

  withFileLockSync(lockDir, () => {
    atomicWriteSync(enabledAgentsPath(ctxRoot), JSON.stringify(agents, null, 2), true);
  });
}

/**
 * Transactional read-modify-write for the enabled-agents map.
 *
 * Acquires the config-dir lock ONCE, then reads the current map, calls `fn`
 * to mutate it (fn may mutate in place and return void, or return a new map),
 * writes the result atomically (keepBak=true), and returns the written map.
 *
 * Because read and write happen inside the same lock acquisition, no concurrent
 * process can interleave between them — closing the TOCTOU window that could
 * cause lost updates when two callers enable/disable different agents at once
 * (e.g. the sage enable/disable race).
 *
 * WS2's CLI `enable-agent` and `disable-agent` commands should call this
 * instead of performing a separate read + write.
 *
 * Never throws — if the read degrades to {}, fn receives {} and the written
 * result is whatever fn returns.
 */
export function mutateEnabledAgentsMap(
  ctxRoot: string,
  fn: (agents: EnabledAgentsMap) => EnabledAgentsMap | void,
): EnabledAgentsMap {
  const lockDir = enabledAgentsLockDir(ctxRoot);
  ensureDir(lockDir);

  return withFileLockSync(lockDir, () => {
    // Read without re-acquiring the lock (we already hold it).
    const current = readEnabledAgentsMapLocked(ctxRoot);

    // Apply the mutation: fn may mutate `current` in place (return void) or
    // return a brand-new map object.
    const result = fn(current);
    const next: EnabledAgentsMap = result !== undefined && result !== null ? result : current;

    // Write atomically with .bak preserved.
    atomicWriteSync(enabledAgentsPath(ctxRoot), JSON.stringify(next, null, 2), true);

    return next;
  });
}
