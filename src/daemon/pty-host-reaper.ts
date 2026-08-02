/**
 * pty-host-reaper — periodic reaper for orphaned pty-host processes (RW-6).
 *
 * WHY THIS EXISTS (explicit ADD, not upstream divergence): upstream/main
 * allocates node-pty in-process and has no src/pty/pty-host-client.ts — it
 * structurally cannot leak host processes and therefore has no reaper. The
 * fork's fork-per-PTY pty-host architecture (kept per fleet decision: proven
 * /dev/ptmx native leak) mints one child process per PTY, and until RW-6 any
 * abandoned host + its claude grandchild were unfindable and permanent — the
 * confirmed multi-day orphan accumulation that ends in posix_spawnp refusal
 * and overnight fleet death.
 *
 * The reaper sweeps on a fixed cadence and kills the process GROUP of any
 * host not owned by a live registry entry:
 *
 *  Tier 1 — ledger entries whose owning daemon is DEAD (prior incarnation):
 *           unambiguous orphans; group-kill host + pty child after grace.
 *  Tier 2 — ledger entries owned by THIS daemon but no longer tracked by the
 *           pty-host client (host exited, pty child survived — the RW-4
 *           SIGKILL-race orphan): kill the surviving pty child's group.
 *  Tier 3 — ledger entries owned by THIS daemon, host alive and tracked, but
 *           NOT owned by any live registry entry (RW-3 delete-without-kill,
 *           RW-5 wedged spawns): killed only after the condition persists
 *           across TWO consecutive sweeps, so transient registry windows
 *           (mid-restart) can never kill a healthy agent.
 *  Tier 4 — stray scan: any `pty-host-entry` process reparented to pid 1
 *           (its daemon is gone; the disconnect self-exit failed) that this
 *           process doesn't track. This is the cleanup path for the standing
 *           pre-ledger orphan population. Its direct children are killed
 *           (by group) before the host itself.
 *
 * Safety rails:
 *  - grace period: nothing younger than graceMs is ever touched.
 *  - pid-recycling guard: a pid is only killed if `ps` shows a command line
 *    matching what the ledger recorded (pty-host-entry / the spawned binary).
 *  - entries recorded by a DIFFERENT but still-live daemon pid are skipped.
 *  - all kills are best-effort; the sweep never throws.
 */

import { execFileSync } from 'child_process';
import { basename } from 'path';
import {
  ledgerPathFor,
  readPtyHostLedger,
  removePtyHost,
  isPidAlive,
  type PtyHostLedgerEntry,
} from '../pty/pty-host-ledger.js';
import { getLiveHostPids } from '../pty/pty-host-client.js';

export interface PsEntry {
  pid: number;
  ppid: number;
  command: string;
}

export interface PtyHostReaperOptions {
  /** Sweep cadence. Default 5 minutes. */
  intervalMs?: number;
  /** Delay before the first sweep after start(). Default 2 minutes. */
  initialDelayMs?: number;
  /** Minimum ledger-entry age before it can be reaped. Default 10 minutes. */
  graceMs?: number;
  /** Host pids currently owned by a live registry entry (agents + workers).
   * When provided, tier 3 (registry-unowned) reaping is enabled. */
  getOwnedHostPids?: () => ReadonlySet<number>;
  /** Injectable process table (tests). Default: `ps -axo pid=,ppid=,command=`. */
  psList?: () => PsEntry[];
  /** Injectable kill (tests). Default: process.kill. */
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
  /** Injectable live-host set (tests). Default: pty-host-client's set. */
  getLiveHosts?: () => ReadonlySet<number>;
  /** Injectable pid-liveness probe (tests). Default: signal-0. */
  isPidAliveFn?: (pid: number) => boolean;
  log?: (msg: string) => void;
}

export const DEFAULT_REAPER_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_REAPER_INITIAL_DELAY_MS = 2 * 60 * 1000;
export const DEFAULT_REAPER_GRACE_MS = 10 * 60 * 1000;

