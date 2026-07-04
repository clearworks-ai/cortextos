import { describe, it, expect } from 'vitest';
import { checkScope } from '../../../src/utils/scope-guard';
import { parseScopeFile, resolveDeclaredGlobs } from '../../../src/bus/scope-guard';

/**
 * SCOPE_GUARD tests — the pure checker is the gate that catches a coding run
 * drifting outside its declared "Files-Touched" scope before the drift becomes
 * an 80-file conflict bomb (the WS4/WS6 failure mode WS12 exists to prevent).
 */
describe('checkScope (pure core)', () => {
  it('flags a touched file outside the declared globs as stray', () => {
    const result = checkScope({
      declaredGlobs: ['src/bus/**', 'tests/**'],
      touchedFiles: ['src/bus/scope-guard.ts', 'src/daemon/rogue.ts'],
    });
    expect(result.ok).toBe(false);
    expect(result.strayFiles).toEqual(['src/daemon/rogue.ts']);
  });

  it('returns ok with no stray files when everything is in scope', () => {
    const result = checkScope({
      declaredGlobs: ['src/bus/**', 'tests/unit/bus/**'],
      touchedFiles: [
        'src/bus/scope-guard.ts',
        'tests/unit/bus/scope-guard.test.ts',
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.strayFiles).toEqual([]);
  });

  it('matches an exact file-path declaration', () => {
    const result = checkScope({
      declaredGlobs: ['src/daemon/fast-checker.ts', 'src/types/index.ts'],
      touchedFiles: ['src/daemon/fast-checker.ts', 'src/types/index.ts'],
    });
    expect(result.ok).toBe(true);
  });

  it('an exact file declaration does NOT cover a sibling file', () => {
    const result = checkScope({
      declaredGlobs: ['src/daemon/fast-checker.ts'],
      touchedFiles: ['src/daemon/fast-checker.ts', 'src/daemon/slow-checker.ts'],
    });
    expect(result.ok).toBe(false);
    expect(result.strayFiles).toEqual(['src/daemon/slow-checker.ts']);
  });

  it('supports a trailing-slash prefix declaration', () => {
    const result = checkScope({
      declaredGlobs: ['src/bus/'],
      touchedFiles: ['src/bus/deep/nested/file.ts'],
    });
    expect(result.ok).toBe(true);
  });

  it('treats a bare directory literal as a prefix but not a partial-name match', () => {
    const result = checkScope({
      declaredGlobs: ['src/bus'],
      touchedFiles: ['src/bus/message.ts', 'src/business.ts'],
    });
    // src/bus/message.ts is covered; src/business.ts must NOT be (prefix guarded by "/")
    expect(result.ok).toBe(false);
    expect(result.strayFiles).toEqual(['src/business.ts']);
  });

  it('single * matches within a segment only, not across path separators', () => {
    const result = checkScope({
      declaredGlobs: ['src/bus/*.ts'],
      touchedFiles: ['src/bus/scope-guard.ts', 'src/bus/nested/deep.ts'],
    });
    expect(result.ok).toBe(false);
    expect(result.strayFiles).toEqual(['src/bus/nested/deep.ts']);
  });

  it('** matches across path separators at any depth', () => {
    const result = checkScope({
      declaredGlobs: ['src/**/*.ts'],
      touchedFiles: ['src/a.ts', 'src/bus/deep/x.ts'],
    });
    expect(result.ok).toBe(true);
  });

  it('fail-safe: empty declared scope with any touched file marks all stray', () => {
    const result = checkScope({
      declaredGlobs: [],
      touchedFiles: ['src/a.ts', 'README.md'],
    });
    expect(result.ok).toBe(false);
    expect(result.strayFiles).toEqual(['src/a.ts', 'README.md']);
  });

  it('empty scope with no touched files is trivially ok', () => {
    const result = checkScope({ declaredGlobs: [], touchedFiles: [] });
    expect(result.ok).toBe(true);
    expect(result.strayFiles).toEqual([]);
  });

  it('normalizes leading ./ and backslash paths before matching', () => {
    const result = checkScope({
      declaredGlobs: ['src/bus/**'],
      touchedFiles: ['./src/bus/scope-guard.ts', 'src\\bus\\other.ts'],
    });
    expect(result.ok).toBe(true);
  });

  it('ignores blank/whitespace declared patterns (does not match everything)', () => {
    const result = checkScope({
      declaredGlobs: ['', '   ', 'src/bus/**'],
      touchedFiles: ['src/daemon/rogue.ts'],
    });
    expect(result.ok).toBe(false);
    expect(result.strayFiles).toEqual(['src/daemon/rogue.ts']);
  });
});

describe('parseScopeFile (CLI scope-file parsing)', () => {
  it('parses a plain newline glob list, ignoring blanks and # comments', () => {
    const content = ['# scope for spec 09', 'src/bus/**', '', 'tests/**', '  '].join('\n');
    expect(parseScopeFile(content)).toEqual(['src/bus/**', 'tests/**']);
  });

  it('extracts backtick-wrapped paths from a spec Targets: field', () => {
    const content = '**Targets:** `src/daemon/fast-checker.ts`, `src/types/index.ts` (small)\n\nmore body';
    expect(parseScopeFile(content)).toEqual([
      'src/daemon/fast-checker.ts',
      'src/types/index.ts',
    ]);
  });

  it('extracts from a Files-Touched: field via comma split when no backticks', () => {
    const content = 'Files-Touched: src/bus/scope-guard.ts, src/utils/scope-guard.ts';
    expect(parseScopeFile(content)).toEqual([
      'src/bus/scope-guard.ts',
      'src/utils/scope-guard.ts',
    ]);
  });
});

describe('resolveDeclaredGlobs (inline + file merge)', () => {
  it('parses an inline --allow list on commas and newlines', () => {
    expect(resolveDeclaredGlobs({ allow: 'src/bus/**, tests/**' })).toEqual([
      'src/bus/**',
      'tests/**',
    ]);
  });

  it('returns [] when neither allow nor scopeFile is provided', () => {
    expect(resolveDeclaredGlobs({})).toEqual([]);
  });
});
