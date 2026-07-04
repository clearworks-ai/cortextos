import { describe, it, expect } from 'vitest';
import {
  reconcile,
  driftFindings,
  type DeclaredAgent,
  type LiveProcess,
} from '../../../src/bus/reconcile';

/**
 * Unit tests for the pure fleet-reconcile logic (WS4).
 *
 * The motivating incident: "sage silently didn't come back after a fleet
 * restart; Josh caught it, not the fleet." These tests lock in that an
 * enabled-but-not-running agent is detected as drift, while intentionally
 * disabled / known-off agents (e.g. permanently-off hunter) are NEVER flagged.
 */

const running = (name: string): LiveProcess => ({ name, status: 'running', pid: 100, uptime: 60 });

describe('reconcile (pure fleet drift)', () => {
  it('clean fleet -> empty drift report', () => {
    const declaredAgents: DeclaredAgent[] = [
      { name: 'frank2', org: 'clearworksai', enabled: true },
      { name: 'larry', org: 'clearworksai', enabled: true },
    ];
    const liveProcesses = [running('frank2'), running('larry')];

    const report = reconcile({ declaredAgents, liveProcesses });

    expect(report.clean).toBe(true);
    expect(report.total).toBe(0);
    expect(report.missing_process).toHaveLength(0);
    expect(report.orphan_process).toHaveLength(0);
    expect(report.missing_cron).toHaveLength(0);
    expect(report.missing_env).toHaveLength(0);
  });

  it('detects missing-process for an enabled agent that is not running', () => {
    const declaredAgents: DeclaredAgent[] = [
      { name: 'frank2', org: 'clearworksai', enabled: true },
      { name: 'sage', org: 'clearworksai', enabled: true },
    ];
    // sage did not come back after the restart.
    const liveProcesses = [running('frank2')];

    const report = reconcile({ declaredAgents, liveProcesses });

    expect(report.clean).toBe(false);
    expect(report.missing_process).toHaveLength(1);
    expect(report.missing_process[0].agent).toBe('sage');
    expect(report.missing_process[0].kind).toBe('missing_process');
    expect(report.missing_process[0].org).toBe('clearworksai');
  });

  it('treats a halted/crashed process as missing (not up)', () => {
    const declaredAgents: DeclaredAgent[] = [{ name: 'muse', org: 'clearworksai', enabled: true }];
    const liveProcesses: LiveProcess[] = [{ name: 'muse', status: 'halted' }];

    const report = reconcile({ declaredAgents, liveProcesses });

    expect(report.missing_process.map(f => f.agent)).toEqual(['muse']);
  });

  it('does NOT flag an intentionally disabled agent (enabled: false)', () => {
    const declaredAgents: DeclaredAgent[] = [
      { name: 'frank2', org: 'clearworksai', enabled: true },
      { name: 'scout', org: 'clearworksai', enabled: false }, // stale duplicate, off
    ];
    const liveProcesses = [running('frank2')];

    const report = reconcile({ declaredAgents, liveProcesses });

    expect(report.clean).toBe(true);
    expect(report.missing_process).toHaveLength(0);
  });

  it('does NOT flag a known-off agent even if config still says enabled (hunter)', () => {
    const declaredAgents: DeclaredAgent[] = [
      { name: 'frank2', org: 'clearworksai', enabled: true },
      // hunter is permanently OFF but a stale config still marks it enabled.
      { name: 'hunter', org: 'clearworksai', enabled: true },
    ];
    const liveProcesses = [running('frank2')];

    const report = reconcile({ declaredAgents, liveProcesses, knownOff: ['hunter'] });

    expect(report.clean).toBe(true);
    expect(report.missing_process).toHaveLength(0);
  });

  it('reports a running known-off agent as orphan (it should be stopped)', () => {
    const declaredAgents: DeclaredAgent[] = [{ name: 'hunter', org: 'clearworksai', enabled: true }];
    const liveProcesses = [running('hunter')];

    const report = reconcile({ declaredAgents, liveProcesses, knownOff: ['hunter'] });

    expect(report.missing_process).toHaveLength(0);
    expect(report.orphan_process).toHaveLength(1);
    expect(report.orphan_process[0].agent).toBe('hunter');
    expect(report.orphan_process[0].kind).toBe('orphan_process');
  });

  it('detects missing-cron: declared cron not scheduled by the daemon', () => {
    const declaredAgents: DeclaredAgent[] = [
      { name: 'larry', org: 'clearworksai', enabled: true, declaredCrons: ['heartbeat', 'credential-preflight'] },
    ];
    const liveProcesses = [running('larry')];
    // Only heartbeat is scheduled; credential-preflight drifted.
    const scheduledCrons = { larry: ['heartbeat'] };

    const report = reconcile({ declaredAgents, liveProcesses, scheduledCrons });

    expect(report.missing_cron).toHaveLength(1);
    expect(report.missing_cron[0].agent).toBe('larry');
    expect(report.missing_cron[0].detail).toBe('credential-preflight');
    expect(report.missing_cron[0].kind).toBe('missing_cron');
  });

  it('does NOT flag crons for a disabled agent', () => {
    const declaredAgents: DeclaredAgent[] = [
      { name: 'scout', org: 'clearworksai', enabled: false, declaredCrons: ['spa-fetch'] },
    ];
    const report = reconcile({ declaredAgents, liveProcesses: [], scheduledCrons: {} });
    expect(report.missing_cron).toHaveLength(0);
    expect(report.clean).toBe(true);
  });

  it('detects missing-env: declared env key absent from present keys', () => {
    const declaredAgents: DeclaredAgent[] = [
      {
        name: 'larry',
        org: 'clearworksai',
        enabled: true,
        declaredEnvKeys: ['ANTHROPIC_API_KEY', 'BOT_TOKEN'],
        presentEnvKeys: ['BOT_TOKEN'], // ANTHROPIC_API_KEY missing
      },
    ];
    const liveProcesses = [running('larry')];

    const report = reconcile({ declaredAgents, liveProcesses });

    expect(report.missing_env).toHaveLength(1);
    expect(report.missing_env[0].agent).toBe('larry');
    expect(report.missing_env[0].detail).toBe('ANTHROPIC_API_KEY');
    expect(report.missing_env[0].kind).toBe('missing_env');
  });

  it('no missing-env when all declared keys are present', () => {
    const declaredAgents: DeclaredAgent[] = [
      {
        name: 'larry',
        org: 'clearworksai',
        enabled: true,
        declaredEnvKeys: ['BOT_TOKEN', 'CHAT_ID'],
        presentEnvKeys: ['BOT_TOKEN', 'CHAT_ID', 'EXTRA'],
      },
    ];
    const report = reconcile({ declaredAgents, liveProcesses: [running('larry')] });
    expect(report.missing_env).toHaveLength(0);
    expect(report.clean).toBe(true);
  });

  it('reports an undeclared running process as orphan', () => {
    const declaredAgents: DeclaredAgent[] = [{ name: 'frank2', org: 'clearworksai', enabled: true }];
    const liveProcesses = [running('frank2'), running('ghost')];

    const report = reconcile({ declaredAgents, liveProcesses });

    expect(report.orphan_process).toHaveLength(1);
    expect(report.orphan_process[0].agent).toBe('ghost');
  });

  it('dedups same agent name across two orgs — one running copy satisfies both', () => {
    // clearworksai/scout + personal/scout both declared enabled; only one runs.
    const declaredAgents: DeclaredAgent[] = [
      { name: 'scout', org: 'clearworksai', enabled: true },
      { name: 'scout', org: 'personal', enabled: true },
    ];
    const liveProcesses = [running('scout')];

    const report = reconcile({ declaredAgents, liveProcesses });

    expect(report.missing_process).toHaveLength(0);
    expect(report.clean).toBe(true);
  });

  it('treats absent enabled flag as enabled (default-on)', () => {
    const declaredAgents: DeclaredAgent[] = [{ name: 'newbie', org: 'clearworksai' }];
    const report = reconcile({ declaredAgents, liveProcesses: [] });
    expect(report.missing_process).toHaveLength(1);
    expect(report.missing_process[0].agent).toBe('newbie');
  });

  it('driftFindings flattens all categories in order', () => {
    const declaredAgents: DeclaredAgent[] = [
      {
        name: 'larry',
        org: 'clearworksai',
        enabled: true,
        declaredCrons: ['c1'],
        declaredEnvKeys: ['K1'],
        presentEnvKeys: [],
      },
    ];
    // larry missing-process + missing-cron + missing-env; plus an orphan.
    const report = reconcile({
      declaredAgents,
      liveProcesses: [running('ghost')],
      scheduledCrons: {},
    });
    const flat = driftFindings(report);
    expect(flat).toHaveLength(4);
    expect(flat.map(f => f.kind)).toEqual([
      'missing_process',
      'orphan_process',
      'missing_cron',
      'missing_env',
    ]);
  });
});
