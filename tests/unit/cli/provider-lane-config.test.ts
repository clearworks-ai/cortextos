import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_LANE_MODE,
  PROVIDER_CONFIG_FILENAME,
  resolveLaneMode,
  resolveLaneModeFrom,
} from '../../../src/cli/provider-lane-config';

describe('resolveLaneModeFrom (FR-E2 pure resolution)', () => {
  it('defaults every lane to shadow', () => {
    expect(DEFAULT_LANE_MODE).toBe('shadow');
    expect(resolveLaneModeFrom(undefined, 'gmail')).toBe('shadow');
    expect(resolveLaneModeFrom({}, 'gmail')).toBe('shadow');
    expect(resolveLaneModeFrom({ lanes: {} }, 'calendar')).toBe('shadow');
  });

  it('defaults a lane absent from an otherwise-populated config to shadow', () => {
    expect(resolveLaneModeFrom({ lanes: { gmail: 'active' } }, 'calendar')).toBe('shadow');
  });

  it('reads an explicitly configured mode (case/whitespace tolerant)', () => {
    expect(resolveLaneModeFrom({ lanes: { gmail: 'active' } }, 'gmail')).toBe('active');
    expect(resolveLaneModeFrom({ lanes: { gmail: '  ACTIVE  ' } }, 'gmail')).toBe('active');
    expect(resolveLaneModeFrom({ lanes: { calendar: 'off' } }, 'calendar')).toBe('off');
    expect(resolveLaneModeFrom({ lanes: { gmail: 'shadow' } }, 'gmail')).toBe('shadow');
  });

  it('collapses any malformed/unknown value to the safe shadow default', () => {
    expect(resolveLaneModeFrom({ lanes: { gmail: 'ACTIVEX' } }, 'gmail')).toBe('shadow');
    expect(resolveLaneModeFrom({ lanes: { gmail: 42 } } as never, 'gmail')).toBe('shadow');
    expect(resolveLaneModeFrom({ lanes: null } as never, 'gmail')).toBe('shadow');
    expect(resolveLaneModeFrom({ lanes: [] } as never, 'gmail')).toBe('shadow');
  });
});

describe('resolveLaneMode (FR-E2 file read path)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'provider-lane-cfg-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('defaults to shadow when provider-config.json is absent', () => {
    expect(resolveLaneMode(dir, 'gmail')).toBe('shadow');
    expect(resolveLaneMode(dir, 'calendar')).toBe('shadow');
  });

  it('defaults to shadow when provider-config.json is malformed', () => {
    writeFileSync(join(dir, PROVIDER_CONFIG_FILENAME), '{ not json', 'utf8');
    expect(resolveLaneMode(dir, 'gmail')).toBe('shadow');
  });

  it('keeps unconfigured lanes at shadow even when the file exists', () => {
    writeFileSync(join(dir, PROVIDER_CONFIG_FILENAME), JSON.stringify({ lanes: {} }), 'utf8');
    expect(resolveLaneMode(dir, 'gmail')).toBe('shadow');
    expect(resolveLaneMode(dir, 'calendar')).toBe('shadow');
  });

  it('reads a deliberately flipped lane from disk', () => {
    writeFileSync(
      join(dir, PROVIDER_CONFIG_FILENAME),
      JSON.stringify({ lanes: { gmail: 'active', calendar: 'shadow' } }),
      'utf8',
    );
    expect(resolveLaneMode(dir, 'gmail')).toBe('active');
    expect(resolveLaneMode(dir, 'calendar')).toBe('shadow');
  });
});
