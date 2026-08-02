/**
 * process-tree — best-effort process-tree enumeration + kill (RW-3 fix).
 *
 * FORK-ONLY MODULE (intentional divergence from upstream): upstream cortextos
 * runs claude in-process via node-pty, so a dead agent process has no
 * daemon-invisible descendants. This fork's pty-host architecture (kept per
 * the proven node-pty native leak) creates a 3-level tree:
 *
 *   daemon → pty-host (forked child) → claude (node-pty spawn) → MCP servers…
 *
 * The phantom-registry reconciler (agent-manager.ts reconcileDeadRegistryEntry)
 * previously deleted the registry Map entry WITHOUT killing this tree, which
 * authorized a fresh spawn on top of still-live orphans — the confirmed
 * accumulation loop behind the 2026-08-01 posix_spawnp fleet death
 * (state/v9-fleet-incident/UPSTREAM-ROOT-WOUND.md, RW-3). This module is the
 * kill/reap half of the KEEP-BUT-FIX; it is slated for removal together with
 * the reconciler once RW-1 (churn) + RW-6 (reaper) land and hold.
 *
 * All functions are synchronous and best-effort: any ps/taskkill failure
 * degrades to a no-op rather than throwing into daemon start paths.
 */

import { execSync } from 'child_process';

export interface ProcessTableEntry {
  pid: number;
  ppid: number;
}

/**
 * Snapshot the live process table as {pid, ppid} pairs.
 * Returns [] on any failure (unsupported platform, ps error).
 */
export function readProcessTable(): ProcessTableEntry[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execSync('ps -axo pid=,ppid=', { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return [];
  }
  const entries: ProcessTableEntry[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) entries.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return entries;
}

/**
 * BFS the descendant set of `rootPids` over a process-table snapshot.
 * Roots themselves are NOT included in the result.
 */
export function listDescendantPids(
  rootPids: number[],
  table: ProcessTableEntry[] = readProcessTable(),
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const { pid, ppid } of table) {
    const list = childrenOf.get(ppid);
    if (list) list.push(pid);
    else childrenOf.set(ppid, [pid]);
  }

  const seen = new Set<number>(rootPids);
  const queue = [...rootPids];
  const descendants: number[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

/**
 * Parse a POSIX `ps -o etime=` value ([[dd-]hh:]mm:ss) into seconds.
 * Returns null on unparseable input.
 */
export function parseEtimeToSeconds(etime: string): number | null {
  const m = etime.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const mins = Number(m[3]);
  const secs = Number(m[4]);
  return ((days * 24 + hours) * 60 + mins) * 60 + secs;
}

/**
 * Elapsed wall-clock seconds since `pid` started, via `ps -o etime=`.
 * Returns null when unavailable (dead pid, win32, ps failure) — callers must
 * treat null as "unknown", never as evidence either way.
 */
export function getProcessElapsedSeconds(pid: number): number | null {
  if (process.platform === 'win32') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execSync(`ps -p ${pid} -o etime=`, { encoding: 'utf-8', timeout: 5000 });
    return parseEtimeToSeconds(out);
  } catch {
    return null;
  }
}

/**
 * SIGKILL every root in `rootPids` plus every live descendant, best-effort.
 *
 * Safety rails:
 * - pid <= 1, the daemon's own pid, and non-integers are never signaled.
 * - ESRCH (already dead) and EPERM (recycled by a foreign-uid process — not
 *   ours, and unkillable by us anyway) are silently ignored.
 * - Descendants are computed from ONE snapshot taken before any signal is
 *   sent, so a parent dying mid-loop cannot hide its children from the sweep.
 *
 * Returns the list of pids that were actually signaled successfully.
 */
export function killProcessTree(
  rootPids: number[],
  log?: (msg: string) => void,
): number[] {
  const roots = [...new Set(rootPids)].filter(
    (p) => Number.isInteger(p) && p > 1 && p !== process.pid,
  );
  if (roots.length === 0) return [];

  if (process.platform === 'win32') {
    const killed: number[] = [];
    for (const pid of roots) {
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { timeout: 5000, stdio: 'ignore' });
        killed.push(pid);
      } catch { /* already gone or access denied — best effort */ }
    }
    return killed;
  }

  const table = readProcessTable();
  const descendants = listDescendantPids(roots, table).filter(
    (p) => p > 1 && p !== process.pid,
  );
  const targets = [...roots, ...descendants];

  const killed: number[] = [];
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch { /* ESRCH: already dead; EPERM: recycled foreign pid — skip */ }
  }
  if (killed.length > 0 && log) {
    log(`killProcessTree: SIGKILLed ${killed.length} pid(s): ${killed.join(', ')}`);
  }
  return killed;
}
