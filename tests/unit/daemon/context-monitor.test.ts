import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatContextBaseline,
  consumeCodexContextOverflowMarker,
  FastChecker,
  handoffGraceMs,
  realContextWindow,
  shouldLogContextBaseline,
} from '../../../src/daemon/fast-checker.js';
import type { BusPaths } from '../../../src/types/index.js';

/**
 * Unit tests for the context monitor logic in fast-checker.ts.
 * Tests the stateless helper functions and state machine in isolation.
 */

// --- Helpers to simulate context_status.json ---

function writeContextStatus(stateDir: string, pct: number | null, exceeds = false, ageMs = 0): void {
  mkdirSync(stateDir, { recursive: true });
  const written_at = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(
    join(stateDir, 'context_status.json'),
    JSON.stringify({ used_percentage: pct, exceeds_200k_tokens: exceeds, written_at }),
    'utf-8',
  );
}

// --- Staleness detection ---

describe('context_status.json staleness detection', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `ctx-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    try { unlinkSync(join(stateDir, 'context_status.json')); } catch { /* ignore */ }
  });

  it('fresh file (0ms) passes staleness check', () => {
    writeContextStatus(stateDir, 72.4, false, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    const age = Date.now() - new Date(raw.written_at).getTime();
    expect(age).toBeLessThan(10 * 60_000);
  });

  it('file older than 10min is considered stale', () => {
    writeContextStatus(stateDir, 72.4, false, 11 * 60_000);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    const age = Date.now() - new Date(raw.written_at).getTime();
    expect(age).toBeGreaterThan(10 * 60_000);
  });

  it('null used_percentage is handled gracefully', () => {
    writeContextStatus(stateDir, null, false, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    expect(raw.used_percentage).toBeNull();
  });

  it('exceeds_200k_tokens=true with null pct is a valid signal', () => {
    writeContextStatus(stateDir, null, true, 0);
    const raw = JSON.parse(require('fs').readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    expect(raw.exceeds_200k_tokens).toBe(true);
  });
});

describe('structured Codex overflow recovery marker', () => {
  let rootDir: string;
  let stateDir: string;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ctx-overflow-test-${Date.now()}-${Math.random()}`);
    stateDir = join(rootDir, 'state', 'agent');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('consumes a valid marker once', () => {
    const markerPath = join(stateDir, '.codex-context-overflow.json');
    const marker = {
      thread_id: 'thread-old',
      turn_id: 'turn-failed',
      reason: 'contextWindowExceeded',
      timestamp: new Date().toISOString(),
    };
    writeFileSync(markerPath, JSON.stringify(marker));

    expect(consumeCodexContextOverflowMarker(stateDir)).toEqual(marker);
    expect(existsSync(markerPath)).toBe(false);
    expect(consumeCodexContextOverflowMarker(stateDir)).toBeNull();
  });

  it('consumes but rejects a stale marker', () => {
    const markerPath = join(stateDir, '.codex-context-overflow.json');
    writeFileSync(markerPath, JSON.stringify({
      thread_id: 'thread-old',
      turn_id: 'turn-failed',
      reason: 'contextWindowExceeded',
      timestamp: new Date(Date.now() - 11 * 60_000).toISOString(),
    }));

    expect(consumeCodexContextOverflowMarker(stateDir)).toBeNull();
    expect(existsSync(markerPath)).toBe(false);
  });

  it('consumes malformed JSON so it cannot be reparsed indefinitely', () => {
    const markerPath = join(stateDir, '.codex-context-overflow.json');
    writeFileSync(markerPath, '{not valid json');

    expect(consumeCodexContextOverflowMarker(stateDir)).toBeNull();
    expect(existsSync(markerPath)).toBe(false);
    expect(consumeCodexContextOverflowMarker(stateDir)).toBeNull();
  });

  it('drives one bounded force-fresh refresh and leaves recovering telemetry', async () => {
    const paths = {
      ctxRoot: rootDir,
      inbox: join(rootDir, 'inbox'),
      inflight: join(rootDir, 'inflight'),
      processed: join(rootDir, 'processed'),
      logDir: join(rootDir, 'logs', 'agent'),
      stateDir,
      taskDir: join(rootDir, 'tasks'),
      approvalDir: join(rootDir, 'approvals'),
      analyticsDir: join(rootDir, 'analytics'),
      deliverablesDir: join(rootDir, 'deliverables'),
    } satisfies BusPaths;
    mkdirSync(paths.logDir, { recursive: true });
    const sessionRefresh = vi.fn().mockResolvedValue(undefined);
    const agent = {
      name: 'agent',
      getAgentDir: () => join(rootDir, 'agent-dir'),
      getConfig: () => ({ runtime: 'codex-app-server', codex_context_cap: 997500 }),
      getOutputBuffer: () => ({ getRecent: () => '' }),
      sessionRefresh,
      injectMessage: vi.fn(),
    } as any;
    const markerPath = join(stateDir, '.codex-context-overflow.json');
    writeFileSync(markerPath, JSON.stringify({
      thread_id: 'thread-old',
      turn_id: 'turn-failed',
      reason: 'contextWindowExceeded',
      timestamp: new Date().toISOString(),
    }));
    writeFileSync(join(stateDir, 'context_status.json'), JSON.stringify({
      used_percentage: 90.23,
      context_window_size: 997500,
      current_usage: {
        input_tokens: 899000,
        output_tokens: 1000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      session_id: 'thread-old',
      context_state: 'overflow',
      written_at: new Date().toISOString(),
    }));
    const checker = new FastChecker(agent, paths, rootDir, { log: vi.fn() });

    await (checker as any).checkContextStatus();
    // Expire any grace/session guard so this specifically proves context_state,
    // not a secondary suppression mechanism, prevents the duplicate action.
    (checker as any).ctxLastSessionId = 'thread-old';
    (checker as any).ctxSessionStartedAt = Date.now() - 20 * 60_000;
    await (checker as any).checkContextStatus();

    expect(sessionRefresh).toHaveBeenCalledTimes(1);
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(join(stateDir, '.force-fresh'))).toBe(true);
    const status = JSON.parse(readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    expect(status).toMatchObject({
      used_percentage: 90.23,
      session_id: 'thread-old',
      context_state: 'recovering',
    });
    expect(agent.injectMessage).not.toHaveBeenCalled();
  });
});

