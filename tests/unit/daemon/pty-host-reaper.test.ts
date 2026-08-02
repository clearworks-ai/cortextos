/**
 * pty-host-reaper.test.ts — RW-6 orphan reaper unit tests.
 *
 * All process-table reads and kills are injected, so these tests exercise the
 * full tier logic (dead-daemon, surviving-pty-child, registry-unowned with
 * two-sweep persistence, stray ppid-1 scan, grace period, pid-recycling
 * guards) without touching any real process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PtyHostReaper, type PsEntry } from '../../../src/daemon/pty-host-reaper.js';
import {
  ledgerPathFor,
  recordPtyHost,
  readPtyHostLedger,
  type PtyHostLedgerEntry,
} from '../../../src/pty/pty-host-ledger.js';

let ctxRoot: string;
let ledgerPath: string;
let kills: Array<{ pid: number; signal: string }>;

const OLD = Date.now() - 60 * 60 * 1000; // 1h ago — far past any grace
const HOST_CMD = 'node /repo/dist/pty/pty-host-entry.js';
const CLAUDE_CMD = 'claude --dangerously-skip-permissions';

function entry(overrides: Partial<PtyHostLedgerEntry> = {}): PtyHostLedgerEntry {
  return {
    hostPid: 500,
    ptyPid: 600,
    file: 'claude',
    agent: 'alice',
    daemonPid: process.pid,
    startedAt: OLD,
    ...overrides,
  };
}

interface ReaperSeams {
  ps?: PsEntry[];
  live?: number[];
  owned?: number[] | null;   // null → no ownership callback (tier 3 disabled)
  alivePids?: number[];      // pids isPidAliveFn reports alive
  graceMs?: number;
}

function makeReaper(seams: ReaperSeams = {}): PtyHostReaper {
  const alive = new Set(seams.alivePids ?? []);
  return new PtyHostReaper(ctxRoot, {
    graceMs: seams.graceMs ?? 10 * 60 * 1000,
    psList: () => seams.ps ?? [],
    killFn: (pid, signal) => kills.push({ pid, signal }),
    getLiveHosts: () => new Set(seams.live ?? []),
    getOwnedHostPids:
      seams.owned === null ? undefined : () => new Set(seams.owned ?? []),
    isPidAliveFn: (pid) => alive.has(pid),
    log: () => { /* silent in tests */ },
  });
}

