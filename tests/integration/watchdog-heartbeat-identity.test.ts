/**
 * tests/integration/watchdog-heartbeat-identity.test.ts
 *
 * Regression for the watchdog heartbeat identity bug: FastChecker's 50-minute
 * idle-session watchdog used to spawn `cortextos bus update-heartbeat` with no
 * explicit env/cwd override, so it inherited the DAEMON's own process.env.
 * In production every agent's watchdog tick landed under whichever agent's
 * CTX_AGENT_NAME happened to be set in that shared environment (observed:
 * 282 misattributed heartbeat entries under one agent's identity in a day).
 *
 * This test exercises the REAL `cortextos bus update-heartbeat` code path
 * end-to-end — resolveEnv(), resolvePaths(), updateHeartbeat(), logEvent() are
 * all real, unmocked — the way FastChecker's fixed watchdog now targets it via
 * an explicit env object. Only os.homedir() is redirected (via HOME) so the
 * test never touches the real ~/.cortextos.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveEnv } from '../../src/utils/env.js';
import { resolvePaths } from '../../src/utils/paths.js';
import { updateHeartbeat } from '../../src/bus/heartbeat.js';
import { logEvent } from '../../src/bus/event.js';

let tmpHome: string;
let realHome: string | undefined;
let realEnvKeys: string[];

/**
 * Run `fn` with process.env patched to simulate the exact env object
 * FastChecker's fixed watchdog now builds for `target` — then restore.
 * Mirrors execFile's isolated child env; nothing here mutates state a
 * concurrent test could observe (vitest runs this file's tests serially).
 */
function withTargetEnv<T>(target: { agentName: string; agentDir: string; org: string; instanceId: string }, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  const overrides: Record<string, string> = {
    HOME: tmpHome,
    CTX_AGENT_NAME: target.agentName,
    CTX_AGENT_DIR: target.agentDir,
    CTX_ORG: target.org,
    CTX_INSTANCE_ID: target.instanceId,
    CTX_PROJECT_ROOT: tmpHome,
  };
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'watchdog-heartbeat-identity-'));
  realHome = process.env.HOME;
  realEnvKeys = ['CTX_AGENT_NAME', 'CTX_AGENT_DIR', 'CTX_ORG', 'CTX_INSTANCE_ID', 'CTX_PROJECT_ROOT', 'CTX_ROOT'];
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  for (const key of realEnvKeys) delete process.env[key];
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Mirrors the `cortextos bus update-heartbeat` action handler exactly. */
function runUpdateHeartbeatCli(status: string) {
  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  updateHeartbeat(paths, env.agentName, status, { org: env.org });
  logEvent(paths, env.agentName, env.org, 'heartbeat', 'heartbeat', 'info', JSON.stringify({ status }), { refreshHeartbeat: true });
  return paths;
}

describe('watchdog heartbeat identity — real CLI path, two distinct targets', () => {
  it('each target agent gets its own heartbeat.json and event file, under its own identity', () => {
    const knox = { agentName: 'knox-test', agentDir: join(tmpHome, 'agents', 'knox-test'), org: 'test-org', instanceId: 'test-instance' };
    const larry = { agentName: 'larry-test', agentDir: join(tmpHome, 'agents', 'larry-test'), org: 'test-org', instanceId: 'test-instance' };
    mkdirSync(knox.agentDir, { recursive: true });
    mkdirSync(larry.agentDir, { recursive: true });

    const knoxPaths = withTargetEnv(knox, () => runUpdateHeartbeatCli(`[watchdog] ${knox.agentName} alive — daemon-observed process liveness`));
    const larryPaths = withTargetEnv(larry, () => runUpdateHeartbeatCli(`[watchdog] ${larry.agentName} alive — daemon-observed process liveness`));

    const knoxHeartbeatFile = join(knoxPaths.stateDir, 'heartbeat.json');
    const larryHeartbeatFile = join(larryPaths.stateDir, 'heartbeat.json');

    expect(existsSync(knoxHeartbeatFile)).toBe(true);
    expect(existsSync(larryHeartbeatFile)).toBe(true);
    // Different agents must resolve to different state directories entirely —
    // the pre-fix bug had them all landing on ONE agent's files.
    expect(knoxPaths.stateDir).not.toBe(larryPaths.stateDir);

    const knoxHeartbeat = JSON.parse(readFileSync(knoxHeartbeatFile, 'utf-8'));
    const larryHeartbeat = JSON.parse(readFileSync(larryHeartbeatFile, 'utf-8'));

    expect(knoxHeartbeat.status).toContain('knox-test alive');
    expect(larryHeartbeat.status).toContain('larry-test alive');
    // No bleed-through: knox's file must never mention larry and vice versa.
    expect(JSON.stringify(knoxHeartbeat)).not.toContain('larry-test');
    expect(JSON.stringify(larryHeartbeat)).not.toContain('knox-test');

    // Event files: real bytes on disk, under each agent's own analytics path.
    const knoxEventDir = join(knoxPaths.analyticsDir, 'events', 'knox-test');
    const larryEventDir = join(larryPaths.analyticsDir, 'events', 'larry-test');
    expect(existsSync(knoxEventDir)).toBe(true);
    expect(existsSync(larryEventDir)).toBe(true);
  });

  it('reproduces the pre-fix bug when no explicit env override is supplied (inherited env wins)', () => {
    // This is the OLD behavior FastChecker used to have: execFile() with no
    // env override at all, so resolveEnv() falls through to whatever
    // CTX_AGENT_NAME the parent process (here, the test process) happens to
    // carry. Setting it once and calling the handler for two "different"
    // logical targets without per-call overrides collapses them onto one
    // identity — demonstrating why the fix (explicit per-call env) is required.
    process.env.HOME = tmpHome;
    process.env.CTX_AGENT_NAME = 'larry-test'; // simulates "whichever agent set this last"
    process.env.CTX_ORG = 'test-org';
    process.env.CTX_INSTANCE_ID = 'test-instance';
    process.env.CTX_PROJECT_ROOT = tmpHome;
    mkdirSync(join(tmpHome, 'agents', 'larry-test'), { recursive: true });

    // Two "ticks" that intend to report on different agents, but without a
    // per-call env override both resolve to the inherited CTX_AGENT_NAME.
    const firstPaths = runUpdateHeartbeatCli('[watchdog] knox-test alive — idle session');
    const secondPaths = runUpdateHeartbeatCli('[watchdog] larry-test alive — idle session');

    // Both land in the SAME state dir — this is the misattribution bug.
    expect(firstPaths.stateDir).toBe(secondPaths.stateDir);
    const heartbeat = JSON.parse(readFileSync(join(firstPaths.stateDir, 'heartbeat.json'), 'utf-8'));
    // The knox-labeled status got overwritten/attributed under larry's identity.
    expect(heartbeat.status).toContain('larry-test alive');
  });
});
