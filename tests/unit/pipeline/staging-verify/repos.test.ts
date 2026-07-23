import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parseMaxAttempts } from '../../../../src/pipeline/staging-verify/cli.js';
import {
  defaultRepoRegistry,
  loadRepoRegistry,
  resolveRepo,
} from '../../../../src/pipeline/staging-verify/repos.js';

describe('repo registry', () => {
  it('resolves repos by key and absolute path', () => {
    const registry = defaultRepoRegistry();
    const clearpath = resolveRepo(registry, 'clearpath');
    const clearpathByPath = resolveRepo(registry, resolve(clearpath.localPath));

    expect(clearpath.key).toBe('clearpath');
    expect(clearpathByPath.key).toBe('clearpath');
  });

  it('lists known keys on unknown repo errors', () => {
    expect(() => resolveRepo(defaultRepoRegistry(), 'unknown')).toThrow(
      /clearpath, cxportal, nonprofit-hub, auditos, gws-security/,
    );
  });

  it('merges override config by key', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-verify-repos-'));
    const overridePath = join(root, 'repos.json');
    writeFileSync(overridePath, JSON.stringify([
      {
        key: 'clearpath',
        stagingEnv: 'qa',
      },
    ]), 'utf-8');

    const registry = loadRepoRegistry(overridePath);
    expect(resolveRepo(registry, 'clearpath').stagingEnv).toBe('qa');

    rmSync(root, { recursive: true, force: true });
  });

  it('fails with described errors for missing or invalid override files', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-verify-repos-bad-'));
    const invalidPath = join(root, 'invalid.json');
    writeFileSync(invalidPath, '{not-json', 'utf-8');

    expect(() => loadRepoRegistry(join(root, 'missing.json'))).toThrow(/Unable to read repo config override/);
    expect(() => loadRepoRegistry(invalidPath)).toThrow(/is not valid JSON/);

    rmSync(root, { recursive: true, force: true });
  });

  it('clamps maxAttempts to the supported range', () => {
    expect(parseMaxAttempts(undefined)).toBe(3);
    expect(parseMaxAttempts('9')).toBe(5);
    expect(parseMaxAttempts('1')).toBe(1);
  });
});
