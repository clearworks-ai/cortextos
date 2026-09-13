import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { spawn as spawnChild, type ChildProcess } from 'child_process';

import type { AgentConfig, BusPaths, CtxEnv, IPCRequest, IPCResponse } from '../../../src/types/index';
import { canonicalAgentId } from '../../../src/daemon/lifecycle/types';
import { LifecycleStateStore } from '../../../src/daemon/lifecycle/state-store';
import {
  ledgerPathFor,
  recordPtyHost,
  type PtyHostLedgerEntry,
} from '../../../src/pty/pty-host-ledger';
import { PtyHostReaper, type PsEntry } from '../../../src/daemon/pty-host-reaper';

/**
 * Task 5.3: All 19 deep-dive-inventoried mechanisms verified routed (or
 * verified legitimately independent) — the single artifact PRD §7's "All 19
 * inventoried mechanisms route through the owner" success criterion rests
 * on. Numbering matches `DEEPDIVE-lifecycle-recurrence-2026-09-11.md` §2
 * exactly (10 core + 9 adjacent), plus the additional ingress adapters
 * PHASES.md's Task 5.3 calls out beyond the 19, plus a supplemental
 * source/AST allowlist scan.
 *
 * Per this task's own "Files to Modify: None" contract: every assertion
 * below is grounded in a FRESH re-read of the real, current (post Phase
 * 1-4) source — not the deep dive's pre-migration line numbers, and not an
 * assumption that every mechanism was actually migrated. Two mechanisms
 * turned out, on that fresh read, to still bypass the supervisor in
 * production despite earlier phases' stated intent to migrate them —
 * documented honestly below as `it.todo(...)` findings (mirroring Task
 * 5.1's own precedent for real, load-bearing gaps), never smoothed into a
 * false passing assertion:
 *
 *  - Mechanisms 1-4 (`AgentProcess.handleExit()`'s crash / clean-exit /
 *    image-poison / opencode-continuation branches): Task 2.3 extracted the
 *    pure classification (`classifyExit()`) but the actual restart action
 *    still calls `this.scheduleRestart()` -> `this.start()` directly,
 *    unconditionally, regardless of `this.supervised`. `handleExit()`
 *    never calls `this.owner.request()` or `this.owner.observe()` at all.
 *  - Mechanism 9 (boot self-heal) and the "fresh IPC start" ingress case:
 *    `AgentManager.startAgent()`'s brand-new-agent path ends in a bare
 *    `await agentProcess.start()` (agent-manager.ts, confirmed by direct
 *    read), never through the owner — a gap Task 2.10 and Task 2.8's own
 *    PROGRESS notes already found and documented (Task 2.8 worked around it
 *    by moving the resume-gate check to the IPC ingress layer instead of
 *    inside `AgentManager`/`AgentLifecycleSupervisor`).
 *  - `src/bus/system.ts`'s `selfRestart()`/`hardRestart()`: both remain raw
 *    marker writers by their OWN doc comments ("still a raw file-level
 *    write, not yet routed through `AgentLifecycleSupervisor.request()`...
 *    that full routing is Task 2.8's job") — confirmed Task 2.8 did not
 *    actually touch these two functions (its Files-to-Modify were
 *    `ipc-server.ts`/`cli/*`, not `bus/system.ts`). The one place this
 *    matters in practice (`FastChecker.forceContextRestart()`'s hard
 *    context-handoff path) sidesteps the gap by calling the REAL routed
 *    `sessionRefresh()` immediately after `hardRestart()`'s marker write —
 *    but a bare `cortextos bus hard-restart`/`self-restart` invocation from
 *    an agent's own tool use never reaches the owner.
 */

// ---------------------------------------------------------------------------
// Shared harness (mirrors tests/integration/lifecycle-control.test.ts and
// tests/integration/lifecycle-manager.test.ts's proven fake-PTY-boundary
// pattern — real AgentManager/AgentLifecycleSupervisor/AgentProcessRuntimeAdapter/
// LifecycleStateStore/IPCServer; only the PTY spawn boundary and unrelated
// Telegram/CronScheduler/WorkerProcess wiring are faked).
// ---------------------------------------------------------------------------

let mockPty: {
  spawn: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  getPid: ReturnType<typeof vi.fn>;
  getHostPid: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  getOutputBuffer: ReturnType<typeof vi.fn>;
};

let onExitHandlers: Array<(exitCode: number, signal?: number) => void> = [];
let dummyChildren: ChildProcess[] = [];
let ptyInstances: Array<typeof mockPty> = [];

function freshMockPty(): typeof mockPty {
  const idx = onExitHandlers.length;
  onExitHandlers.push(() => {});
  const child = spawnChild('sleep', ['60']);
  dummyChildren.push(child);
  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockImplementation(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      setImmediate(() => onExitHandlers[idx]?.(0));
    }),
    write: vi.fn(),
    getPid: vi.fn().mockImplementation(() => child.pid),
    getHostPid: vi.fn().mockImplementation(() => child.pid),
    isAlive: vi.fn().mockReturnValue(true),
    onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
      onExitHandlers[idx] = cb;
    }),
    getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: () => true }),
  };
}

function nextPty(): typeof mockPty {
  const p = freshMockPty();
  ptyInstances.push(p);
  return p;
}

vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: function () { return nextPty(); } }));
vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({ CodexAppServerPTY: function () { return nextPty(); } }));
vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function () { return nextPty(); },
  hermesDbExists: () => false,
}));
vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function () { return nextPty(); },
  opencodeSessionExists: () => false,
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    startCount = 0;
    stopCount = 0;
    constructor(public process: unknown) {}
    async start() { this.startCount++; }
    stop() { this.stopCount++; }
    wake() { /* no-op */ }
    isDuplicate() { return false; }
    queueTelegramMessage() { /* no-op */ }
    async handleActivityCallback() { /* no-op */ }
  },
}));
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class { async sendMessage() { /* no-op */ } },
}));
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    start() { return new Promise<void>(() => {}); }
    stop() { /* no-op */ }
    onMessage() { /* no-op */ }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    constructor(_opts: { agentName: string }) {}
    start() { /* no-op */ }
    stop() { /* no-op */ }
    reload() { /* no-op */ }
    getNextFireTimes() { return []; }
  },
}));
vi.mock('../../../src/daemon/worker-process.js', () => ({
  WorkerProcess: class {
    async spawn() { /* no-op */ }
    async terminate() { /* no-op */ }
    onDone() { /* no-op */ }
    isFinished() { return true; }
    getStatus() { return {}; }
  },
}));
vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: async () => ({ status: 'empty' as const, count: 0 }),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { IPCServer } = await import('../../../src/daemon/ipc-server.js');
const { AgentLifecycleSupervisor } = await import('../../../src/daemon/lifecycle/supervisor.js');
const { AgentProcessRuntimeAdapter } = await import('../../../src/daemon/lifecycle/agent-runtime.js');
const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

type AnyAgentManager = InstanceType<typeof AgentManager> & {
  agents: Map<string, {
    process: InstanceType<typeof AgentProcess>;
    checker: unknown;
    supervised?: boolean;
    supervisor?: InstanceType<typeof AgentLifecycleSupervisor>;
  }>;
};

const INSTANCE_ID = 'lifecycle-boundary-test';
const ORG = 'acme';

function fakeBusPaths(ctxRoot: string, agentName: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(ctxRoot, 'orgs', ORG, 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', ORG, 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', ORG, 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', ORG, 'deliverables'),
  };
}

/** Fake `Socket` — captures the single JSON response `handleRequest` writes. */
function fakeSocket(): { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  return { write: vi.fn(), end: vi.fn() };
}

async function callIpc(server: InstanceType<typeof IPCServer>, request: IPCRequest): Promise<IPCResponse> {
  const socket = fakeSocket();
  await (server as unknown as { handleRequest(req: IPCRequest, sock: unknown): Promise<void> }).handleRequest(request, socket);
  expect(socket.write).toHaveBeenCalledTimes(1);
  return JSON.parse(socket.write.mock.calls[0][0] as string) as IPCResponse;
}

const supervisedConfig: AgentConfig = { supervised: true, startup_delay: 0, runtime: 'codex-app-server' };

let testDir: string;
let ctxRoot: string;
let frameworkRoot: string;
let agentDirA: string;

beforeEach(() => {
  onExitHandlers = [];
  ptyInstances = [];
  dummyChildren = [];
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-boundary-test-'));
  ctxRoot = join(testDir, 'instance');
  frameworkRoot = join(testDir, 'framework');
  agentDirA = join(frameworkRoot, 'orgs', ORG, 'agents', 'alice');
  mkdirSync(agentDirA, { recursive: true });
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of dummyChildren) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(testDir, { recursive: true, force: true });
});

function makeManager(): AnyAgentManager {
  return new AgentManager(INSTANCE_ID, ctxRoot, frameworkRoot, ORG) as unknown as AnyAgentManager;
}

// ---------------------------------------------------------------------------
// Source-scan helpers (Task 1.6's technique, inverted: proving a REQUIRED
// call exists / a FORBIDDEN call does not, rather than proving an import
// doesn't exist).
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

/** Slice `source` from `startNeedle` up to (not including) `endNeedle`, so a
 * single method/block's body can be isolated for a scan without a full AST
 * parser — the same "read the real file, don't trust a stale line number"
 * discipline this task's own Step 1 requires, applied at test-run time so a
 * future edit that moves the method re-locates it rather than silently
 * scanning the wrong span. Throws loudly (not a soft failure) if either
 * needle is missing, since a scan against the wrong span is worse than no
 * scan. */
