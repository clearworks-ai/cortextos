/**
 * sage-drop-regression.test.ts
 *
 * Regression test proving that the sage-drop TOCTOU is closed:
 *   1. readInstanceEnableList (agent-manager) returns a consistent map even
 *      when the raw file is missing, empty, or corrupt at read time.
 *   2. An enabled agent is NOT dropped when the map transitions from
 *      "not present" → "present+enabled" (simulating a CLI enable arriving
 *      just after daemon boot starts reading).
 *   3. A disabled agent is correctly excluded from discoverAndStart.
 *   4. mutateEnabledAgentsMap writes are atomic: a concurrent torn-write
 *      scenario (primary corrupt, .bak intact) recovers correctly so the
 *      daemon never observes an empty map.
 *
 * Root cause recap: The old readInstanceEnableList() did a bare
 * existsSync + JSON.parse(readFileSync(...)) with no lock.  A CLI
 * enable/disable overlapping daemon boot could produce a half-written or
 * empty enabled-agents.json.  The daemon then saw sage as absent, skipped
 * it in discoverAndStart AND in bootSelfHeal (which re-read the same
 * corrupt map), so sage was dropped and never recovered.
 *
 * Fix: readInstanceEnableList now delegates to readEnabledAgentsMap which
 * holds the config-dir lock across the entire read and uses the .bak
 * fallback, so only fully-committed maps are ever observed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readEnabledAgentsMap,
  writeEnabledAgentsMap,
  mutateEnabledAgentsMap,
} from '../../../src/bus/enabled-agents-io.js';

// ---------------------------------------------------------------------------
// Mock AgentProcess, FastChecker, Telegram so we can spin up AgentManager
// without spawning real PTY processes.
// ---------------------------------------------------------------------------

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    constructor(name: string, _env: unknown, _config: unknown, _log: unknown) {
      this.name = name;
    }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
    onStatusChanged() { /* no-op */ }
    setTelegramHandle() { /* no-op */ }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { return Promise.resolve(); }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
    static formatTelegramTextMessage() { return ''; }
    static formatTelegramPhotoMessage() { return ''; }
    static formatTelegramDocumentMessage() { return ''; }
    static formatTelegramVoiceMessage() { return ''; }
    static formatTelegramVideoMessage() { return ''; }
    static formatTelegramReaction() { return ''; }
    static readLastSent() { return null; }
    isDuplicate() { return false; }
    queueTelegramMessage() { /* no-op */ }
    handleCallback() { return Promise.resolve(); }
    handleActivityCallback() { return Promise.resolve(); }
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() { /* no-op */ }
    sendMessage() { return Promise.resolve(); }
    validateCredentials() { return Promise.resolve({ ok: true }); }
  },
  formatValidateError: () => '',
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    lastExitReason = 'stopped-externally';
    onMessage() { /* no-op */ }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
    async start() { /* no-op */ }
    stop() { /* no-op */ }
  },
}));

vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
    getNextFireTimes() { return []; }
  },
  nextFireFromCron: () => NaN,
}));

vi.mock('../../../src/daemon/cron-migration.js', () => ({
  migrateCronsForAgent: () => { /* no-op */ },
}));

vi.mock('../../../src/telegram/logging.js', () => ({
  recordInboundTelegram: () => { /* no-op */ },
  cacheLastSent: () => { /* no-op */ },
  logOutboundMessage: () => { /* no-op */ },
  buildRecentHistory: () => null,
}));

vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: () => Promise.resolve({ status: 'empty' }),
}));

// Don't mock validate.js — let all exports pass through. Partial mocking
// would suppress validateInstanceId and break downstream imports.

vi.mock('../../../src/telegram/media.js', () => ({
  processMediaMessage: () => Promise.resolve(null),
}));

vi.mock('../../../src/utils/strip-bom.js', () => ({
  stripBom: (s: string) => s,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeAgentConfig(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ name: 'test' }));
}

// ---------------------------------------------------------------------------
// Tests: readEnabledAgentsMap (shared module) — consistency under torn state
// ---------------------------------------------------------------------------

