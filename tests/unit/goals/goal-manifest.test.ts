import { describe, expect, it } from 'vitest';
import { auditGoalCompletion, createGoalManifest, migrateGoalRun, validateGoalManifest } from '../../../src/goals/goal-manifest.js';
import type { GoalRun } from '../../../src/goals/goal-run.js';

describe('schema-v3 goal manifest', () => {
  it('preserves six explicit items byte-for-byte, in order, through JSON', () => {
    const objective = '# Board\n- One!\n- Two?\n- Three.\n- Four — exact\n- Five (x)\n- Six: final';
    const manifest = createGoalManifest(objective, ['proof']); const roundTrip = JSON.parse(JSON.stringify(manifest));
    expect(roundTrip.objectiveVerbatim).toBe(objective);
    expect(roundTrip.boards[0].items.map((item: any) => item.textVerbatim)).toEqual(['One!', 'Two?', 'Three.', 'Four — exact', 'Five (x)', 'Six: final']);
    expect(validateGoalManifest(roundTrip)).toEqual([]);
  });
  it('uses one exact singleton for unstructured input', () => { const objective = 'Finish A; then B, exactly.'; const manifest = createGoalManifest(objective); expect(manifest.boards).toHaveLength(1); expect(manifest.boards[0]!.items[0]!.textVerbatim).toBe(objective); });
  it('rejects mutation, removal, and reordering by digest/order/source', () => {
    const manifest = createGoalManifest('# B\n- A\n- B', ['proof']); const changed = structuredClone(manifest); changed.boards[0]!.items.reverse(); changed.boards[0]!.items[0]!.textVerbatim = 'renamed';
    expect(validateGoalManifest(changed).length).toBeGreaterThan(0); const removed = structuredClone(manifest); removed.boards[0]!.items.pop(); expect(validateGoalManifest(removed)).toContain('manifest digest mismatch');
  });
  it('migrates active v2 exactly and leaves terminal v2 historical', () => {
    const base: GoalRun = { schemaVersion: 2, id: 'x', agentName: 'a', goal: 'verbatim!', repo: '.', state: 'queued', attempt: 0, maxAttempts: 3, acceptanceChecks: [], artifacts: [], events: [], createdAt: 'x', updatedAt: 'x' };
    expect(migrateGoalRun(base).manifest?.objectiveVerbatim).toBe('verbatim!'); expect(migrateGoalRun({ ...base, state: 'done' }).schemaVersion).toBe(2);
  });
  it('fails completion when progress/results/review are absent', () => {
    const manifest = createGoalManifest('one', ['proof']); const run: GoalRun = { schemaVersion: 3, id: 'x', agentName: 'a', goal: 'one', repo: '.', state: 'verifying', manifest, itemProgress: [{ itemId: 'item-001', status: 'done', phase: 'review', cycle: 1, attempt: 0, evidenceReceipts: [], reviewReceipts: [], findings: [], updatedAt: 'x' }], attempt: 0, maxAttempts: 3, acceptanceChecks: [{ id: 'proof', command: ['true'], required: true, timeoutMs: 1 }], artifacts: [], events: [], createdAt: 'x', updatedAt: 'x', finalVerificationPassed: true };
    expect(auditGoalCompletion(run).passed).toBe(false);
  });
});
