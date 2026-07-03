import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  diffAgents,
  diffCrons,
  checkBriefsUrl,
  runFleetReconcile,
} from '../../../src/daemon/fleet-reconcile.js';
import type {
  ReconcileDeps,
  ReconcileReport,
} from '../../../src/daemon/fleet-reconcile.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

interface FakeIpcCall {
  type: string;
  agent?: string;
  data?: Record<string, unknown>;
  source?: string;
}

/** Records every IPC send; scripted per-type responses. */
function makeFakeIpc(opts: {
  statuses?: Array<{ name: string; status: string; uptime?: number }>;
  startAgentSuccess?: boolean;
  startAgentError?: string;
} = {}) {
  const calls: FakeIpcCall[] = [];
  return {
    calls,
    send: async (req: FakeIpcCall) => {
      calls.push(req);
      if (req.type === 'status') {
        return { success: true, data: opts.statuses ?? [] };
      }
      if (req.type === 'start-agent') {
        if (opts.startAgentSuccess === false) {
          return { success: false, error: opts.startAgentError ?? 'boom' };
        }
        return { success: true, data: `Starting ${req.agent}` };
      }
      return { success: true, data: null };
    },
  };
}

let testDir: string;
let ctxRoot: string;

function writeEnabledAgents(registry: Record<string, unknown>): void {
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify(registry), 'utf-8');
}

function writeAgentConfig(org: string, agent: string, config: Record<string, unknown>): void {
  const dir = join(ctxRoot, 'orgs', org, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf-8');
}

function writeLiveCrons(agent: string, crons: Array<Record<string, unknown>>): void {
  const dir = join(ctxRoot, '.cortextOS', 'state', 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'crons.json'), JSON.stringify({ crons }), 'utf-8');
}

function writeEnvFile(vars: Record<string, string>): string {
  const path = join(ctxRoot, '.env');
  writeFileSync(
    path,
    Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
    'utf-8'
  );
  return path;
}

function baseDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    ctxRoot,
    ipc: makeFakeIpc(),
    fetcher: async () => 200,
    now: () => new Date('2026-07-03T12:00:00.000Z'),
    frameworkRoot: ctxRoot,
    ...overrides,
  };
}