function killedPids(): number[] {
  return kills.map(k => k.pid);
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'pty-reaper-test-'));
  ledgerPath = ledgerPathFor(ctxRoot);
  kills = [];
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('PtyHostReaper ledger tiers', () => {
  it('removes entries whose host AND pty are both gone, without killing', () => {
    recordPtyHost(ledgerPath, entry());
    makeReaper({ ps: [] }).sweep();
    expect(readPtyHostLedger(ledgerPath)).toEqual([]);
    expect(kills).toEqual([]);
  });

  it('tier 1: group-kills host + pty child of a DEAD daemon after grace', () => {
    recordPtyHost(ledgerPath, entry({ daemonPid: 40000 })); // dead daemon (not in alivePids)
    makeReaper({
      ps: [
        { pid: 500, ppid: 1, command: HOST_CMD },
        { pid: 600, ppid: 500, command: CLAUDE_CMD },
      ],
    }).sweep();
    // pty child group first, then host group (each: -pid then pid)
    expect(killedPids()).toEqual([-600, 600, -500, 500]);
    expect(kills.every(k => k.signal === 'SIGKILL')).toBe(true);
    expect(readPtyHostLedger(ledgerPath)).toEqual([]);
  });

  it('skips entries recorded by a DIFFERENT daemon that is still alive', () => {
    recordPtyHost(ledgerPath, entry({ daemonPid: 40000 }));
    makeReaper({
      ps: [{ pid: 500, ppid: 40000, command: HOST_CMD }],
      alivePids: [40000],
    }).sweep();
    expect(kills).toEqual([]);
    expect(readPtyHostLedger(ledgerPath)).toHaveLength(1);
  });

  it('grace period: nothing younger than graceMs is touched', () => {
    recordPtyHost(ledgerPath, entry({ daemonPid: 40000, startedAt: Date.now() - 1000 }));
    makeReaper({
      ps: [{ pid: 500, ppid: 1, command: HOST_CMD }],
    }).sweep();
    expect(kills).toEqual([]);
    expect(readPtyHostLedger(ledgerPath)).toHaveLength(1);
  });

  it('tier 2: kills the surviving pty child when our host died (RW-4 race orphan)', () => {
    recordPtyHost(ledgerPath, entry()); // daemonPid = us
    makeReaper({
      ps: [{ pid: 600, ppid: 1, command: CLAUDE_CMD }], // host 500 gone, claude 600 survives
      live: [],                                          // client no longer tracks it
    }).sweep();
    expect(killedPids()).toEqual([-600, 600]);
    expect(readPtyHostLedger(ledgerPath)).toEqual([]);
  });

  it('pid-recycling guard: recorded ptyPid now runs an unrelated command → no kill', () => {
    recordPtyHost(ledgerPath, entry());
    makeReaper({
      ps: [{ pid: 600, ppid: 1, command: 'vim ~/notes.txt' }], // pid recycled
      live: [],
    }).sweep();
    expect(kills).toEqual([]); // both "dead" per guard → entry just removed
    expect(readPtyHostLedger(ledgerPath)).toEqual([]);
  });

  it('pid-recycling guard: recorded hostPid now runs an unrelated command → no kill', () => {
    recordPtyHost(ledgerPath, entry({ ptyPid: 0 }));
    makeReaper({
      ps: [{ pid: 500, ppid: 1, command: 'grep foo' }], // pid recycled, not a pty-host
      live: [],
    }).sweep();
    expect(kills).toEqual([]);
    expect(readPtyHostLedger(ledgerPath)).toEqual([]);
  });

  it('tier 3: registry-unowned host needs TWO consecutive sweeps before the kill', () => {
    recordPtyHost(ledgerPath, entry());
    const ps: PsEntry[] = [
      { pid: 500, ppid: process.pid, command: HOST_CMD },
      { pid: 600, ppid: 500, command: CLAUDE_CMD },
    ];
    const reaper = makeReaper({ ps, live: [500], owned: [] });

    reaper.sweep(); // first sweep: flag only
    expect(kills).toEqual([]);
    expect(readPtyHostLedger(ledgerPath)).toHaveLength(1);

    reaper.sweep(); // second sweep: condition persisted → reap
    expect(killedPids()).toEqual([-600, 600, -500, 500]);
    expect(readPtyHostLedger(ledgerPath)).toEqual([]);
  });

  it('tier 3: flag clears if the registry re-owns the host between sweeps', () => {
    recordPtyHost(ledgerPath, entry());
    const owned = new Set<number>();
    const reaper = new PtyHostReaper(ctxRoot, {
      graceMs: 10 * 60 * 1000,
      psList: () => [{ pid: 500, ppid: process.pid, command: HOST_CMD }],
      killFn: (pid, signal) => kills.push({ pid, signal }),
      getLiveHosts: () => new Set([500]),
      getOwnedHostPids: () => owned,
      isPidAliveFn: () => false,
      log: () => { /* silent */ },
    });

    reaper.sweep();      // unowned → flagged
    owned.add(500);
    reaper.sweep();      // re-owned → no kill, pending flag cleared
    owned.delete(500);
    reaper.sweep();      // unowned again → flagged only (fresh two-sweep cycle)
    expect(kills).toEqual([]);
    expect(readPtyHostLedger(ledgerPath)).toHaveLength(1);
  });

  it('live + registry-owned host is never touched', () => {
    recordPtyHost(ledgerPath, entry());
    makeReaper({
      ps: [
        { pid: 500, ppid: process.pid, command: HOST_CMD },
        { pid: 600, ppid: 500, command: CLAUDE_CMD },
      ],
      live: [500],
      owned: [500],
    }).sweep();
    expect(kills).toEqual([]);
    expect(readPtyHostLedger(ledgerPath)).toHaveLength(1);
  });

  it('without an ownership callback, live tracked hosts are left alone (tier 3 disabled)', () => {
    recordPtyHost(ledgerPath, entry());
    const reaper = makeReaper({
      ps: [{ pid: 500, ppid: process.pid, command: HOST_CMD }],
      live: [500],
      owned: null,
    });
    reaper.sweep();
    reaper.sweep();
    expect(kills).toEqual([]);
    expect(readPtyHostLedger(ledgerPath)).toHaveLength(1);
  });
});