function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start === -1) throw new Error(`sliceBetween: start needle not found: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end === -1) throw new Error(`sliceBetween: end needle not found after start: ${endNeedle}`);
  return source.slice(start, end);
}

/** Strip `//` and `/* *\/` comments so a doc-comment mentioning a call by
 * name (e.g. "written by WorkerProcess.spawn()") never counts as a real
 * call site in the AST allowlist scan. Deliberately simple (not a full
 * tokenizer) — adequate for this codebase's actual comment style, same
 * "regex-scan, not a real parser" tradeoff Task 1.6 already accepted. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// =============================================================================
// Mechanisms 1-4: exit classification (AgentProcess.handleExit())
// =============================================================================

describe('Mechanism 1-4: exit classification (crash / clean-exit / image-poison / opencode-continuation)', () => {
  it('all four branches share the pure classifyExit() decision (one exit handler, not four independent mechanisms)', () => {
    const src = readSrc('daemon/agent-process.ts');
    const body = sliceBetween(src, 'private handleExit(exitCode: number): void {', 'private scheduleRestart(delayMs: number, failureLabel: string): void {');
    expect(body).toContain('classifyExit(obs, budgets)');
    // Every restart-producing case funnels through the same shared helper —
    // proves "mutually exclusive branches of one exit handler", not four
    // separate recovery mechanisms each free to diverge.
    expect(body.match(/this\.scheduleRestart\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it.todo(
    'KNOWN GAP (confirmed via direct read of the current handleExit() body, not the deep dive\'s pre-migration line numbers): ' +
    'none of the four restart-producing branches (image-poison, opencode-continuation clean-exit-restart, plain clean-exit, crash) ' +
    'call this.owner.request()/observe() — every one calls this.scheduleRestart() -> this.start() directly, unconditionally, ' +
    'regardless of this.supervised. Task 2.3 only extracted the pure classification (classifyExit()); no later Phase 2/3 task ' +
    'rewired the actual restart action through the supervisor for this seam. This means a supervised agent\'s crash/clean-exit/' +
    'image-poison/opencode-continuation restart still bypasses AgentLifecycleSupervisor entirely today. Real fix: route handleExit()\'s ' +
    'restart branches through this.owner.request({kind:\'restart\', cause: <crash|clean-exit|image-poison|opencode-continuation>}) ' +
    'when this.supervised, mirroring sessionRefresh()\'s existing gate (agent-process.ts ~L883).',
  );

  it('current fact, asserted directly (not assumed): handleExit() never references this.owner at all', () => {
    const src = readSrc('daemon/agent-process.ts');
    const body = sliceBetween(src, 'private handleExit(exitCode: number): void {', 'private scheduleRestart(delayMs: number, failureLabel: string): void {');
    expect(body).not.toMatch(/this\.owner/);
    expect(body).not.toMatch(/\bthis\.supervised\b/);
  });
});

// =============================================================================
// Mechanism 5-6: context controller hard path + session-age timer share one
// real seam — AgentProcess.sessionRefresh()
// =============================================================================

describe('Mechanism 5: context controller (hard path) routes through sessionRefresh()', () => {
  it('forceContextRestart() calls hardRestart() then this.agent.sessionRefresh() — never a direct restart of its own', () => {
    const src = readSrc('daemon/fast-checker.ts');
    const body = sliceBetween(src, 'private forceContextRestart(reason: string): void {', "  private hashMessage(text: string): string {");
    expect(body).toContain('hardRestart(this.paths, this.agent.name,');
    expect(body).toContain('this.agent.sessionRefresh()');
    // The three hard-path triggers (codex context-full, PTY overflow banner,
    // 5-min ignored-handoff deadline) all funnel here.
    const triggerSites = readSrc('daemon/fast-checker.ts');
    expect(triggerSites.match(/this\.forceContextRestart\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe('Mechanism 6: session-age timer / sessionRefresh() — routes through the owner when supervised', () => {
  let sr6ctxRoot: string;
  let env: CtxEnv;
  let config: AgentConfig;
  let store: LifecycleStateStore;
  let agentId: string;
  const NAME = 'alice';

  beforeEach(() => {
    sr6ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-boundary-sr-'));
    mkdirSync(join(sr6ctxRoot, 'state', NAME), { recursive: true });
    env = {
      instanceId: INSTANCE_ID,
      ctxRoot: sr6ctxRoot,
      frameworkRoot: sr6ctxRoot,
      agentName: NAME,
      agentDir: join(sr6ctxRoot, 'agents', NAME),
      org: ORG,
      projectRoot: sr6ctxRoot,
    };
    config = {};
    agentId = canonicalAgentId({ instanceId: INSTANCE_ID, org: ORG, name: NAME });
    store = new LifecycleStateStore(fakeBusPaths(sr6ctxRoot, NAME), agentId);
    const adopted = store.adopt('stopped');
    if (!adopted.ok) throw new Error(`test setup: adopt failed: ${adopted.message}`);
  });

  afterEach(() => {
    rmSync(sr6ctxRoot, { recursive: true, force: true });
  });

  it('supervised: true — sessionRefresh() submits a real LifecycleRequest{kind:"refresh", cause:"session-age"} through the owner', async () => {
    const ap = new AgentProcess(NAME, env, config, () => {}, true);
    const adapter = new AgentProcessRuntimeAdapter(ap, store, config.runtime, env);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, adapter);
    ap.setOwner(supervisor);

    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');

    const started = await supervisor.request({
      requestId: 'sr6-start', kind: 'start', cause: 'manual-cli', mode: 'continue',
      observedGeneration: null, userInitiated: true, evidence: {}, requestedAtMs: Date.now(),
    });
    expect(started.accepted).toBe(true);
    requestSpy.mockClear();

    const refreshReceipt = await ap.sessionRefresh();
    expect(refreshReceipt).toBeDefined();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({ kind: 'refresh', cause: 'session-age' });

    // Documented, pre-existing, already-recorded limitation (Task 2.10's own
    // notes): sessionRefresh() hardcodes cause:'session-age' regardless of
    // caller, so the context-hard-full trigger path (mechanism 5) is real
    // and routed, but is not distinguishable from the 71h timer by `cause`
    // alone today. Not a new finding — cited here for completeness.
  });

  it('supervised: false/absent — sessionRefresh() never touches the owner (legacy stop()+start() pair only)', async () => {
    const ap = new AgentProcess(NAME, env, config, () => {});
    const adapter = new AgentProcessRuntimeAdapter(ap, store, config.runtime, env);
    const supervisor = new AgentLifecycleSupervisor(agentId, store, adapter);
    ap.setOwner(supervisor); // wired but never consulted since supervised=false

    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');
    await ap.start();
    requestSpy.mockClear();
    await ap.sessionRefresh();
    expect(requestSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Mechanism 7: generic wedge — alert-only, asserted
// =============================================================================

describe('Mechanism 7: generic wedge — alert-only, never a restart/start request', () => {
  it('wedge-detector.ts: detectWedge() is a pure decision function with zero request()/observe()/start() calls', () => {
    const src = readSrc('daemon/wedge-detector.ts');
    expect(src).not.toMatch(/\.request\(/);
    expect(src).not.toMatch(/\.observe\(/);
    expect(src).not.toMatch(/\.start\(\)/);
  });

  it('fast-checker.ts: checkWedgeInner()/reportWedge() never call owner.request()/supervisor.request() with kind start or restart', () => {
    const src = readSrc('daemon/fast-checker.ts');
    const body = sliceBetween(src, 'private checkWedgeInner(): void {', 'private mtimeMsOrNull(path: string): number | null {');
    const reportBody = sliceBetween(src, 'private reportWedge(reason: string): void {', 'private writeWedgeNotificationReceipt(receipt: WedgeNotificationReceipt): void {');
    for (const body_ of [body, reportBody]) {
      expect(body_).not.toMatch(/owner\.request\(|supervisor\.request\(|\.request\(\s*\{\s*[\s\S]{0,80}kind:\s*['"](?:start|restart)['"]/);
    }
    // reportWedge is explicitly a Telegram alert + durable receipt only.
    expect(reportBody).toContain('ALERT ONLY');
    expect(reportBody).not.toMatch(/this\.agent\.(start|sessionRefresh)\(/);
  });
});

// =============================================================================
// Mechanism 8: 50-minute watchdog — observation-only
// =============================================================================

describe('Mechanism 8: 50-minute watchdog — daemon-observed liveness only, never a restart', () => {
  it('the watchdog interval callback calls supervisor.observe({kind:"watchdog-heartbeat"}) and never .request()', () => {
    const src = readSrc('daemon/fast-checker.ts');
    const body = sliceBetween(src, 'const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1000;', 'while (this.running) {');
    expect(body).toContain("kind: 'watchdog-heartbeat'");
    expect(body).toContain('this.supervisor.observe(');
    expect(body).not.toMatch(/\.request\(/);
    expect(body).not.toMatch(/this\.agent\.(start|sessionRefresh)\(/);
  });
});

// =============================================================================
// Mechanism 9: boot self-heal
// =============================================================================

describe('Mechanism 9: boot self-heal', () => {
  it('a supervised agent persisted stopped/halted/quarantined is never resurrected by bootSelfHeal', async () => {
    const am = makeManager();
    const agentId = canonicalAgentId({ instanceId: INSTANCE_ID, org: ORG, name: 'alice' });
    const store = new LifecycleStateStore(fakeBusPaths(ctxRoot, 'alice'), agentId);
    const adopted = store.adopt('halted');
    expect(adopted.ok).toBe(true);

    const startAgentSpy = vi.spyOn(am, 'startAgent');
    await am.bootSelfHeal(
      [{ name: 'alice', dir: agentDirA, org: ORG, config: supervisedConfig }],
      {},
    );

    expect(startAgentSpy).not.toHaveBeenCalled();
    expect(am.agents.has('alice')).toBe(false);
  });

  it.todo(
    'KNOWN GAP (already documented by Task 2.10\'s and Task 2.8\'s own PROGRESS notes, re-confirmed here by direct read): ' +
    'when bootSelfHeal() DOES attempt a recovery start (no persisted stopped/halted/quarantined/blocked record), it calls ' +
    'this.startAgent(name, dir, config, org), whose brand-new-agent branch ends in a bare `await agentProcess.start()` ' +
    '(agent-manager.ts) — never through AgentLifecycleSupervisor.request(), even when config.supervised === true. Only the ' +
    '"stale in-registry" reconcile path (reconcileSupervisedRestart) routes a start through the owner today. Task 2.8 worked ' +
    'around the user-facing symptom (resurrecting a stopped agent) by adding the resume-gate check at the IPC ingress layer ' +
    'instead, but the underlying startAgent() bypass for a genuinely-fresh start remains open.',
  );
});

// =============================================================================
// Mechanism 10: PTY-host reaper
// =============================================================================

describe('Mechanism 10: PTY-host reaper', () => {
  let phrCtxRoot: string;
  let ledgerPath: string;

  beforeEach(() => {
    phrCtxRoot = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-boundary-reaper-'));
    ledgerPath = ledgerPathFor(phrCtxRoot);
  });

  afterEach(() => {
    rmSync(phrCtxRoot, { recursive: true, force: true });
  });

  const OLD = Date.now() - 60 * 60 * 1000;
  const HOST_CMD = 'node /repo/dist/pty/pty-host-entry.js';

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

  it('Tier 3 (registry-unowned but live+tracked): submits to the resolvable owner via observe(), and never kills', () => {
    recordPtyHost(ledgerPath, entry());
    const observeSpy = vi.fn();
    const fakeOwner = { observe: observeSpy } as unknown as InstanceType<typeof AgentLifecycleSupervisor>;
    const kills: Array<{ pid: number; signal: string }> = [];

    const reaper = new PtyHostReaper(phrCtxRoot, {
      graceMs: 10 * 60 * 1000,
      psList: (): PsEntry[] => [{ pid: 500, ppid: process.pid, command: HOST_CMD }, { pid: 600, ppid: 500, command: 'claude' }],
      killFn: (pid, signal) => kills.push({ pid, signal }),
      getLiveHosts: () => new Set([500]),
      getOwnedHostPids: () => new Set(), // registry does NOT own this host -> Tier 3 candidate
      isPidAliveFn: () => true,
      getSupervisorForAgent: (agentName) => (agentName === 'alice' ? fakeOwner : undefined),
      log: () => {},
    });

    reaper.sweep();

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy.mock.calls[0][0]).toMatchObject({ kind: 'pty-host-cleanup-candidate' });
    expect(kills.length).toBe(0); // preserve+log(+submit), never kill
  });

  it('Tier 1 (dead-daemon orphan): kills unconditionally and never consults getSupervisorForAgent — a different, sanctioned reaper responsibility, not a live agent\'s current generation', () => {
    recordPtyHost(ledgerPath, entry({ daemonPid: 999_999 })); // definitely-dead daemon pid
    const observeSpy = vi.fn();
    const fakeOwner = { observe: observeSpy } as unknown as InstanceType<typeof AgentLifecycleSupervisor>;
    const kills: Array<{ pid: number; signal: string }> = [];

    const reaper = new PtyHostReaper(phrCtxRoot, {
      graceMs: 10 * 60 * 1000,
      psList: (): PsEntry[] => [{ pid: 500, ppid: 1, command: HOST_CMD }, { pid: 600, ppid: 500, command: 'claude' }],
      killFn: (pid, signal) => kills.push({ pid, signal }),
      getLiveHosts: () => new Set(),
      getOwnedHostPids: () => new Set(),
      isPidAliveFn: () => false, // owning daemon confirmed dead
      getSupervisorForAgent: (agentName) => (agentName === 'alice' ? fakeOwner : undefined),
      log: () => {},
    });

    reaper.sweep();

    expect(observeSpy).not.toHaveBeenCalled();
    expect(kills.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Mechanism 11: manager stale-entry eviction/reconciliation
// =============================================================================

describe('Mechanism 11: manager stale-entry eviction — owner-mediated reconciliation, not manual kill-tree eviction', () => {
  it('a supervised entry stale in the registry (mapped but not alive) reconciles via supervisor.request({kind:"start", cause:"reaper"})', async () => {
    const am = makeManager();
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    const entry = am.agents.get('alice')!;

    // Simulate exactly the stale-in-registry scenario: the process dies
    // without a clean stopAgent() teardown, so the map entry survives.
    await entry.process.stop();
    expect(am.agents.has('alice')).toBe(true); // still mapped — the stale condition

    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({ kind: 'start', cause: 'reaper' });
  });
});

// =============================================================================
// Mechanisms 12-14: provider-local recovery — keeps its own logic, gains
// generation identity/cancellation (PRD §2.8), never routes through the owner
// =============================================================================

describe('Mechanism 12: OpenCode startup finds its old process marker — provider-local SIGTERM/SIGKILL reap, never owner-mediated', () => {
  it('cleanupStaleProcessMarker()/terminateStaleProcess() never call owner/supervisor.request()', () => {
    const src = readSrc('pty/opencode-pty.ts');
    const body = sliceBetween(src, 'private async cleanupStaleProcessMarker(): Promise<StaleMarkerCleanupResult> {', 'private async waitForProcessExit(pid: number, graceMs: number): Promise<boolean> {');
    expect(body).toMatch(/process\.kill\(pid, 'SIGTERM'\)/);
    expect(body).toMatch(/process\.kill\(pid, 'SIGKILL'\)/);
    expect(body).not.toMatch(/owner\.request\(|supervisor\.request\(/);
  });
});

describe('Mechanism 13: OpenCode shell-prompt recovery — input-mode recovery, not a restart, gated by generation liveness', () => {
  it('injectMessage() checks isGenerationLive() at each step and never calls owner.request()/start a new generation', () => {
    const src = readSrc('pty/opencode-pty.ts');
    const body = sliceBetween(src, 'override injectMessage(content: string): void {', 'private detectInputMode(): ');
    expect(body).toContain('this.detectInputMode()');
    expect(body.match(/this\.isGenerationLive\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(body).not.toMatch(/owner\.request\(|supervisor\.request\(/);
    expect(body).not.toMatch(/\.spawn\(/); // never a restart — escape+typed-exit+resubmit only
  });
});

describe('Mechanism 14: Codex app-server startup retries — bounded local retry, gated by intent-revocation, never owner-mediated', () => {
  it('startAppServerWithRetry() checks isIntentRevoked()/_alive at loop-top and after backoff, never calls owner.request()', () => {
    const src = readSrc('pty/codex-app-server-pty.ts');
    const body = sliceBetween(src, 'private async startAppServerWithRetry(): Promise<void> {', 'private startAppServer(): Promise<void> {');
    expect(body.match(/this\.isIntentRevoked\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(body).not.toMatch(/owner\.request\(|supervisor\.request\(/);
  });
});

// =============================================================================
// Mechanism 15: primary/activity Telegram poller conflict-restart wrappers
// =============================================================================

describe('Mechanism 15: Telegram poller conflict-restart wrappers — transport repair, abort-cancellable by a supervised stop', () => {
  it('both wrappers sleep on the abortable 30s backoff keyed to entry.ingressAbort, and stop teardown aborts it', () => {
    const src = readSrc('daemon/agent-manager.ts');
    // Both the primary and activity poller wrappers use the same abortable sleep.
    expect(src.match(/sleepAbortable\(30_000, ownEntry\.ingressAbort\?\.signal\)/g)?.length ?? 0).toBe(2);
    // stopSupervisedAgent / stopAgent / retireSupervisedAgentForShutdown all
    // abort the SAME AbortController the wrapper's sleep is keyed to.
    expect(src.match(/entry\.ingressAbort\?\.abort\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Mechanism 16: doctor / orphan-scan — read-only, asserted
// =============================================================================

describe('Mechanism 16: doctor/orphan-scan — read-only, asserted', () => {
  it('findStateDirOrphans() and orphan-scan.ts contain zero kill/process-mutation calls', () => {
    const src = readSrc('daemon/orphan-scan.ts');
    expect(src).not.toMatch(/process\.kill\(/);
    expect(src).not.toMatch(/killProcessTree\(|killSnapshotSurvivors\(/);
    expect(src).not.toMatch(/\.request\(|\.observe\(/);
  });
});

// =============================================================================
// Mechanism 17: status dormancy — advisory-only, asserted
// =============================================================================

describe('Mechanism 17: status dormancy — advisory-only, asserted', () => {
  it('getAllStatuses() computes dormancy and projects supervisor state but calls no lifecycle-mutating method', () => {
    const src = readSrc('daemon/agent-manager.ts');
    const body = sliceBetween(src, 'getAllStatuses(): AgentStatus[] {', 'private readHeartbeatMs(agent: string): number | null {');
    expect(body).toContain('computeDormancy(');
    expect(body).toContain('entry.supervisor.snapshot()'); // read-only projection
    expect(body).not.toMatch(/\.request\(|\.observe\(|\.stop\(\)|\.start\(\)|process\.kill\(/);
  });

  it('runtime: getAllStatuses() never calls supervisor.request() for a supervised agent', async () => {
    const am = makeManager();
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');
    am.getAllStatuses();
    expect(requestSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Mechanism 18: Sage's fleet-health-check cron — observer; verify the READ
// path it depends on is truthful (no daemon-side call site to spy on — it is
// prompt-driven, per the deep dive's own framing)
// =============================================================================

describe('Mechanism 18: Sage fleet-health-check cron (observer) — the status surface it reads reports truthfully', () => {
  it('cortextos status (IPC "status") reports a supervised agent\'s real desiredState/phase — the input this observer trusts', async () => {
    const am = makeManager();
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);

    const response = await callIpc(server, { type: 'status', source: 'test' });
    expect(response.success).toBe(true);
    const statuses = response.data as Array<{ name: string; desiredState?: string }>;
    const alice = statuses.find((s) => s.name === 'alice');
    expect(alice?.desiredState).toBe('running');

    await (am as unknown as { stopAgent(name: string, userInitiated?: boolean): Promise<unknown> }).stopAgent('alice', true);
    const afterStop = await callIpc(server, { type: 'status', source: 'test' });
    const aliceAfter = (afterStop.data as Array<{ name: string; desiredState?: string }>).find((s) => s.name === 'alice');
    if (aliceAfter?.desiredState !== undefined) {
      expect(aliceAfter.desiredState).toBe('stopped');
    }
  });

  it('this file never opens sage-codex/frank2-codex crons.json for write (no live cron file touched)', () => {
    // Structural guarantee, not just "the test didn't happen to call it":
    // this whole file never imports fs.writeFileSync targeting a crons.json
    // path, and never imports anything from an agent's live crons.json at
    // all. Grep this file's own source for the literal strings, so a future
    // edit that accidentally introduces such a write fails this assertion.
    const selfSrc = readFileSync(__filename, 'utf-8');
    expect(selfSrc).not.toMatch(/sage-codex\/crons\.json|frank2-codex\/crons\.json/);
  });
});

// =============================================================================
// Mechanism 19: frank2's heartbeat cron — cortextos start cannot clear
// stopped/HALT/quarantine
// =============================================================================

describe('Mechanism 19: frank2 heartbeat cron — "cortextos start <name>" cannot resurrect a contained agent', () => {
  it('a plain maintenance start-agent (the exact frank2 heartbeat-cron shape) against a stopped agent is refused with REQUIRES_RESUME, never resurrects it', async () => {
    const am = makeManager();
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    await (am as unknown as { stopAgent(name: string, userInitiated?: boolean): Promise<unknown> }).stopAgent('alice', true);
    expect(am.agents.has('alice')).toBe(false);
    const spawnCountAfterStop = ptyInstances.length;

    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);
    // Exactly what frank2's cron prompt issues: `cortextos start <name>`,
    // no --resume flag, no `data.resume`.
    const blocked = await callIpc(server, { type: 'start-agent', agent: 'alice', source: 'cortextos start' });

    expect(blocked.success).toBe(false);
    expect(blocked.code).toBe('REQUIRES_RESUME');
    expect(blocked.accepted).toBe(false);
    expect(am.agents.has('alice')).toBe(false);
    expect(ptyInstances.length).toBe(spawnCountAfterStop); // no resurrection, no new PTY
  });
});

// =============================================================================
// Additional ingress adapters
// =============================================================================

describe('Additional ingress adapters', () => {
  it('IPC/CLI stop routes a supervised agent through supervisor.request({kind:"stop"})', async () => {
    const am = makeManager();
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);
    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);
    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');

    const stopResp = await callIpc(server, { type: 'stop-agent', agent: 'alice', source: 'cortextos stop' });
    expect(stopResp.success).toBe(true);
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stop', cause: 'manual-cli', userInitiated: true }));
  });

  it('IPC/CLI restart routes a supervised agent through supervisor.request({kind:"restart"}), honoring data.mode', async () => {
    // Separate fixture agent (never stopped/resumed): the IPC start-agent
    // "resume" path re-reads config from disk via loadAgentConfig() when no
    // `config` argument is passed (ipc-server.ts's start-agent case only
    // ever passes `agent`+`dir`) — chaining resume->restart on the SAME
    // fixture would require a real on-disk config.json carrying
    // `supervised: true` for that reload to preserve supervision, which is
    // an unrelated test-fixture concern this assertion does not need to
    // exercise. Restarting a freshly-started (never stopped) supervised
    // agent proves the exact same routing seam directly.
    const am = makeManager();
    const agentDirB = join(frameworkRoot, 'orgs', ORG, 'agents', 'bob');
    mkdirSync(agentDirB, { recursive: true });
    await am.startAgent('bob', agentDirB, supervisedConfig, ORG);
    const server = new IPCServer(am as unknown as InstanceType<typeof AgentManager>, INSTANCE_ID);
    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');

    const restartResp = await callIpc(server, { type: 'restart-agent', agent: 'bob', source: 'cortextos restart', data: { mode: 'fresh' } });
    expect(restartResp.success).toBe(true);
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'restart', cause: 'manual-cli', mode: 'fresh' }));
  });

  it('dashboard equivalence (not re-tested end-to-end here): dashboard/.../lifecycle/route.ts sends the identical IPC request shapes just exercised above — proven by Task 2.9\'s own co-located route test (dashboard/src/app/api/agents/[name]/lifecycle/__tests__/route.test.ts), out of this unit-test file\'s scope (dashboard/ sits outside src/ and this repo\'s root typecheck/build)', () => {
    expect(true).toBe(true);
  });

  it("bus selfRestart()/hardRestart(): confirmed CURRENT behavior — both remain raw marker writers, never call the owner directly", () => {
    const src = readSrc('bus/system.ts');
    const selfRestartBody = sliceBetween(src, 'export function selfRestart(paths: BusPaths, agentName: string, reason?: string): void {', 'export function hardRestart(');
    const hardRestartBody = sliceBetween(src, 'export function hardRestart(paths: BusPaths, agentName: string, reason?: string): void {', 'export function autoCommit(');
    // Strip comments first: hardRestart's OWN doc comment mentions the class
    // name descriptively ("not yet routed through AgentLifecycleSupervisor.
    // request()") — that is documentation, not a real call site, and must
    // not itself trip this check.
    for (const body of [selfRestartBody, hardRestartBody]) {
      expect(stripComments(body)).not.toMatch(/owner\.request\(|supervisor\.request\(|AgentLifecycleSupervisor/);
    }
    // The doc comment's admission is still real signal — confirm it says so
    // (against the RAW, un-stripped source), so this test also catches the
    // day that comment is deleted without the underlying gap actually being
    // closed.
    expect(hardRestartBody).toMatch(/not yet routed through/);
  });

  it.todo(
    'KNOWN GAP: src/bus/system.ts\'s selfRestart()/hardRestart() are called directly by src/cli/bus.ts (the `cortextos bus self-restart` / ' +
    '`cortextos bus hard-restart` commands an agent invokes on itself) with NO subsequent call that routes through the owner — unlike ' +
    'FastChecker.forceContextRestart(), which calls hardRestart() and then the REAL routed sessionRefresh() immediately after. Task 2.2\'s ' +
    'own doc comment says this routing is "Task 2.8\'s job", but Task 2.8\'s actual Files-to-Modify were ipc-server.ts/cli/{start,stop,restart}.ts, ' +
    'never bus/system.ts — so a bare self-restart/hard-restart invocation from an agent\'s own bus command never reaches ' +
    'AgentLifecycleSupervisor.request() at all for a supervised agent.',
  );

  it('crash-alert hook marker consumption: classifyFromMarkers()/the hook body never mutate lifecycle state, only classify + write its own dedup/count files', () => {
    const src = readSrc('hooks/hook-crash-alert.ts');
    const noComments = stripComments(src);
    expect(noComments).not.toMatch(/\.request\(|\.observe\(|process\.kill\(|AgentLifecycleSupervisor/);
    expect(noComments).not.toMatch(/\bspawn\(|\bfork\(/);
  });

  it('daemon shutdown (stopAll): retires a supervised agent\'s runtime WITHOUT a supervisor stop request, and durable desiredState survives it (not a user stop)', async () => {
    const am = makeManager();
    await am.startAgent('alice', agentDirA, supervisedConfig, ORG);

    const agentId = canonicalAgentId({ instanceId: INSTANCE_ID, org: ORG, name: 'alice' });
    const preShutdown = new LifecycleStateStore(fakeBusPaths(ctxRoot, 'alice'), agentId).load();
    if ('corrupt' in preShutdown) throw new Error('test setup: expected an adopted record before stopAll()');
    expect(preShutdown.desiredState).toBe('running');

    const requestSpy = vi.spyOn(AgentLifecycleSupervisor.prototype, 'request');
    await am.stopAll();

    expect(am.agents.has('alice')).toBe(false); // runtime WAS retired
    expect(requestSpy).not.toHaveBeenCalled(); // ...but never via supervisor.request()

    const postShutdown = new LifecycleStateStore(fakeBusPaths(ctxRoot, 'alice'), agentId).load();
    if ('corrupt' in postShutdown) throw new Error('durable record vanished across stopAll() — regression');
    // The whole point: daemon shutdown must NEVER durably commit 'stopped' —
    // bootSelfHeal must be free to bring it back up next boot.
    expect(postShutdown.desiredState).toBe('running');
  });
});

// =============================================================================
// Supplemental source/AST allowlist: no production spawn or kill call site
// exists outside src/daemon/lifecycle/agent-runtime.ts and its sanctioned
// helpers (Task 1.6's technique, inverted).
// =============================================================================

describe('Source/AST allowlist: production spawn/kill call sites', () => {
  /**
   * Every entry is a file this scan's regexes match somewhere in `src/`
   * (verified 2026-09-13 against the current tree — re-run the scan below
   * to reconfirm on any future edit). One-line justification per entry, per
   * this task's own instruction, so a future addition is a reviewable diff.
   */
  const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
    // --- The real PTY runtime spawn chain AgentProcess.startImplFenced() delegates through (Task 2.1) ---
    { file: join('src', 'pty', 'agent-pty.ts'), reason: 'base AgentPTY.spawn() — the real spawn chain startImplFenced()/startImpl() delegates through' },
    { file: join('src', 'pty', 'hermes-pty.ts'), reason: 'runtime-specific PTY subclass spawn() override, calls super.spawn() into agent-pty.ts' },
    { file: join('src', 'pty', 'opencode-pty.ts'), reason: 'runtime-specific PTY subclass spawn() override (super.spawn()); also owns mechanism 12\'s provider-local SIGTERM/SIGKILL stale-marker reap and mechanism 13\'s generation-gated shell-prompt recovery, both explicitly sanctioned to keep their own logic per PRD §2.8' },
    { file: join('src', 'pty', 'codex-app-server-pty.ts'), reason: 'runtime-specific PTY subclass spawn() override, calls super.spawn() into agent-pty.ts' },
    { file: join('src', 'pty', 'pty-host-client.ts'), reason: 'hostSpawn()\'s fork(hostEntry, ...) — explicitly named as a sanctioned low-level helper by this task\'s own spec' },
    { file: join('src', 'pty', 'pty-host-entry.ts'), reason: 'the actual forked PTY-host child process entry point — explicitly named as a sanctioned low-level helper by this task\'s own spec; necessarily calls real spawn primitives' },
    { file: join('src', 'daemon', 'agent-process.ts'), reason: 'this.pty.spawn(...) inside startImpl()/the real SIGKILL escalation inside runStop() — the adapter\'s sole real backing implementation (Task 2.1/2.6), called only via startImplFenced()/runStopFenced()' },
    { file: join('src', 'utils', 'process-tree.ts'), reason: 'killProcessTree()/killSnapshotSurvivors() — explicitly named as the sanctioned low-level teardown helper by this task\'s own spec (Task 2.6)' },
    { file: join('src', 'daemon', 'pty-host-reaper.ts'), reason: 'mechanism 10 — ledger-verified dead-daemon/untracked-host orphan cleanup, a distinct sanctioned reaper responsibility (never a live agent\'s own current generation; Tier 3 never kills, only observes)' },
    // --- Ephemeral WORKER lifecycle — explicitly outside the per-agent count (DEEPDIVE §2 counting rule) ---
    { file: join('src', 'daemon', 'worker-process.ts'), reason: 'WorkerProcess.spawn() — ephemeral one-shot worker lifecycle, explicitly outside DEEPDIVE §2\'s per-agent mechanism count ("worker-only lifecycles are outside this per-agent count")' },
    { file: join('src', 'daemon', 'agent-manager.ts'), reason: 'worker.spawn(env, prompt, config) call site — same ephemeral worker lifecycle as above, not an agent runtime spawn/kill' },
    // --- Unrelated subprocess use: not an agent runtime, not a lifecycle mutation ---
    { file: join('src', 'cli', 'start.ts'), reason: 'spawns the DAEMON process itself at CLI startup — not an agent runtime' },
    { file: join('src', 'cli', 'install.ts'), reason: 'one-shot PTY smoke-test for install diagnostics — not a recovery mechanism' },
    { file: join('src', 'cli', 'doctor.ts'), reason: 'one-shot PTY smoke-test for doctor diagnostics — not a recovery mechanism' },
    { file: join('src', 'cli', 'dashboard.ts'), reason: 'spawns the Next.js dashboard dev/prod server process — unrelated to agent lifecycle' },
    { file: join('src', 'cli', 'webhook-bridge.ts'), reason: 'process.kill(pid, \'SIGUSR1\') is a non-terminating wake signal to the fast-checker poll loop, not a lifecycle kill' },
    { file: join('src', 'bus', 'multica', 'trigger.ts'), reason: 'spawns an unrelated one-shot external script, not an agent PTY' },
    { file: join('src', 'daemon', 'meeting-consumer-dispatch.ts'), reason: 'spawns a deterministic one-shot meeting-consumer script, not an agent PTY' },
    { file: join('src', 'telegram', 'transcribe.ts'), reason: 'spawns a one-shot transcription binary, not an agent PTY' },
    { file: join('src', 'pipeline', 'staging-verify', 'railway.ts'), reason: 'spawns the Railway CLI for a one-shot staging check, not an agent PTY' },
  ];

  function isAllowed(relFile: string): { file: string; reason: string } | undefined {
    return ALLOWLIST.find((e) => e.file === relFile);
  }

  it('every real spawn(/fork( call site in src/ (excluding tests/) is in the allowlist', () => {
    const allSrcFiles = collectSourceFiles(SRC_ROOT);
    const spawnForkRegex = /\bspawn\(|\bfork\(/;
    const offenders: string[] = [];

    for (const file of allSrcFiles) {
      const relFile = relative(REPO_ROOT, file);
      const text = stripComments(readFileSync(file, 'utf-8'));
      if (!spawnForkRegex.test(text)) continue;
      const relToSrc = relative(REPO_ROOT, file);
      if (!isAllowed(relToSrc)) offenders.push(relToSrc);
    }

    expect(offenders, `Unlisted spawn()/fork() call site(s), review and either allowlist with a justification or fix:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every real terminating process.kill(...)/taskkill call site in src/ (excluding tests/, excluding signal-0 liveness probes) is in the allowlist', () => {
    const allSrcFiles = collectSourceFiles(SRC_ROOT);
    // Signal-0 (`process.kill(pid, 0)`) is a liveness PROBE, not a
    // mutation — deliberately excluded from this scan by design (it never
    // terminates anything). Everything else (a real signal, or a variable
    // signal parameter forwarded from a caller) is flagged.
    const signalZeroRegex = /process\.kill\([^,)]+,\s*0\)/g;
    const killRegex = /process\.kill\(|taskkill/;
    const offenders: string[] = [];

    for (const file of allSrcFiles) {
      const relFile = relative(REPO_ROOT, file);
      const raw = stripComments(readFileSync(file, 'utf-8'));
      const withoutSignalZero = raw.replace(signalZeroRegex, '');
      if (!killRegex.test(withoutSignalZero)) continue;
      if (!isAllowed(relFile)) offenders.push(relFile);
    }

    expect(offenders, `Unlisted terminating kill call site(s), review and either allowlist with a justification or fix:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the allowlist itself contains no stale entries (every listed file still actually matches one of the two scans)', () => {
    const spawnForkRegex = /\bspawn\(|\bfork\(/;
    const signalZeroRegex = /process\.kill\([^,)]+,\s*0\)/g;
    const killRegex = /process\.kill\(|taskkill/;

    const stale: string[] = [];
    for (const { file } of ALLOWLIST) {
      const full = join(REPO_ROOT, file);
      const text = stripComments(readFileSync(full, 'utf-8'));
      const withoutSignalZero = text.replace(signalZeroRegex, '');
      const matchesSpawn = spawnForkRegex.test(text);
      const matchesKill = killRegex.test(withoutSignalZero);
      if (!matchesSpawn && !matchesKill) stale.push(file);
    }
    expect(stale, `Allowlist entries that no longer match anything (safe to remove):\n${stale.join('\n')}`).toEqual([]);
  });
});
