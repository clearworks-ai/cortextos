import { describe, expect, it } from 'vitest';
import { GoalThreadManager } from '../../../src/goals/goal-thread-manager.js';
const manager = (report: unknown, blocker?: any) => new GoalThreadManager({ createThread: async () => ({ id: 'x' }), resumeThread: async () => {}, setThreadGoal: async () => {}, dispatchPrompt: async () => ({ outcome: 'completed', report, blocker }) });
describe('GoalThreadManager strict envelopes', () => {
  it('accepts exact implementation item/cycle and rejects planning/mismatch/malformed', async () => {
    expect((await manager({ kind: 'implementation_report', itemId: 'i', cycle: 2, status: 'completed', summary: 'done' }).dispatchImplementation('t', 'p', 'i', 2, 'now')).kind).toBe('accepted');
    expect((await manager({ kind: 'implementation_report', itemId: 'wrong', cycle: 2, status: 'completed', summary: 'done' }).dispatchImplementation('t', 'p', 'i', 2, 'now')).kind).toBe('invalid');
    expect((await manager('not json').dispatchImplementation('t', 'p', 'i', 2, 'now')).kind).toBe('invalid');
  });
  it('accepts findings/approval and requires findings for changes', async () => {
    const changes = await manager({ kind: 'review_report', itemId: 'i', cycle: 1, decision: 'changes_requested', summary: 'fix', findings: [{ summary: 'bug' }] }).dispatchReview('review', 'p', 'i', 1, 'now'); expect(changes.kind).toBe('accepted');
    expect((await manager({ kind: 'review_report', itemId: 'i', cycle: 1, decision: 'approved', summary: 'ok' }).dispatchReview('review', 'p', 'i', 1, 'now')).kind).toBe('accepted');
    expect((await manager({ kind: 'review_report', itemId: 'i', cycle: 1, decision: 'approved', summary: 'not ok', findings: [{ summary: 'bug' }] }).dispatchReview('review', 'p', 'i', 1, 'now')).kind).toBe('invalid');
  });
  it('rejects failed turns and envelope extensions', async () => { const failed = new GoalThreadManager({ createThread: async () => ({ id: 'x' }), resumeThread: async () => {}, setThreadGoal: async () => {}, dispatchPrompt: async () => ({ outcome: 'failed', report: { kind: 'implementation_report', itemId: 'i', cycle: 1, status: 'completed', summary: 'fake' } }) }); expect((await failed.dispatchImplementation('t', 'p', 'i', 1, 'now')).kind).toBe('invalid'); expect((await manager({ kind: 'implementation_report', itemId: 'i', cycle: 1, status: 'completed', summary: 'x', extra: true }).dispatchImplementation('t', 'p', 'i', 1, 'now')).kind).toBe('invalid'); });
  it('only forwards structured blockers and bounds summaries', async () => { const result = await manager(undefined, { kind: 'credential', summary: 'x'.repeat(900), source: 'codex_turn' }).dispatchImplementation('t', 'p', 'i', 1, 'now'); expect(result.kind).toBe('blocked'); if (result.kind === 'blocked') expect(result.blocker.summary.length).toBeLessThanOrEqual(512); });
});
