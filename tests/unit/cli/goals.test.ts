import { describe, expect, it } from 'vitest';
import { lintGoals, renderGoalsMarkdown } from '../../../src/cli/goals.js';

describe('renderGoalsMarkdown', () => {
  it('renders plain lines: focus, numbered goals, blocked-on', () => {
    const markdown = renderGoalsMarkdown({
      focus: 'Ship the Monday pipeline brief',
      goals: ['Keep contacts and pipeline accurate', { title: 'Draft follow-ups for approval' }],
      bottleneck: 'Two Moxie proposals await Josh',
      updated_at: '2026-10-11T00:00:00Z',
      updated_by: 'frank2-codex',
    });

    expect(markdown).toBe([
      '# Goals',
      '',
      'Focus: Ship the Monday pipeline brief',
      '',
      '1. Keep contacts and pipeline accurate',
      '2. Draft follow-ups for approval',
      '',
      'Blocked on: Two Moxie proposals await Josh',
      '',
    ].join('\n'));
  });

  it('omits history, correction blocks, and empty bottleneck', () => {
    const markdown = renderGoalsMarkdown({
      focus: 'Current focus',
      goals: ['Current goal'],
      bottleneck: '',
      updated_by: 'sage-codex',
      cu3_correction_2026_08_19: { retraction_anchor: 'anchor-hash', false_claims_in_this_file: ['FALSE claim'] },
    });

    expect(markdown).not.toContain('anchor-hash');
    expect(markdown).not.toContain('FALSE claim');
    expect(markdown).not.toContain('Blocked on');
    expect(markdown).not.toContain('sage-codex');
    expect(markdown).not.toContain('Auto-generated');
  });

  it('tells the agent to ask when nothing is set', () => {
    const markdown = renderGoalsMarkdown({});
    expect(markdown).toContain('Focus: not set. Ask your orchestrator.');
    expect(markdown).toContain('No goals set. Ask your orchestrator.');
  });
});

describe('lintGoals', () => {
  it('is clean for short plain goals', () => {
    expect(lintGoals({ focus: 'Research AEC signals for Josh', goals: ['Send the daily brief', 'Draft the Friday newsletter'] })).toEqual([]);
  });

  it('flags task IDs, hashes, legal register, length, and count', () => {
    const problems = lintGoals({
      focus: 'Preserve task_1790398044100_06722606 as terminal evidence and infer no new lane',
      goals: Array.from({ length: 8 }, (_, i) => `goal ${i}`),
      bottleneck: 'x'.repeat(300),
    });
    expect(problems.some((p) => p.includes('8 goals'))).toBe(true);
    expect(problems.some((p) => p.includes('over 240 chars'))).toBe(true);
    expect(problems.some((p) => p.includes('task IDs, hashes'))).toBe(true);
  });
});
