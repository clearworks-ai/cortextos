import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hasNodeSqlite, openLinksDb, upsertEdge, upsertEntity } from '../../../../src/bus/kb-graph/db.js';
import {
  parseRelationalIntent,
  executeIntent,
  runGraphCanary,
} from '../../../../src/bus/kb-graph/relational.js';
import type { SlugResolver } from '../../../../src/bus/kb-graph/resolve.js';

describe('relational parser', () => {
  it('parses seven patterns and rejects freeform', () => {
    expect(parseRelationalIntent('who invested in X?')).toMatchObject({
      kind: 'edge_in',
      edgeType: 'invested_in',
      seedNames: ['X'],
    });
    expect(parseRelationalIntent('who works at Clearworks?')?.edgeType).toBe('works_at');
    expect(parseRelationalIntent('who founded Acme?')?.edgeType).toBe('founded');
    expect(parseRelationalIntent('who advises Bob?')?.edgeType).toBe('advises');
    expect(parseRelationalIntent('who does Alice work with?')).toMatchObject({
      kind: 'two_hop_peers',
      seedNames: ['Alice'],
    });
    expect(parseRelationalIntent('what connects A and B?')).toMatchObject({
      kind: 'any_path',
      seedNames: ['A', 'B'],
    });
    expect(parseRelationalIntent('who did X introduce me to?')?.kind).toBe('intro_traversal');
    expect(parseRelationalIntent('summarize the wiki')).toBeNull();
  });
});