/** Marker that identifies a pty-host process on a `ps` command line. */
const HOST_MARKER = 'pty-host-entry';

function defaultPsList(): PsEntry[] {
  if (process.platform === 'win32') return [];
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const entries: PsEntry[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      entries.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
    }
    return entries;
  } catch {
    return [];
  }
}

export class PtyHostReaper {
  private readonly ledgerPath: string;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly graceMs: number;
  private readonly getOwnedHostPids?: () => ReadonlySet<number>;
  private readonly psList: () => PsEntry[];
  private readonly killFn: (pid: number, signal: NodeJS.Signals) => void;
  private readonly getLiveHosts: () => ReadonlySet<number>;
  private readonly isPidAliveFn: (pid: number) => boolean;
  private readonly log: (msg: string) => void;

  private initialTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Tier-3 two-sweep persistence: host pids flagged registry-unowned last sweep. */
  private pendingRegistryOrphans = new Set<number>();

  constructor(ctxRoot: string, opts: PtyHostReaperOptions = {}) {
    this.ledgerPath = ledgerPathFor(ctxRoot);
    this.intervalMs = opts.intervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
    this.initialDelayMs = opts.initialDelayMs ?? DEFAULT_REAPER_INITIAL_DELAY_MS;
    this.graceMs = opts.graceMs ?? DEFAULT_REAPER_GRACE_MS;
    this.getOwnedHostPids = opts.getOwnedHostPids;
    this.psList = opts.psList ?? defaultPsList;
    this.killFn = opts.killFn ?? ((pid, sig) => process.kill(pid, sig));
    this.getLiveHosts = opts.getLiveHosts ?? getLiveHostPids;
    this.isPidAliveFn = opts.isPidAliveFn ?? isPidAlive;
    this.log = opts.log ?? ((msg) => console.log(`[pty-reaper] ${msg}`));
  }

