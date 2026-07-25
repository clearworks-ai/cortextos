import { describe, it, expect } from 'vitest';
import {
  extractMentions,
  inferLinkType,
  contextWindow,
  PARTNER_ROLE_RE,
} from '../../../../src/bus/kb-graph/link-extraction.js';

describe('link-extraction', () => {
  it('Sequoia led the seed round → invested_in 1.0', () => {
    const r = inferLinkType('Sequoia led the seed round', null);
    expect(r.type).toBe('invested_in');
    expect(r.confidence).toBe(1.0);
  });

  it('early investor → invested_in 1.0; page-role-only → 0.8', () => {
    const direct = inferLinkType('early investor in Clearworks', null);
    expect(direct.type).toBe('invested_in');
    expect(direct.confidence).toBe(1.0);

    const prior = 'I am a venture partner at a fund.'.match(PARTNER_ROLE_RE);
    const role = inferLinkType('mentions Acme casually', prior);
    expect(role.confidence).toBe(0.8);
    expect(role.type).toBe('works_at');

    const invPrior = 'investor in many startups'.match(PARTNER_ROLE_RE);
    const inv = inferLinkType('mentioned PortCo', invPrior);
    expect(inv.type).toBe('invested_in');
    expect(inv.confidence).toBe(0.8);
  });

  it('founded / advises / works_at families', () => {
    expect(inferLinkType('co-founded Acme in 2019', null)).toMatchObject({
      type: 'founded',
      confidence: 1.0,
    });
    expect(inferLinkType('advisor to the board', null).type).toBe('advises');
    expect(inferLinkType('advisory board member', null).type).toBe('advises');
    expect(inferLinkType('CEO of Clearworks', null).type).toBe('works_at');
    expect(inferLinkType('engineer at Acme', null).type).toBe('works_at');
    expect(inferLinkType('joined the team', null).type).toBe('works_at');
  });

  it('precedence: founded beats CEO of', () => {
    const r = inferLinkType('founded Acme and is CEO of Acme', null);
    expect(r.type).toBe('founded');
  });

  it('fallback mentions 0.5', () => {
    const r = inferLinkType('hello there friend', null);
    expect(r).toEqual({ type: 'mentions', confidence: 0.5, matchedFamily: null });
  });

  it('extractMentions: wikilinks, mdlinks, bare; rejects URL', () => {
    const body = [
      'See [[people/josh-weiss]] and [[projects/x|label]].',
      'Also [Acme](companies/acme.md) and see projects/gbrain-port for context.',
      'Ignore https://a.md please.',
    ].join(' ');
    const m = extractMentions(body);
    const targets = m.map((x) => x.rawTarget);
    expect(targets).toContain('people/josh-weiss');
    expect(targets).toContain('projects/x');
    expect(targets).toContain('companies/acme');
    expect(targets).toContain('projects/gbrain-port');
    expect(targets.some((t) => t.includes('https'))).toBe(false);
    expect(m.find((x) => x.rawTarget === 'people/josh-weiss')?.source).toBe('wikilink-resolved');
    expect(m.find((x) => x.rawTarget === 'projects/gbrain-port')?.source).toBe('mentions');
  });

  it('contextWindow clamps at edges', () => {
    const body = 'abcdefghij';
    const w = contextWindow(body, 0, 240);
    expect(w.length).toBeLessThanOrEqual(240);
    expect(w.startsWith('a')).toBe(true);
    const mid = contextWindow('x'.repeat(500) + 'TARGET' + 'y'.repeat(500), 500, 240);
    expect(mid.length).toBeLessThanOrEqual(240);
    expect(mid.includes('TARGET') || mid.includes('xxxx')).toBe(true);
  });
});
