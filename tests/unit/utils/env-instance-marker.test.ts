import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// RW-2 regression suite: resolveEnv() (the daemon/bus/hooks/agent-env leg)
// must resolve the instance through the SAME chain the CLI uses — including
// the ~/.cortextos/state/ACTIVE_INSTANCE marker. Before this fix, env.ts
// never consulted the marker, so bare bus/hook calls wrote to
// ~/.cortextos/default/ while the live daemon (and every CLI command) was on
// the marker instance — the instance split-brain.

let fakeHome: string;
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

import { resolveEnv } from '../../../src/utils/env';

function writeMarker(contents: string): void {
  mkdirSync(join(fakeHome, '.cortextos', 'state'), { recursive: true });
  writeFileSync(join(fakeHome, '.cortextos', 'state', 'ACTIVE_INSTANCE'), contents, 'utf-8');
}

const CTX_KEYS = [
  'CTX_INSTANCE_ID',
  'CTX_ROOT',
  'CTX_FRAMEWORK_ROOT',
  'CTX_AGENT_NAME',
  'CTX_AGENT_DIR',
  'CTX_ORG',
  'CTX_PROJECT_ROOT',
  'CTX_TIMEZONE',
  'CTX_ORCHESTRATOR',
] as const;

describe('resolveEnv instance resolution is marker-aware (RW-2)', () => {
  const saved: Record<string, string | undefined> = {};
  let fakeCwd: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ctx-env-marker-'));
    // Isolate cwd so no real .cortextos-env leaks in, and the
    // basename(cwd) agentName fallback stays a valid agent name.
    fakeCwd = join(fakeHome, 'agentcwd');
    mkdirSync(fakeCwd, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
    for (const k of CTX_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of CTX_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('bare resolveEnv() picks up the ACTIVE_INSTANCE marker (no more default/ split-brain)', () => {
    writeMarker('cortextos1\n');
    const env = resolveEnv();
    expect(env.instanceId).toBe('cortextos1');
    expect(env.ctxRoot).toBe(join(fakeHome, '.cortextos', 'cortextos1'));
  });

  it("back-compat: bare resolveEnv() stays 'default' when no marker exists", () => {
    const env = resolveEnv();
    expect(env.instanceId).toBe('default');
    expect(env.ctxRoot).toBe(join(fakeHome, '.cortextos', 'default'));
  });

  it('CTX_INSTANCE_ID env var wins over the marker', () => {
    writeMarker('cortextos1\n');
    process.env.CTX_INSTANCE_ID = 'from-env';
    const env = resolveEnv();
    expect(env.instanceId).toBe('from-env');
  });

  it('overrides.instanceId wins over the marker', () => {
    writeMarker('cortextos1\n');
    const env = resolveEnv({ instanceId: 'from-override' });
    expect(env.instanceId).toBe('from-override');
  });

  it('.cortextos-env file value wins over the marker', () => {
    writeMarker('cortextos1\n');
    writeFileSync(join(fakeCwd, '.cortextos-env'), 'CTX_INSTANCE_ID=from-file\n', 'utf-8');
    const env = resolveEnv();
    expect(env.instanceId).toBe('from-file');
  });

  it('explicit CTX_ROOT still wins for ctxRoot even when the marker sets the instance', () => {
    writeMarker('cortextos1\n');
    process.env.CTX_ROOT = join(fakeHome, 'custom-root');
    const env = resolveEnv();
    expect(env.instanceId).toBe('cortextos1');
    expect(env.ctxRoot).toBe(join(fakeHome, 'custom-root'));
  });
});
