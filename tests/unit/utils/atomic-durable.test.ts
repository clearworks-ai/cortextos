import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ESM named exports from 'fs' can't be spied on directly (module namespace is
// not configurable). To simulate parent-directory fsync failure (EINVAL) we
// mock the module and toggle behavior via a hoisted flag; every other export
// passes straight through to the real implementation.
const mockState = vi.hoisted(() => ({ failDirFsync: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    openSync: (path: unknown, flags?: unknown, mode?: unknown) => {
      if (mockState.failDirFsync && flags === 'r') {
        const err = Object.assign(new Error('EINVAL: directory fsync not supported'), {
          code: 'EINVAL',
        });
        throw err;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.openSync as any)(path, flags, mode);
    },
  };
});

import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteDurableSync } from '../../../src/utils/atomic';

describe('atomicWriteDurableSync', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'cortextos-atomic-durable-test-'));
    mockState.failDirFsync = false;
  });

  afterEach(() => {
    mockState.failDirFsync = false;
    vi.restoreAllMocks();
    // Restore write perms in case a test left a read-only dir behind, so cleanup can proceed.
    try {
      chmodSync(fixtureRoot, 0o755);
    } catch {
      // ignore
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('round-trips content, including the trailing-newline convention (matches atomicWriteSync)', () => {
    const filePath = join(fixtureRoot, 'record.json');
    atomicWriteDurableSync(filePath, '{"a":1}');

    const written = readFileSync(filePath, 'utf-8');
    expect(written).toBe('{"a":1}\n');
  });

  it('leaves no .tmp.* file behind after a successful write', () => {
    const filePath = join(fixtureRoot, 'record.json');
    atomicWriteDurableSync(filePath, '{"a":1}');

    const leftovers = readdirSync(fixtureRoot).filter((f) => f.startsWith('.tmp.'));
    expect(leftovers).toEqual([]);
    expect(existsSync(filePath)).toBe(true);
  });

  it('cleans up the temp file and rethrows on write failure', () => {
    // Make the target directory read-only so opening the temp file for write fails (EACCES).
    const roDir = join(fixtureRoot, 'readonly-dir');
    mkdirSync(roDir, { recursive: true });
    chmodSync(roDir, 0o555);

    const filePath = join(roDir, 'record.json');

    expect(() => atomicWriteDurableSync(filePath, '{"a":1}')).toThrow();

    chmodSync(roDir, 0o755); // restore so we can inspect/clean up
    const leftovers = readdirSync(roDir).filter((f) => f.startsWith('.tmp.'));
    expect(leftovers).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });

  it('tolerates parent-directory fsync failure: write still succeeds, failure is logged not thrown', () => {
    const filePath = join(fixtureRoot, 'record.json');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockState.failDirFsync = true;

    expect(() => atomicWriteDurableSync(filePath, '{"a":1}')).not.toThrow();

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('{"a":1}\n');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('returns void (single signature, no throwing/verbose variant)', () => {
    const filePath = join(fixtureRoot, 'contract-check.json');
    const result = atomicWriteDurableSync(filePath, 'x');
    expect(result).toBeUndefined();
  });
});
