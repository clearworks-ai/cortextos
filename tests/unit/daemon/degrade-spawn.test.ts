/**
 * WS8 Layer A — fleet-degrade failover spawn-path tests.
 *
 * Verifies that agent-process.ts correctly:
 *   (a) Leaves the spawn unchanged when the degrade marker is absent.
 *   (b) Degrades to opencode + glm-5.2 when marker present + degrade_ok:true + degrade_tier:'reasoning'.
 *   (c) Degrades to opencode + glm-4.7-flash when degrade_tier:'mechanical'.
 *   (d) Does NOT degrade when degrade_ok is absent (conservative default).
 *   (e) Returns to the configured model when the marker is cleared.
 *
 * Strategy: mock `fs` (existsSync + readFileSync) so we can simulate the
 * marker file being present/absent, and mock the PTY constructors to capture
 * which config was passed. We never touch disk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// PTY constructor spies. We capture the config argument so we can assert
// which runtime + model the spawn path chose.
// ---------------------------------------------------------------------------
let lastAgentPtyConfig: Record<string, unknown> | null = null;
let lastOpencodePtyConfig: Record<string, unknown> | null = null;

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

function makeMockPty(label: string) {
  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    write: vi.fn(),
    getPid: vi.fn().mockReturnValue(label === 'opencode' ? 22222 : 11111),
    isAlive: vi.fn().mockReturnValue(true),
    onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
      capturedOnExit = cb;
    }),
    getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
    setTelegramHandle: vi.fn(),
  };
}

const mockAgentPtyInstance = makeMockPty('claude');
const mockOpencodePtyInstance = makeMockPty('opencode');

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY(_env: unknown, config: Record<string, unknown>) {
    lastAgentPtyConfig = config;
    return mockAgentPtyInstance;
  },
}));

vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY(_env: unknown, config: Record<string, unknown>) {
    lastOpencodePtyConfig = config;
    return mockOpencodePtyInstance;
  },
  opencodeSessionExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockAgentPtyInstance; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPtyInstance; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// fs mock — controls existsSync + readFileSync so we can simulate the
// fleet-degrade.json marker being present or absent.
// ---------------------------------------------------------------------------
const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    closeSync: vi.fn(),
    openSync: vi.fn(),
    readSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

// ---------------------------------------------------------------------------
// Shared test env. frameworkRoot is where the daemon looks for the marker:
//   <frameworkRoot>/orgs/clearworksai/agents/larry/state/fleet-degrade.json
// ---------------------------------------------------------------------------
const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'frank2',
  agentDir: '/tmp/fw/orgs/clearworksai/agents/frank2',
  org: 'clearworksai',
  projectRoot: '/tmp/fw',
};

const DEGRADE_MARKER_PATH =
  '/tmp/fw/orgs/clearworksai/agents/larry/state/fleet-degrade.json';

const DEPLETED_MARKER = JSON.stringify({
  anthropic: 'DEPLETED',
  since: '2026-07-04T00:00:00Z',
  degrade_map: {
    reasoning: 'openrouter/z-ai/glm-5.2',
    mechanical: 'openrouter/z-ai/glm-4.7-flash',
  },
  failover_runtime: 'opencode',
});

beforeEach(() => {
  capturedOnExit = null;
  lastAgentPtyConfig = null;
  lastOpencodePtyConfig = null;

  for (const pty of [mockAgentPtyInstance, mockOpencodePtyInstance]) {
    pty.spawn.mockClear();
    pty.kill.mockClear();
    pty.write.mockClear();
    pty.getPid.mockClear();
    pty.isAlive.mockReset().mockReturnValue(true);
    pty.onExit.mockClear();
    pty.getOutputBuffer.mockClear();
  }

  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset().mockReturnValue('');
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.unlinkSync.mockReset();
});

// Helper: configure fsMocks so the degrade marker appears to exist and be readable.
function activateDegradeMarker() {
  fsMocks.existsSync.mockImplementation((path: unknown) => {
    return path === DEGRADE_MARKER_PATH;
  });
  fsMocks.readFileSync.mockImplementation((path: unknown) => {
    if (path === DEGRADE_MARKER_PATH) return DEPLETED_MARKER;
    return '';
  });
}

// Helper: configure fsMocks so the degrade marker does not exist.
function clearDegradeMarker() {
  fsMocks.existsSync.mockImplementation((path: unknown) => {
    return path !== DEGRADE_MARKER_PATH;
  });
}

// ---------------------------------------------------------------------------
// (a) Marker absent → claude-code agent launches with its configured model.
// ---------------------------------------------------------------------------
describe('WS8 Layer A — degrade-spawn', () => {
  it('(a) marker absent → AgentPTY spawned with configured claude model, no degrade', async () => {
    clearDegradeMarker();

    const ap = new AgentProcess('frank2', mockEnv, {
      model: 'claude-sonnet-5',
      // degrade_ok intentionally absent
    });
    await ap.start();

    expect(lastAgentPtyConfig).not.toBeNull();
    expect(lastOpencodePtyConfig).toBeNull();
    expect(lastAgentPtyConfig?.model).toBe('claude-sonnet-5');
    expect(lastAgentPtyConfig?.runtime).toBeUndefined(); // unset = claude-code default
  });

  // ---------------------------------------------------------------------------
  // (b) Marker present + degrade_ok:true + degrade_tier:'reasoning' → opencode + glm-5.2
  // ---------------------------------------------------------------------------
  it('(b) marker present + degrade_ok:true + degrade_tier:reasoning → OpencodePTY + glm-5.2', async () => {
    activateDegradeMarker();

    const ap = new AgentProcess('frank2', mockEnv, {
      model: 'claude-sonnet-5',
      degrade_ok: true,
      degrade_tier: 'reasoning',
    });
    await ap.start();

    expect(lastOpencodePtyConfig).not.toBeNull();
    expect(lastAgentPtyConfig).toBeNull();
    expect(lastOpencodePtyConfig?.model).toBe('openrouter/z-ai/glm-5.2');
    expect(lastOpencodePtyConfig?.runtime).toBe('opencode');
  });

  // ---------------------------------------------------------------------------
  // (c) Marker present + degrade_ok:true + degrade_tier:'mechanical' → opencode + glm-4.7-flash
  // ---------------------------------------------------------------------------
  it('(c) marker present + degrade_ok:true + degrade_tier:mechanical → OpencodePTY + glm-4.7-flash', async () => {
    activateDegradeMarker();

    const ap = new AgentProcess('muse', mockEnv, {
      model: 'claude-sonnet-5',
      degrade_ok: true,
      degrade_tier: 'mechanical',
    });
    await ap.start();

    expect(lastOpencodePtyConfig).not.toBeNull();
    expect(lastAgentPtyConfig).toBeNull();
    expect(lastOpencodePtyConfig?.model).toBe('openrouter/z-ai/glm-4.7-flash');
    expect(lastOpencodePtyConfig?.runtime).toBe('opencode');
  });

  // ---------------------------------------------------------------------------
  // (d) Marker present but agent has NO degrade_ok → NOT degraded (conservative default).
  // ---------------------------------------------------------------------------
  it('(d) marker present but degrade_ok absent → AgentPTY, no degrade (conservative default)', async () => {
    activateDegradeMarker();

    const ap = new AgentProcess('larry', mockEnv, {
      model: 'claude-opus-4-8',
      // degrade_ok intentionally absent — larry should never degrade
    });
    await ap.start();

    expect(lastAgentPtyConfig).not.toBeNull();
    expect(lastOpencodePtyConfig).toBeNull();
    expect(lastAgentPtyConfig?.model).toBe('claude-opus-4-8');
  });

  // ---------------------------------------------------------------------------
  // (e) Marker cleared → next spawn returns to configured model.
  //
  // Tests self-heal round-trip by spinning up a fresh AgentProcess once the
  // marker is gone — proves the change is per-spawn (read-only against marker),
  // not sticky to a running process. We avoid calling stop() here because the
  // mock PTY never fires onExit, which would cause stop() to hang for 10s.
  // ---------------------------------------------------------------------------
  it('(e) marker cleared → fresh spawn uses AgentPTY with configured model (self-heal)', async () => {
    // First: marker active → spawn is degraded.
    activateDegradeMarker();

    const ap1 = new AgentProcess('frank2', mockEnv, {
      model: 'claude-sonnet-5',
      degrade_ok: true,
      degrade_tier: 'reasoning',
    });
    await ap1.start();
    expect(lastOpencodePtyConfig).not.toBeNull();
    expect(lastOpencodePtyConfig?.model).toBe('openrouter/z-ai/glm-5.2');

    // Reset spy tracking.
    lastAgentPtyConfig = null;
    lastOpencodePtyConfig = null;
    capturedOnExit = null;
    mockAgentPtyInstance.onExit.mockClear();
    mockOpencodePtyInstance.onExit.mockClear();
    mockAgentPtyInstance.spawn.mockClear();
    mockOpencodePtyInstance.spawn.mockClear();

    // Clear the marker (simulates ALERT_RECOVER deleting fleet-degrade.json).
    clearDegradeMarker();

    // Second: fresh AgentProcess with same config, marker now absent → no degrade.
    const ap2 = new AgentProcess('frank2', mockEnv, {
      model: 'claude-sonnet-5',
      degrade_ok: true,
      degrade_tier: 'reasoning',
    });
    await ap2.start();
    expect(lastAgentPtyConfig).not.toBeNull();
    expect(lastOpencodePtyConfig).toBeNull();
    expect(lastAgentPtyConfig?.model).toBe('claude-sonnet-5');
  });
});
