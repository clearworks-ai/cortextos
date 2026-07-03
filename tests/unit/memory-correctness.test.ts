/**
 * tests/unit/memory-correctness.test.ts — WS10/R8 memory-correctness harness.
 *
 * Fixture: tests/fixtures/memory-correctness/MEMORY.md contains
 *   - 2 valid entries (topic_a.md, topic_b.md exist)
 *   - 1 overlong entry (> 200 chars, trips max-entry-chars)
 *   - 1 entry pointing at a missing topic file (topic_missing.md)
 *
 * The KB query fn is INJECTED — these tests never touch a real knowledge base.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const FIXTURE_DIR = join(__dirname, '../fixtures/memory-correctness');
const FIXTURE_MD = readFileSync(join(FIXTURE_DIR, 'MEMORY.md'), 'utf-8');

const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
});

async function importHarness() {
  return import('../../src/utils/memory-index.js');
}

// ---------------------------------------------------------------------------
// parseMemoryIndex
// ---------------------------------------------------------------------------

describe('parseMemoryIndex', () => {
  it('extracts all 4 index entries from the fixture with line/title/topicFile/summary', async () => {
    const { parseMemoryIndex } = await importHarness();

    const entries = parseMemoryIndex(FIXTURE_MD);
    expect(entries).toHaveLength(4);

    const first = entries[0];
    expect(first.title).toBe('Railway alerts route to larry');
    expect(first.topicFile).toBe('topic_a.md');
    expect(first.summary).toContain('route all Railway/deploy/CI failures to larry');
    expect(first.line).toBeGreaterThan(0);
    expect(FIXTURE_MD.split('\n')[first.line - 1]).toContain('[Railway alerts route to larry]');

    expect(entries.map(e => e.topicFile)).toEqual([
      'topic_a.md',
      'topic_b.md',
      'topic_a.md',
      'topic_missing.md',
    ]);
  });

  it('ignores headings, prose, and non-entry lines', async () => {
    const { parseMemoryIndex } = await importHarness();

    const entries = parseMemoryIndex(FIXTURE_MD);
    for (const e of entries) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.topicFile.endsWith('.md')).toBe(true);
    }
    // The "Non-entry lines like this one" prose line is not an entry.
    expect(entries.some(e => e.title.includes('Non-entry'))).toBe(false);
  });

  it('returns [] for markdown with no entries', async () => {
    const { parseMemoryIndex } = await importHarness();
    expect(parseMemoryIndex('# Just a heading\n\nSome prose.\n')).toEqual([]);
  });

  it('fixture topic files exist for the valid entries and are missing for the phantom one', () => {
    expect(existsSync(join(FIXTURE_DIR, 'topic_a.md'))).toBe(true);
    expect(existsSync(join(FIXTURE_DIR, 'topic_b.md'))).toBe(true);
    expect(existsSync(join(FIXTURE_DIR, 'topic_missing.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lintMemoryIndex
// ---------------------------------------------------------------------------

describe('lintMemoryIndex', () => {
  it('flags the overlong fixture entry with max-entry-chars and its line number', async () => {
    const { lintMemoryIndex, parseMemoryIndex } = await importHarness();

    const violations = lintMemoryIndex(FIXTURE_MD, {
      maxBytes: 10240,
      maxLines: 200,
      maxEntryChars: 200,
    });

    const entryViolations = violations.filter(v => v.rule === 'max-entry-chars');
    expect(entryViolations).toHaveLength(1);

    const overlong = parseMemoryIndex(FIXTURE_MD).find(e =>
      e.title.startsWith('This entry is far too long')
    );
    expect(overlong).toBeDefined();
    expect(entryViolations[0].line).toBe(overlong!.line);
  });

  it('does not flag the fixture for max-bytes or max-lines (it is small)', async () => {
    const { lintMemoryIndex } = await importHarness();

    const violations = lintMemoryIndex(FIXTURE_MD, {
      maxBytes: 10240,
      maxLines: 200,
      maxEntryChars: 200,
    });

    expect(violations.some(v => v.rule === 'max-bytes')).toBe(false);
    expect(violations.some(v => v.rule === 'max-lines')).toBe(false);
  });

  it('flags a >10KB index with max-bytes', async () => {
    const { lintMemoryIndex } = await importHarness();

    // Build a synthetic index bigger than 10KB.
    const line = '- [entry](topic_a.md) — a compact one-line summary of a memory claim\n';
    const big = line.repeat(Math.ceil(11000 / line.length));
    expect(Buffer.byteLength(big, 'utf-8')).toBeGreaterThan(10240);

    const violations = lintMemoryIndex(big, {
      maxBytes: 10240,
      maxLines: 100000,
      maxEntryChars: 200,
    });

    expect(violations.some(v => v.rule === 'max-bytes')).toBe(true);
  });

  it('flags a >200-line index with max-lines', async () => {
    const { lintMemoryIndex } = await importHarness();

    const big = Array.from({ length: 250 }, (_, i) => `- [e${i}](topic_a.md) — s${i}`).join('\n');
    const violations = lintMemoryIndex(big, {
      maxBytes: 10 * 1024 * 1024,
      maxLines: 200,
      maxEntryChars: 200,
    });

    expect(violations.some(v => v.rule === 'max-lines')).toBe(true);
  });

  it('returns [] for a clean, small index', async () => {
    const { lintMemoryIndex } = await importHarness();

    const clean = '# Index\n- [ok](topic_a.md) — short summary\n';
    expect(lintMemoryIndex(clean, { maxBytes: 10240, maxLines: 200, maxEntryChars: 200 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkMemoryAgainstKB — injected query fn, no real KB
// ---------------------------------------------------------------------------

describe('checkMemoryAgainstKB', () => {
  it('flags the unbacked entry and passes the backed ones via a fake kbQueryFn', async () => {
    const { parseMemoryIndex, checkMemoryAgainstKB } = await importHarness();

    const entries = parseMemoryIndex(FIXTURE_MD);

    // Fake KB: backs everything except the phantom claim.
    const queries: string[] = [];
    const fakeKb = (q: string) => {
      queries.push(q);
      if (q === 'Phantom claim with no topic file') {
        return { results: [] };
      }
      return { results: [{ source_file: 'kb/some-doc.md' }] };
    };

    const report = checkMemoryAgainstKB(entries, fakeKb);

    expect(report.unbacked).toHaveLength(1);
    expect(report.unbacked[0].title).toBe('Phantom claim with no topic file');
    expect(report.unbacked[0].topicFile).toBe('topic_missing.md');

    expect(report.backed).toHaveLength(3);
    expect(report.backed.map(e => e.title)).toContain('Railway alerts route to larry');
    expect(report.backed.map(e => e.title)).toContain('Briefs go to the website');

    // The injected fn was queried once per entry, by title.
    expect(queries).toHaveLength(entries.length);
    expect(queries).toContain('Railway alerts route to larry');
  });

  it('reports everything unbacked when the KB returns nothing', async () => {
    const { parseMemoryIndex, checkMemoryAgainstKB } = await importHarness();

    const entries = parseMemoryIndex(FIXTURE_MD);
    const report = checkMemoryAgainstKB(entries, () => ({ results: [] }));

    expect(report.backed).toEqual([]);
    expect(report.unbacked).toHaveLength(entries.length);
  });

  it('handles an empty entry list without querying', async () => {
    const { checkMemoryAgainstKB } = await importHarness();

    const fake = vi.fn(() => ({ results: [] }));
    const report = checkMemoryAgainstKB([], fake);

    expect(report).toEqual({ unbacked: [], backed: [] });
    expect(fake).not.toHaveBeenCalled();
  });
});
