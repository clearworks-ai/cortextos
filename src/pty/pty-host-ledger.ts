/**
 * pty-host-ledger — durable on-disk PID ledger for forked pty-host processes.
 *
 * RW-6 (UPSTREAM-ROOT-WOUND): the fork's pty-host architecture forks one
 * child process per PTY (pty-host-client.ts), but until this ledger existed
 * the ONLY record of a host was the in-memory PtyHostProxy. Any abandoned
 * proxy (daemon restart/crash, wedged spawn, registry desync) left the host
 * process — and the claude grandchild inside it — unfindable and permanent.
 *
 * This is an explicit ADD, not a divergence from upstream: upstream/main has
 * no src/pty/pty-host-client.ts at all (it allocates node-pty in-process), so
 * upstream structurally cannot need, and does not have, this containment.
 * The fork's fork-per-PTY design (kept per fleet decision — proven ptmx leak)
 * requires it.
 *
 * The ledger lives at <ctxRoot>/state/pty-hosts.json and records, per host:
 * the host pid, the pid of the process spawned inside the pty (available once
 * pty-ready arrives), the binary name, the owning daemon pid, and spawn time.
 * The reaper (src/daemon/pty-host-reaper.ts) sweeps it periodically.
 *
 * Every function here is best-effort: a ledger failure must NEVER break a
 * spawn or a teardown. All writes are atomic (atomicWriteSync).
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

export interface PtyHostLedgerEntry {
  /** pid of the forked pty-host child (own process group — forked detached). */
  hostPid: number;
  /** pid of the process node-pty spawned inside the host; 0 until pty-ready. */
  ptyPid: number;
  /** binary spawned inside the pty (e.g. "claude", "codex") — used by the
   * reaper as a pid-recycling guard before killing ptyPid. */
  file: string;
  /** CTX_AGENT_NAME of the owner, when known. Diagnostic only. */
  agent: string;
  /** pid of the daemon process that forked this host. */
  daemonPid: number;
  /** epoch ms at fork time. */
  startedAt: number;
}

interface LedgerFile {
  version: 1;
  hosts: PtyHostLedgerEntry[];
}

/** Canonical ledger location for an instance. */
export function ledgerPathFor(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'pty-hosts.json');
}

/** Read all entries. Missing/corrupt file → empty list (never throws). */
export function readPtyHostLedger(ledgerPath: string): PtyHostLedgerEntry[] {
  try {
    if (!existsSync(ledgerPath)) return [];
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as LedgerFile;
    if (!parsed || !Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.filter(
      (h): h is PtyHostLedgerEntry =>
        typeof h === 'object' && h !== null && typeof h.hostPid === 'number' && h.hostPid > 0,
    );
  } catch {
    return [];
  }
}

function writeLedger(ledgerPath: string, hosts: PtyHostLedgerEntry[]): void {
  try {
    ensureDir(dirname(ledgerPath));
    const payload: LedgerFile = { version: 1, hosts };
    atomicWriteSync(ledgerPath, JSON.stringify(payload, null, 2));
  } catch {
    /* best effort — ledger failures must never break spawn/teardown */
  }
}

/** Record a freshly forked host. Replaces any stale entry with the same pid. */
export function recordPtyHost(ledgerPath: string, entry: PtyHostLedgerEntry): void {
  const hosts = readPtyHostLedger(ledgerPath).filter(h => h.hostPid !== entry.hostPid);
  hosts.push(entry);
  writeLedger(ledgerPath, hosts);
}

/** Fill in the pty child pid once pty-ready arrives from the host. */
export function updatePtyHostPtyPid(ledgerPath: string, hostPid: number, ptyPid: number): void {
  const hosts = readPtyHostLedger(ledgerPath);
  const entry = hosts.find(h => h.hostPid === hostPid);
  if (!entry) return;
  entry.ptyPid = ptyPid;
  writeLedger(ledgerPath, hosts);
}

/** Remove an entry (normal teardown, or reaper cleanup). */
export function removePtyHost(ledgerPath: string, hostPid: number): void {
  const hosts = readPtyHostLedger(ledgerPath);
  const next = hosts.filter(h => h.hostPid !== hostPid);
  if (next.length === hosts.length) return;
  writeLedger(ledgerPath, next);
}

/** Signal-0 liveness probe. EPERM counts as alive (process exists). */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
