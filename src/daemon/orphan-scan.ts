/**
 * orphan-scan — find leaked runtime processes squatting an agent's state dir.
 *
 * WHY THIS EXISTS (knox-codex, 2026-09-08). A runtime process that outlives its
 * agent reparents to launchd and keeps writing that agent's state dir:
 * heartbeat.json stays fresh, the thread file keeps updating, turns keep being
 * billed, and the daemon believes the agent was replaced. knox carried two
 * generations of these simultaneously while two restarts failed to displace the
 * session.
 *
 * WHY THIS ONLY REPORTS. The pty-host ledger records hostPid and ptyPid — not
 * the ptyPid's own child, which is what leaks. Nothing on disk can identify one
 * of these, so an automatic reaper would have to fall back on "SIGKILL any
 * ppid=1 process that looks like a runtime binary", and on this machine that
 * also matches the user's own detached `codex` sessions. Detection is safe;
 * the kill stays a human decision.
 *
 * Prevention lives at the source, in AgentProcess.stop(), which snapshots and
 * sweeps its child's descendants. This scan is the backstop for orphans created
 * before that fix — and the thing that makes the failure legible at all.
 */

import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { sep } from 'path';

export interface PsRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface OrphanCandidate extends PsRow {
  cwd: string;
  /** The agent whose state dir this process is holding. */
  agent: string;
}

export interface OrphanScanInput {
  /** `<ctxRoot>/state` — agent state dirs are its immediate children. */
  stateRoot: string;
  psList: () => PsRow[];
  /** A process's cwd, or null when unreadable (foreign uid, already exited). */
  cwdOf: (pid: number) => string | null;
  /** Pids the daemon still tracks; never reported whatever their ppid says. */
  liveAgentPids: Set<number>;
  /**
   * Path canonicaliser, injectable for tests. Defaults to realpathSync.
   *
   * REQUIRED, not a nicety: on macOS `ps`/`lsof` report a process cwd through
   * its canonical path, so a process started in /tmp/x reports
   * /private/tmp/x (/tmp is a symlink). Comparing raw strings silently misses
   * every orphan whose state root reaches through a symlink — caught only by
   * scanning a real reparented process, not by fixture paths.
   */
  realpath?: (p: string) => string;
}

/**
 * The agent name if `cwd` sits inside an agent's state dir, else null.
 * The state root itself is not an agent.
 */
function agentFromCwd(cwd: string, stateRoot: string): string | null {
  if (cwd === stateRoot) return null; // the root itself is not an agent
  const root = stateRoot.endsWith(sep) ? stateRoot : stateRoot + sep;
  if (!cwd.startsWith(root)) return null;
  const rest = cwd.slice(root.length);
  const name = rest.split(sep)[0];
  return name && name.length > 0 ? name : null;
}

/**
 * Reparented (ppid=1) processes whose cwd is inside an agent state dir and that
 * the daemon does not track. Read-only; never signals anything.
 */
export function findStateDirOrphans(input: OrphanScanInput): OrphanCandidate[] {
  const { psList, cwdOf, liveAgentPids } = input;
  const canonicalise = input.realpath ?? ((p: string) => {
    try { return realpathSync(p); } catch { return p; }
  });
  const stateRoot = canonicalise(input.stateRoot);
  const out: OrphanCandidate[] = [];

  let rows: PsRow[];
  try {
    rows = psList();
  } catch {
    return [];
  }

  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 1) continue;
    if (row.pid === process.pid) continue;
    // Reparenting to launchd is the signature: the parent that owned this
    // process is gone, yet it is still running.
    if (row.ppid !== 1) continue;
    if (liveAgentPids.has(row.pid)) continue;

    let cwd: string | null;
    try {
      cwd = cwdOf(row.pid);
    } catch {
      continue;
    }
    if (!cwd) continue; // unknown is not orphaned

    const agent = agentFromCwd(canonicalise(cwd), stateRoot);
    if (!agent) continue;

    out.push({ ...row, cwd, agent });
  }
  return out;
}

/** Live process table with command lines. Returns [] on any failure. */
export function readPsRows(): PsRow[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return [];
  }
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

/**
 * A process's cwd via lsof, or null. macOS has no /proc, so lsof is the only
 * route — acceptable here because this scan is on-demand (a doctor check), not
 * a poll-cycle read.
 */
export function readCwd(pid: number): string | null {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      if (line.startsWith('n')) return line.slice(1).trim();
    }
  } catch { /* no such pid, or not ours to inspect */ }
  return null;
}
