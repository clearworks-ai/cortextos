import { describe, expect, it } from 'vitest';
import { renderGoalsMarkdown } from '../../../src/cli/goals.js';

describe('renderGoalsMarkdown', () => {
  it('preserves append-only correction metadata from goals.json', () => {
    const markdown = renderGoalsMarkdown({
      focus: 'Current focus',
      goals: ['Current goal'],
      bottleneck: 'Current bottleneck',
      updated_at: '2026-08-21T00:24:00Z',
      updated_by: 'sage-codex',
      cu3_correction_2026_08_19: {
        retraction_anchor: 'anchor-hash',
        retraction_source: 'ledger.jsonl:38',
        false_claims_in_this_file: ['Historical claim — FALSE.'],
        true_baseline: '75 matched / 5 missing / 2 ambiguous.',
        corrected_disposition: 'Clean 82-of-82 remains open.',
      },
    }, { agent: 'larry-codex', org: 'clearworksai' });

    expect(markdown).toContain('CORRECTION — 2026-08-19');
    expect(markdown).toContain('**Retraction anchor:** `anchor-hash` (ledger.jsonl:38)');
    expect(markdown).toContain('> - Historical claim — FALSE.');
    expect(markdown).toContain('**True baseline:** 75 matched / 5 missing / 2 ambiguous.');
    expect(markdown).toContain('**Corrected disposition:** Clean 82-of-82 remains open.');
    expect(markdown.indexOf('CORRECTION')).toBeLessThan(markdown.indexOf('## Focus'));
  });

  it('does not render unrelated custom objects as corrections', () => {
    const markdown = renderGoalsMarkdown({
      focus: 'Current focus',
      custom_metadata: { retraction_anchor: 'not-a-correction' },
    }, { agent: 'sage-codex', org: 'clearworksai' });

    expect(markdown).not.toContain('not-a-correction');
  });
});
