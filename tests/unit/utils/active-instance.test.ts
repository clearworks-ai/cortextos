/**
 * WS7 — ACTIVE_INSTANCE marker resolution.
 *
 * The literal instance id 'default' points at a DEAD instance (frozen
 * 2026-06-25); the LIVE canonical instance is cortextos1. These tests prove
 * that with no explicit instance id, path resolution follows the
 * ~/.cortextos/ACTIVE_INSTANCE marker and falls back to 'cortextos1' —
 * never to 'default'.
 *
 * HOME-override pattern follows tests/unit/cli/lifecycle-markers.test.ts so
 * the user's real ~/.cortextos marker can never leak into the assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  resolveActiveInstance,
  getActiveInstanceMarkerPath,
  ACTIVE_INSTANCE_FALLBACK,
} from '../../../src/utils/active-instance';
import { resolvePaths, getIpcPath } from '../../../src/utils/paths';

describe('WS7: resolveActiveInstance', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-ws7-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeMarker(content: string): void {
    mkdirSync(join(tmpHome, '.cortextos'), { recursive: true });
    writeFileSync(join(tmpHome, '.cortextos', 'ACTIVE_INSTANCE'), content, 'utf-8');
  }

  it('exports cortextos1 as the fallback constant', () => {
    expect(ACTIVE_INSTANCE_FALLBACK).toBe('cortextos1');
  });

  it('returns cortextos1 when no marker file exists (never "default")', () => {
    expect(resolveActiveInstance()).toBe('cortextos1');
  });

  it('returns cortextos1 when even ~/.cortextos does not exist', () => {
    // Fresh HOME with nothing in it — the readFileSync throws, we fall back.
    expect(resolveActiveInstance()).toBe('cortextos1');
  });

  it('returns cortextos1 for a marker containing "cortextos1\\n"', () => {
    writeMarker('cortextos1\n');
    expect(resolveActiveInstance()).toBe('cortextos1');
  });

  it('returns a custom valid instance id from the marker', () => {
    writeMarker('staging_2\n');
    expect(resolveActiveInstance()).toBe('staging_2');
  });

  it('reads only the first line and trims it', () => {
    writeMarker('  my-instance  \nsecond line ignored\n');
    expect(resolveActiveInstance()).toBe('my-instance');
  });

  it('falls back to cortextos1 for invalid marker content ("Bad Id!")', () => {
    writeMarker('Bad Id!\n');
    expect(resolveActiveInstance()).toBe('cortextos1');
  });

  it('falls back to cortextos1 for an empty marker', () => {
    writeMarker('');
    expect(resolveActiveInstance()).toBe('cortextos1');
  });

  it('never throws, even when the marker path is a directory', () => {
    mkdirSync(join(tmpHome, '.cortextos', 'ACTIVE_INSTANCE'), { recursive: true });
    expect(() => resolveActiveInstance()).not.toThrow();
    expect(resolveActiveInstance()).toBe('cortextos1');
  });

  it('getActiveInstanceMarkerPath points at ~/.cortextos/ACTIVE_INSTANCE', () => {
    expect(getActiveInstanceMarkerPath()).toBe(
      join(homedir(), '.cortextos', 'ACTIVE_INSTANCE'),
    );
  });

  describe('resolvePaths / getIpcPath lazy default', () => {
    it('resolvePaths with no instanceId resolves under cortextos1 when no marker exists', () => {
      const paths = resolvePaths('commander');
      expect(paths.ctxRoot).toBe(join(homedir(), '.cortextos', 'cortextos1'));
      expect(paths.inbox).toBe(join(homedir(), '.cortextos', 'cortextos1', 'inbox', 'commander'));
    });

    it('resolvePaths with no instanceId resolves under the marker value', () => {
      writeMarker('staging_2\n');
      const paths = resolvePaths('commander');
      expect(paths.ctxRoot).toBe(join(homedir(), '.cortextos', 'staging_2'));
    });

    it('explicit instanceId argument still wins over the marker', () => {
      writeMarker('staging_2\n');
      const paths = resolvePaths('commander', 'default');
      expect(paths.ctxRoot).toBe(join(homedir(), '.cortextos', 'default'));
    });

    it('getIpcPath with no instanceId resolves under the marker value', () => {
      writeMarker('staging_2\n');
      if (process.platform === 'win32') {
        expect(getIpcPath()).toBe('\\\\.\\pipe\\cortextos-staging_2');
      } else {
        expect(getIpcPath()).toBe(join(homedir(), '.cortextos', 'staging_2', 'daemon.sock'));
      }
    });

    it('getIpcPath with no instanceId and no marker resolves under cortextos1', () => {
      if (process.platform === 'win32') {
        expect(getIpcPath()).toBe('\\\\.\\pipe\\cortextos-cortextos1');
      } else {
        expect(getIpcPath()).toBe(join(homedir(), '.cortextos', 'cortextos1', 'daemon.sock'));
      }
    });

    it('getIpcPath explicit instanceId still wins over the marker', () => {
      writeMarker('staging_2\n');
      if (process.platform === 'win32') {
        expect(getIpcPath('default')).toBe('\\\\.\\pipe\\cortextos-default');
      } else {
        expect(getIpcPath('default')).toBe(join(homedir(), '.cortextos', 'default', 'daemon.sock'));
      }
    });
  });
});