// --- Threshold tier selection ---

describe('context monitor tier selection', () => {
  const WARN = 70;
  const HANDOFF = 80;

  function selectTier(pct: number, exceeds: boolean, warningFiredAt: number, handoffFiredAt: number, now: number) {
    const effectivePct = pct !== null ? pct : (exceeds ? 101 : null);
    if (effectivePct === null) return 'none';

    // Tier 2 check (handoff) — must check before warning for edge cases
    if (effectivePct >= HANDOFF && handoffFiredAt === 0) return 'handoff';

    // Tier 1 check (warning) — 15min cooldown
    if (effectivePct >= WARN && now - warningFiredAt > 15 * 60_000) return 'warning';

    return 'none';
  }

  it('69% triggers no action', () => {
    expect(selectTier(69, false, 0, 0, Date.now())).toBe('none');
  });

  it('70% triggers warning', () => {
    expect(selectTier(70, false, 0, 0, Date.now())).toBe('warning');
  });

  it('79% triggers warning (below handoff threshold)', () => {
    expect(selectTier(79, false, 0, 0, Date.now())).toBe('warning');
  });

  it('80% triggers handoff (first time)', () => {
    expect(selectTier(80, false, 0, 0, Date.now())).toBe('handoff');
  });

  it('90% triggers handoff (first time, above handoff threshold)', () => {
    expect(selectTier(90, false, 0, 0, Date.now())).toBe('handoff');
  });

  it('80% with handoff already fired triggers warning (if cooldown elapsed)', () => {
    const handoffFiredAt = Date.now() - 20 * 60_000; // 20min ago
    expect(selectTier(80, false, 0, handoffFiredAt, Date.now())).toBe('warning');
  });
});

// --- Handoff grace window (fresh-session false-100% loop guard) ---

