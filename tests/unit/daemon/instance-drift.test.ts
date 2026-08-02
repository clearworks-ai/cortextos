import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Isolate the ACTIVE_INSTANCE marker per-test by pointing homedir() at a
// throwaway temp dir (same pattern as resolve-active-instance.test.ts).
let fakeHome: string;
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

import {
  detectInstanceMarkerDrift,
  INSTANCE_MARKER_DRIFT_CHECK_MS,
} from '../../../src/daemon/instance-drift';

function writeMarker(contents: string): void {
  mkdirSync(join(fakeHome, '.cortextos', 'state'), { recursive: true });
  writeFileSync(join(fakeHome, '.cortextos', 'state', 'ACTIVE_INSTANCE'), contents, 'utf-8');
}

describe('detectInstanceMarkerDrift (M7 boot-pin, RW-2)', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ctx-instance-drift-'));
  });

  afterEach(() => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('returns null when no marker exists (nothing to drift from)', () => {
    expect(detectInstanceMarkerDrift('default')).toBeNull();
  });

  it('returns null when the marker matches the boot-pinned instance', () => {
    writeMarker('cortextos1\n');
    expect(detectInstanceMarkerDrift('cortextos1')).toBeNull();
  });

  it('returns a loud warning when the marker drifts from the boot value', () => {
    writeMarker('cortextos2\n');
    const msg = detectInstanceMarkerDrift('cortextos1');
    expect(msg).toBeTruthy();
    expect(msg).toContain('INSTANCE MARKER DRIFT');
    expect(msg).toContain("booted pinned to instance 'cortextos1'");
    expect(msg).toContain("now reads 'cortextos2'");
    // Actionable remediation for the operator.
    expect(msg).toContain('cortextos instance --set cortextos1');
  });

  it('returns null on an invalid marker (resolver degrades to fallback)', () => {
    writeMarker('Not/A Valid Id!');
    expect(detectInstanceMarkerDrift('cortextos1')).toBeNull();
  });

  it('never throws — pure check even on unreadable marker state', () => {
    expect(() => detectInstanceMarkerDrift('cortextos1')).not.toThrow();
  });

  it('re-warn cadence is a sane fixed interval', () => {
    expect(INSTANCE_MARKER_DRIFT_CHECK_MS).toBe(60_000);
  });
});
