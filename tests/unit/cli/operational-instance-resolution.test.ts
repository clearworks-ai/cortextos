/**
 * WS7 follow-up (PR #49): the marker-aware resolver was only wired into a
 * couple of commands. Operational, fleet-targeting commands (restart, start,
 * stop, doctor, enable, notify-agent, add-agent, import-agent, dashboard,
 * tunnel) declared `--instance <id>` with a HARDCODED commander default of
 * 'default', then used `options.instance` directly. Because commander fills
 * the literal string 'default' when the flag is omitted, options.instance was
 * NEVER undefined, so the CTX_INSTANCE_ID / active-instance-marker fallbacks in
 * resolveInstanceId() were dead code. Result: `cortextos restart <agent>` said
 * "Daemon is not running" unless you passed --instance cortextos1.
 *
 * This test pins the fixed resolution path end-to-end for an operational
 * command (restart): the commander option no longer hardcodes a default (so a
 * bare invocation yields undefined), and resolveInstanceId() then applies the
 * documented priority option > env > marker > default. It proves:
 *   - marker absent + no flag + no env -> 'default' (back-compat)
 *   - explicit --instance wins over marker
 *   - active-instance marker (e.g. cortextos1) wins when the flag is omitted
 *   - CTX_INSTANCE_ID wins when the flag is omitted and no marker is used
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point homedir() at a temp dir so the active-instance marker path
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
import { restartCommand } from '../../../src/cli/restart';
import { resolveInstanceId } from '../../../src/cli/resolve-instance-id';
import { activeInstanceMarkerPath } from '../../../src/utils/resolve-active-instance';

function writeMarker(contents: string): void {
  const p = activeInstanceMarkerPath();
  mkdirSync(join(fakeHome, '.cortextos', 'state'), { recursive: true });
  writeFileSync(p, contents);
}

describe('operational command instance resolution (restart, marker-aware)', () => {
  const origEnv = process.env.CTX_INSTANCE_ID;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ctx-op-instance-'));
    delete process.env.CTX_INSTANCE_ID;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = origEnv;
    vi.restoreAllMocks();
  });

  it('the restart --instance option carries NO hardcoded default (bare = undefined)', () => {
    // This is the crux: if commander pre-filled 'default', the resolver could
    // never see the marker. A bare command must surface undefined so the
    // resolver decides.
    expect(restartCommand.opts().instance).toBeUndefined();
  });

  it('marker absent + no flag + no env -> "default" (back-compat preserved)', () => {
    const bareFlag = restartCommand.opts().instance; // undefined
    expect(resolveInstanceId(bareFlag)).toBe('default');
  });

  it('explicit --instance wins over the active-instance marker', () => {
    writeMarker('cortextos1');
    // Simulates `cortextos restart <agent> --instance e2e-test`.
    expect(resolveInstanceId('e2e-test')).toBe('e2e-test');
  });

  it('active-instance marker (cortextos1) resolves a BARE command to the non-default instance', () => {
    writeMarker('cortextos1');
    const bareFlag = restartCommand.opts().instance; // undefined
    // This is the headline symptom the fix targets: a bare `cortextos restart`
    // must now target cortextos1 (the live daemon), not the dead 'default'.
    expect(resolveInstanceId(bareFlag)).toBe('cortextos1');
  });

  it('CTX_INSTANCE_ID resolves a BARE command to the non-default instance', () => {
    process.env.CTX_INSTANCE_ID = 'cortextos1';
    const bareFlag = restartCommand.opts().instance; // undefined
    expect(resolveInstanceId(bareFlag)).toBe('cortextos1');
  });
});
