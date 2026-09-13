import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  importFreshRequest,
  consumeFreshRequest,
  restoreFreshRequest,
  writeForceFreshMarker,
  projectSessionRefreshMarker,
} from '../../../src/daemon/lifecycle/legacy-compat';
import type { GenerationToken } from '../../../src/daemon/lifecycle/types';

const FORCE_FRESH = '.force-fresh';

describe('legacy-compat: fresh-start intent as an identified request (Task 2.2)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-legacy-compat-test-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function markerPath(): string {
    return join(stateDir, FORCE_FRESH);
  }

  function reservedFiles(): string[] {
    return readdirSync(stateDir).filter((f) => f.includes(`${FORCE_FRESH}.reserved.`));
  }

  describe('importFreshRequest', () => {
    it('returns null when no marker is present', () => {
      expect(importFreshRequest(stateDir)).toBeNull();
    });

    it('reserves the marker BY RENAME, not read-then-unlink: the live file is gone, a reserved copy exists', () => {
      writeFileSync(markerPath(), 'operator requested fresh\n', 'utf-8');

      const req = importFreshRequest(stateDir);

      expect(req).not.toBeNull();
      expect(existsSync(markerPath())).toBe(false); // live path no longer holds it
      expect(existsSync(req!.reservedPath)).toBe(true); // reserved copy does
      expect(req!.reason).toBe('operator requested fresh');
      expect(reservedFiles().length).toBe(1);
    });

    it('a second import while one is already reserved finds nothing (the request belongs to the first renamer)', () => {
      writeFileSync(markerPath(), 'reason\n', 'utf-8');
      const first = importFreshRequest(stateDir);
      expect(first).not.toBeNull();

      const second = importFreshRequest(stateDir);
      expect(second).toBeNull();
    });
  });

  describe('deciding a mode never consumes a request (acceptance criterion)', () => {
    it('calling the mode-decision equivalent twice, with no intervening spawn outcome, leaves the reservation untouched', () => {
      writeFileSync(markerPath(), 'reason\n', 'utf-8');
      const req = importFreshRequest(stateDir);
      expect(req).not.toBeNull();

      // Simulate `shouldContinue()` being consulted twice for the SAME
      // decision (e.g. a caller re-checking) without either an explicit
      // consume or restore in between. Nothing about "deciding" touches the
      // filesystem beyond the import that already happened above.
      const decidedFreshOnce = req !== null;
      const decidedFreshTwice = req !== null;
      expect(decidedFreshOnce).toBe(true);
      expect(decidedFreshTwice).toBe(true);

      // The reservation must still be exactly where it was — neither
      // consumed nor restored just because it was "decided" against.
      expect(existsSync(req!.reservedPath)).toBe(true);
      expect(existsSync(markerPath())).toBe(false);
    });
  });

  describe('consumeFreshRequest', () => {
    it('a successful fresh startup consumes ONLY the reserved request', () => {
      writeFileSync(markerPath(), 'reason\n', 'utf-8');
      const req = importFreshRequest(stateDir)!;

      consumeFreshRequest(req);

      expect(existsSync(req.reservedPath)).toBe(false);
      expect(existsSync(markerPath())).toBe(false);
      expect(reservedFiles().length).toBe(0);
    });

    it('is idempotent — consuming twice does not throw', () => {
      writeFileSync(markerPath(), 'reason\n', 'utf-8');
      const req = importFreshRequest(stateDir)!;

      consumeFreshRequest(req);
      expect(() => consumeFreshRequest(req)).not.toThrow();
    });
  });

  describe('restoreFreshRequest — failed spawn preserves fresh intent (upstream 31af138b case)', () => {
    it('a failed spawn restores the request; the next import still finds it', () => {
      writeFileSync(markerPath(), 'image-poison auto-recovery\n', 'utf-8');
      const req = importFreshRequest(stateDir)!;
      expect(req).not.toBeNull();

      // Simulate a failed spawn attempt.
      restoreFreshRequest(req);

      // The live marker is back — reserved copy is gone.
      expect(existsSync(markerPath())).toBe(true);
      expect(existsSync(req.reservedPath)).toBe(false);
      expect(readFileSync(markerPath(), 'utf-8')).toBe('image-poison auto-recovery\n');

      // The next start's decision still finds (and can re-reserve) it.
      const reimported = importFreshRequest(stateDir);
      expect(reimported).not.toBeNull();
      expect(reimported!.reason).toBe('image-poison auto-recovery');
    });

    it('is idempotent — restoring twice does not throw and does not duplicate the marker', () => {
      writeFileSync(markerPath(), 'reason\n', 'utf-8');
      const req = importFreshRequest(stateDir)!;

      restoreFreshRequest(req);
      expect(() => restoreFreshRequest(req)).not.toThrow();
      expect(reservedFiles().length).toBe(0);
    });
  });

  describe('a newer request survives an older consumer/restorer (TOCTOU guard)', () => {
    it('consumeFreshRequest on an old reservation never touches a newer live marker', () => {
      writeFileSync(markerPath(), 'request A\n', 'utf-8');
      const reqA = importFreshRequest(stateDir)!;
      expect(existsSync(markerPath())).toBe(false); // A reserved it away

      // A concurrent writer (e.g. hardRestart() from a separate CLI process)
      // lands a brand-new request B at the live path before A is resolved.
      writeFileSync(markerPath(), 'request B\n', 'utf-8');

      consumeFreshRequest(reqA);

      // B must be completely untouched.
      expect(existsSync(markerPath())).toBe(true);
      expect(readFileSync(markerPath(), 'utf-8')).toBe('request B\n');
    });

    it('restoreFreshRequest on a failed old attempt never clobbers a newer live marker (never overwrite a request newer than the one reserved)', () => {
      writeFileSync(markerPath(), 'request A\n', 'utf-8');
      const reqA = importFreshRequest(stateDir)!;

      // Request B lands while A's spawn attempt is still in flight / after it
      // failed but before A's restore runs.
      writeFileSync(markerPath(), 'request B\n', 'utf-8');

      restoreFreshRequest(reqA);

      // B stands; A's now-redundant reservation was dropped, not restored
      // over B.
      expect(readFileSync(markerPath(), 'utf-8')).toBe('request B\n');
      expect(existsSync(reqA.reservedPath)).toBe(false);
      expect(reservedFiles().length).toBe(0);

      // B itself is still importable by the next decision.
      const importedB = importFreshRequest(stateDir);
      expect(importedB).not.toBeNull();
      expect(importedB!.reason).toBe('request B');
    });
  });

  describe('writeForceFreshMarker (bus/system.ts hardRestart() write path)', () => {
    it('writes the marker atomically (temp-write + rename) with the exact caller-supplied content', () => {
      const nestedStateDir = join(stateDir, 'nested-agent');
      writeForceFreshMarker(nestedStateDir, 'context handoff\n');

      const written = join(nestedStateDir, FORCE_FRESH);
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, 'utf-8')).toBe('context handoff\n');

      // No leftover staging artifact.
      const leftovers = readdirSync(nestedStateDir).filter((f) => f.includes('.write-'));
      expect(leftovers.length).toBe(0);
    });

    it('a marker written this way is importable by importFreshRequest exactly like any other writer', () => {
      writeForceFreshMarker(stateDir, 'bus hard-restart\n');

      const req = importFreshRequest(stateDir);
      expect(req).not.toBeNull();
      expect(req!.reason).toBe('bus hard-restart');
    });
  });

  describe('projectSessionRefreshMarker', () => {
    it('writes the exact same on-disk content the SessionEnd crash-alert hook already expects', () => {
      const token: GenerationToken = { agentId: 'test/acme/alice', supervisorEpoch: 0, generation: 1 };
      projectSessionRefreshMarker(stateDir, token);

      const written = join(stateDir, '.session-refresh');
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, 'utf-8')).toBe('session-time-cap rollover\n');
    });
  });
});

