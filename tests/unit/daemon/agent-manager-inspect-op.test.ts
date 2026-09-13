import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the PTY/Telegram layers — same shape as the existing
// agent-manager.test.ts so we can construct AgentManager without spawning
// anything real. The inspect helper is pure logic over the agents Map; we
// only need to control what is in / out of the Map.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) { this.name = name; this.dir = dir; }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() {} } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager.inspectAgentOp — issue #346 (DEDUPED vs NOT_FOUND)', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-inspect-test-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('start on empty registry: ok (queued)', () => {
    const r = am.inspectAgentOp('start', 'alice');
    expect(r.ok).toBe(true);
  });

  it('start when agent already in registry: DEDUPED (not NOT_FOUND)', () => {
    // Simulate an in-flight start by injecting an entry into the private map.
    // This is the exact precondition that triggers the BUG-011 dedup branch
    // in startAgent — we need to confirm it surfaces as DEDUPED, not NOT_FOUND.
    // The entry must report a LIVE pid so inspectAgentOp's dead-registry
    // reconciliation keeps it (a phantom/dead entry would be reaped, turning
    // this into a legitimate NOT_FOUND — a different case).
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {
      process: { getStatus: () => ({ status: 'running', pid: 1234 }) },
      checker: { stop() {} },
    } as unknown);
    vi.spyOn(process, 'kill').mockImplementation(() => undefined as unknown as true);

    const r = am.inspectAgentOp('start', 'alice');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('DEDUPED');
      expect(r.message).toMatch(/already in registry/);
      expect(r.message).toContain('alice');
    }
  });

  it('stop on empty registry: NOT_FOUND (the misreport bug — must distinguish)', () => {
    const r = am.inspectAgentOp('stop', 'ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_FOUND');
      expect(r.message).toMatch(/not in registry/);
      expect(r.message).toContain('ghost');
      expect(r.message).toContain('stop');
    }
  });

  it('restart on empty registry: NOT_FOUND', () => {
    const r = am.inspectAgentOp('restart', 'ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_FOUND');
      expect(r.message).toContain('restart');
    }
  });

  it('stop on agent in registry: ok', () => {
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {} as unknown);
    const r = am.inspectAgentOp('stop', 'alice');
    expect(r.ok).toBe(true);
  });

  it('restart on agent in registry: ok', () => {
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', {} as unknown);
    const r = am.inspectAgentOp('restart', 'alice');
    expect(r.ok).toBe(true);
  });

  it('inspectAgentOp does not mutate the agents map (read-only check)', () => {
    const before = (am as unknown as { agents: Map<string, unknown> }).agents.size;
    am.inspectAgentOp('start', 'alice');
    am.inspectAgentOp('stop', 'ghost');
    am.inspectAgentOp('restart', 'phantom');
    const after = (am as unknown as { agents: Map<string, unknown> }).agents.size;
    expect(after).toBe(before);
  });
});

/**
 * Task 3.5: rewritten for the `DispatchResult` contract —
 * `injectAgentDetailed()` now takes `(agentName, text, effect, workIds)` and
 * returns `Promise<DispatchResult>` (`NOT_RUNNING`/`DUPLICATE`/`REVOKED`/
 * `FAILED`, no more `NOT_FOUND`/`DEDUPED`). The old issue #346 distinctions
 * still matter — they're just expressed through the new codes:
 * `NOT_FOUND` -> `FAILED` (not one of `DispatchResult`'s four failure
 * variants), `DEDUPED` -> `DUPLICATE` (now carries `existingWorkIds`, the
 * work-ledger-correlated redelivery signal, not a bare content-hash hit).
 */
