import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGoalManifest } from '../../src/goals/goal-manifest.js';
import { DEFAULT_GOAL_CONFIG, type GoalRun } from '../../src/goals/goal-run.js';
import { GoalRunStore } from '../../src/goals/goal-run-store.js';
import { CodexAppServerPTY } from '../../src/pty/codex-app-server-pty.js';

const waitFor = async (predicate: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> => { const started = Date.now(); while (Date.now() - started < timeoutMs) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error(`timed out waiting for ${label}`); };

/**
 * Process-boundary adapter proof. This does not replace request(), _rpc, the
 * socket client, or adapter lifecycle. The source-test build cannot use the
 * compiled pty-host entry, so only the child-process launcher seam is supplied.
 * The deterministic app-server fixture runs as a separate OS process while
 * CodexAppServerPTY performs real socket connect, JSON-RPC, notification,
 * restart, scheduler, interrupt, and teardown paths.
 */
describe('durable goal real PTY process boundary', () => {
  it('recovers, advances blocked siblings, persists reviewer restart, correlates noise, and shuts down safely', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-pty-process-')); const bin = join(root, 'bin'); mkdirSync(bin); const mock = join(process.cwd(), 'tests/e2e/mock-codex.js'); const wrapper = join(bin, 'codex'); writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} "$@"\n`); chmodSync(wrapper, 0o755); const scenarioState = join(root, 'scenario.json'); writeFileSync(scenarioState, JSON.stringify({ boots: 0 }));
    const previous = { PATH: process.env.PATH, durable: process.env.CXR_GOAL_DURABLE, tick: process.env.CXR_GOAL_TICK_INTERVAL_MS, retry: process.env.CXR_GOAL_RETRY_DELAY_MS, scenario: process.env.MOCK_CODEX_GOAL_SCENARIO, state: process.env.MOCK_CODEX_GOAL_STATE };
    process.env.PATH = `${bin}:${previous.PATH ?? ''}`; process.env.CXR_GOAL_DURABLE = 'true'; process.env.CXR_GOAL_TICK_INTERVAL_MS = '20'; process.env.CXR_GOAL_RETRY_DELAY_MS = '1'; process.env.MOCK_CODEX_GOAL_SCENARIO = '1'; process.env.MOCK_CODEX_GOAL_STATE = scenarioState;
    const processLauncher = (_file: string, args: string[], options: any) => { const child = spawnProcess(wrapper, args, { cwd: options.cwd, env: { ...options.env, MOCK_CODEX_GOAL_SCENARIO: '1', MOCK_CODEX_GOAL_STATE: scenarioState }, stdio: ['pipe', 'pipe', 'pipe'] }); return { pid: child.pid ?? 0, write: (data: string) => child.stdin.write(data), onData: (callback: (data: string) => void) => { const out = (chunk: Buffer) => callback(chunk.toString()); child.stdout.on('data', out); child.stderr.on('data', out); return { dispose: () => { child.stdout.off('data', out); child.stderr.off('data', out); } }; }, onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => { const handler = (code: number | null) => callback({ exitCode: code ?? 1 }); child.on('exit', handler); return { dispose: () => child.off('exit', handler) }; }, kill: (signal?: string) => child.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM') }; };
    const stateRoot = join(root, 'state', 'agent'); const objective = '# Board\n- Credential item\n- Reviewer item'; const manifest = createGoalManifest(objective, ['proof']); const now = new Date().toISOString(); const run: GoalRun = { schemaVersion: 3, id: 'process-run', agentName: 'agent', goal: objective, repo: process.cwd(), state: 'queued', manifest, itemProgress: manifest.boards[0]!.items.map((item) => ({ itemId: item.id, status: 'runnable', phase: 'implementation', cycle: 1, attempt: 0, evidenceReceipts: [], reviewReceipts: [], findings: [], updatedAt: now })), schedulingCursor: 0, attempt: 0, maxAttempts: 3, acceptanceChecks: [{ id: 'proof', command: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 1000, required: true }], artifacts: [], events: [], createdAt: now, updatedAt: now };
    const store = new GoalRunStore(stateRoot, { ...DEFAULT_GOAL_CONFIG, tickIntervalMs: 20, retryDelayMs: 1 }); await store.initialize(); await store.create(run); expect((await store.claimEligible('agent', run.id, 'crashed-process', 0)).kind).toBe('claimed');
    const env: any = { ctxRoot: root, agentName: 'agent', agentDir: root, projectRoot: root, frameworkRoot: root, instanceId: 'test', org: 'test' }; const config: any = { name: 'agent', working_directory: process.cwd() }; let first: CodexAppServerPTY | undefined; let second: CodexAppServerPTY | undefined;
    try {
      first = new CodexAppServerPTY(env, config); (first as any)._spawnFn = processLauncher; await first.spawn('fresh', ''); const firstPid = first.getPid(); expect(firstPid).toBeTruthy(); expect(firstPid).not.toBe(process.pid);
      await waitFor(async () => { const persisted = await store.get('agent', run.id); return persisted?.itemProgress?.[0]?.status === 'waiting' && persisted.itemProgress[1]?.cycle === 2 && Boolean((first as any).goalPendingTurn); }, 'first process reviewer reopen and cycle-2 dispatch');
      await first.kill(); const interrupted = await store.get('agent', run.id); expect(interrupted?.state).toBe('retry_wait'); expect(interrupted?.itemProgress?.[0]?.status).toBe('waiting'); expect(interrupted?.itemProgress?.[1]?.cycle).toBe(2);
      second = new CodexAppServerPTY(env, config); (second as any)._spawnFn = processLauncher; await second.spawn('continue', ''); const secondPid = second.getPid(); expect(secondPid).toBeTruthy(); expect(secondPid).not.toBe(firstPid);
      await waitFor(async () => { const persisted = await store.get('agent', run.id); return persisted?.state === 'needs_human' && persisted.itemProgress?.[1]?.status === 'done'; }, 'second process reviewer approval');
      const completed = await store.get('agent', run.id); expect(completed?.itemProgress?.map((item) => item.status)).toEqual(['waiting', 'done']); expect(completed?.itemProgress?.[1]?.findings.some((finding) => finding.summary === 'fixture restart finding')).toBe(true); expect(JSON.parse(readFileSync(scenarioState, 'utf8')).boots).toBe(2);
    } finally {
      await second?.kill(); await first?.kill();
      const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; }; restore('PATH', previous.PATH); restore('CXR_GOAL_DURABLE', previous.durable); restore('CXR_GOAL_TICK_INTERVAL_MS', previous.tick); restore('CXR_GOAL_RETRY_DELAY_MS', previous.retry); restore('MOCK_CODEX_GOAL_SCENARIO', previous.scenario); restore('MOCK_CODEX_GOAL_STATE', previous.state); rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
