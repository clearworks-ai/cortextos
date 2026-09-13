/**
 * lifecycle-process-retirement.test.ts — Task 2.7: PTY-host identity
 * carriage and reaper routing.
 *
 * Three PHASES.md-specified cases (Testing Protocol):
 *   1. Aborted handshake -> no unregistered runtime survives.
 *   2. Reaper finding a supervised host -> candidate submitted to the
 *      owning AgentLifecycleSupervisor, no independent kill.
 *   3. Reaper finding an unknown host -> preserved and logged, UNCHANGED
 *      from pre-Task-2.7 behavior (no owner to submit a candidate to).
 * Plus one extra regression case proving Tiers 1/2/4 (no plausible live
 * owner) are unaffected by the new `getSupervisorForAgent` hook.
 *
 * Uses the REAL `AgentLifecycleSupervisor` + `LifecycleStateStore` (only the
 * `RuntimeAdapter` is faked — this suite is about PTY-host/reaper wiring, not
 * generation start/retire effects) and the REAL `PtyHostReaper` +
 * `pty-host-ledger.ts`, mirroring the "real collaborators, faked boundary"
 * pattern `tests/integration/lifecycle-manager.test.ts` already established.
 * Case 1 forks a real stub host process via `hostSpawn()` itself (same
 * child_process-mock-redirect pattern `tests/unit/pty/pty-host-ready.test.ts`
 * uses), so the "no unregistered runtime survives" assertion is against a
 * real process and a real on-disk ledger, not a mock.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fork, type ChildProcess } from 'child_process';
import type { BusPaths } from '../../src/types/index';
import type { OwnedResource, RetirementResult } from '../../src/daemon/lifecycle/types';
import { LifecycleStateStore } from '../../src/daemon/lifecycle/state-store';
import { AgentLifecycleSupervisor, type RuntimeAdapter } from '../../src/daemon/lifecycle/supervisor';
import { PtyHostReaper, type PsEntry } from '../../src/daemon/pty-host-reaper';
import {
  ledgerPathFor,
  recordPtyHost,
  readPtyHostLedger,
  type PtyHostLedgerEntry,
} from '../../src/pty/pty-host-ledger';

const DEAD_STUB = join(__dirname, '../fixtures/pty-stub-dead-host.cjs');
let lastForkedChild: ChildProcess | null = null;

// Same redirect pattern as tests/unit/pty/pty-host-ready.test.ts: hostSpawn()
// resolves its host entry from dist/, which does not exist in this worktree
// during unit/integration runs — redirect any pty-host-entry fork to a real,
// disposable stub process instead. Case 2/3 below never call `fork` at all
// (PtyHostReaper's `psList`/`killFn` are always injected), so this mock is
// harmless for them.
vi.mock('child_process', async () => {
  const real = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...real,
    fork: (path: string, args: string[], opts: Record<string, unknown>) => {
      const target = path.includes('pty-host-entry') ? DEAD_STUB : path;
      const child = (real.fork as typeof fork)(target, args ?? [], opts ?? {});
      if (path.includes('pty-host-entry')) lastForkedChild = child;
      return child;
    },
  };
});

const { hostSpawn } = await import('../../src/pty/pty-host-client.js');

// ─── shared helpers ─────────────────────────────────────────────────────────

function fakeBusPaths(ctxRoot: string, agentName: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(ctxRoot, 'orgs', 'x', 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', 'x', 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', 'x', 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', 'x', 'deliverables'),
  };
}

/** A real AgentLifecycleSupervisor over a real (temp-rooted) LifecycleStateStore,
 * with a no-op fake RuntimeAdapter — this suite is about PTY-host/reaper
 * wiring, not generation start/retire effects. */
function makeSupervisor(ctxRoot: string, agentName: string): AgentLifecycleSupervisor {
  const agentId = `inst/org/${agentName}`;
  const store = new LifecycleStateStore(fakeBusPaths(ctxRoot, agentName), agentId);
  const runtime: RuntimeAdapter = {
    async startGeneration(): Promise<{ ok: boolean; resources: OwnedResource[]; error?: string }> {
      return { ok: true, resources: [] };
    },
    async retireGeneration(): Promise<RetirementResult> {
      return { status: 'retired', released: [] };
    },
    async deliver() {
      return { ok: true, workIds: [], batchId: 'unused' };
    },
  };
  return new AgentLifecycleSupervisor(agentId, store, runtime);
}