function readReceipts(): ReconcileReport[] {
  const path = join(ctxRoot, 'state', 'fleet-reconcile-receipts.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as ReconcileReport);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'fleet-reconcile-test-'));
  ctxRoot = join(testDir, 'instance');
  mkdirSync(ctxRoot, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// diffAgents (pure)
// ---------------------------------------------------------------------------

describe('diffAgents', () => {
  it('classifies enabled-but-missing, disabled-and-missing, and extra agents', () => {
    const diff = diffAgents(
      {
        sage: { enabled: true },
        larry: {},               // no enabled flag → default-on
        hunter: { enabled: false }, // permanently off
        muse: { enabled: true },
      },
      ['muse', 'ghost']
    );
    expect(diff.missing.sort()).toEqual(['larry', 'sage']);
    expect(diff.skipped_disabled).toEqual(['hunter']);
    expect(diff.extra).toEqual(['ghost']);
  });

  it('a running agent is never missing, even when disabled in the registry', () => {
    const diff = diffAgents({ hunter: { enabled: false } }, ['hunter']);
    expect(diff.missing).toEqual([]);
    expect(diff.skipped_disabled).toEqual([]);
    expect(diff.extra).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// diffCrons (pure) — all three drift kinds
// ---------------------------------------------------------------------------

describe('diffCrons', () => {
  it('detects all three drift kinds', () => {
    const drift = diffCrons(
      [
        { name: 'heartbeat', schedule: '6h' },
        { name: 'morning-brief', schedule: '0 8 * * *' },
        { name: 'weekly', schedule: '0 16 * * 1' },
      ],
      [
        { name: 'heartbeat', schedule: '6h' },          // in sync
        { name: 'morning-brief', schedule: '0 9 * * *' }, // schedule drifted
        { name: 'rogue-cron', schedule: '30m' },          // live only
        // 'weekly' missing from live crons.json
      ]
    );
    expect(drift).toContainEqual({ kind: 'schedule-mismatch', id: 'morning-brief' });
    expect(drift).toContainEqual({ kind: 'missing-in-crons', id: 'weekly' });
    expect(drift).toContainEqual({ kind: 'missing-in-config', id: 'rogue-cron' });
    expect(drift).toHaveLength(3);
  });

  it('returns no drift when config and live agree', () => {
    const crons = [{ name: 'heartbeat', schedule: '6h' }];
    expect(diffCrons(crons, crons)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkBriefsUrl
// ---------------------------------------------------------------------------

describe('checkBriefsUrl', () => {
  it('ok on 200 from a briefs.clearworks.ai host', async () => {
    const path = writeEnvFile({
      BRIEFS_BASE_URL: 'https://briefs.clearworks.ai',
      DASHBOARD_BRIEF_TOKEN: 'tok123',
    });
    const seen: string[] = [];
    const result = await checkBriefsUrl(path, async url => { seen.push(url); return 200; });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.url).toBe('https://briefs.clearworks.ai?token=tok123');
    expect(seen).toEqual([result.url]);
  });

  it('not ok on 404', async () => {
    const path = writeEnvFile({
      BRIEFS_BASE_URL: 'https://briefs.clearworks.ai',
      DASHBOARD_BRIEF_TOKEN: 'tok123',
    });
    const result = await checkBriefsUrl(path, async () => 404);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.note).toContain('404');
  });

  it('not ok on timeout / network error (fetcher throws)', async () => {
    const path = writeEnvFile({
      BRIEFS_BASE_URL: 'https://briefs.clearworks.ai',
      DASHBOARD_BRIEF_TOKEN: 'tok123',
    });
    const result = await checkBriefsUrl(path, async () => {
      throw new Error('The operation was aborted');
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.note).toContain('fetch failed');
  });

  it('not ok on 200 from a NON-briefs host (stale Railway URL drift)', async () => {
    const path = writeEnvFile({
      BRIEFS_BASE_URL: 'https://briefs-production.up.railway.app',
      DASHBOARD_BRIEF_TOKEN: 'tok123',
    });
    const result = await checkBriefsUrl(path, async () => 200);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.note).toContain('is not briefs.clearworks.ai');
  });

  it('missing env file → url null, ok false, note recorded', async () => {
    const result = await checkBriefsUrl(join(ctxRoot, 'nope.env'), async () => 200);
    expect(result).toMatchObject({ url: null, status: null, ok: false });
    expect(result.note).toContain('not found');
  });

  it('missing env vars → url null, ok false, note names the vars', async () => {
    const path = writeEnvFile({ SOMETHING_ELSE: 'x' });
    const result = await checkBriefsUrl(path, async () => 200);
    expect(result.ok).toBe(false);
    expect(result.url).toBeNull();
    expect(result.note).toContain('BRIEFS_BASE_URL');
    expect(result.note).toContain('DASHBOARD_BRIEF_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// runFleetReconcile — orchestration
// ---------------------------------------------------------------------------

describe('runFleetReconcile', () => {
  it('sends start-agent for enabled-but-missing agents and records them as restarted', async () => {
    writeEnabledAgents({ sage: { enabled: true }, muse: { enabled: true } });
    const ipc = makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 100 }] });

    const report = await runFleetReconcile(baseDeps({ ipc }));

    expect(report.agents.missing).toEqual(['sage']);
    expect(report.agents.restarted).toEqual(['sage']);
    const starts = ipc.calls.filter(c => c.type === 'start-agent');
    expect(starts).toHaveLength(1);
    expect(starts[0].agent).toBe('sage');
    expect(starts[0].data).toEqual({ name: 'sage' });
  });

  it('NEVER sends start-agent for a disabled agent (hunter stays off)', async () => {
    writeEnabledAgents({ hunter: { enabled: false }, muse: { enabled: true } });
    const ipc = makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 100 }] });

    const report = await runFleetReconcile(baseDeps({ ipc }));

    expect(report.agents.skipped_disabled).toEqual(['hunter']);
    expect(report.agents.missing).toEqual([]);
    expect(report.agents.restarted).toEqual([]);
    const hunterCalls = ipc.calls.filter(
      c => c.type === 'start-agent' && (c.agent === 'hunter' || c.data?.name === 'hunter')
    );
    expect(hunterCalls).toHaveLength(0);
    // No start-agent of any kind was needed in this scenario.
    expect(ipc.calls.filter(c => c.type === 'start-agent')).toHaveLength(0);
  });

  it('--dry-run reports missing agents but sends zero start-agent calls', async () => {
    writeEnabledAgents({ sage: { enabled: true } });
    const ipc = makeFakeIpc({ statuses: [] });

    const report = await runFleetReconcile(baseDeps({ ipc, dryRun: true }));

    expect(report.agents.missing).toEqual(['sage']);
    expect(report.agents.restarted).toEqual([]);
    expect(ipc.calls.filter(c => c.type === 'start-agent')).toHaveLength(0);
  });

  it('running-but-not-registered agents are reported as extra', async () => {
    writeEnabledAgents({ muse: { enabled: true } });
    const ipc = makeFakeIpc({
      statuses: [
        { name: 'muse', status: 'running', uptime: 100 },
        { name: 'ghost', status: 'running', uptime: 50 },
      ],
    });

    const report = await runFleetReconcile(baseDeps({ ipc }));

    expect(report.agents.extra).toEqual(['ghost']);
  });

  it('start-agent IPC failure lands in errors and the run keeps going', async () => {
    writeEnabledAgents({ sage: { enabled: true }, larry: { enabled: true } });
    const ipc = makeFakeIpc({ statuses: [], startAgentSuccess: false, startAgentError: 'NOT_FOUND' });

    const report = await runFleetReconcile(baseDeps({ ipc }));

    expect(report.agents.restarted).toEqual([]);
    expect(report.errors.filter(e => e.includes('start-agent'))).toHaveLength(2);
    // Both were still attempted — the first failure did not abort the loop.
    expect(ipc.calls.filter(c => c.type === 'start-agent')).toHaveLength(2);
  });

  it('detects cron drift in all three kinds from config.json vs live crons.json', async () => {
    writeEnabledAgents({ muse: { enabled: true } });
    writeAgentConfig('clearworksai', 'muse', {
      crons: [
        { name: 'heartbeat', schedule: '6h', prompt: 'beat' },
        { name: 'digest', schedule: '0 8 * * *', prompt: 'digest' },
      ],
    });
    writeLiveCrons('muse', [
      { name: 'heartbeat', schedule: '12h', prompt: 'beat' },  // schedule-mismatch
      { name: 'rogue', schedule: '30m', prompt: 'rogue' },     // missing-in-config
      // 'digest' absent → missing-in-crons
    ]);
    const ipc = makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 100 }] });

    const report = await runFleetReconcile(baseDeps({ ipc }));

    expect(report.cronDrift).toContainEqual({ agent: 'muse', kind: 'schedule-mismatch', id: 'heartbeat' });
    expect(report.cronDrift).toContainEqual({ agent: 'muse', kind: 'missing-in-crons', id: 'digest' });
    expect(report.cronDrift).toContainEqual({ agent: 'muse', kind: 'missing-in-config', id: 'rogue' });
    expect(report.cronDrift).toHaveLength(3);
  });

  it('appends exactly one valid JSON receipt line per run with all report fields', async () => {
    writeEnabledAgents({ muse: { enabled: true } });
    writeEnvFile({
      BRIEFS_BASE_URL: 'https://briefs.clearworks.ai',
      DASHBOARD_BRIEF_TOKEN: 'tok',
    });
    const ipc = makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 100 }] });

    await runFleetReconcile(baseDeps({ ipc }));
    const afterFirst = readReceipts();
    expect(afterFirst).toHaveLength(1);

    await runFleetReconcile(baseDeps({ ipc: makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 200 }] }) }));
    const afterSecond = readReceipts();
    expect(afterSecond).toHaveLength(2);

    const receipt = afterFirst[0];
    expect(receipt.run_at).toBe('2026-07-03T12:00:00.000Z');
    expect(['post-restart', 'daily', 'manual']).toContain(receipt.trigger);
    expect(receipt.agents).toEqual({
      missing: [],
      restarted: [],
      skipped_disabled: [],
      extra: [],
    });
    expect(Array.isArray(receipt.cronDrift)).toBe(true);
    expect(receipt.briefsCheck).toMatchObject({ ok: true, status: 200 });
    expect(Array.isArray(receipt.errors)).toBe(true);
  });

  it('labels the first run daily, then post-restart when the daemon start moved', async () => {
    writeEnabledAgents({ muse: { enabled: true } });
    const now = () => new Date('2026-07-03T12:00:00.000Z');

    // Run 1: daemon has been up 10h → marker written, trigger daily.
    const first = await runFleetReconcile(baseDeps({
      now,
      ipc: makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 36_000 }] }),
    }));
    expect(first.trigger).toBe('daily');

    // Run 2: same daemon start (same uptime clockwise) → still daily.
    const second = await runFleetReconcile(baseDeps({
      now,
      ipc: makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 36_000 }] }),
    }));
    expect(second.trigger).toBe('daily');

    // Run 3: daemon restarted — uptime collapsed to 60s → post-restart.
    const third = await runFleetReconcile(baseDeps({
      now,
      ipc: makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 60 }] }),
    }));
    expect(third.trigger).toBe('post-restart');

    // Run 4: same fresh daemon → back to daily.
    const fourth = await runFleetReconcile(baseDeps({
      now,
      ipc: makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 60 }] }),
    }));
    expect(fourth.trigger).toBe('daily');
  });

  it('explicit trigger override wins over auto-detection', async () => {
    writeEnabledAgents({});
    const report = await runFleetReconcile(baseDeps({ trigger: 'manual' }));
    expect(report.trigger).toBe('manual');
  });

  it('malformed enabled-agents.json → error recorded, no crash, empty diff', async () => {
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{ not json !!!', 'utf-8');
    const ipc = makeFakeIpc({ statuses: [{ name: 'muse', status: 'running', uptime: 100 }] });

    const report = await runFleetReconcile(baseDeps({ ipc }));

    expect(report.errors.some(e => e.includes('enabled-agents.json'))).toBe(true);
    expect(report.agents.missing).toEqual([]);
    expect(report.agents.skipped_disabled).toEqual([]);
    // Everything running is unregistered against an (effectively) empty registry.
    expect(report.agents.extra).toEqual(['muse']);
    // And the receipt still landed.
    expect(readReceipts()).toHaveLength(1);
  });

  it('briefsCheck failure shape flows through to the receipt', async () => {
    writeEnabledAgents({});
    writeEnvFile({
      BRIEFS_BASE_URL: 'https://briefs.clearworks.ai',
      DASHBOARD_BRIEF_TOKEN: 'tok',
    });
    const report = await runFleetReconcile(baseDeps({ fetcher: async () => 404 }));
    expect(report.briefsCheck.ok).toBe(false);
    expect(report.briefsCheck.status).toBe(404);
    expect(readReceipts()[0].briefsCheck.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Receipt-channel-only guarantee
// ---------------------------------------------------------------------------

describe('no Telegram paths', () => {
  it('the fleet-reconcile module contains zero Telegram send paths', () => {
    const source = readFileSync(
      new URL('../../../src/daemon/fleet-reconcile.ts', import.meta.url),
      'utf-8'
    );
    // No telegram imports, no Telegram API classes, no bus send-telegram.
    expect(source).not.toMatch(/from ['"].*telegram/i);
    expect(source).not.toMatch(/TelegramAPI|TelegramPoller|send-telegram|sendTelegram|sendMessage/);
  });
});
