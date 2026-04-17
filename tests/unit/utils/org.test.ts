import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { normalizeOrgName } from '../../../src/utils/org';

// macOS APFS/HFS+ is case-insensitive by default. Tests that depend on two
// directories differing only in case (AcmeCorp vs acmecorp) cannot run there
// — the second mkdir either errors with EEXIST or collapses into the first.
// Probe once at module load by creating a temp dir, then checking whether
// the uppercased path resolves to the same entry.
function isCaseSensitiveFs(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'cortextos-case-probe-'));
  try {
    mkdirSync(join(probe, 'a'));
    return !existsSync(join(probe, 'A'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const CASE_SENSITIVE = isCaseSensitiveFs();

let fwRoot: string;

beforeEach(() => {
  fwRoot = mkdtempSync(join(tmpdir(), 'cortextos-org-test-'));
  mkdirSync(join(fwRoot, 'orgs'), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(fwRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('normalizeOrgName', () => {
  it('exact match: returns input unchanged', () => {
    mkdirSync(join(fwRoot, 'orgs', 'AcmeCorp'));
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
  });

  it.skipIf(!CASE_SENSITIVE)('case drift: lowercase input resolves to CamelCase canonical on disk', () => {
    mkdirSync(join(fwRoot, 'orgs', 'AcmeCorp'));
    expect(normalizeOrgName(fwRoot, 'acmecorp')).toBe('AcmeCorp');
    expect(normalizeOrgName(fwRoot, 'ACMECORP')).toBe('AcmeCorp');
    expect(normalizeOrgName(fwRoot, 'AcmeCORP')).toBe('AcmeCorp');
  });

  it('no match: returns input unchanged (callers get a clearer error at file op time)', () => {
    mkdirSync(join(fwRoot, 'orgs', 'AcmeCorp'));
    expect(normalizeOrgName(fwRoot, 'ghostcompany')).toBe('ghostcompany');
  });

  it('empty framework orgs dir: returns input unchanged', () => {
    // orgs/ exists but is empty
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
  });

  it('missing framework orgs dir: returns input unchanged', () => {
    rmSync(join(fwRoot, 'orgs'), { recursive: true });
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
  });

  it('empty org input: returns empty string (no normalization attempted)', () => {
    expect(normalizeOrgName(fwRoot, '')).toBe('');
  });

  it.skipIf(!CASE_SENSITIVE)('exact case match wins over case-insensitive match on case-sensitive filesystems', () => {
    mkdirSync(join(fwRoot, 'orgs', 'AcmeCorp'));
    mkdirSync(join(fwRoot, 'orgs', 'acmecorp'));
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
    expect(normalizeOrgName(fwRoot, 'acmecorp')).toBe('acmecorp');
  });

  it('ignores non-directory entries with matching name', () => {
    // A stray file named like an org must not be returned as a directory match.
    writeFileSync(join(fwRoot, 'orgs', 'AcmeCorp.txt'), 'not a dir');
    expect(normalizeOrgName(fwRoot, 'AcmeCorp')).toBe('AcmeCorp');
  });
});
