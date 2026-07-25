import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hasNodeSqlite } from '../../../../src/bus/kb-graph/db.js';

vi.mock('../../../../src/utils/org.js', () => ({
  normalizeOrgName: (_root: string, org: string) => `NORM:${org}`,
}));

const {
  openLinksDb,
  upsertEdge,
  upsertEntity,
  getWatermark,
  setWatermark,
  edgeStats,
  linksDbPath,
} = await import('../../../../src/bus/kb-graph/db.js');
const { extractEdges } = await import('../../../../src/bus/kb-graph/extract.js');

describe.skipIf(!hasNodeSqlite())('kb-graph/db', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kbdb-'));
    dbPath = join(dir, 'links.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('DDL idempotent open twice', () => {
    const db1 = openLinksDb(dbPath);
    db1.close();
    const db2 = openLinksDb(dbPath);
    upsertEntity(db2, 'people/a', 'people');
    expect(edgeStats(db2).entities).toBe(1);
    db2.close();
  });

  it('UNIQUE upsert updates context; empty link_kind uniqueness', () => {
    const db = openLinksDb(dbPath);
    upsertEdge(db, {
      from_slug: 'a',
      to_slug: 'b',
      type: 'mentions',
      link_source: 'mentions',
      link_kind: '',
      context: 'one',
      confidence: 0.5,
      source_path: '/x',
    });
    upsertEdge(db, {
      from_slug: 'a',
      to_slug: 'b',
      type: 'mentions',
      link_source: 'mentions',
      link_kind: '',
      context: 'two',
      confidence: 0.5,
      source_path: '/x',
    });
    expect(edgeStats(db).edges).toBe(1);
    const row = db.prepare('SELECT context FROM edges').get() as { context: string };
    expect(row.context).toBe('two');

    // typed_ner can coexist
    upsertEdge(db, {
      from_slug: 'a',
      to_slug: 'b',
      type: 'works_at',
      link_source: 'mentions',
      link_kind: 'typed_ner',
      context: 'ceo',
      confidence: 1,
      source_path: '/x',
    });
    expect(edgeStats(db).edges).toBe(2);
    db.close();
  });

  it('watermark skip + force re-extract', () => {
    const root = join(dir, 'wiki');
    mkdirSync(join(root, 'people'), { recursive: true });
    const file = join(root, 'people', 't.md');
    writeFileSync(file, 'Hello [[projects/x]] engineer at Place.\n');
    const resolver = {
      resolve: (name: string) => ({ slug: name.includes('/') ? name : `x/${name}`, method: 'exact' as const }),
    };
    const r1 = extractEdges({ roots: [root], dbPath, resolver, wikiRoot: root });
    expect(r1.filesScanned).toBe(1);
    const r2 = extractEdges({ roots: [root], dbPath, resolver, wikiRoot: root });
    expect(r2.filesSkippedUnchanged).toBe(1);
    expect(r2.filesScanned).toBe(0);
    const r3 = extractEdges({ roots: [root], dbPath, resolver, wikiRoot: root, force: true });
    expect(r3.filesScanned).toBe(1);

    const db = openLinksDb(dbPath);
    expect(getWatermark(db, file)).toBeTruthy();
    setWatermark(db, file, 'abc');
    expect(getWatermark(db, file)).toBe('abc');
    db.close();
  });

  it('linksDbPath uses normalized org', () => {
    const p = linksDbPath('inst1', '/fw', 'MyOrg');
    expect(p).toContain('/orgs/NORM:MyOrg/knowledge-base/links.sqlite');
  });
});
