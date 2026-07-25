import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSlugIndex,
  createSlugResolver,
  slugify,
  trigramSimilarity,
} from '../../../../src/bus/kb-graph/resolve.js';

describe('kb-graph/resolve', () => {
  let wiki: string;

  beforeEach(() => {
    wiki = mkdtempSync(join(tmpdir(), 'wiki-'));
    mkdirSync(join(wiki, 'people'), { recursive: true });
    mkdirSync(join(wiki, 'projects'), { recursive: true });
    mkdirSync(join(wiki, 'tools'), { recursive: true });
    mkdirSync(join(wiki, 'companies'), { recursive: true });
    writeFileSync(join(wiki, 'people', 'josh-weiss.md'), '# Josh Weiss\n');
    writeFileSync(join(wiki, 'people', 'alice-chen.md'), '# Alice Chen\n');
    writeFileSync(join(wiki, 'people', 'alice-brown.md'), '# Alice Brown\n');
    writeFileSync(join(wiki, 'projects', 'gbrain-port.md'), '# gbrain-port\n');
    writeFileSync(join(wiki, 'tools', 'gws.md'), '# gws\n');
    writeFileSync(join(wiki, 'companies', 'acme.md'), '# Acme\n');
    writeFileSync(join(wiki, '_master-index.md'), '# index\n');
  });

  afterEach(() => {
    rmSync(wiki, { recursive: true, force: true });
  });

  it('buildSlugIndex discovers dirs from disk and skips root files', () => {
    const idx = buildSlugIndex(wiki);
    expect(idx.length).toBe(6);
    expect(idx.some((e) => e.slug === 'companies/acme')).toBe(true);
    expect(idx.some((e) => e.base === '_master-index')).toBe(false);
  });

  it('exact resolves', () => {
    const r = createSlugResolver(wiki);
    expect(r.resolve('people/josh-weiss')?.method).toBe('exact');
    expect(r.resolve('josh-weiss')?.slug).toBe('people/josh-weiss');
    expect(r.resolve('Josh Weiss')?.method).toBe('exact');
  });

  it('prefix unique expands; ambiguous does not', () => {
    const r = createSlugResolver(wiki);
    expect(r.resolve('gbrain')?.slug).toBe('projects/gbrain-port');
    expect(r.resolve('gbrain')?.method).toBe('prefix');
    const alice = r.resolve('alice');
    expect(alice?.method).not.toBe('prefix');
  });

  it('fuzzy typo and trigram math', () => {
    expect(trigramSimilarity('abc', 'abc')).toBe(1);
    expect(trigramSimilarity('abc', 'xyz')).toBe(0);
    const r = createSlugResolver(wiki);
    const hit = r.resolve('Josh Wiess');
    expect(hit?.slug).toBe('people/josh-weiss');
    expect(hit?.method).toBe('fuzzy');
    expect(hit?.score ?? 0).toBeGreaterThanOrEqual(0.3);
  });

  it('typeHint scopes then falls back', () => {
    const r = createSlugResolver(wiki);
    expect(r.resolve('acme', 'companies')?.slug).toBe('companies/acme');
    // fallback to global when nowhere in hint
    const noHit = r.resolve('josh-weiss', 'companies');
    expect(noHit?.slug).toBe('people/josh-weiss');
  });

  it('slugify fallback', () => {
    const r = createSlugResolver(wiki);
    expect(r.resolve('Totally New Person')).toEqual({
      slug: 'totally-new-person',
      method: 'slugify',
    });
    expect(r.resolve('Totally New Person', 'people')?.slug).toBe('people/totally-new-person');
  });

  it('cache returns same object identity', () => {
    const r = createSlugResolver(wiki);
    const a = r.resolve('josh-weiss');
    const b = r.resolve('josh-weiss');
    expect(a).toBe(b);
  });

  it('slugify transforms', () => {
    expect(slugify('Co-Founded, LLC!')).toBe('co-founded-llc');
  });
});
