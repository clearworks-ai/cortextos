import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseFrontmatterBlock,
  extractFrontmatterEdges,
} from '../../../../src/bus/kb-graph/frontmatter.js';
import { hasNodeSqlite, openLinksDb, edgeStats } from '../../../../src/bus/kb-graph/db.js';
import { extractEdges } from '../../../../src/bus/kb-graph/extract.js';
import { createSlugResolver } from '../../../../src/bus/kb-graph/resolve.js';

describe('frontmatter', () => {
  it('worked example yields 6 edges', () => {
    const content = `---
companies: [Clearworks, prior-startup]
investments: [PortCo-1, PortCo-2]
advises: [founder-alice, founder-bob]
---
Body here.
`;
    const resolver = {
      resolve(name: string, typeHint?: string) {
        const s = name.toLowerCase().replace(/\s+/g, '-');
        if (typeHint) return { slug: `${typeHint}/${s}`, method: 'slugify' as const };
        return { slug: s, method: 'slugify' as const };
      },
    };
    const edges = extractFrontmatterEdges(
      content,
      { pageSlug: 'people/josh-weiss', sourcePath: 'people/josh-weiss.md' },
      resolver,
    );
    expect(edges).toHaveLength(6);
    expect(edges.every((e) => e.link_source === 'frontmatter' && e.confidence === 0.9)).toBe(true);
    expect(edges.filter((e) => e.type === 'works_at')).toHaveLength(2);
    expect(edges.filter((e) => e.type === 'invested_in')).toHaveLength(2);
    expect(edges.filter((e) => e.type === 'advises')).toHaveLength(2);
  });

  it('key_people produces incoming works_at', () => {
    const wiki = mkdtempSync(join(tmpdir(), 'fm-wiki-'));
    mkdirSync(join(wiki, 'people'), { recursive: true });
    writeFileSync(join(wiki, 'people', 'alice-chen.md'), '# Alice\n');
    const resolver = createSlugResolver(wiki);
    const content = `---
key_people: [alice-chen]
---
`;
    const edges = extractFrontmatterEdges(
      content,
      { pageSlug: 'companies/acme', sourcePath: 'companies/acme.md' },
      resolver,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].from_slug).toBe('people/alice-chen');
    expect(edges[0].to_slug).toBe('companies/acme');
    expect(edges[0].type).toBe('works_at');
    rmSync(wiki, { recursive: true, force: true });
  });

  it('value shapes + unknown + nested ignored', () => {
    const content = `---
title: Page
companies: ["Acme Corp", Foo]
relates_to:
  - bar
  - baz
works_at: SoloCo
mystery: nope
nested: { a: 1 }
---
hi [[people/x]]
`;
    const block = parseFrontmatterBlock(content)!;
    expect(block.fields.get('companies')).toEqual(['Acme Corp', 'Foo']);
    expect(block.fields.get('relates_to')).toEqual(['bar', 'baz']);
    expect(block.fields.get('works_at')).toEqual(['SoloCo']);
    expect(block.fields.has('mystery')).toBe(true);
    // mystery not in LINK_MAP — ignored by extract
    const edges = extractFrontmatterEdges(
      content,
      { pageSlug: 'p/x', sourcePath: 'p' },
      {
        resolve: (n: string) => ({ slug: n.toLowerCase(), method: 'slugify' as const }),
      },
    );
    expect(edges.some((e) => e.type === 'relates_to')).toBe(true);
    expect(edges.every((e) => e.type !== 'mystery')).toBe(true);

    // body mention offset: endOffset past closing --- so body starts with hi
    const body = content.slice(block.endOffset);
    expect(body.trimStart().startsWith('hi')).toBe(true);
    expect(parseFrontmatterBlock('no fm')).toBeNull();
  });
});

describe.skipIf(!hasNodeSqlite())('frontmatter extract integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-ext-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('frontmatter + body commit together; different link_source both present; watermark', () => {
    const wiki = join(dir, 'wiki');
    mkdirSync(join(wiki, 'people'), { recursive: true });
    const file = join(wiki, 'people', 'josh.md');
    writeFileSync(
      file,
      `---
companies: [Clearworks]
---
Josh is CEO of Clearworks and mentions [[companies/clearworks]].
`,
    );
    const dbPath = join(dir, 'links.sqlite');
    const resolver = {
      resolve(name: string) {
        const n = name.toLowerCase().replace(/\s+/g, '-');
        if (n.includes('clearworks') || n === 'companies/clearworks') {
          return { slug: 'companies/clearworks', method: 'exact' as const };
        }
        return { slug: n.includes('/') ? n : `people/${n}`, method: 'slugify' as const };
      },
    };
    const r1 = extractEdges({ roots: [wiki], dbPath, resolver, wikiRoot: wiki });
    expect(r1.errors).toEqual([]);
    const db = openLinksDb(dbPath);
    const rows = db
      .prepare(`SELECT link_source, type, link_kind FROM edges WHERE to_slug='companies/clearworks'`)
      .all() as Array<{ link_source: string; type: string; link_kind: string }>;
    expect(rows.some((r) => r.link_source === 'frontmatter')).toBe(true);
    expect(rows.some((r) => r.link_source === 'wikilink-resolved' || r.link_source === 'mentions')).toBe(
      true,
    );
    const n1 = edgeStats(db).edges;
    db.close();

    const r2 = extractEdges({ roots: [wiki], dbPath, resolver, wikiRoot: wiki });
    expect(r2.filesSkippedUnchanged).toBe(1);
    const db2 = openLinksDb(dbPath);
    expect(edgeStats(db2).edges).toBe(n1);
    db2.close();
  });
});
