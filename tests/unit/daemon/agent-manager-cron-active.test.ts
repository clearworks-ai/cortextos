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
