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

/**
 * A recorded process: identity (`command`) alongside the pid, so a sweep can
 * tell "the process I meant" from "whatever holds that pid now".
 */
export interface ProcessSnapshotEntry {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * Snapshot the live process table WITH command lines.
 * Returns [] on any failure (unsupported platform, ps error).
 */
export function readProcessSnapshot(): ProcessSnapshotEntry[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execSync('ps -axo pid=,ppid=,command=', { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return [];
  }
  const entries: ProcessSnapshotEntry[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) entries.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return entries;
}

/**
 * Record the descendant set of `rootPids` — pids AND their command lines —
 * WHILE THE ROOTS ARE STILL ALIVE. Roots themselves are not included.
 *
 * This exists because of the ordering trap that caused the knox-codex incident
 * (2026-09-08): once a parent dies, the kernel reparents its children to pid 1,
 * so `listDescendantPids([deadParent])` returns an EMPTY set — the walk finds
 * nothing precisely when there is an orphan to find. Take this snapshot before
 * signalling anything, then hand it to killSnapshotSurvivors() afterwards.
 */
export function snapshotDescendants(
  rootPids: number[],
  table: ProcessSnapshotEntry[] = readProcessSnapshot(),
): ProcessSnapshotEntry[] {
  const byPid = new Map(table.map((e) => [e.pid, e]));
  const descendantPids = listDescendantPids(
    rootPids,
    table.map(({ pid, ppid }) => ({ pid, ppid })),
  );
  const out: ProcessSnapshotEntry[] = [];
  for (const pid of descendantPids) {
    const entry = byPid.get(pid);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * An entry this call could not positively confirm one way or the other:
 * signalled but still present after the verification read (not yet reaped,
 * or the signal was trapped/ineffective), a kill attempt that failed with
 * something other than ESRCH (e.g. EPERM — recycled to a foreign-uid owner,
 * or any other unexpected failure), or a verification read this call could
 * not trust (ps failure). `reason` is a short, human-readable explanation for
 * post-incident logs — never machine-parsed.
 */
export interface UnresolvedSurvivor {
  entry: ProcessSnapshotEntry;
  reason: string;
}

/**
 * Task 2.6: structured outcome of a sweep, replacing the old bare
 * `number[]` ("signal sent") return. Four buckets distinguish what the old
 * shape could not: confirmed gone, ambiguous, already gone, and recycled
 * (never ours). `signalled` is kept for logging and as the superset the
 * verification pass below narrows into `confirmedAbsent` vs `unresolved`.
 */
export interface KillSnapshotSurvivorsResult {
  /** pids this call actually SIGKILLed (signal delivered without an
   * immediate ESRCH/EPERM) — the old `number[]` semantic. NOT proof of
   * absence by itself; see `confirmedAbsent`/`unresolved`. */
  signalled: number[];
  /** Entries SIGKILLed by this call AND subsequently confirmed absent from a
   * fresh process-table read. The only entries safe to call "retired". */
  confirmedAbsent: ProcessSnapshotEntry[];
  /** Entries whose fate this call could not positively confirm. Ambiguity
   * here must NEVER be promoted to `confirmedAbsent` by a caller. */
  unresolved: UnresolvedSurvivor[];
  /** Entries that had already exited cleanly before this call touched
   * them — clean, not an orphan, not a failure. */
  alreadyGone: ProcessSnapshotEntry[];
  /** Entries whose pid was recycled by an unrelated process before this call
   * ran — explicitly NOT ours to kill, per the identity guard below. */
  recycled: ProcessSnapshotEntry[];
}

/**
 * SIGKILL every entry from a prior snapshotDescendants() that is STILL ALIVE and
 * STILL THE SAME PROGRAM, then VERIFY each one actually died. Upgrades the
 * pre-Task-2.6 contract ("signal sent") to a structured result that
 * distinguishes verified absence from mere ambiguity — "signal sent" and
 * "timeout elapsed" stop counting as done.
 *
 * Safety rails (unchanged from the original, pre-verification implementation):
 * - pid-recycling guard: a pid is killed only if its CURRENT command still
 *   matches what the snapshot recorded. Up to ~21s can pass between snapshot
 *   and sweep (the graceful-stop window), which is ample time for the OS to
 *   hand that pid to something else. Liveness alone is not identity.
 * - pid <= 1 and this process are never signalled.
 * - ESRCH from the kill itself means the process died between the liveness
 *   check and the kill call — genuinely gone, not a failure. Anything else
 *   (EPERM, etc.) is ambiguous and lands in `unresolved`, never swallowed
 *   into a false "done".
 *
 * Verification pass (new in Task 2.6): a single fresh process-table read
 * after the kill loop above — NOT a poll/sleep loop, so this adds no new
 * timing to the existing kill sequence. Pass `opts.verifyTable` to inject a
 * deterministic post-kill table (tests); production calls take a real,
 * fresh `readProcessSnapshot()`. An empty, non-injected verification table is
 * treated as an unreliable read (ps failure), never as proof every signalled
 * pid is gone — a real host always has something running.
 */
export function killSnapshotSurvivors(
  snapshot: ProcessSnapshotEntry[],
  opts: {
    table?: ProcessSnapshotEntry[];
    verifyTable?: ProcessSnapshotEntry[];
    killFn?: (pid: number, signal: NodeJS.Signals) => void;
    log?: (msg: string) => void;
  } = {},
): KillSnapshotSurvivorsResult {
  const result: KillSnapshotSurvivorsResult = {
    signalled: [],
    confirmedAbsent: [],
    unresolved: [],
    alreadyGone: [],
    recycled: [],
  };
  if (snapshot.length === 0) return result;

  const killFn = opts.killFn ?? ((pid, signal) => process.kill(pid, signal));
  const table = opts.table ?? readProcessSnapshot();
  const current = new Map(table.map((e) => [e.pid, e.command]));

  const signalledEntries: ProcessSnapshotEntry[] = [];
  for (const entry of snapshot) {
    const { pid, command } = entry;
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    const nowCommand = current.get(pid);
    if (nowCommand === undefined) { result.alreadyGone.push(entry); continue; }  // exited cleanly — nothing to do
    if (nowCommand !== command) { result.recycled.push(entry); continue; }      // pid recycled — NOT ours to kill
    try {
      killFn(pid, 'SIGKILL');
      result.signalled.push(pid);
      signalledEntries.push(entry);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ESRCH') {
        // Died between our liveness check and the kill call — genuinely gone.
        result.alreadyGone.push(entry);
      } else {
        // EPERM or anything unexpected: we neither delivered the signal nor
        // can rule out this is still a live process we simply can't touch.
        // Ambiguity is never reported as done.
        result.unresolved.push({
          entry,
          reason: code ? `kill failed: ${code}` : 'kill failed: unknown error',
        });
      }
    }
  }

  if (signalledEntries.length > 0) {
    let verifyTable: ProcessSnapshotEntry[];
    let verifyReliable = true;
    if (opts.verifyTable) {
      verifyTable = opts.verifyTable;
    } else {
      verifyTable = readProcessSnapshot();
      if (verifyTable.length === 0) verifyReliable = false;
    }
    const verifyCurrent = new Map(verifyTable.map((e) => [e.pid, e.command]));
    for (const entry of signalledEntries) {
      if (!verifyReliable) {
        result.unresolved.push({
          entry,
          reason: 'verification read unavailable (ps failure) — absence not confirmed',
        });
      } else if (verifyCurrent.has(entry.pid)) {
        result.unresolved.push({
          entry,
          reason: 'still present after SIGKILL — not yet reaped, or unkillable',
        });
      } else {
        result.confirmedAbsent.push(entry);
      }
    }
  }

  if (result.signalled.length > 0 && opts.log) {
    opts.log(
      `killSnapshotSurvivors: SIGKILLed ${result.signalled.length} orphaned descendant(s): ${result.signalled.join(', ')}`,
    );
  }
  return result;
}
