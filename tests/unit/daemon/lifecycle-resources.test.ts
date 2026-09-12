import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir, homedir } from 'os';

import type { BusPaths, AgentConfig, CtxEnv } from '../../../src/types/index';
import type { EffectToken } from '../../../src/daemon/lifecycle/types';
import { canonicalAgentId } from '../../../src/daemon/lifecycle/types';
import { LifecycleStateStore } from '../../../src/daemon/lifecycle/state-store';

// --- Fake PTYs: all four runtime constructors return the same controllable
// stub object, mirroring the pattern used by
// tests/unit/daemon/conversation-buffer.test.ts and
// tests/unit/daemon/agent-process-stop-orphan-sweep.test.ts. Only the PTY
// spawn boundary is faked -- everything else in AgentProcess (and the real
// LifecycleStateStore's fs-backed commits) runs for real against a tmp dir.
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

// Capture the PTY exit handler so tests can simulate the child actually
// exiting at a controlled time -- the same pattern every other AgentProcess
// test file in this directory uses (agent-process.test.ts et al). A bare
// `vi.fn()` onExit registration is never invoked on its own, which would
// otherwise leave `retireGeneration()` -> `runStop()`'s
// `Promise.race([exitPromise, sleep(15000)])` blocked on the full 15s
// ceiling every single time.
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

function freshMockPty(): typeof mockPty {
  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    write: vi.fn(),
    getPid: vi.fn().mockReturnValue(31001),
    getHostPid: vi.fn().mockReturnValue(31000),
    isAlive: vi.fn().mockReturnValue(true),
    onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
      capturedOnExit = cb;
    }),
    getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: () => true }),
  };
}

vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: function () { return mockPty; } }));
vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({ CodexAppServerPTY: function () { return mockPty; } }));
vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function () { return mockPty; },
  hermesDbExists: () => false,
}));
vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function () { return mockPty; },
  opencodeSessionExists: () => false,
}));

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
const { AgentProcessRuntimeAdapter } = await import('../../../src/daemon/lifecycle/agent-runtime.js');

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

let ctxRoot: string;
let agentDir: string;
let env: CtxEnv;
let config: AgentConfig;
let store: LifecycleStateStore;
let agentId: string;

const NAME = 'alice';
const ORG = 'acme';
const INSTANCE_ID = 'lifecycle-resources-test';

let effectSeq = 0;
function makeEffect(overrides: Partial<EffectToken> = {}): EffectToken {
  effectSeq += 1;
  return {
    agentId,
    supervisorEpoch: 0,
    generation: 1,
    intentRevision: 0,
    effectId: `effect-${effectSeq}`,
    ...overrides,
  };
}