function entry(overrides: Partial<PtyHostLedgerEntry> = {}): PtyHostLedgerEntry {
  return {
    hostPid: 500,
    ptyPid: 600,
    file: 'claude',
    agent: 'alice',
    daemonPid: process.pid,
    startedAt: Date.now() - 60 * 60 * 1000, // 1h ago — far past any grace
    ...overrides,
  };
}

// ─── Case 2 & 3: reaper Tier 3 owner-submission routing ────────────────────

describe('Task 2.7: reaper Tier 3 submits to the current owner', () => {
  it('reaper finding a SUPERVISED host submits the candidate to its AgentLifecycleSupervisor, and still never kills it', () => {
    const ctxRoot = mkdtempSync(join(tmpdir(), 'lifecycle-retirement-test-'));
    try {
      const ledgerPath = ledgerPathFor(ctxRoot);
      recordPtyHost(ledgerPath, entry({ agent: 'alice' }));

      const supervisor = makeSupervisor(ctxRoot, 'alice');
      const observeSpy = vi.spyOn(supervisor, 'observe');

      const kills: Array<{ pid: number; signal: string }> = [];
      const ps: PsEntry[] = [
        { pid: 500, ppid: process.pid, command: 'node /repo/dist/pty/pty-host-entry.js' },
        { pid: 600, ppid: 500, command: 'claude --dangerously-skip-permissions' },
      ];
      const reaper = new PtyHostReaper(ctxRoot, {
        graceMs: 10 * 60 * 1000,
        psList: () => ps,
        killFn: (pid, signal) => kills.push({ pid, signal }),
        getLiveHosts: () => new Set([500]), // client still tracks it
        getOwnedHostPids: () => new Set(),  // NOT the single current-host pointer
        isPidAliveFn: () => false,
        getSupervisorForAgent: (name) => (name === 'alice' ? supervisor : undefined),
        log: () => { /* silent */ },
      });

      reaper.sweep();

      // The reaper's OWN decision is unchanged: Tier 3 never kills, per
      // 5499f344 (acceptance criterion "existing conservative treatment...
      // is retained"). The host stays in the ledger.
      expect(kills).toEqual([]);
      expect(readPtyHostLedger(ledgerPath)).toHaveLength(1);

      // The delta THIS task adds: the candidate was actually submitted to
      // the current owner (not just logged locally by the reaper).
      expect(observeSpy).toHaveBeenCalledTimes(1);
      const observed = observeSpy.mock.calls[0][0];
      expect(observed.kind).toBe('pty-host-cleanup-candidate');
      expect(observed.evidence['hostPid']).toBe(500);
      expect(observed.evidence['ptyPid']).toBe(600);
      expect(observed.evidence['sweepCount']).toBe(1);

      // The owner itself confirmed/refuted the claim against its own
      // authoritative resource bundle (empty in this test — no generation
      // was ever started), and recorded the answer for introspection.
      const candidate = supervisor.lastPtyHostCleanupCandidate();
      expect(candidate).not.toBeNull();
      expect(candidate?.hostPid).toBe(500);
      expect(candidate?.stillClaimed).toBe(false);
    } finally {
      rmSync(ctxRoot, { recursive: true, force: true });
    }
  });

  it('reaper finding an UNKNOWN host is preserved and logged, unchanged from pre-Task-2.7 behavior', () => {
    const ctxRoot = mkdtempSync(join(tmpdir(), 'lifecycle-retirement-test-'));
    try {
      const ledgerPath = ledgerPathFor(ctxRoot);
      recordPtyHost(ledgerPath, entry({ agent: 'ghost-agent' }));

      const kills: Array<{ pid: number; signal: string }> = [];
      const logs: string[] = [];
      const ps: PsEntry[] = [
        { pid: 500, ppid: process.pid, command: 'node /repo/dist/pty/pty-host-entry.js' },
        { pid: 600, ppid: 500, command: 'claude --dangerously-skip-permissions' },
      ];
      const reaper = new PtyHostReaper(ctxRoot, {
        graceMs: 10 * 60 * 1000,
        psList: () => ps,
        killFn: (pid, signal) => kills.push({ pid, signal }),
        getLiveHosts: () => new Set([500]),
        getOwnedHostPids: () => new Set(),
        isPidAliveFn: () => false,
        // No agent named 'ghost-agent' is supervised (or exists at all) —
        // exactly the "unknown/legacy/unsupervised" case: no owner to ask.
        getSupervisorForAgent: () => undefined,
        log: (message) => logs.push(message),
      });

      reaper.sweep();
      reaper.sweep(); // persistence across sweeps still isn't proof of orphanhood

      expect(kills).toEqual([]);
      expect(readPtyHostLedger(ledgerPath)).toHaveLength(1);
      expect(logs.filter((line) => line.includes('preserving registry-unowned'))).toHaveLength(1);
    } finally {
      rmSync(ctxRoot, { recursive: true, force: true });
    }
  });

  it('Tiers 1/2/4 (no plausible live owner) are unaffected by getSupervisorForAgent: a dead-daemon entry is still reaped independently', () => {
    const ctxRoot = mkdtempSync(join(tmpdir(), 'lifecycle-retirement-test-'));
    try {
      const ledgerPath = ledgerPathFor(ctxRoot);
      recordPtyHost(ledgerPath, entry({ agent: 'alice', daemonPid: 999999 })); // dead daemon

      const supervisor = makeSupervisor(ctxRoot, 'alice');
      const observeSpy = vi.spyOn(supervisor, 'observe');
      const kills: Array<{ pid: number; signal: string }> = [];

      const reaper = new PtyHostReaper(ctxRoot, {
        graceMs: 10 * 60 * 1000,
        psList: () => [
          { pid: 500, ppid: 1, command: 'node /repo/dist/pty/pty-host-entry.js' },
          { pid: 600, ppid: 500, command: 'claude --dangerously-skip-permissions' },
        ],
        killFn: (pid, signal) => kills.push({ pid, signal }),
        getLiveHosts: () => new Set(),
        getOwnedHostPids: () => new Set(),
        isPidAliveFn: () => false, // the recorded daemonPid is dead
        getSupervisorForAgent: (name) => (name === 'alice' ? supervisor : undefined),
        log: () => { /* silent */ },
      });

      reaper.sweep();

      // Tier 1 (dead-daemon) is unambiguous — killed exactly as before this
      // task, and no owner is ever consulted for it (the whole point of
      // Tier 1 is that there is nothing plausible to ask).
      expect(kills.map((k) => k.pid)).toEqual([-600, 600, -500, 500]);
      expect(readPtyHostLedger(ledgerPath)).toEqual([]);
      expect(observeSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(ctxRoot, { recursive: true, force: true });
    }
  });
});

// ─── Case 1: aborted handshake leaves no unregistered runtime ──────────────

describe('Task 2.7: aborted host handshake never leaves an unregistered runtime', () => {
  it('a host that dies before pty-ready is rejected AND its ledger registration is removed', async () => {
    const ctxRoot = mkdtempSync(join(tmpdir(), 'lifecycle-retirement-handshake-test-'));
    try {
      const ledgerPath = ledgerPathFor(ctxRoot);
      lastForkedChild = null;

      await expect(
        hostSpawn('echo', ['hi'], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          env: {
            CTX_ROOT: ctxRoot,
            CTX_INSTANCE_ID: 'inst',
            CTX_ORG: 'org',
            CTX_AGENT_NAME: 'alice',
          },
        }),
      ).rejects.toThrow(/exited before pty-ready/);

      // The child that was forked (and whose ledger entry was persisted
      // BEFORE the spawn message was even sent — see hostSpawn's own
      // sequencing comment) must not be left running...
      expect(lastForkedChild).not.toBeNull();
      const exited = await new Promise<boolean>((resolve) => {
        const child = lastForkedChild!;
        if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
        const t = setTimeout(() => resolve(false), 5000);
        child.once('exit', () => { clearTimeout(t); resolve(true); });
      });
      expect(exited).toBe(true);

      // ...and no ledger registration survives the aborted handshake either
      // — "persist identity before authorizing native launch" does not mean
      // "leak a phantom registration forever" once the launch is refused.
      expect(readPtyHostLedger(ledgerPath)).toEqual([]);
    } finally {
      rmSync(ctxRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
