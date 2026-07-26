import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FastChecker } from '../../../src/daemon/fast-checker.js';
import { CRONS_DIRECTORY, CRONS_FILENAME } from '../../../src/bus/crons-schema.js';
import type { BusPaths, CronDefinition } from '../../../src/types/index.js';

function createMockAgent(
  name = 'test-agent',
  config: Record<string, unknown> = { runtime: 'claude-code' },
  agentDir = '/tmp/test-agent',
) {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
    getAgentDir: vi.fn().mockReturnValue(agentDir),
    getCtxRoot: vi.fn().mockReturnValue(agentDir),
    getConfig: vi.fn().mockReturnValue(config),
    getOutputBuffer: vi.fn().mockReturnValue({ getRecent: vi.fn().mockReturnValue('') }),
    sessionRefresh: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) {
      mkdirSync(dir, { recursive: true });
    }
  }
  return paths;
}

function writeCronsFixture(ctxRoot: string, agentName: string, cron: CronDefinition): void {
  const agentDir = join(ctxRoot, CRONS_DIRECTORY, agentName);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, CRONS_FILENAME),
    JSON.stringify({
      updated_at: new Date().toISOString(),
      crons: [cron],
    }, null, 2),
  );
}

function writeCronStateFixture(stateDir: string, cronName: string, lastFire: string): void {
  writeFileSync(
    join(stateDir, 'cron-state.json'),
    JSON.stringify({
      updated_at: new Date().toISOString(),
      crons: [{ name: cronName, last_fire: lastFire, interval: '30m' }],
    }, null, 2),
  );
}

describe('cron liveness reload-before-restart escalation', () => {
  let testDir: string;
  let paths: BusPaths;
  let originalCtxRoot: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-cron-liveness-escalation-'));
    paths = createTestPaths(testDir);
    originalCtxRoot = process.env.CTX_ROOT;
    process.env.CTX_ROOT = testDir;
  });

  afterEach(() => {
    if (originalCtxRoot === undefined) {
      delete process.env.CTX_ROOT;
    } else {
      process.env.CTX_ROOT = originalCtxRoot;
    }
    vi.clearAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeChecker() {
    const agent = createMockAgent('race-agent', { runtime: 'claude-code' }, testDir);
    const reloadCrons = vi.fn().mockReturnValue(true);
    const checker = new FastChecker(agent, paths, '/tmp/framework', { reloadCrons });
    return { agent, reloadCrons, checker };
  }

  function overdueCron(now: number): CronDefinition {
    return {
      name: 'heartbeat',
      prompt: 'ping',
      schedule: '30m',
      enabled: true,
      created_at: new Date(now - 3 * 60 * 60_000).toISOString(),
      last_fired_at: new Date(now - 2 * 60 * 60_000).toISOString(),
    };
  }

  it('first overdue tick only increments streak', async () => {
    const now = Date.now();
    const { agent, reloadCrons, checker } = makeChecker();
    writeCronsFixture(testDir, agent.name, overdueCron(now));
    writeCronStateFixture(paths.stateDir, 'heartbeat', new Date(now - 2 * 60 * 60_000).toISOString());

    await (checker as any).checkCronLiveness(now);

    expect((checker as any).cronLivenessOverdueStreak).toBe(1);
    expect(reloadCrons).not.toHaveBeenCalled();
    expect(agent.sessionRefresh).not.toHaveBeenCalled();
  });

  it('second consecutive overdue tick reloads crons without restarting', async () => {
    const now = Date.now();
    const { agent, reloadCrons, checker } = makeChecker();
    writeCronsFixture(testDir, agent.name, overdueCron(now));
    writeCronStateFixture(paths.stateDir, 'heartbeat', new Date(now - 2 * 60 * 60_000).toISOString());

    await (checker as any).checkCronLiveness(now);
    await (checker as any).checkCronLiveness(now + 61_000);

    expect((checker as any).cronLivenessOverdueStreak).toBe(2);
    expect(reloadCrons).toHaveBeenCalledTimes(1);
    expect(agent.sessionRefresh).not.toHaveBeenCalled();
  });

  it('third consecutive overdue tick escalates to sessionRefresh after reload tier', async () => {
    const now = Date.now();
    const { agent, reloadCrons, checker } = makeChecker();
    writeCronsFixture(testDir, agent.name, overdueCron(now));
    writeCronStateFixture(paths.stateDir, 'heartbeat', new Date(now - 2 * 60 * 60_000).toISOString());

    await (checker as any).checkCronLiveness(now);
    await (checker as any).checkCronLiveness(now + 61_000);
    await (checker as any).checkCronLiveness(now + 122_000);

    expect(reloadCrons).toHaveBeenCalledTimes(1);
    expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not re-escalate within the 15 minute cooldown', async () => {
    const now = Date.now();
    const { agent, reloadCrons, checker } = makeChecker();
    writeCronsFixture(testDir, agent.name, overdueCron(now));
    writeCronStateFixture(paths.stateDir, 'heartbeat', new Date(now - 2 * 60 * 60_000).toISOString());

    await (checker as any).checkCronLiveness(now);
    await (checker as any).checkCronLiveness(now + 61_000);
    await (checker as any).checkCronLiveness(now + 122_000);
    await (checker as any).checkCronLiveness(now + 183_000);

    expect(reloadCrons).toHaveBeenCalledTimes(1);
    expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);
  });

  it('resets the streak when cron liveness recovers before a new overdue episode', async () => {
    const now = Date.now();
    const { agent, reloadCrons, checker } = makeChecker();
    writeCronsFixture(testDir, agent.name, overdueCron(now));
    writeCronStateFixture(paths.stateDir, 'heartbeat', new Date(now - 2 * 60 * 60_000).toISOString());

    await (checker as any).checkCronLiveness(now);

    const recoveredAt = now + 61_000;
    writeCronStateFixture(paths.stateDir, 'heartbeat', new Date(recoveredAt - 1_000).toISOString());
    await (checker as any).checkCronLiveness(recoveredAt);

    writeCronStateFixture(paths.stateDir, 'heartbeat', new Date(now - 2 * 60 * 60_000).toISOString());
    await (checker as any).checkCronLiveness(recoveredAt + 61_000);

    expect((checker as any).cronLivenessOverdueStreak).toBe(1);
    expect(reloadCrons).not.toHaveBeenCalled();
    expect(agent.sessionRefresh).not.toHaveBeenCalled();
  });
});
