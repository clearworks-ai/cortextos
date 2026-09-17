import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GoalRun } from '../../../src/types/goal-run.js';
import { GoalLeaseProtocol } from '../../../src/daemon/goal-lease-protocol.js';
import { GoalRunStore } from '../../../src/daemon/goal-run-store.js';
import { GoalStateMachine } from '../../../src/daemon/goal-state-machine.js';
import { GoalRunner } from '../../../src/daemon/goal-runner.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (): GoalRun => ({ id: 'run-1', agentName: 'agent', goal: 'test', repo: process.cwd(), state: 'queued', attempt: 0, maxAttempts: 3, acceptanceChecks: [], artifacts: [], events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

describe('goal run control plane primitives', () => {
  it('persists runs and rejects stale lease-token mutations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-run-')); dirs.push(dir); const store = new GoalRunStore(dir); await store.initialize();
    const value = run(); await store.create(value); const lease = GoalLeaseProtocol.generateLease('runner');
    await store.updateUnleased(value.agentName, value.id, current => ({ ...GoalStateMachine.transition(current, 'claimed'), ...lease }));
    await expect(store.update(value.agentName, value.id, 'stale', current => current)).rejects.toThrow('Lease token mismatch');
    const updated = await store.update(value.agentName, value.id, lease.leaseToken, current => GoalStateMachine.transition(current, 'running'));
    expect(updated.state).toBe('running'); expect(GoalLeaseProtocol.isValid(updated, lease.leaseToken)).toBe(true);
  });

  it('enforces terminal state and lease renewal invariants', () => {
    const value = run(); expect(GoalStateMachine.canTransition('queued', 'done')).toBe(false);
    const lease = GoalLeaseProtocol.generateLease('runner'); const claimed = { ...GoalStateMachine.transition(value, 'claimed'), ...lease };
    expect(GoalLeaseProtocol.clear(GoalLeaseProtocol.renew(claimed)).leaseToken).toBeUndefined();
    expect(() => GoalStateMachine.transition(value, 'done')).toThrow('Invalid state transition');
  });

  it('keeps recoverable failures retryable after the legacy attempt limit', async () => {
    let latest: GoalRun = { ...run(), state: 'verifying' as const, attempt: 3, leaseToken: 'lease' };
    const store = { update: async (_agent: string, _id: string, _token: string, mutate: (current: GoalRun) => GoalRun) => (latest = mutate(latest)) } as unknown as GoalRunStore;
    const runner = new GoalRunner(store, { retryDelayMs: 1, retryMaxDelayMs: 1, checkTimeoutMs: 1 }, {} as never) as unknown as { failOrRetry(run: GoalRun, token: string, reason: string): Promise<void> };
    await runner.failOrRetry(latest, 'lease', 'Acceptance checks failed');
    expect(latest.state).toBe('retry_wait');
  });
});