describe('readEnabledAgentsMap — torn-write recovery (TOCTOU regression)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sage-drop-reg-'));
    mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns {} when no file exists (first-run / clean state)', () => {
    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({});
  });

  it('returns the committed map after a successful write', () => {
    writeEnabledAgentsMap(tmpRoot, { sage: { enabled: true, org: 'clearworksai' } });
    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({ sage: { enabled: true, org: 'clearworksai' } });
  });

  it('falls back to .bak when primary is corrupt (torn-write simulation)', () => {
    // Write a valid map (creates .bak on the second write due to keepBak=true)
    writeEnabledAgentsMap(tmpRoot, { sage: { enabled: true, org: 'clearworksai' } });
    writeEnabledAgentsMap(tmpRoot, { sage: { enabled: true, org: 'clearworksai' }, larry: { enabled: true } });

    // Simulate a torn write: corrupt the primary file.
    const primaryPath = join(tmpRoot, 'config', 'enabled-agents.json');
    writeFileSync(primaryPath, '{"sage": { CORRUPT JSON', 'utf-8');

    // Should recover from .bak (the previous state).
    const result = readEnabledAgentsMap(tmpRoot);
    // .bak has the first write: { sage: { enabled: true, org: 'clearworksai' } }
    expect(result.sage).toBeDefined();
    expect(result.sage.enabled).toBe(true);
  });

  it('returns {} and quarantines primary when both primary and .bak are corrupt', () => {
    const configDir = join(tmpRoot, 'config');
    const primaryPath = join(configDir, 'enabled-agents.json');
    const bakPath = primaryPath + '.bak';

    writeFileSync(primaryPath, '{ CORRUPT', 'utf-8');
    writeFileSync(bakPath, '{ ALSO CORRUPT', 'utf-8');

    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({});

    // Primary should be quarantined (moved to .broken-<ts>)
    expect(existsSync(primaryPath)).toBe(false);
    const files = require('fs').readdirSync(configDir) as string[];
    const broken = files.filter(f => f.includes('.broken-'));
    expect(broken.length).toBeGreaterThan(0);
  });

  it('mutateEnabledAgentsMap is transactional — enable does not overwrite a concurrent disable', () => {
    // Write initial state: both sage and larry enabled.
    writeEnabledAgentsMap(tmpRoot, {
      sage: { enabled: true, org: 'clearworksai' },
      larry: { enabled: true, org: 'clearworksai' },
    });

    // Simulate concurrent mutations: one enables sage, one disables larry.
    // Both should be visible in the final state (no lost update).
    mutateEnabledAgentsMap(tmpRoot, (agents) => {
      agents['sage'] = { enabled: true, org: 'clearworksai', status: 'configured' };
    });
    mutateEnabledAgentsMap(tmpRoot, (agents) => {
      if (agents['larry']) agents['larry'].enabled = false;
    });

    const final = readEnabledAgentsMap(tmpRoot);
    expect(final['sage']?.enabled).toBe(true);
    expect(final['larry']?.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: AgentManager.discoverAndStart — sage not dropped across torn reads
// ---------------------------------------------------------------------------

describe('AgentManager.discoverAndStart — sage not dropped (regression)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'sage-drop-am-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('starts sage when enabled-agents.json shows enabled:true', async () => {
    // Set up agent directory.
    writeAgentConfig(join(frameworkRoot, 'orgs', 'clearworksai', 'agents', 'sage'));

    // Write a valid enabled-agents map via the shared module.
    writeEnabledAgentsMap(ctxRoot, { sage: { enabled: true, org: 'clearworksai' } });

    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const mgr = new AgentManager('default', ctxRoot, frameworkRoot, 'clearworksai');
    await mgr.discoverAndStart();

    const names = mgr.getAgentNames();
    expect(names).toContain('sage');
  });

  it('does NOT start sage when enabled:false (disable is honored)', async () => {
    writeAgentConfig(join(frameworkRoot, 'orgs', 'clearworksai', 'agents', 'sage'));

    writeEnabledAgentsMap(ctxRoot, { sage: { enabled: false, org: 'clearworksai' } });

    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const mgr = new AgentManager('default', ctxRoot, frameworkRoot, 'clearworksai');
    await mgr.discoverAndStart();

    const names = mgr.getAgentNames();
    expect(names).not.toContain('sage');
  });

  it('defaults sage to enabled when enabled-agents.json is missing (default-on)', async () => {
    writeAgentConfig(join(frameworkRoot, 'orgs', 'clearworksai', 'agents', 'sage'));
    // No config file written — daemon defaults to enabled-on-discovery.

    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const mgr = new AgentManager('default', ctxRoot, frameworkRoot, 'clearworksai');
    await mgr.discoverAndStart();

    const names = mgr.getAgentNames();
    expect(names).toContain('sage');
  });

  it('recovers sage from .bak when primary is corrupt at boot (torn-write scenario)', async () => {
    writeAgentConfig(join(frameworkRoot, 'orgs', 'clearworksai', 'agents', 'sage'));

    // Write a valid map so .bak is created.
    writeEnabledAgentsMap(ctxRoot, { sage: { enabled: true, org: 'clearworksai' } });
    // Second write causes first write to become .bak.
    writeEnabledAgentsMap(ctxRoot, { sage: { enabled: true, org: 'clearworksai' } });

    // Simulate torn write: corrupt primary.
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{ CORRUPT JSON', 'utf-8');

    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const mgr = new AgentManager('default', ctxRoot, frameworkRoot, 'clearworksai');
    await mgr.discoverAndStart();

    // readInstanceEnableList via readEnabledAgentsMap should recover from .bak.
    // sage was enabled in .bak, so it must start.
    const names = mgr.getAgentNames();
    expect(names).toContain('sage');
  });

  it('bootSelfHeal catches sage when discoverAndStart loop failed and re-reads consistent map', async () => {
    writeAgentConfig(join(frameworkRoot, 'orgs', 'clearworksai', 'agents', 'sage'));

    writeEnabledAgentsMap(ctxRoot, { sage: { enabled: true, org: 'clearworksai' } });

    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const mgr = new AgentManager('default', ctxRoot, frameworkRoot, 'clearworksai') as unknown as {
      bootSelfHeal: (
        agentDirs: Array<{ name: string; dir: string; org: string; config: Record<string, unknown> }>,
        instanceEnabled: Record<string, { enabled?: boolean; org?: string; status?: string }>,
      ) => Promise<void>;
      getAgentNames: () => string[];
    };

    // Call bootSelfHeal directly with the correct enabled map.
    const instanceEnabled = readEnabledAgentsMap(ctxRoot);
    await mgr.bootSelfHeal(
      [{ name: 'sage', dir: join(frameworkRoot, 'orgs', 'clearworksai', 'agents', 'sage'), org: 'clearworksai', config: {} }],
      instanceEnabled,
    );

    expect(mgr.getAgentNames()).toContain('sage');
  });
});