  start(): void {
    if (this.timer || this.initialTimer) return;
    this.initialTimer = setTimeout(() => {
      this.sweep();
      this.timer = setInterval(() => this.sweep(), this.intervalMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }, this.initialDelayMs);
    if (typeof this.initialTimer.unref === 'function') this.initialTimer.unref();
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Pids already signalled in the current sweep — prevents the stray scan
   * re-killing a pid the ledger tier just handled (ps snapshot is stale). */
  private killedThisSweep = new Set<number>();

  /** One reap pass. Public so tests (and ops tooling) can invoke it directly. */
  sweep(): void {
    this.killedThisSweep.clear();
    try {
      this.sweepLedger();
      this.sweepStrays();
    } catch (err) {
      // The reaper must never take the daemon down.
      this.log(`sweep error (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sweepLedger(): void {
    const entries = readPtyHostLedger(this.ledgerPath);
    if (entries.length === 0) {
      this.pendingRegistryOrphans.clear();
      return;
    }
    const ps = this.psList();
    const byPid = new Map<number, PsEntry>();
    for (const p of ps) byPid.set(p.pid, p);

    const live = this.getLiveHosts();
    const owned = this.getOwnedHostPids ? this.getOwnedHostPids() : null;
    const now = Date.now();
    const nextPending = new Set<number>();

    for (const entry of entries) {
      const hostPs = byPid.get(entry.hostPid);
      // Pid-recycling guard: only treat the pid as "our host" if ps agrees.
      const hostAlive = !!hostPs && hostPs.command.includes(HOST_MARKER);
      const ptyPs = entry.ptyPid > 0 ? byPid.get(entry.ptyPid) : undefined;
      const ptyAlive = !!ptyPs && commandMatchesFile(ptyPs.command, entry.file);

      if (!hostAlive && !ptyAlive) {
        // Everything is gone (or the pids were recycled) — just clean up.
        removePtyHost(this.ledgerPath, entry.hostPid);
        continue;
      }

      if (now - entry.startedAt < this.graceMs) continue;

      const isSelf = entry.daemonPid === process.pid;
      if (!isSelf && this.isPidAliveFn(entry.daemonPid)) {
        // Recorded by a different daemon that is still alive — not ours to reap.
        continue;
      }

      let reap = false;
      let tier = '';
      if (!isSelf) {
        // Tier 1: owning daemon is dead.
        reap = true;
        tier = 'dead-daemon';
      } else if (!live.has(entry.hostPid)) {
        // Tier 2: our fork, but the client no longer tracks it. Either the
        // host exited leaving a surviving pty child (RW-4 race), or the
        // in-memory state was lost. Both are orphans.
        reap = true;
        tier = hostAlive ? 'untracked-host' : 'surviving-pty-child';
      } else if (owned !== null && !owned.has(entry.hostPid)) {
        // Tier 3: tracked by the client but no live registry entry owns it
        // (RW-3 delete-without-kill / RW-5 wedged spawn). Require the
        // condition to persist across two sweeps before killing.
        if (this.pendingRegistryOrphans.has(entry.hostPid)) {
          reap = true;
          tier = 'registry-unowned';
        } else {
          nextPending.add(entry.hostPid);
        }
      }

      if (!reap) continue;

      this.log(
        `reaping ${tier} pty-host ${entry.hostPid} (agent=${entry.agent || '?'}, ` +
        `file=${entry.file}, ptyPid=${entry.ptyPid}, daemonPid=${entry.daemonPid}, ` +
        `age=${Math.round((now - entry.startedAt) / 1000)}s)`,
      );
      this.killEntry(entry, hostAlive, ptyAlive);
      removePtyHost(this.ledgerPath, entry.hostPid);
    }

    this.pendingRegistryOrphans = nextPending;
  }

  /**
   * Tier 4 — stray scan: pty-host-entry processes reparented to pid 1 whose
   * pids this process doesn't track and the ledger doesn't know. This is the
   * cleanup mechanism for the pre-ledger standing orphan population.
   */
  private sweepStrays(): void {
    if (process.platform === 'win32') return;
    const ps = this.psList();
    if (ps.length === 0) return;
    const live = this.getLiveHosts();
    const ledgerPids = new Set(readPtyHostLedger(this.ledgerPath).map(e => e.hostPid));

    for (const p of ps) {
      if (!p.command.includes(HOST_MARKER)) continue;
      if (p.ppid !== 1) continue;               // still has a live parent daemon
      if (p.pid === process.pid) continue;
      if (live.has(p.pid)) continue;            // ours and tracked
      if (ledgerPids.has(p.pid)) continue;      // ledger tiers handle it
      if (this.killedThisSweep.has(p.pid)) continue; // already handled this sweep
      this.log(`reaping stray orphaned pty-host ${p.pid} (ppid=1): ${p.command.slice(0, 120)}`);
      // Kill the host's direct children first (their own groups — node-pty
      // children are session leaders, so the host group won't reach them).
      for (const c of ps) {
        if (c.ppid !== p.pid) continue;
        this.groupKill(c.pid);
      }
      this.groupKill(p.pid);
    }
  }

  private killEntry(entry: PtyHostLedgerEntry, hostAlive: boolean, ptyAlive: boolean): void {
    // pty child first: it is a session leader (node-pty setsid), so it lives
    // in its OWN group and would not be reached by the host's group kill.
    if (ptyAlive) this.groupKill(entry.ptyPid);
    if (hostAlive) this.groupKill(entry.hostPid);
  }

  /** SIGKILL a pid's process group, then the pid itself. Best-effort. */
  private groupKill(pid: number): void {
    if (!pid || pid <= 0) return;
    this.killedThisSweep.add(pid);
    if (process.platform !== 'win32') {
      try { this.killFn(-pid, 'SIGKILL'); } catch { /* no such group */ }
    }
    try { this.killFn(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** Does a ps command line plausibly refer to the binary the ledger recorded? */
function commandMatchesFile(command: string, file: string): boolean {
  if (!file) return true; // nothing recorded — cannot apply the guard
  const base = basename(file);
  return command.includes(base);
}
