import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// homedir() is the only thing the resolver reads for path construction; point
// it at a throwaway temp dir per-test so the marker file is fully isolated.
let fakeHome: string;
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

import {
  resolveActiveInstance,
  activeInstanceMarkerPath,
} from '../../../src/utils/resolve-active-instance';

function writeMarker(contents: string): void {
  const p = activeInstanceMarkerPath();
  mkdirSync(join(fakeHome, '.cortextos', 'state'), { recursive: true });
  writeFileSync(p, contents, 'utf-8');
}

describe('resolveActiveInstance', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ctx-active-instance-'));
  });

  afterEach(() => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('places the marker at the top level of ~/.cortextos (not under an instance)', () => {
    expect(activeInstanceMarkerPath()).toBe(
      join(fakeHome, '.cortextos', 'state', 'ACTIVE_INSTANCE'),
    );
  });

  it('returns the marker value when present and valid', () => {
    writeMarker('cortextos1\n');
    expect(resolveActiveInstance('default')).toBe('cortextos1');
  });

  it('trims surrounding whitespace from the marker value', () => {
    writeMarker('  cortextos1  \n');
    expect(resolveActiveInstance('default')).toBe('cortextos1');
  });

  it('falls back when the marker is absent', () => {
    expect(resolveActiveInstance('default')).toBe('default');
  });

  it('falls back when the marker is empty', () => {
    writeMarker('');
    expect(resolveActiveInstance('default')).toBe('default');
  });

  it('falls back when the marker is whitespace-only', () => {
    writeMarker('   \n  ');
    expect(resolveActiveInstance('default')).toBe('default');
  });

  it('falls back when the marker holds an invalid instance id', () => {
    writeMarker('Not/A Valid Id!');
    expect(resolveActiveInstance('default')).toBe('default');
  });

  it('honors a custom fallback', () => {
    expect(resolveActiveInstance('cortextos2')).toBe('cortextos2');
  });

  it('never throws — returns the fallback on any read error', () => {
    expect(() => resolveActiveInstance('default')).not.toThrow();
    expect(resolveActiveInstance('default')).toBe('default');
  });
});