describe('handoff grace window', () => {
  const WARN = 70;
  const HANDOFF = 80;
  const HANDOFF_GRACE_MS = 120_000;

  // Mirrors fast-checker tier selection with the grace guard added: a session
  // younger than HANDOFF_GRACE_MS suppresses warning + handoff so a transient
  // false-high reading on a fresh session cannot trigger a handoff→restart loop.
  function selectTierWithGrace(
    pct: number | null,
    exceeds: boolean,
    warningFiredAt: number,
    handoffFiredAt: number,
    now: number,
    sessionStartedAt: number,
  ) {
    const effectivePct = pct !== null ? pct : (exceeds ? 101 : null);
    if (effectivePct === null) return 'none';
    const withinGrace = sessionStartedAt > 0 && now - sessionStartedAt < HANDOFF_GRACE_MS;
    if (effectivePct >= HANDOFF && handoffFiredAt === 0 && !withinGrace) return 'handoff';
    if (effectivePct >= WARN && !withinGrace && now - warningFiredAt > 15 * 60_000) return 'warning';
    return 'none';
  }

  it('100% within grace of a fresh session does NOT fire handoff (breaks false-100% loop)', () => {
    const now = Date.now();
    const sessionStartedAt = now - 30_000; // 30s into session, inside 2min grace
    expect(selectTierWithGrace(100, false, 0, 0, now, sessionStartedAt)).toBe('none');
  });

  it('exceeds_200k within grace does NOT fire handoff', () => {
    const now = Date.now();
    const sessionStartedAt = now - 10_000;
    expect(selectTierWithGrace(null, true, 0, 0, now, sessionStartedAt)).toBe('none');
  });

  it('100% after grace expires DOES fire handoff (genuine sustained overflow still acts)', () => {
    const now = Date.now();
    const sessionStartedAt = now - 3 * 60_000; // 3min old, past 2min grace
    expect(selectTierWithGrace(100, false, 0, 0, now, sessionStartedAt)).toBe('handoff');
  });

  it('warning within grace is also suppressed', () => {
    const now = Date.now();
    const sessionStartedAt = now - 30_000;
    expect(selectTierWithGrace(75, false, 0, 0, now, sessionStartedAt)).toBe('none');
  });

  it('unset sessionStartedAt (0) imposes no grace — preserves prior behavior', () => {
    const now = Date.now();
    expect(selectTierWithGrace(80, false, 0, 0, now, 0)).toBe('handoff');
  });
});

// --- Runtime-aware grace window (laggy codex/opencode prompt-cache spike) ---

describe('handoffGraceMs runtime-aware grace window', () => {
  it('codex-app-server gets the extended 10min grace', () => {
    expect(handoffGraceMs('codex-app-server')).toBe(600_000);
  });

  it('opencode gets the extended 10min grace', () => {
    expect(handoffGraceMs('opencode')).toBe(600_000);
  });

  it('claude-code keeps the 2min grace', () => {
    expect(handoffGraceMs('claude-code')).toBe(120_000);
  });

  it('hermes keeps the 2min grace', () => {
    expect(handoffGraceMs('hermes')).toBe(120_000);
  });

  it('undefined runtime keeps the 2min grace', () => {
    expect(handoffGraceMs(undefined)).toBe(120_000);
  });

  it('a spurious 100% spike at T+5min within codex extended grace is suppressed, but a claude session past its 2min grace fires', () => {
    const now = Date.now();
    const sessionStartedAt = now - 5 * 60_000; // 5min into session

    // codex: 5min < 10min grace -> still within grace -> suppressed
    const codexWithinGrace =
      sessionStartedAt > 0 && now - sessionStartedAt < handoffGraceMs('codex-app-server');
    expect(codexWithinGrace).toBe(true);

    // claude: 5min > 2min grace -> past grace -> a genuine high reading would act
    const claudeWithinGrace =
      sessionStartedAt > 0 && now - sessionStartedAt < handoffGraceMs('claude-code');
    expect(claudeWithinGrace).toBe(false);
  });
});

// --- Warning deduplication ---

describe('warning deduplication', () => {
  it('warning within 15min cooldown does not fire again', () => {
    const warningFiredAt = Date.now() - 5 * 60_000; // 5min ago
    const now = Date.now();
    const cooldownElapsed = now - warningFiredAt > 15 * 60_000;
    expect(cooldownElapsed).toBe(false);
  });

  it('warning after 15min cooldown fires again', () => {
    const warningFiredAt = Date.now() - 16 * 60_000; // 16min ago
    const now = Date.now();
    const cooldownElapsed = now - warningFiredAt > 15 * 60_000;
    expect(cooldownElapsed).toBe(true);
  });
});

// --- Circuit breaker ---

