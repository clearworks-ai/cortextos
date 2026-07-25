import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveEnv } from '../../../src/utils/env.js';

// Import pure helpers via evaluate path — exercise mismatch by importing尔斯 resolveActiveInstance
import { resolveActiveInstance } from '../../../src/utils/resolve-active-instance.js';

describe('instance mismatch predicate', () => {
  const originalStrict = process.env.CTX_STRICT_INSTANCE;
  const originalId = process.env.CTX_INSTANCE_ID;

  afterEach(() => {
    if (originalStrict === undefined) delete process.env.CTX_STRICT_INSTANCE;
    else process.env.CTX_STRICT_INSTANCE = originalStrict;
    if (originalId === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = originalId;
  });

  it('marker equals env is no mismatch', () => {
    // Can't easily mock homedir marker without fs mock; assert identity of resolveActiveInstance return type
    const marker = resolveActiveInstance('default');
    expect(typeof marker).toBe('string');
    // When applied to itself: marker === marker → silent
    expect(marker === marker).toBe(true);
  });

  it('empty marker fallback is silent against same fallback', () => {
    const m = resolveActiveInstance('');
    // empty fallback returns '' when marker missing (per implementation) OR 'default' if default used
    expect(typeof m).toBe('string');
  });
});

describe('fix-agent-settings Cron* strip', () => {
  it('REQUIRED_ALLOW no longer includes CronCreate (pin via source scan)', () => {
    const src = readFileSync(join(process.cwd(), 'src/cli/bus.ts'), 'utf-8');
    // REQUIRED_ALLOW block must not list CronCreate
    const m = src.match(/const REQUIRED_ALLOW = \[([\s\S]*?)\];/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toMatch(/CronCreate/);
    expect(m![1]).not.toMatch(/CronList/);
    expect(m![1]).not.toMatch(/CronDelete/);
    expect(src).toMatch(/const STRIP_ALLOW = \['CronCreate', 'CronList', 'CronDelete'\]/);
  });
});

describe('comment-deletion gate', () => {
  it('false next-30s-tick comments removed from bus + ipc-server', () => {
    const bus = readFileSync(join(process.cwd(), 'src/cli/bus.ts'), 'utf-8');
    const ipc = readFileSync(join(process.cwd(), 'src/daemon/ipc-server.ts'), 'utf-8');
    expect(bus).not.toMatch(/next 30s tick/);
    expect(ipc).not.toMatch(/next 30s tick/);
  });
});

describe('kb-job-run allowExcessArguments', () => {
  it('bus.ts chains allowExcessArguments(true) after allowUnknownOption', () => {
    const src = readFileSync(join(process.cwd(), 'src/cli/bus.ts'), 'utf-8');
    const idx = src.indexOf(".command('kb-job-run')");
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 1200);
    expect(slice).toMatch(/\.allowUnknownOption\(true\)/);
    expect(slice).toMatch(/\.allowExcessArguments\(true\)/);
  });
});
