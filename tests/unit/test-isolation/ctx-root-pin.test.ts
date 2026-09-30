import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { readFileSync } from 'fs';

describe('vitest CTX_ROOT pin', () => {
  it('setup pins CTX_ROOT under os.tmpdir, not the repo cwd', () => {
    const root = process.env.CTX_ROOT;
    expect(root).toBeTruthy();
    expect(resolve(root!)).toContain(resolve(tmpdir()));
    expect(resolve(root!)).not.toBe(resolve(process.cwd()));
  });

  it('setup source assigns mkdtemp CTX_ROOT (no cwd fallback)', () => {
    const src = readFileSync(join(process.cwd(), 'tests/setup/clear-ctx-env.ts'), 'utf-8');
    expect(src).toContain('mkdtempSync');
    expect(src).toContain('process.env.CTX_ROOT = mkdtempSync');
    expect(src).toContain("process.env.CTX_INSTANCE_ID = 'vitest'");
  });

  it('worktree fingerprint uses mkdtemp, not a fixed /tmp path, and never git-restores', () => {
    const src = readFileSync(join(process.cwd(), 'tests/setup/worktree-guard-setup.ts'), 'utf-8');
    expect(src).toContain('mkdtempSync');
    expect(src).not.toContain('cortextos-vitest-worktree-fingerprint.txt');
    expect(src).not.toMatch(/execSync\([^)]*git restore/);
    expect(src).not.toMatch(/execSync\([^)]*git checkout/);
    expect(src).toContain('rmSync(runTmp');
  });
});