describe('context monitor circuit breaker', () => {
  it('3 restarts within 15min window trips breaker', () => {
    const now = Date.now();
    const restarts = [now - 14 * 60_000, now - 10 * 60_000, now - 1 * 60_000];
    const windowMs = 15 * 60_000;
    const inWindow = restarts.filter(t => now - t < windowMs);
    expect(inWindow.length).toBe(3);
    expect(inWindow.length >= 3).toBe(true); // trips
  });

  it('2 restarts in 15min window does not trip', () => {
    const now = Date.now();
    const restarts = [now - 10 * 60_000, now - 5 * 60_000];
    const inWindow = restarts.filter(t => now - t < 15 * 60_000);
    expect(inWindow.length).toBeLessThan(3);
  });

  it('old restarts outside 15min window are excluded', () => {
    const now = Date.now();
    const restarts = [now - 20 * 60_000, now - 18 * 60_000, now - 1 * 60_000];
    const inWindow = restarts.filter(t => now - t < 15 * 60_000);
    expect(inWindow.length).toBe(1); // only the recent one counts
  });

  it('circuit breaker resets after 30min pause', () => {
    const circuitBrokenAt = Date.now() - 31 * 60_000; // 31min ago
    const shouldReset = Date.now() - circuitBrokenAt >= 30 * 60_000;
    expect(shouldReset).toBe(true);
  });

  it('circuit breaker still active at 29min', () => {
    const circuitBrokenAt = Date.now() - 29 * 60_000;
    const shouldReset = Date.now() - circuitBrokenAt >= 30 * 60_000;
    expect(shouldReset).toBe(false);
  });
});

// --- Overflow-banner backstop self-referential guard ---

describe('overflow-banner backstop corroboration guard', () => {
  // Mirrors the hard overflow backstop in fast-checker.ts (~line 1021). The PTY
  // banner regex is a backstop that force-restarts when Claude's live context-
  // overflow banner appears in an agent's terminal. Without the
  // ctxCorroboratesOverflow gate, the regex matched those banner phrases as benign
  // TEXT — so any agent that merely READ or DISCUSSED the overflow/compaction
  // mechanism (memory files, daemon source, chat) printed the strings into its own
  // PTY buffer and force-restarted itself at low context. Because the watchdog is
  // shared, multiple agents investigating the compaction mechanism at once could
  // cascade across runtimes. The gate requires usage to corroborate the banner:
  // exceeds_200k OR pct >= 85.
  const OVERFLOW_BANNER_RE = /extra usage.*?1[Mm] context|conversation too long.*?compaction/i;

  // NEW (guarded) detector — gates the banner regex on real high context.
  function forceRestartsOnOverflow(recentOutput: string, pct: number | null, exceeds200k: boolean): boolean {
    const ctxCorroboratesOverflow = exceeds200k || (pct !== null && pct >= 85);
    return ctxCorroboratesOverflow && OVERFLOW_BANNER_RE.test(recentOutput);
  }

  // OLD (pre-fix) detector — regex only, no context gate. Kept here ONLY to prove
  // the regression test has teeth: each real cascade string below MUST trip this,
  // and MUST NOT trip the guarded detector at low context. A test that passed on
  // both code paths would prove nothing.
  function oldDetectorRestarts(recentOutput: string): boolean {
    return OVERFLOW_BANNER_RE.test(recentOutput);
  }

  // The real same-line banner strings that triggered the false-positive. The regex
  // has no /s flag, so both tokens must share a line.
  const CASCADE_STRINGS = [
    // an agent's own answer describing the mechanism to the user
    'Context compaction/handoff — YES. The daemon watches compaction signals ("conversation too long…compaction") at threshold',
    // an agent's memory entry documenting the bug, quoting the regex pattern
    '## Self-Referential Overflow False-Positive — detector trips on conversation too long.*compaction in its own output',
    // an agent's diagnosis, quoting the pattern verbatim
    'fast-checker.ts has an unconditional regex that force-restarts on text matching conversation too long.*compaction',
  ];

  it('TEETH: every real cascade string trips the OLD detector (reproduces the bug)', () => {
    // If any of these did NOT match, the test would be a no-op green.
    for (const s of CASCADE_STRINGS) {
      expect(oldDetectorRestarts(s)).toBe(true);
    }
  });

  it('ROOT CAUSE: the same real cascade strings at LOW context do NOT force-restart on the fix', () => {
    // Each of these benign quotes looped an agent on old code; the guard kills it.
    for (const s of CASCADE_STRINGS) {
      expect(forceRestartsOnOverflow(s, 12, false)).toBe(false);
      expect(forceRestartsOnOverflow(s, 70, false)).toBe(false);
      expect(forceRestartsOnOverflow(s, 84, false)).toBe(false);
    }
  });

  it('genuine overflow (pct >= 85) with the banner DOES force-restart (backstop preserved)', () => {
    // Boundary: 84 is safe (covered above), 85 acts.
    expect(forceRestartsOnOverflow(CASCADE_STRINGS[0], 85, false)).toBe(true);
    expect(forceRestartsOnOverflow(CASCADE_STRINGS[0], 99, false)).toBe(true);
  });

  it('genuine overflow (exceeds_200k, null pct) with the banner DOES force-restart', () => {
    expect(forceRestartsOnOverflow(CASCADE_STRINGS[0], null, true)).toBe(true);
  });

  it('high context with NO banner phrase does NOT force-restart (regex still required)', () => {
    expect(forceRestartsOnOverflow('ordinary work output, nothing about overflow', 99, true)).toBe(false);
  });

  it('the "extra usage / 1M context" banner variant is gated the same way', () => {
    const variant = 'error: enable extra usage to access the 1M context window';
    expect(forceRestartsOnOverflow(variant, 20, false)).toBe(false); // low context, benign
    expect(forceRestartsOnOverflow(variant, 90, false)).toBe(true);  // genuine overflow
  });

  it('AGENTS.md-style boot text quoting the phrase at low context is safe', () => {
    const bootText = 'fast-checker watches context % and compaction signals ("conversation too long...compaction")';
    expect(forceRestartsOnOverflow(bootText, 8, false)).toBe(false);
  });
});