describe('AgentManager.injectAgentDetailed — Task 3.5 DispatchResult contract (was issue #346)', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-inject-test-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function dummyEffect(agentId: string) {
    return { agentId, supervisorEpoch: 0, generation: 0, intentRevision: 0, effectId: 'test-effect' };
  }

  it('agent not in registry: FAILED (NOT_FOUND has no DispatchResult analog — the actual harness misreport surface)', async () => {
    const r = await am.injectAgentDetailed('ghost', 'hello', dummyEffect('ghost'), []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('FAILED');
      expect(r.message).toContain('ghost');
      expect(r.message).toMatch(/not in registry/);
    }
  });

  it('agent in registry but PTY dead: NOT_RUNNING (was conflated with NOT_FOUND)', async () => {
    const fakeEntry = {
      process: {
        injectMessageDetailed: async () => ({
          ok: false,
          code: 'NOT_RUNNING' as const,
          retryable: true,
          message: 'agent "alice" is registered but not running (status: stopped)',
        }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const r = await am.injectAgentDetailed('alice', 'hello', dummyEffect('alice'), []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_RUNNING');
      expect(r.message).toMatch(/registered but not running/);
    }
  });

  it('agent running, workIds correlate to an already-dispatched record: DUPLICATE (the cron-salt collision case)', async () => {
    const fakeEntry = {
      process: {
        injectMessageDetailed: async () => ({
          ok: false,
          code: 'DUPLICATE' as const,
          retryable: false,
          existingWorkIds: ['work-1'],
          message: 'inject for "alice" deduped — content matches MessageDedup hash window',
        }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const r = await am.injectAgentDetailed('alice', 'duplicate-content', dummyEffect('alice'), ['work-1']);
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === 'DUPLICATE') {
      expect(r.existingWorkIds).toEqual(['work-1']);
      expect(r.message).toMatch(/MessageDedup/);
    } else {
      throw new Error('expected DUPLICATE');
    }
  });

  it('a revoked generation: REVOKED', async () => {
    const fakeEntry = {
      process: {
        injectMessageDetailed: async () => ({ ok: false, code: 'REVOKED' as const, retryable: false, message: 'revoked' }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const r = await am.injectAgentDetailed('alice', 'x', dummyEffect('alice'), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('REVOKED');
  });

  it('agent running, novel content: ok, with workIds/batchId echoed back', async () => {
    const fakeEntry = {
      process: {
        injectMessageDetailed: async () => ({ ok: true as const, workIds: ['work-2'], batchId: 'batch-1' }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const r = await am.injectAgentDetailed('alice', 'novel-content', dummyEffect('alice'), ['work-2']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workIds).toEqual(['work-2']);
      expect(r.batchId).toBe('batch-1');
    }
  });

  it('boolean injectAgent stays back-compat — agent not in registry collapses to false', () => {
    expect(am.injectAgent('ghost', 'hello')).toBe(false);
  });

  it('boolean injectAgent stays back-compat — legacy injectMessage() false collapses to false', () => {
    const fakeEntry = { process: { injectMessage: () => false } };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    expect(am.injectAgent('alice', 'x')).toBe(false);
  });

  it('boolean injectAgent stays back-compat — legacy injectMessage() true collapses to true', () => {
    const fakeEntry = { process: { injectMessage: () => true } };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    expect(am.injectAgent('alice', 'x')).toBe(true);
  });

  it('injectAgent() is fully decoupled from the async injectMessageDetailed() — calls the sync legacy shim directly, stays synchronous', () => {
    const injectMessage = vi.fn(() => true);
    const injectMessageDetailed = vi.fn();
    const fakeEntry = { process: { injectMessage, injectMessageDetailed } };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const result = am.injectAgent('alice', 'x');
    expect(result).toBe(true); // plain boolean, not a Promise
    expect(injectMessage).toHaveBeenCalledWith('x');
    expect(injectMessageDetailed).not.toHaveBeenCalled();
  });

  it('injectWorker regression: unchanged boolean behavior, no DispatchResult involved', () => {
    expect(am.injectWorker('nonexistent-worker', 'text')).toBe(false);
  });
});

/**
 * Task 3.5: `injectAgentManual()` — the convenience wrapper for a caller
 * (today, only `ipc-server.ts`'s manual `inject-agent` IPC command) with no
 * `EffectToken`/`workIds` of its own. Mints a best-effort effect from the
 * agent's own per-agent supervisor snapshot.
 */
describe('AgentManager.injectAgentManual — Task 3.5 best-effort effect minting', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-inject-manual-test-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('agent not in registry: FAILED', async () => {
    const r = await am.injectAgentManual('ghost', 'hi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('FAILED');
  });

  it('mints an effect reflecting the agent supervisor live snapshot, with empty workIds', async () => {
    let seenEffect: unknown;
    let seenWorkIds: unknown;
    const fakeEntry = {
      process: {
        injectMessageDetailed: async (_text: string, effect: unknown, workIds: unknown) => {
          seenEffect = effect;
          seenWorkIds = workIds;
          return { ok: true as const, workIds: [], batchId: 'b' };
        },
      },
      supervisor: {
        snapshot: () => ({ agentId: 'alice', supervisorEpoch: 5, currentGeneration: 2, intentRevision: 3 }),
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('alice', fakeEntry);
    const r = await am.injectAgentManual('alice', 'hi');
    expect(r.ok).toBe(true);
    expect(seenWorkIds).toEqual([]);
    expect(seenEffect).toMatchObject({ agentId: 'alice', supervisorEpoch: 5, generation: 2, intentRevision: 3 });
  });

  it('falls back to a sentinel effect when no supervisor is wired on the entry', async () => {
    let seenEffect: unknown;
    const fakeEntry = {
      process: {
        injectMessageDetailed: async (_text: string, effect: unknown) => {
          seenEffect = effect;
          return { ok: true as const, workIds: [], batchId: 'b' };
        },
      },
    };
    (am as unknown as { agents: Map<string, unknown> }).agents.set('bob', fakeEntry);
    const r = await am.injectAgentManual('bob', 'hi');
    expect(r.ok).toBe(true);
    expect(seenEffect).toMatchObject({ agentId: 'bob', supervisorEpoch: 0, generation: 0, intentRevision: 0 });
  });
});
