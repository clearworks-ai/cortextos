import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Isolate the marker file per-test by pointing homedir() at a temp dir.
let fakeHome: string;
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

import { resolveInstanceId } from '../../../src/cli/resolve-instance-id';
import { addAgentCommand } from '../../../src/cli/add-agent';

function writeMarker(contents: string): void {
  mkdirSync(join(fakeHome, '.cortextos', 'state'), { recursive: true });
  writeFileSync(join(fakeHome, '.cortextos', 'state', 'ACTIVE_INSTANCE'), contents, 'utf-8');
}

describe('marker-aware instance resolution', () => {
  const originalInstance = process.env.CTX_INSTANCE_ID;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ctx-marker-res-'));
    delete process.env.CTX_INSTANCE_ID;
  });

  afterEach(() => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
    if (originalInstance === undefined) {
      delete process.env.CTX_INSTANCE_ID;
    } else {
      process.env.CTX_INSTANCE_ID = originalInstance;
    }
    vi.restoreAllMocks();
  });

  it('resolves to the marker value when no option and no env are set', () => {
    writeMarker('cortextos1\n');
    expect(resolveInstanceId(undefined)).toBe('cortextos1');
  });

  it('back-compat: bare resolution stays "default" when no marker exists', () => {
    expect(resolveInstanceId(undefined)).toBe('default');
  });

  it('explicit --instance wins over the marker', () => {
    writeMarker('cortextos1\n');
    expect(resolveInstanceId('from-cli')).toBe('from-cli');
  });

  it('CTX_INSTANCE_ID wins over the marker', () => {
    writeMarker('cortextos1\n');
    process.env.CTX_INSTANCE_ID = 'from-env';
    expect(resolveInstanceId(undefined)).toBe('from-env');
  });

  it('ignores an invalid marker and falls back to "default"', () => {
    writeMarker('Not A Valid Id');
    expect(resolveInstanceId(undefined)).toBe('default');
  });
});

describe('add-agent command instance option', () => {
  it('leaves --instance unset so downstream resolution can win (no hardcoded default)', () => {
    // The 4 fixed operational commands must not carry a commander "default"
    // 3rd-arg — that would shadow marker/env resolution. add-agent is the
    // representative case for this batch.
    expect(addAgentCommand.opts().instance).toBeUndefined();
  });
});