describe.skipIf(!hasNodeSqlite())('relational execute + canary', () => {
  let dir: string;
  let dbPath: string;
  let resolver: SlugResolver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rel-'));
    dbPath = join(dir, 'links.sqlite');
    const map: Record<string, string> = {
      clearworks: 'companies/clearworks',
      'companies/clearworks': 'companies/clearworks',
      sequoia: 'people/sequoia-partner',
      'people/sequoia-partner': 'people/sequoia-partner',
      alice: 'people/alice',
      'people/alice': 'people/alice',
      bob: 'people/bob',
      'people/bob': 'people/bob',
      a: 'people/a',
      b: 'people/b',
      c: 'people/c',
      d: 'people/d',
      e: 'people/e',
      f: 'people/f',
      'people/a': 'people/a',
      'people/b': 'people/b',
      'people/c': 'people/c',
      'people/d': 'people/d',
      'people/e': 'people/e',
      'people/f': 'people/f',
      x: 'people/x',
      'people/x': 'people/x',
      'josh-weiss': 'people/josh-weiss',
    };
    resolver = {
      resolve(name: string) {
        const key = name.toLowerCase();
        if (map[key]) return { slug: map[key], method: 'exact' as const };
        return { slug: key, method: 'slugify' as const };
      },
    };

    const db = openLinksDb(dbPath);
    for (const slug of Object.values(map)) {
      upsertEntity(db, slug, slug.split('/')[0]);
    }
    upsertEdge(db, {
      from_slug: 'people/sequoia-partner',
      to_slug: 'companies/clearworks',
      type: 'invested_in',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: 'Sequoia led the seed round',
      confidence: 1.0,
      source_path: null,
    });
    upsertEdge(db, {
      from_slug: 'people/sequoia-partner',
      to_slug: 'companies/clearworks',
      type: 'mentions',
      link_source: 'mentions',
      link_kind: '',
      context: 'mentioned',
      confidence: 0.5,
      source_path: null,
    });
    upsertEdge(db, {
      from_slug: 'people/alice',
      to_slug: 'companies/clearworks',
      type: 'works_at',
      link_source: 'frontmatter',
      link_kind: '',
      context: null,
      confidence: 0.9,
      source_path: null,
    });
    upsertEdge(db, {
      from_slug: 'people/bob',
      to_slug: 'companies/clearworks',
      type: 'works_at',
      link_source: 'frontmatter',
      link_kind: '',
      context: null,
      confidence: 0.9,
      source_path: null,
    });
    // chain for any_path: a-c-b and long path a-d-e-f-b
    upsertEdge(db, {
      from_slug: 'people/a',
      to_slug: 'people/c',
      type: 'relates_to',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: null,
      confidence: 1.0,
      source_path: null,
    });
    upsertEdge(db, {
      from_slug: 'people/b',
      to_slug: 'people/c',
      type: 'relates_to',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: null,
      confidence: 0.8,
      source_path: null,
    });
    upsertEdge(db, {
      from_slug: 'people/a',
      to_slug: 'people/d',
      type: 'relates_to',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: null,
      confidence: 1,
      source_path: null,
    });
    upsertEdge(db, {
      from_slug: 'people/d',
      to_slug: 'people/e',
      type: 'relates_to',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: null,
      confidence: 1,
      source_path: null,
    });
    upsertEdge(db, {
      from_slug: 'people/e',
      to_slug: 'people/f',
      type: 'relates_to',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: null,
      confidence: 1,
      source_path: null,
    });
    upsertEdge(db, {
      from_slug: 'people/f',
      to_slug: 'people/b',
      type: 'relates_to',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: null,
      confidence: 1,
      source_path: null,
    });
    // cycle
    upsertEdge(db, {
      from_slug: 'people/a',
      to_slug: 'people/x',
      type: 'relates_to',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: null,
      confidence: 1,
      source_path: null,
    });
    upsertEdge(db, {
      from_slug: 'people/x',
      to_slug: 'people/a',
      type: 'relates_to',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: null,
      confidence: 1,
      source_path: null,
    });
    // intro
    upsertEdge(db, {
      from_slug: 'people/x',
      to_slug: 'people/bob',
      type: 'mentions',
      link_source: 'mentions',
      link_kind: '',
      context: 'introduced',
      confidence: 0.5,
      source_path: null,
    });
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('edge_in returns typed row with context', () => {
    const db = openLinksDb(dbPath);
    const intent = parseRelationalIntent('who invested in Clearworks')!;
    const out = executeIntent(db, intent, resolver);
    expect(out.hits[0]?.slug).toBe('people/sequoia-partner');
    expect(out.hits[0]?.confidence).toBe(1.0);
    expect(out.hits[0]?.path[0].context).toBe('Sequoia led the seed round');
    db.close();
  });

  it('plain mentions excluded from invested_in, included in intro', () => {
    const db = openLinksDb(dbPath);
    const inv = executeIntent(db, parseRelationalIntent('who invested in Clearworks')!, resolver);
    expect(inv.hits.every((h) => h.path[0].type !== 'mentions')).toBe(true);
    const intro = executeIntent(db, parseRelationalIntent('who did X introduce me to')!, resolver);
    expect(intro.hits.some((h) => h.slug === 'people/bob')).toBe(true);
    db.close();
  });

  it('two_hop_peers', () => {
    const db = openLinksDb(dbPath);
    const out = executeIntent(db, parseRelationalIntent('who does Alice work with')!, resolver);
    expect(out.hits.some((h) => h.slug === 'people/bob')).toBe(true);
    expect(out.hits.some((h) => h.slug === 'people/alice')).toBe(false);
    expect(out.hits[0].path.length).toBe(2);
    db.close();
  });

  it('any_path depth and weakest-link confidence', () => {
    const db = openLinksDb(dbPath);
    const out = executeIntent(db, parseRelationalIntent('what connects A and B')!, resolver, {
      maxDepth: 4,
    });
    expect(out.hits.length).toBeGreaterThan(0);
    const viaC = out.hits.find((h) => h.path.length === 2);
    expect(viaC?.confidence).toBe(0.8);

    const shallow = executeIntent(db, parseRelationalIntent('what connects A and B')!, resolver, {
      maxDepth: 3,
    });
    const deepNeed = shallow.hits.some((h) => h.path.length >= 5);
    expect(deepNeed).toBe(false);
    const deep = executeIntent(db, parseRelationalIntent('what connects A and B')!, resolver, {
      maxDepth: 6,
    });
    expect(deep.hits.some((h) => h.path.length >= 4)).toBe(true);
    db.close();
  });

  it('unresolved seed → empty hits resolved null', () => {
    const db = openLinksDb(dbPath);
    const out = executeIntent(db, parseRelationalIntent('who works at NobodyCorp')!, resolver);
    expect(out.seeds[0].resolved).toBeNull();
    expect(out.hits).toEqual([]);
    db.close();
  });

  it('canary pass/fail', () => {
    const db = openLinksDb(dbPath);
    const pass = runGraphCanary(db, resolver, {
      min_edges: 1,
      queries: [{ query: 'who works at Clearworks?', expect_slug: 'people/alice' }],
    });
    expect(pass.ok).toBe(true);
    const fail = runGraphCanary(db, resolver, {
      min_edges: 1,
      queries: [{ query: 'who works at Clearworks?', expect_slug: 'people/nobody' }],
    });
    expect(fail.ok).toBe(false);
    expect(fail.failures.length).toBeGreaterThan(0);
    db.close();
  });
});