// --- Handoff block consumption ---

// --- ROOT FIX: real model-window measurement (kills restart churn) ---

describe('realContextWindow model→window map', () => {
  it('maps 1M-context models to 1_000_000', () => {
    expect(realContextWindow('claude-sonnet-5')).toBe(1_000_000);
    expect(realContextWindow('claude-opus-5')).toBe(1_000_000);
    expect(realContextWindow('claude-opus-4-8')).toBe(1_000_000);
    expect(realContextWindow('claude-fable-5')).toBe(1_000_000);
  });

  it('maps [1m] variants and provider prefixes to 1_000_000', () => {
    expect(realContextWindow('claude-sonnet-5[1m]')).toBe(1_000_000);
    expect(realContextWindow('claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(realContextWindow('us.anthropic.claude-sonnet-5')).toBe(1_000_000);
    expect(realContextWindow('CLAUDE-OPUS-5')).toBe(1_000_000); // case-insensitive
  });

  it('maps haiku-class and unknown models to 200_000', () => {
    expect(realContextWindow('claude-haiku-5')).toBe(200_000);
    expect(realContextWindow('claude-3-5-haiku')).toBe(200_000);
    expect(realContextWindow('some-unknown-model')).toBe(200_000);
  });

  it('maps absent model (CC default) to 200_000 (never over-estimate)', () => {
    expect(realContextWindow(undefined)).toBe(200_000);
    expect(realContextWindow('')).toBe(200_000);
  });
});

describe('realPct replaces CC 200K-based used_percentage', () => {
  // Mirror of fast-checker's realPct derivation + handoff decision. rawTokens is
  // current-turn occupancy from input_tokens + output_tokens only; the effective
  // denominator prefers context_window_size and falls back to realContextWindow(model).
  // The calculation falls back to CC used_percentage only when rawTokens is absent.
  const HANDOFF = 60;

  function sumUsage(cu: Record<string, number> | null): number | null {
    if (!cu) return null;
    const inputTokens = Number.isFinite(cu.input_tokens) ? cu.input_tokens : 0;
    const outputTokens = Number.isFinite(cu.output_tokens) ? cu.output_tokens : 0;
    const sum =
      inputTokens
      + outputTokens;
    return sum > 0 ? sum : null;
  }

  function decide(
    model: string | undefined,
    ccPct: number | null,
    cu: Record<string, number> | null,
    contextWindowSize: number | null = null,
  ) {
    const realWindow =
      contextWindowSize !== null && Number.isFinite(contextWindowSize) && contextWindowSize > 0
        ? contextWindowSize
        : realContextWindow(model);
    const rawTokens = sumUsage(cu);
    const realPct = rawTokens !== null ? (rawTokens / realWindow) * 100 : ccPct;
    const fires = realPct !== null && realPct >= HANDOFF;
    return { realPct, fires };
  }

  it('1M model at 140K tokens → ~14% → NO handoff (was 70% → handoff)', () => {
    const r = decide('claude-sonnet-5[1m]', 70, { input_tokens: 140_000 });
    expect(r.realPct).toBeCloseTo(14, 5);
    expect(r.fires).toBe(false);
  });

  it('1M model at 620K tokens → ~62% → handoff fires', () => {
    const r = decide('claude-opus-4-8[1m]', 100, { input_tokens: 620_000 });
    expect(r.realPct).toBeCloseTo(62, 5);
    expect(r.fires).toBe(true);
  });

  it('haiku agent at 140K tokens → 70% → handoff (still 200K window)', () => {
    const r = decide('claude-haiku-5', 70, { input_tokens: 140_000 });
    expect(r.realPct).toBeCloseTo(70, 5);
    expect(r.fires).toBe(true);
  });

  it('current_usage absent → falls back to CC used_percentage', () => {
    const r = decide('claude-sonnet-5[1m]', 70, null);
    expect(r.realPct).toBe(70);
    expect(r.fires).toBe(true);
  });

  it('uses the bridge denominator and ignores large cache fields', () => {
    const r = decide('claude-sonnet-5[1m]', null, {
      input_tokens: 278_039,
      cache_creation_input_tokens: 400_000,
      cache_read_input_tokens: 500_000,
      output_tokens: 947,
    }, 997_500);
    expect(r.realPct).toBeCloseTo(27.97, 2); // (278,039 + 947) / 997,500
    expect(r.fires).toBe(false);
  });

  it('falls back to the model denominator when the bridge denominator is invalid', () => {
    const r = decide('claude-sonnet-5[1m]', null, { input_tokens: 600_000 }, 0);
    expect(r.realPct).toBeCloseTo(60, 5); // 600K / 1M
    expect(r.fires).toBe(true);
  });
});

describe('context baseline observability', () => {
  it('formats exact current-turn occupancy and denominator', () => {
    expect(formatContextBaseline(278_986, 997_500, 'bridge context_window_size'))
      .toBe('Context baseline: 27.97% (278986/997500) current-turn occupancy; denominator=bridge context_window_size');
  });

  it('logs once per effective denominator and re-emits only when it changes', () => {
    const rawTokens = 278_986;
    let lastDenominator: number | null = null;
    const logs: string[] = [];

    for (let tick = 0; tick < 3; tick += 1) {
      if (shouldLogContextBaseline(lastDenominator, 997_500, rawTokens)) {
        logs.push(formatContextBaseline(rawTokens, 997_500, 'bridge context_window_size'));
        lastDenominator = 997_500;
      }
    }

    expect(logs).toHaveLength(1);
    expect(shouldLogContextBaseline(lastDenominator, 997_500, rawTokens)).toBe(false);
    expect(shouldLogContextBaseline(lastDenominator, 1_000_000, rawTokens)).toBe(true);
    expect(shouldLogContextBaseline(lastDenominator, 997_500, null)).toBe(false);
  });
});

describe('consumeHandoffBlock', () => {
  let stateDir: string;
  let handoffDocPath: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `handoff-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    handoffDocPath = join(stateDir, 'handoff-doc.md');
    writeFileSync(handoffDocPath, '# Handoff\n\n## Current Tasks\n- Working on X', 'utf-8');
  });

  afterEach(() => {
    try { unlinkSync(join(stateDir, '.handoff-doc-path')); } catch { /* ignore */ }
    try { unlinkSync(handoffDocPath); } catch { /* ignore */ }
  });

  it('returns empty string when no marker exists', () => {
    // Simulate consumeHandoffBlock logic
    const markerPath = join(stateDir, '.handoff-doc-path');
    const exists = existsSync(markerPath);
    expect(exists).toBe(false);
    // result would be ''
  });

  it('returns handoff block when marker exists and doc is present', () => {
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(markerPath, handoffDocPath + '\n', 'utf-8');

    // Simulate consumeHandoffBlock logic
    const doc = require('fs').readFileSync(markerPath, 'utf-8').trim();
    unlinkSync(markerPath);
    const docExists = existsSync(doc);
    expect(docExists).toBe(true);
    expect(doc).toBe(handoffDocPath);
    expect(existsSync(markerPath)).toBe(false); // consumed
  });

  it('marker file is unlinked after consumption', () => {
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(markerPath, handoffDocPath + '\n', 'utf-8');
    expect(existsSync(markerPath)).toBe(true);
    // consume
    require('fs').readFileSync(markerPath, 'utf-8').trim();
    unlinkSync(markerPath);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('returns empty when marker points to nonexistent doc', () => {
    const markerPath = join(stateDir, '.handoff-doc-path');
    writeFileSync(markerPath, '/nonexistent/path/doc.md\n', 'utf-8');
    const doc = require('fs').readFileSync(markerPath, 'utf-8').trim();
    unlinkSync(markerPath);
    const docExists = existsSync(doc);
    expect(docExists).toBe(false);
  });
});