describe('PtyHostReaper stray scan (tier 4)', () => {
  it('kills a ppid-1 pty-host unknown to ledger and live set, children first', () => {
    makeReaper({
      ps: [
        { pid: 700, ppid: 1, command: HOST_CMD },        // stray orphan host
        { pid: 800, ppid: 700, command: CLAUDE_CMD },    // its claude child
      ],
    }).sweep();
    expect(killedPids()).toEqual([-800, 800, -700, 700]);
  });

  it('does not touch pty-hosts that still have a live parent daemon', () => {
    makeReaper({
      ps: [{ pid: 700, ppid: 12345, command: HOST_CMD }],
    }).sweep();
    expect(kills).toEqual([]);
  });

  it('does not touch ppid-1 hosts tracked by this process or present in the ledger', () => {
    recordPtyHost(ledgerPath, entry({ hostPid: 700, ptyPid: 0, startedAt: Date.now() }));
    makeReaper({
      ps: [
        { pid: 700, ppid: 1, command: HOST_CMD }, // in ledger (young → grace protects)
        { pid: 701, ppid: 1, command: HOST_CMD }, // in live set
      ],
      live: [701],
    }).sweep();
    expect(kills).toEqual([]);
  });

  it('ignores non-pty-host ppid-1 processes entirely', () => {
    makeReaper({
      ps: [{ pid: 700, ppid: 1, command: '/usr/sbin/somedaemon' }],
    }).sweep();
    expect(kills).toEqual([]);
  });
});

describe('PtyHostReaper lifecycle', () => {
  it('start/stop is idempotent and never fires before the initial delay', async () => {
    recordPtyHost(ledgerPath, entry({ daemonPid: 40000 }));
    const reaper = makeReaper({
      ps: [{ pid: 500, ppid: 1, command: HOST_CMD }],
    });
    // huge initial delay via private option — use a fresh instance instead
    const slow = new PtyHostReaper(ctxRoot, {
      initialDelayMs: 60_000,
      psList: () => [{ pid: 500, ppid: 1, command: HOST_CMD }],
      killFn: (pid, signal) => kills.push({ pid, signal }),
      getLiveHosts: () => new Set(),
      isPidAliveFn: () => false,
      log: () => { /* silent */ },
    });
    slow.start();
    slow.start(); // idempotent
    await new Promise(r => setTimeout(r, 50));
    expect(kills).toEqual([]);
    slow.stop();
    slow.stop(); // idempotent
    reaper.stop();
  });

  it('sweep never throws even when injected seams explode', () => {
    const reaper = new PtyHostReaper(ctxRoot, {
      psList: () => { throw new Error('ps exploded'); },
      killFn: () => { throw new Error('kill exploded'); },
      getLiveHosts: () => { throw new Error('live exploded'); },
      isPidAliveFn: () => { throw new Error('alive exploded'); },
      log: () => { /* silent */ },
    });
    recordPtyHost(ledgerPath, entry());
    expect(() => reaper.sweep()).not.toThrow();
  });
});
