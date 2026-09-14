import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Capture the onFire callback the AgentManager hands to CronScheduler so we can
// drive a cron fire directly (onFire is a private closure with no public entry).
const cronCapture = vi.hoisted(() => ({
  onFireByAgent: new Map<string, (cron: { name: string; prompt?: string }) => Promise<void>>(),
}));

vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    constructor(opts: { agentName: string; onFire: (cron: { name: string; prompt?: string }) => Promise<void> }) {
      cronCapture.onFireByAgent.set(opts.agentName, opts.onFire);
    }
    start() { /* no-op */ }
    stop() { /* no-op */ }
    getNextFireTimes() { return []; }
  },
}));

// PTY + FastChecker are irrelevant here (we register a fake agent entry directly).
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class { async start() {} async stop() {} getStatus() { return { status: 'running' }; } onExit() {} },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));

import { AgentManager } from '../../../src/daemon/agent-manager.js';

describe('AgentManager.onFire — .cron-active marker (loop6)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cron-active-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    cronCapture.onFireByAgent.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeManagerWithCron(agentName: string) {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    // Register a minimal non-hermes agent so startAgentCronScheduler proceeds.
    (am as unknown as { agents: Map<string, unknown> }).agents.set(agentName, {
      process: { config: { runtime: 'claude' } },
      checker: {},
    });
    (am as unknown as { startAgentCronScheduler(name: string): void }).startAgentCronScheduler(agentName);
    const onFire = cronCapture.onFireByAgent.get(agentName);
    if (!onFire) throw new Error('onFire was not captured');
    return { am, onFire, markerPath: join(ctxRoot, 'state', agentName, '.cron-active') };
  }

  it('writes .cron-active with the readCronActive shape BEFORE injectAgent, then removes it after', async () => {
    const { am, onFire, markerPath } = makeManagerWithCron('boris');

    let markerAtInject: string | null = null;
    vi.spyOn(am, 'injectAgent').mockImplementation(() => {
      markerAtInject = existsSync(markerPath) ? readFileSync(markerPath, 'utf-8') : null;
      return true;
    });

    await onFire({ name: 'heartbeat', prompt: 'tick' });

    // Written before injectAgent ran, with the exact shape readCronActive parses.
    expect(markerAtInject).not.toBeNull();
    const parsed = JSON.parse(markerAtInject as unknown as string) as { cronName: string; firedAt: string; expiresAt: number };
    expect(parsed.cronName).toBe('heartbeat');
    expect(typeof parsed.firedAt).toBe('string');
    expect(typeof parsed.expiresAt).toBe('number');
    expect(parsed.expiresAt).toBeGreaterThan(Date.now());

    // Cleaned up after the turn.
    expect(existsSync(markerPath)).toBe(false);
  });

  it('removes the marker even when injectAgent throws (finally block runs)', async () => {
    const { am, onFire, markerPath } = makeManagerWithCron('boris');
    vi.spyOn(am, 'injectAgent').mockImplementation(() => {
      // Prove the marker exists mid-turn, then blow up.
      expect(existsSync(markerPath)).toBe(true);
      throw new Error('inject boom');
    });

    await expect(onFire({ name: 'heartbeat', prompt: 'tick' })).rejects.toThrow(/inject boom/);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('removes the marker when injectAgent returns false (onFire throws, finally runs)', async () => {
    const { am, onFire, markerPath } = makeManagerWithCron('boris');
    vi.spyOn(am, 'injectAgent').mockReturnValue(false);
    await expect(onFire({ name: 'heartbeat', prompt: 'tick' })).rejects.toThrow(/injectAgent returned false/);
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe('AgentManager.onFire — supervised gating (production hotfix 2026-09-13)', () => {
  // Regression for a real production incident: Task 2.5's lazy adoption gives
  // EVERY agent a real supervisor object, supervised or not. onFire used to
  // gate on that object's mere presence instead of `entry.supervised === true`,
  // so every cron fire on every unsupervised agent called `acceptBatch()` and
  // created a work-ledger entry nothing ever completed — `outstandingWork()`
  // grew forever and Task 3.6's wedge-exclusion widening then alerted
  // "suspected wedge" on every cycle, for every agent, in production.
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cron-supervised-gate-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    cronCapture.onFireByAgent.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeManagerWithSupervisor(agentName: string, supervised: boolean) {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const acceptBatch = vi.fn().mockResolvedValue({ ok: true, workIds: ['work-test-1'], batchId: 'batch-test-1' });
    const snapshot = vi.fn().mockReturnValue({
      agentId: agentName,
      supervisorEpoch: 1,
      currentGeneration: 1,
      intentRevision: 0,
    });
    // A real (lazily-adopted) supervisor object is present on EVERY entry,
    // matching Task 2.5's design — the bug was never checking `supervised`.
    (am as unknown as { agents: Map<string, unknown> }).agents.set(agentName, {
      process: { config: { runtime: 'claude' } },
      checker: {},
      supervised,
      supervisor: { acceptBatch, snapshot },
    });
    (am as unknown as { startAgentCronScheduler(name: string): void }).startAgentCronScheduler(agentName);
    const onFire = cronCapture.onFireByAgent.get(agentName);
    if (!onFire) throw new Error('onFire was not captured');
    return { am, onFire, acceptBatch };
  }

  it('an unsupervised agent (supervised: false, supervisor object present) never calls acceptBatch — falls back to legacy injectAgent', async () => {
    const { am, onFire, acceptBatch } = makeManagerWithSupervisor('unsupervised-agent', false);
    vi.spyOn(am, 'injectAgent').mockReturnValue(true);

    await onFire({ name: 'heartbeat', prompt: 'tick' });

    expect(acceptBatch).not.toHaveBeenCalled();
    expect(am.injectAgent).toHaveBeenCalledTimes(1);
  });

  it('an agent with no `supervised` field at all (the real production shape before this fix) never calls acceptBatch either', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const acceptBatch = vi.fn().mockResolvedValue({ ok: true, workIds: ['work-test-1'], batchId: 'batch-test-1' });
    (am as unknown as { agents: Map<string, unknown> }).agents.set('legacy-shape-agent', {
      process: { config: { runtime: 'claude' } },
      checker: {},
      supervisor: { acceptBatch }, // supervised field entirely absent
    });
    (am as unknown as { startAgentCronScheduler(name: string): void }).startAgentCronScheduler('legacy-shape-agent');
    const onFire = cronCapture.onFireByAgent.get('legacy-shape-agent');
    if (!onFire) throw new Error('onFire was not captured');
    vi.spyOn(am, 'injectAgent').mockReturnValue(true);

    await onFire({ name: 'heartbeat', prompt: 'tick' });

    expect(acceptBatch).not.toHaveBeenCalled();
  });

  it('a genuinely supervised agent (supervised: true) DOES route the cron fire through acceptBatch', async () => {
    const { am, onFire, acceptBatch } = makeManagerWithSupervisor('supervised-agent', true);
    vi.spyOn(am, 'injectAgentDetailed').mockResolvedValue({ ok: true, workIds: ['work-test-1'], batchId: 'batch-test-1' });

    await onFire({ name: 'heartbeat', prompt: 'tick' });

    expect(acceptBatch).toHaveBeenCalledTimes(1);
  });
});