beforeEach(() => {
  capturedOnExit = null;
  mockPty = freshMockPty();
  ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-resources-test-'));
  agentDir = join(ctxRoot, 'agents', NAME);
  mkdirSync(agentDir, { recursive: true });
  env = {
    instanceId: INSTANCE_ID,
    ctxRoot,
    frameworkRoot: ctxRoot,
    agentName: NAME,
    agentDir,
    org: ORG,
    projectRoot: ctxRoot,
  };
  config = {};
  agentId = canonicalAgentId({ instanceId: INSTANCE_ID, org: ORG, name: NAME });
  store = new LifecycleStateStore(fakeBusPaths(ctxRoot, NAME), agentId);
  const adopted = store.adopt('stopped');
  if (!adopted.ok) throw new Error(`test setup: adopt failed: ${adopted.message}`);
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

function buildAdapter(runtime?: AgentConfig['runtime']) {
  const cfg: AgentConfig = { ...config, runtime };
  const proc = new AgentProcess(NAME, env, cfg, () => { /* silence */ });
  const adapter = new AgentProcessRuntimeAdapter(proc, store, runtime, env);
  return { proc, adapter };
}

type Adapter = ReturnType<typeof buildAdapter>['adapter'];

/**
 * `retireGeneration()` invokes the real `runStop()` teardown: runtime-specific
 * graceful-shutdown writes/sleeps (up to 6s of real waiting for the
 * claude-code default -- 1s after Ctrl-C, 5s after `/exit`), then
 * `pty.kill()`, then races the real `exitPromise` against a 15s timeout.
 * Firing the captured `onExit` handler manually (simulating the child
 * actually exiting once killed) under fake timers drains all of that
 * instantly instead of either hanging on the un-fired 15s ceiling or paying
 * the full real-time cost of the graceful-shutdown sleeps. Mirrors
 * `agent-process.test.ts`'s "restart (stop then start) reaps the old PTY"
 * test, the established pattern for this exact situation elsewhere in this
 * test directory.
 */
async function retireAndDrain(
  adapter: Adapter,
  token: GenerationToken,
  resources: OwnedResource[],
): Promise<RetirementResult> {
  vi.useFakeTimers();
  try {
    const promise = adapter.retireGeneration(token, resources);
    capturedOnExit?.(0, 0);
    await vi.runAllTimersAsync();
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

describe('AgentProcessRuntimeAdapter.startGeneration — reservation before spawn', () => {
  it('persists reserved resources before calling the real spawn path', async () => {
    const { adapter } = buildAdapter();
    const effect = makeEffect({ generation: 1 });

    // The mocked spawn observes the store's ON-DISK state at the exact
    // moment it is invoked -- this is the load-bearing assertion that
    // reservation precedes any process creation, not merely precedes the
    // returned promise settling.
    let reservedKindsSeenAtSpawnTime: string[] = [];
    mockPty.spawn.mockImplementation(async () => {
      const loaded = store.load();
      if (!('corrupt' in loaded)) {
        reservedKindsSeenAtSpawnTime = loaded.resources
          .filter((r) => r.owner.generation === effect.generation && r.owner.agentId === agentId && r.state === 'reserved')
          .map((r) => r.kind);
      }
    });

    const result = await adapter.startGeneration(effect, 'fresh');

    expect(result.ok).toBe(true);
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    // At spawn time every kind was reserved -- proves the reservation commit
    // landed on disk strictly before the spawn call, not concurrently with
    // or after it.
    expect(reservedKindsSeenAtSpawnTime).toEqual(
      expect.arrayContaining(['runtime', 'pty-host', 'session', 'socket', 'checker', 'poller', 'scheduler', 'descendant', 'dispatch', 'handoff-lease']),
    );

    await retireAndDrain(
      adapter,
      { agentId, supervisorEpoch: effect.supervisorEpoch, generation: effect.generation },
      result.resources,
    );
  });

  it('spawn failure leaves a reserved-but-unacquired resource, not a phantom acquired one', async () => {
    const { adapter } = buildAdapter();
    mockPty.spawn.mockRejectedValue(new Error('spawn boom'));

    const effect = makeEffect({ generation: 1 });
    const result = await adapter.startGeneration(effect, 'fresh');

    expect(result.ok).toBe(false);
    expect(result.resources).toEqual([]);

    const snapshot = store.load();
    if ('corrupt' in snapshot) throw new Error('expected a valid snapshot after a failed spawn');

    const thisGeneration = snapshot.resources.filter(
      (r) => r.owner.generation === effect.generation && r.owner.agentId === agentId,
    );
    expect(thisGeneration.length).toBeGreaterThan(0);
    for (const r of thisGeneration) {
      expect(r.state).toBe('reserved');
      expect(r.pid).toBeNull();
    }
    // None promoted to acquired, none deleted -- every minted kind still present.
    const kinds = new Set(thisGeneration.map((r) => r.kind));
    expect(kinds.has('runtime')).toBe(true);
    expect(kinds.has('pty-host')).toBe(true);
    expect(kinds.has('session')).toBe(true);
  });

  it('fails closed (no spawn attempted) when the store is corrupt', async () => {
    const { adapter } = buildAdapter();
    // Force corruption: write invalid JSON straight into the record path.
    const recordPath = join(ctxRoot, 'state', NAME, 'lifecycle', 'supervisor.json');
    mkdirSync(join(ctxRoot, 'state', NAME, 'lifecycle'), { recursive: true });
    writeFileSync(recordPath, 'not json', 'utf-8');

    const effect = makeEffect({ generation: 1 });
    const result = await adapter.startGeneration(effect, 'fresh');

    expect(result.ok).toBe(false);
    expect(mockPty.spawn).not.toHaveBeenCalled();
  });
});

describe('AgentProcessRuntimeAdapter.startGeneration — late-arriving spawn belongs to the outgoing generation', () => {
  it('tags the returned resources with the effect\'s own generation, not whatever the store shows by the time the promise resolves', async () => {
    const { adapter } = buildAdapter();

    let resolveSpawn: (() => void) | null = null;
    mockPty.spawn.mockImplementation(() => new Promise<void>((resolve) => { resolveSpawn = resolve; }));

    const outgoingEffect = makeEffect({ generation: 1, intentRevision: 0 });
    const startPromise = adapter.startGeneration(outgoingEffect, 'fresh');

    // Simulate a stop/halt (or a superseding start) committing mid-spawn --
    // the store's currentGeneration/intentRevision move on to a NEWER value
    // while the outgoing generation's spawn is still in flight.
    const loaded = store.load();
    if ('corrupt' in loaded) throw new Error('expected a valid snapshot mid-test');
    const committed = store.commit(
      { supervisorEpoch: loaded.supervisorEpoch, revision: loaded.revision },
      (draft) => {
        draft.intentRevision += 1;
        draft.currentGeneration = 2;
        draft.nextGeneration = 3;
      },
    );
    expect(committed.ok).toBe(true);

    // Now let the outgoing generation's spawn actually complete.
    resolveSpawn!();
    const result = await startPromise;

    expect(result.ok).toBe(true);
    expect(result.resources.length).toBeGreaterThan(0);
    for (const r of result.resources) {
      expect(r.owner.generation).toBe(1); // the OUTGOING effect's own generation
      expect(r.owner.agentId).toBe(agentId);
    }
    // Never the generation the store moved on to.
    expect(result.resources.every((r) => r.owner.generation !== 2)).toBe(true);

    await retireAndDrain(adapter, { agentId, supervisorEpoch: 0, generation: 1 }, result.resources);
  });
});

describe('AgentProcessRuntimeAdapter.startGeneration — captured resource bundle (integration, real AgentProcess)', () => {
  it('bundle carries the fake PTY host pid and the runtime-appropriate session path (claude-code default)', async () => {
    const { adapter } = buildAdapter();
    mockPty.getHostPid.mockReturnValue(42424);

    const effect = makeEffect({ generation: 1 });
    const result = await adapter.startGeneration(effect, 'fresh');

    expect(result.ok).toBe(true);

    const ptyHost = result.resources.find((r) => r.kind === 'pty-host');
    expect(ptyHost).toBeDefined();
    expect(ptyHost?.pid).toBe(42424);
    expect(ptyHost?.state).toBe('acquired');

    const session = result.resources.find((r) => r.kind === 'session');
    expect(session).toBeDefined();
    expect(session?.location).toBe(
      join(homedir(), '.claude', 'projects', agentDir.split(sep).join('-')),
    );

    const runtime = result.resources.find((r) => r.kind === 'runtime');
    expect(runtime).toBeDefined();
    expect(runtime?.state).toBe('acquired');
    expect(runtime?.owner.generation).toBe(1);

    // Placeholders stay honestly reserved, never fabricated as acquired.
    for (const kind of ['checker', 'poller', 'scheduler', 'dispatch', 'handoff-lease', 'descendant'] as const) {
      const r = result.resources.find((x) => x.kind === kind);
      expect(r).toBeDefined();
      expect(r?.state).toBe('reserved');
      expect(r?.pid).toBeNull();
    }

    // No native socket for the default (claude-code) runtime.
    expect(result.resources.find((r) => r.kind === 'socket')).toBeUndefined();

    await retireAndDrain(adapter, { agentId, supervisorEpoch: 0, generation: 1 }, result.resources);
  });

  it('captures a socket resource for codex-app-server and a matching session path', async () => {
    const { adapter } = buildAdapter('codex-app-server');

    const effect = makeEffect({ generation: 1 });
    const result = await adapter.startGeneration(effect, 'fresh');

    expect(result.ok).toBe(true);
    const socket = result.resources.find((r) => r.kind === 'socket');
    expect(socket).toBeDefined();
    expect(socket?.location).toBe(join(ctxRoot, 'state', NAME, 'codex-app-server-thread.json'));

    const session = result.resources.find((r) => r.kind === 'session');
    expect(session?.location).toBe(join(ctxRoot, 'state', NAME, 'codex-app-server-thread.json'));

    await retireAndDrain(adapter, { agentId, supervisorEpoch: 0, generation: 1 }, result.resources);
  });

  it('omits the pty-host resource entirely when getHostPid() returns null', async () => {
    const { adapter } = buildAdapter();
    mockPty.getHostPid.mockReturnValue(null);

    const effect = makeEffect({ generation: 1 });
    const result = await adapter.startGeneration(effect, 'fresh');

    expect(result.ok).toBe(true);
    expect(result.resources.find((r) => r.kind === 'pty-host')).toBeUndefined();

    await retireAndDrain(adapter, { agentId, supervisorEpoch: 0, generation: 1 }, result.resources);
  });
});

describe('AgentProcessRuntimeAdapter.retireGeneration — reachable teardown', () => {
  it('invokes the real runStop() teardown and returns the resources as retired', async () => {
    const { adapter } = buildAdapter();
    const effect = makeEffect({ generation: 1 });
    const started = await adapter.startGeneration(effect, 'fresh');
    expect(started.ok).toBe(true);

    const retireResult = await retireAndDrain(
      adapter,
      { agentId, supervisorEpoch: 0, generation: 1 },
      started.resources,
    );

    expect(retireResult.status).toBe('retired');
    if (retireResult.status === 'retired') {
      expect(retireResult.released).toEqual(started.resources);
    }
    expect(mockPty.kill).toHaveBeenCalled();
  });
});

describe('AgentProcessRuntimeAdapter.deliver', () => {
  it('maps a successful inject onto DispatchResult ok:true', async () => {
    const { adapter } = buildAdapter();
    const effect = makeEffect({ generation: 1 });
    const started = await adapter.startGeneration(effect, 'fresh');
    expect(started.ok).toBe(true);

    const result = await adapter.deliver(effect, 'hello', ['work-1']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workIds).toEqual(['work-1']);
      expect(result.batchId).toBe(effect.effectId);
    }

    await retireAndDrain(adapter, { agentId, supervisorEpoch: 0, generation: 1 }, started.resources);
  });

  it('maps NOT_RUNNING when there is no live pty', async () => {
    const { adapter } = buildAdapter();
    const effect = makeEffect({ generation: 1 });

    const result = await adapter.deliver(effect, 'hello', ['work-1']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_RUNNING');
      expect(result.retryable).toBe(true);
    }
  });
});
