import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir, homedir as realHomedir } from 'os';
import { join } from 'path';

// Point homedir() at a temp dir so the marker path
// (~/.cortextos/state/ACTIVE_INSTANCE) is controllable and never touches the
// real machine.
let fakeHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

// Import AFTER the mock is registered.
import {
  resolveActiveInstance,
  activeInstanceMarkerPath,
} from '../../../src/utils/resolve-active-instance';
import { resolvePaths, getIpcPath } from '../../../src/utils/paths';
import { resolveInstanceId } from '../../../src/cli/resolve-instance-id';

function writeMarker(contents: string): void {
  const p = activeInstanceMarkerPath();
  mkdirSync(join(fakeHome, '.cortextos', 'state'), { recursive: true });
  writeFileSync(p, contents);
}

describe('resolveActiveInstance', () => {
  const origEnv = process.env.CTX_INSTANCE_ID;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ctx-active-instance-'));
    delete process.env.CTX_INSTANCE_ID;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = origEnv;
    vi.restoreAllMocks();
  });

  it('marker present -> resolves to its value', () => {
    writeMarker('cortextos1');
    expect(resolveActiveInstance()).toBe('cortextos1');
    expect(resolveActiveInstance('default')).toBe('cortextos1');
  });

  it('trims surrounding whitespace/newlines in the marker', () => {
    writeMarker('  cortextos1 \n');
    expect(resolveActiveInstance()).toBe('cortextos1');
  });

  it('marker absent -> falls back to default', () => {
    expect(resolveActiveInstance()).toBe('default');
    expect(resolveActiveInstance('default')).toBe('default');
  });

  it('honors a non-default fallback when the marker is absent', () => {
    expect(resolveActiveInstance('someOtherFallback'.toLowerCase())).toBe('someotherfallback');
  });

  it('empty marker -> falls back to default', () => {
    writeMarker('   \n');
    expect(resolveActiveInstance('default')).toBe('default');
  });

  it('invalid (path-traversal) marker content is ignored -> falls back to default', () => {
    writeMarker('../evil');
    expect(resolveActiveInstance('default')).toBe('default');
  });

  it('activeInstanceMarkerPath is the top-level state marker (not instance-nested)', () => {
    expect(activeInstanceMarkerPath()).toBe(
      join(fakeHome, '.cortextos', 'state', 'ACTIVE_INSTANCE'),
    );
  });
});

describe('resolvePaths marker awareness', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ctx-active-instance-'));
    delete process.env.CTX_INSTANCE_ID;
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('no instance arg + marker present -> ctxRoot uses the marker instance', () => {
    writeMarker('cortextos1');
    const paths = resolvePaths('muse');
    expect(paths.ctxRoot).toBe(join(fakeHome, '.cortextos', 'cortextos1'));
    expect(paths.stateDir).toBe(join(fakeHome, '.cortextos', 'cortextos1', 'state', 'muse'));
  });

  it('no instance arg + marker absent -> ctxRoot falls back to default (back-compat)', () => {
    const paths = resolvePaths('muse');
    expect(paths.ctxRoot).toBe(join(fakeHome, '.cortextos', 'default'));
  });

  it('explicit instance arg always wins over the marker', () => {
    writeMarker('cortextos1');
    const paths = resolvePaths('muse', 'e2e-test');
    expect(paths.ctxRoot).toBe(join(fakeHome, '.cortextos', 'e2e-test'));
  });

  it('explicit "default" arg still wins over the marker', () => {
    writeMarker('cortextos1');
    const paths = resolvePaths('muse', 'default');
    expect(paths.ctxRoot).toBe(join(fakeHome, '.cortextos', 'default'));
  });
});

describe('getIpcPath marker awareness', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ctx-active-instance-'));
    delete process.env.CTX_INSTANCE_ID;
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Socket path only applies off-Windows; the named-pipe branch encodes the id
  // directly, so assert on the resolved id string regardless of platform.
  const isWin = process.platform === 'win32';

  it('no arg + marker present -> path uses the marker instance', () => {
    writeMarker('cortextos1');
    const p = getIpcPath();
    if (isWin) expect(p).toBe('\\\\.\\pipe\\cortextos-cortextos1');
    else expect(p).toBe(join(fakeHome, '.cortextos', 'cortextos1', 'daemon.sock'));
  });

  it('no arg + marker absent -> path falls back to default', () => {
    const p = getIpcPath();
    if (isWin) expect(p).toBe('\\\\.\\pipe\\cortextos-default');
    else expect(p).toBe(join(fakeHome, '.cortextos', 'default', 'daemon.sock'));
  });

  it('explicit arg always wins over the marker', () => {
    writeMarker('cortextos1');
    const p = getIpcPath('e2e-test');
    if (isWin) expect(p).toBe('\\\\.\\pipe\\cortextos-e2e-test');
    else expect(p).toBe(join(fakeHome, '.cortextos', 'e2e-test', 'daemon.sock'));
  });
});

describe('resolveInstanceId priority (option > env > marker > default)', () => {
  const origEnv = process.env.CTX_INSTANCE_ID;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ctx-active-instance-'));
    delete process.env.CTX_INSTANCE_ID;
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = origEnv;
    vi.restoreAllMocks();
  });

  it('explicit option wins over env and marker', () => {
    process.env.CTX_INSTANCE_ID = 'from-env';
    writeMarker('cortextos1');
    expect(resolveInstanceId('from-option')).toBe('from-option');
  });

  it('env wins over marker when no option', () => {
    process.env.CTX_INSTANCE_ID = 'from-env';
    writeMarker('cortextos1');
    expect(resolveInstanceId()).toBe('from-env');
  });

  it('marker wins over default when no option and no env', () => {
    writeMarker('cortextos1');
    expect(resolveInstanceId()).toBe('cortextos1');
  });

  it('falls back to default when option, env, and marker are all absent', () => {
    expect(resolveInstanceId()).toBe('default');
  });
});

// Reference the real homedir import so the linter does not flag it as unused;
// it documents that the mock intentionally shadows os.homedir.
void realHomedir;
