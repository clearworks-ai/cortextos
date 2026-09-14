import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readAllHeartbeats } from '../../../src/bus/heartbeat';
import type { BusPaths, Heartbeat } from '../../../src/types';

describe('readAllHeartbeats', () => {
  let ctxRoot: string;
  let paths: BusPaths;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-heartbeats-'));
    paths = {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox', 'reader'),
      inflight: join(ctxRoot, 'inflight', 'reader'),
      processed: join(ctxRoot, 'processed', 'reader'),
      logDir: join(ctxRoot, 'logs', 'reader'),
      stateDir: join(ctxRoot, 'state', 'reader'),
      taskDir: join(ctxRoot, 'tasks'),
      approvalDir: join(ctxRoot, 'approvals'),
      analyticsDir: join(ctxRoot, 'analytics'),
      heartbeatDir: join(ctxRoot, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function writeHeartbeat(agent: string): void {
    const stateDir = join(ctxRoot, 'state', agent);
    mkdirSync(stateDir, { recursive: true });
    const heartbeat: Heartbeat = {
      agent,
      org: 'test-org',
      status: 'online',
      current_task: '',
      mode: 'day',
      last_heartbeat: '2026-08-30T20:00:00Z',
      loop_interval: '4h',
    };
    writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify(heartbeat));
  }

  it('keeps backward-compatible state scanning when no enabled registry exists', () => {
    writeHeartbeat('alpha');
    writeHeartbeat('beta');

    expect(readAllHeartbeats(paths).map((heartbeat) => heartbeat.agent).sort())
      .toEqual(['alpha', 'beta']);
  });

  it('returns only explicitly enabled registered identities', () => {
    writeHeartbeat('alpha-codex');
    writeHeartbeat('legacy-alpha');
    writeHeartbeat('historical-artifact');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({
        'alpha-codex': { enabled: true, org: 'test-org' },
        'legacy-alpha': { enabled: false, org: 'test-org' },
      }),
    );

    expect(readAllHeartbeats(paths).map((heartbeat) => heartbeat.agent))
      .toEqual(['alpha-codex']);
  });
});