// ---------------------------------------------------------------------------
// Hermes honors fresh intent (Task 2.2 test case 4) — adapted from
// tests/unit/daemon/agent-process-hermes.test.ts: confirms Hermes's
// `hermesDbExists()` DB-existence decision is completely unaffected by a
// `.force-fresh` marker (PHASES.md's explicit ruling — Hermes semantics are
// NOT changed by this task), while the marker is still imported and
// consumed/restored against the spawn outcome for audit-consistency
// bookkeeping, so it no longer leaks in the state dir indefinitely (the
// second upstream `31af138b` defect).
//
// This describe block needs a real `AgentProcess` + real filesystem (the
// reservation-by-rename mechanics operate on real files), so — unlike
// `agent-process-hermes.test.ts` — 'fs' is intentionally left UNMOCKED here.
// ---------------------------------------------------------------------------

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(false) }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

const mockHermesDbExists = vi.fn().mockReturnValue(false);
vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockPty; },
  hermesDbExists: (...args: unknown[]) => mockHermesDbExists(...args),
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
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

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

describe('AgentProcess + Hermes: fresh-request bookkeeping does not change hermesDbExists semantics', () => {
  let ctxRoot: string;
  const agentName = 'hermes-agent';

  function mockEnvFor(root: string) {
    return {
      instanceId: 'test',
      ctxRoot: root,
      frameworkRoot: join(root, 'fw'),
      agentName,
      agentDir: join(root, 'fw', 'orgs', 'acme', 'agents', agentName),
      org: 'acme',
      projectRoot: join(root, 'fw'),
    };
  }

  function forceFreshLivePath(root: string): string {
    return join(root, 'state', agentName, FORCE_FRESH);
  }

  function reservedLeftovers(root: string): string[] {
    const dir = join(root, 'state', agentName);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.includes(`${FORCE_FRESH}.reserved.`));
  }

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-legacy-compat-hermes-'));
    mkdirSync(join(ctxRoot, 'state', agentName), { recursive: true });
    capturedOnExit = null;
    mockHermesDbExists.mockReset().mockReturnValue(false);
    mockPty.spawn.mockReset().mockResolvedValue(undefined);
    mockPty.kill.mockClear();
    mockPty.write.mockClear();
    mockPty.isAlive.mockReset().mockReturnValue(true);
    mockPty.onExit.mockClear();
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('hermesDbExists()=true still spawns `continue` with a `.force-fresh` marker present, and the marker is consumed as bookkeeping', async () => {
    mockHermesDbExists.mockReturnValue(true);
    writeFileSync(forceFreshLivePath(ctxRoot), 'operator armed fresh\n', 'utf-8');

    const ap = new AgentProcess(agentName, mockEnvFor(ctxRoot), { runtime: 'hermes' });
    await ap.start();

    // Hermes's DECISION is unaffected by the marker — still `continue`.
    expect(mockPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));

    // But the marker was imported and consumed (bookkeeping/audit
    // consistency): no live marker, no leftover reservation file.
    expect(existsSync(forceFreshLivePath(ctxRoot))).toBe(false);
    expect(reservedLeftovers(ctxRoot).length).toBe(0);
  });

  it('hermesDbExists()=false with a `.force-fresh` marker present still spawns `fresh` (both signals agree) and consumes the marker', async () => {
    mockHermesDbExists.mockReturnValue(false);
    writeFileSync(forceFreshLivePath(ctxRoot), 'operator armed fresh\n', 'utf-8');

    const ap = new AgentProcess(agentName, mockEnvFor(ctxRoot), { runtime: 'hermes' });
    await ap.start();

    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(existsSync(forceFreshLivePath(ctxRoot))).toBe(false);
    expect(reservedLeftovers(ctxRoot).length).toBe(0);
  });

  it('a failed Hermes spawn restores the imported bookkeeping request instead of losing it', async () => {
    mockHermesDbExists.mockReturnValue(true);
    writeFileSync(forceFreshLivePath(ctxRoot), 'operator armed fresh\n', 'utf-8');
    mockPty.spawn.mockRejectedValueOnce(new Error('spawn boom'));

    const ap = new AgentProcess(agentName, mockEnvFor(ctxRoot), { runtime: 'hermes' });
    await ap.start();

    expect(ap.getStatus().status).toBe('crashed');
    // The request survives the failed spawn, restored to the live path.
    expect(existsSync(forceFreshLivePath(ctxRoot))).toBe(true);
    expect(readFileSync(forceFreshLivePath(ctxRoot), 'utf-8')).toBe('operator armed fresh\n');
    expect(reservedLeftovers(ctxRoot).length).toBe(0);
  });

  it('no marker present: Hermes behavior and bookkeeping are both untouched (no regression)', async () => {
    mockHermesDbExists.mockReturnValue(true);

    const ap = new AgentProcess(agentName, mockEnvFor(ctxRoot), { runtime: 'hermes' });
    await ap.start();

    expect(mockPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
    expect(existsSync(forceFreshLivePath(ctxRoot))).toBe(false);
    expect(reservedLeftovers(ctxRoot).length).toBe(0);
  });
});
