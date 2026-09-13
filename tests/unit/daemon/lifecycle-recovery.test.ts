import { describe, expect, it } from 'vitest';
import {
  classifyExit,
  CLEAN_EXIT_BACKOFF_DEFAULT_MS,
  CLEAN_EXIT_BACKOFF_OPENCODE_MS,
  CLEAN_EXIT_HALT_THRESHOLD,
  CRASH_BACKOFF_BASE_MS,
  CRASH_BACKOFF_CAP_MS,
  evaluateContextBaseline,
  FORCE_FRESH_BACKOFF_MS,
  IMAGE_POISON_THRESHOLD,
  IMAGE_POISON_WINDOW_MS,
  OPENCODE_CONTINUE_WEDGE_FAST_EXIT_MS,
  OPENCODE_CONTINUE_WEDGE_THRESHOLD,
  STARTUP_FAILURE_SPAWN_AGE_MS,
  STARTUP_FAILURE_THRESHOLD,
  STARTUP_FAILURE_WINDOW_MS,
  type ContextBaselineState,
  type ExitObservation,
} from '../../../src/daemon/lifecycle/recovery-policy';
import type { LifecycleSnapshot } from '../../../src/daemon/lifecycle/types';

type Budgets = LifecycleSnapshot['recoveryBudgets'];

const BASE_TOKEN = { agentId: 'default/clearworks/knox', supervisorEpoch: 1, generation: 1 };

function baseObs(overrides: Partial<ExitObservation> = {}): ExitObservation {
  return {
    token: BASE_TOKEN,
    exitCode: 1,
    signal: null,
    recentOutput: '',
    runtime: 'claude-code',
    startedAtMs: 0,
    exitedAtMs: 10_000,
    spawnMode: 'continue',
    wasReady: true,
    gates: { daemonShuttingDown: false, disabled: false, intentional: false, planned: false },
    limits: { maxCrashesPerDay: 10, crashWindowMs: 0, crashWindowMax: 0 },
    ...overrides,
  };
}

describe('classifyExit — gates (steps 1-4)', () => {
  it('daemon-shutdown gate: action none, cause daemon-shutdown, no budgets charged', () => {
    const obs = baseObs({ gates: { daemonShuttingDown: true, disabled: false, intentional: false, planned: false } });
    const proposal = classifyExit(obs, {});
    expect(proposal.action).toBe('none');
    expect(proposal.cause).toBe('daemon-shutdown');
    expect(proposal.updatedBudgets).toEqual({});
  });

  it('disabled gate: action none, cause clean-exit (closest neutral cause), no budgets charged', () => {
    const obs = baseObs({ gates: { daemonShuttingDown: false, disabled: true, intentional: false, planned: false } });
    const proposal = classifyExit(obs, {});
    expect(proposal.action).toBe('none');
    expect(proposal.cause).toBe('clean-exit');
    expect(proposal.updatedBudgets).toEqual({});
  });

  it('intentional-stop gate: action none, cause clean-exit, no budgets charged', () => {
    const obs = baseObs({ gates: { daemonShuttingDown: false, disabled: false, intentional: true, planned: false } });
    const proposal = classifyExit(obs, {});
    expect(proposal.action).toBe('none');
    expect(proposal.cause).toBe('clean-exit');
    expect(proposal.updatedBudgets).toEqual({});
  });

  it('planned-restart gate: action none, cause clean-exit, no budgets charged', () => {
    const obs = baseObs({ gates: { daemonShuttingDown: false, disabled: false, intentional: false, planned: true } });
    const proposal = classifyExit(obs, {});
    expect(proposal.action).toBe('none');
    expect(proposal.cause).toBe('clean-exit');
    expect(proposal.updatedBudgets).toEqual({});
  });

  it('gates are checked in order — daemon-shutdown wins even if others are also true', () => {
    const obs = baseObs({ gates: { daemonShuttingDown: true, disabled: true, intentional: true, planned: true } });
    const proposal = classifyExit(obs, {});
    expect(proposal.cause).toBe('daemon-shutdown');
  });

  it('an intentional exit still yields an observation the owner can record (never returns nothing)', () => {
    const obs = baseObs({ gates: { daemonShuttingDown: false, disabled: false, intentional: true, planned: false } });
    const proposal = classifyExit(obs, {});
    expect(proposal).toBeDefined();
    expect(proposal.evidence).toBeDefined();
  });
});

describe('classifyExit — image-poison (step 5)', () => {
  const poisonedOutput = 'API Error: 400 messages.0.content.0.image.source.base64.data: bad';

  it('classifies as image-poison, restarts fresh, fixed 5s backoff, below threshold', () => {
    const obs = baseObs({ exitCode: 0, recentOutput: poisonedOutput });
    const proposal = classifyExit(obs, {});
    expect(proposal.cause).toBe('image-poison');
    expect(proposal.action).toBe('restart');
    expect(proposal.mode).toBe('fresh');
    expect(proposal.delayMs).toBe(FORCE_FRESH_BACKOFF_MS);
    expect(proposal.updatedBudgets['image-poison'].count).toBe(1);
  });

  it('also matches the "image format image/<fmt> not supported" variant', () => {
    const obs = baseObs({ exitCode: 0, recentOutput: 'image format image/webp not supported' });
    const proposal = classifyExit(obs, {});
    expect(proposal.cause).toBe('image-poison');
  });

  it('trips the circuit breaker on the 3rd recovery within 15 minutes: pause-and-alert, no restart', () => {
    let budgets: Budgets = {};
    let proposal;
    for (let i = 0; i < IMAGE_POISON_THRESHOLD; i++) {
      const obs = baseObs({ exitCode: 0, recentOutput: poisonedOutput, exitedAtMs: 10_000 + i * 1000 });
      proposal = classifyExit(obs, budgets);
      budgets = { ...budgets, ...proposal.updatedBudgets };
    }
    expect(proposal!.action).toBe('pause-and-alert');
    expect(proposal!.delayMs).toBe(0);
    expect(proposal!.evidence.circuitBreakerTripped).toBe(true);
  });

  it('a recovery outside the 15-minute window resets the counter to 1', () => {
    const budgets: Budgets = { 'image-poison': { count: 2, windowStartMs: 0, pausedUntilMs: null } };
    const obs = baseObs({ exitCode: 0, recentOutput: poisonedOutput, exitedAtMs: IMAGE_POISON_WINDOW_MS + 1_000 });
    const proposal = classifyExit(obs, budgets);
    expect(proposal.updatedBudgets['image-poison'].count).toBe(1);
    expect(proposal.action).toBe('restart');
  });
});

describe('classifyExit — opencode continuation wedge (step 6)', () => {
  function wedgeObs(exitedAtMs: number): ExitObservation {
    return baseObs({
      exitCode: 0,
      runtime: 'opencode',
      spawnMode: 'continue',
      startedAtMs: 0,
      exitedAtMs,
      wasReady: false,
    });
  }

  it('classifies as opencode-continuation, mode continue, below threshold', () => {
    const obs = wedgeObs(OPENCODE_CONTINUE_WEDGE_FAST_EXIT_MS - 1);
    const proposal = classifyExit(obs, {});
    expect(proposal.cause).toBe('opencode-continuation');
    expect(proposal.action).toBe('restart');
    expect(proposal.mode).toBe('continue');
    expect(proposal.delayMs).toBe(CLEAN_EXIT_BACKOFF_OPENCODE_MS);
    expect(proposal.updatedBudgets['opencode-continuation'].count).toBe(1);
  });

  it('at the 3rd consecutive sub-60s exit-0 continuation, arms fresh with 5s backoff and resets the streak', () => {
    let budgets: Budgets = {};
    let proposal;
    for (let i = 0; i < OPENCODE_CONTINUE_WEDGE_THRESHOLD; i++) {
      const obs = wedgeObs(1000 + i * 1000);
      proposal = classifyExit(obs, budgets);
      budgets = { ...budgets, ...proposal.updatedBudgets };
    }
    expect(proposal!.cause).toBe('opencode-continuation');
    expect(proposal!.mode).toBe('fresh');
    expect(proposal!.delayMs).toBe(FORCE_FRESH_BACKOFF_MS);
    expect(proposal!.updatedBudgets['opencode-continuation'].count).toBe(0);
  });

  it('is not a wedge candidate for non-opencode runtimes even in continue mode', () => {
    const obs = baseObs({ exitCode: 0, runtime: 'claude-code', spawnMode: 'continue', wasReady: true, startedAtMs: 0, exitedAtMs: 1000 });
    const proposal = classifyExit(obs, {});
    expect(proposal.cause).not.toBe('opencode-continuation');
  });

  it('is not a wedge candidate for a fresh spawn mode', () => {
    const obs = baseObs({ exitCode: 0, runtime: 'opencode', spawnMode: 'fresh', wasReady: true, startedAtMs: 0, exitedAtMs: 1000 });
    const proposal = classifyExit(obs, {});
    expect(proposal.cause).not.toBe('opencode-continuation');
  });

  it('resets the wedge streak to 0 on a non-wedge clean exit', () => {
    const budgets: Budgets = { 'opencode-continuation': { count: 2, windowStartMs: 0, pausedUntilMs: null } };
    const obs = baseObs({ exitCode: 0, runtime: 'opencode', spawnMode: 'fresh', wasReady: true, startedAtMs: 0, exitedAtMs: 1000 });
    const proposal = classifyExit(obs, budgets);
    expect(proposal.updatedBudgets['opencode-continuation']).toEqual({ count: 0, windowStartMs: 1000, pausedUntilMs: null });
  });
});

describe('classifyExit — exit-before-ready startup-failure (step 7)', () => {
  function beforeReadyObs(exitedAtMs: number): ExitObservation {
    return baseObs({
      exitCode: 0,
      runtime: 'claude-code',
      spawnMode: 'fresh',
      startedAtMs: 0,
      exitedAtMs,
      wasReady: false,
    });
  }

  it('below threshold: falls through to clean-exit restart, but still charges the startup-failure streak', () => {
    const obs = beforeReadyObs(STARTUP_FAILURE_SPAWN_AGE_MS - 1);
    const proposal = classifyExit(obs, {});
    expect(proposal.cause).toBe('clean-exit');
    expect(proposal.action).toBe('restart');
    expect(proposal.updatedBudgets['startup-failure'].count).toBe(1);
  });

  it('at the 3rd before-ready exit within 60s: halts and alerts as startup-failure', () => {
    let budgets: Budgets = {};
    let proposal;
    for (let i = 0; i < STARTUP_FAILURE_THRESHOLD; i++) {
      const obs = beforeReadyObs(1000 + i * 1000);
      proposal = classifyExit(obs, budgets);
      budgets = { ...budgets, ...proposal.updatedBudgets };
    }
    expect(proposal!.cause).toBe('startup-failure');
    expect(proposal!.action).toBe('halt');
    expect(proposal!.delayMs).toBe(0);
  });

  it('a before-ready exit outside the 60s window resets the streak to 1', () => {
    const budgets: Budgets = { 'startup-failure': { count: 2, windowStartMs: 0, pausedUntilMs: null } };
    // exitedAtMs is past the prior window's start, but startedAtMs tracks
    // right alongside it so ageMs stays "before ready" — isolates the
    // window-rollover behavior from the before-ready spawn-age condition.
    const exitedAtMs = STARTUP_FAILURE_WINDOW_MS + 1000;
    const obs = baseObs({
      exitCode: 0,
      runtime: 'claude-code',
      spawnMode: 'fresh',
      wasReady: false,
      startedAtMs: exitedAtMs - 100,
      exitedAtMs,
    });
    const proposal = classifyExit(obs, budgets);
    expect(proposal.updatedBudgets['startup-failure'].count).toBe(1);
  });

  it('spawnAgeMs at or after the 8s threshold is not "before ready"', () => {
    const obs = beforeReadyObs(STARTUP_FAILURE_SPAWN_AGE_MS);
    const proposal = classifyExit(obs, {});
    expect(proposal.updatedBudgets['startup-failure']).toEqual({ count: 0, windowStartMs: STARTUP_FAILURE_SPAWN_AGE_MS, pausedUntilMs: null });
  });
});

describe('classifyExit — fallthrough clean-exit (step 8)', () => {
  it('a ready clean exit clears the startup-failure streak and restarts to continue', () => {
    const budgets: Budgets = { 'startup-failure': { count: 2, windowStartMs: 0, pausedUntilMs: null } };
    const obs = baseObs({ exitCode: 0, runtime: 'claude-code', spawnMode: 'continue', wasReady: true, startedAtMs: 0, exitedAtMs: 20_000 });
    const proposal = classifyExit(obs, budgets);
    expect(proposal.cause).toBe('clean-exit');
    expect(proposal.action).toBe('restart');
    expect(proposal.mode).toBe('continue');
    expect(proposal.delayMs).toBe(CLEAN_EXIT_BACKOFF_DEFAULT_MS);
    expect(proposal.updatedBudgets['startup-failure']).toEqual({ count: 0, windowStartMs: 20_000, pausedUntilMs: null });
  });

  it('uses the 2s opencode backoff instead of the 3s default', () => {
    const obs = baseObs({ exitCode: 0, runtime: 'opencode', spawnMode: 'fresh', wasReady: true, startedAtMs: 0, exitedAtMs: 20_000 });
    const proposal = classifyExit(obs, {});
    expect(proposal.delayMs).toBe(CLEAN_EXIT_BACKOFF_OPENCODE_MS);
  });

  it('halts at the 8th clean exit within 60s (CLEAN_EXIT_LOOP)', () => {
    let budgets: Budgets = {};
    let proposal;
    for (let i = 0; i < CLEAN_EXIT_HALT_THRESHOLD; i++) {
      const obs = baseObs({ exitCode: 0, runtime: 'claude-code', spawnMode: 'continue', wasReady: true, startedAtMs: 0, exitedAtMs: 1000 + i * 100 });
      proposal = classifyExit(obs, budgets);
      budgets = { ...budgets, ...proposal.updatedBudgets };
    }
    expect(proposal!.cause).toBe('clean-exit');
    expect(proposal!.action).toBe('halt');
    expect(proposal!.delayMs).toBe(0);
  });
});

describe('classifyExit — genuine crash (step 9)', () => {
  it('classifies as crash with exponential backoff: 5s, 10s, 20s...', () => {
    let budgets: Budgets = {};
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const obs = baseObs({ exitCode: 1, exitedAtMs: 1000 + i * 1000 });
      const proposal = classifyExit(obs, budgets);
      budgets = { ...budgets, ...proposal.updatedBudgets };
      delays.push(proposal.delayMs);
    }
    expect(delays).toEqual([
      CRASH_BACKOFF_BASE_MS,
      CRASH_BACKOFF_BASE_MS * 2,
      CRASH_BACKOFF_BASE_MS * 4,
      CRASH_BACKOFF_BASE_MS * 8,
    ]);
  });

  it('caps exponential backoff at 300s', () => {
    // windowStartMs must equal the UTC day-start boundary for exitedAtMs so
    // the daily counter is recognized as "same day, continuing" rather than
    // rolling over to a fresh count of 1.
    const budgets: Budgets = { 'crash-daily': { count: 20, windowStartMs: 0, pausedUntilMs: null } };
    const obs = baseObs({ exitCode: 1, exitedAtMs: 1000, limits: { maxCrashesPerDay: 100, crashWindowMs: 0, crashWindowMax: 0 } });
    const proposal = classifyExit(obs, budgets);
    expect(proposal.delayMs).toBe(CRASH_BACKOFF_CAP_MS);
  });

  it('halts at the configured daily crash limit', () => {
    let budgets: Budgets = {};
    let proposal;
    for (let i = 0; i < 10; i++) {
      const obs = baseObs({ exitCode: 1, exitedAtMs: 1000 + i * 1000, limits: { maxCrashesPerDay: 10, crashWindowMs: 0, crashWindowMax: 0 } });
      proposal = classifyExit(obs, budgets);
      budgets = { ...budgets, ...proposal.updatedBudgets };
    }
    expect(proposal!.action).toBe('halt');
    expect(proposal!.budgetKey).toBe('crash-daily');
    expect(proposal!.budgetLimit).toBe(10);
  });

  it('resets the daily counter on a new UTC day', () => {
    const budgets: Budgets = { 'crash-daily': { count: 9, windowStartMs: 0, pausedUntilMs: null } };
    const obs = baseObs({ exitCode: 1, exitedAtMs: 86_400_000 + 5000 });
    const proposal = classifyExit(obs, budgets);
    expect(proposal.updatedBudgets['crash-daily'].count).toBe(1);
  });

  it('a configured crash-window halts before the daily counter is even touched', () => {
    let budgets: Budgets = {};
    let proposal;
    const limits = { maxCrashesPerDay: 100, crashWindowMs: 30_000, crashWindowMax: 3 };
    for (let i = 0; i < 3; i++) {
      const obs = baseObs({ exitCode: 1, exitedAtMs: 1000 + i * 1000, limits });
      proposal = classifyExit(obs, budgets);
      budgets = { ...budgets, ...proposal.updatedBudgets };
    }
    expect(proposal!.action).toBe('halt');
    expect(proposal!.budgetKey).toBe('crash-window');
    expect(proposal!.updatedBudgets['crash-daily']).toBeUndefined();
  });

  it('clean exits are never counted as crashes and vice versa', () => {
    const cleanObs = baseObs({ exitCode: 0, runtime: 'claude-code', spawnMode: 'continue', wasReady: true, startedAtMs: 0, exitedAtMs: 1000 });
    const cleanProposal = classifyExit(cleanObs, {});
    expect(cleanProposal.updatedBudgets['crash-daily']).toBeUndefined();
    expect(cleanProposal.updatedBudgets['crash-window']).toBeUndefined();

    const crashObs = baseObs({ exitCode: 1, exitedAtMs: 1000 });
    const crashProposal = classifyExit(crashObs, {});
    expect(crashProposal.updatedBudgets['clean-exit']).toBeUndefined();
    expect(crashProposal.updatedBudgets['opencode-continuation']).toBeUndefined();
    expect(crashProposal.updatedBudgets['startup-failure']).toBeUndefined();
  });
});

describe('classifyExit — budgets persist across a simulated generation change', () => {
  it('the crash-daily counter keeps accumulating across different GenerationToken.generation values', () => {
    let budgets: Budgets = {};

    const obsGen1 = baseObs({ exitCode: 1, exitedAtMs: 1000, token: { ...BASE_TOKEN, generation: 1 } });
    const p1 = classifyExit(obsGen1, budgets);
    budgets = { ...budgets, ...p1.updatedBudgets };
    expect(budgets['crash-daily'].count).toBe(1);

    // Simulate a new process object / new generation reusing the SAME
    // persisted budgets record (owned by the supervisor, not the process).
    const obsGen2 = baseObs({ exitCode: 1, exitedAtMs: 2000, token: { ...BASE_TOKEN, generation: 2 } });
    const p2 = classifyExit(obsGen2, budgets);
    budgets = { ...budgets, ...p2.updatedBudgets };
    expect(budgets['crash-daily'].count).toBe(2);

    const obsGen3 = baseObs({ exitCode: 1, exitedAtMs: 3000, token: { ...BASE_TOKEN, generation: 3 } });
    const p3 = classifyExit(obsGen3, budgets);
    expect(p3.updatedBudgets['crash-daily'].count).toBe(3);
  });
});

describe('classifyExit — purity', () => {
  it('does not mutate the input budgets object', () => {
    const budgets: Budgets = { 'crash-daily': { count: 1, windowStartMs: 1000, pausedUntilMs: null } };
    const frozen = JSON.parse(JSON.stringify(budgets));
    classifyExit(baseObs({ exitCode: 1, exitedAtMs: 1000 }), budgets);
    expect(budgets).toEqual(frozen);
  });
});

// Task 4.1 (OPTIONAL, non-release-blocking; PRD §5 Open Question 3):
// generation-keyed context baseline. Mirrors upstream `5a8e7cbc`'s (#937)
// four-scenario suite, but scenario D replaces upstream's "unanchored legacy
// path unchanged" with the actual delta this task adds over a literal
// upstream port: a generation change resets baseline/alert state, which
// upstream's session_id-keyed fields cannot guarantee (upstream's own commit
// message documents session_id as null-prone on a fresh session).
describe('evaluateContextBaseline', () => {
  const EMPTY_STATE: ContextBaselineState = { generation: null, baselinePct: null, alertFiredAt: null };

  it('scenario A — heavy-baseline idle session: suppressed, alerts exactly once', () => {
    // First post-grace reading is already at/above threshold (65% >= 60%).
    const captured = evaluateContextBaseline(EMPTY_STATE, {
      generation: 1,
      effectivePct: 65,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 1000,
    });
    expect(captured.state.baselinePct).toBe(65);
    expect(captured.suppressHandoff).toBe(true);
    expect(captured.emitAlertNow).toBe(true);
    expect(captured.state.alertFiredAt).toBe(1000);

    // Idle ticks after: still suppressed, but the alert never re-fires.
    const idle1 = evaluateContextBaseline(captured.state, {
      generation: 1,
      effectivePct: 67,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 2000,
    });
    expect(idle1.suppressHandoff).toBe(true);
    expect(idle1.emitAlertNow).toBe(false);
    expect(idle1.state.alertFiredAt).toBe(1000); // unchanged

    const idle2 = evaluateContextBaseline(idle1.state, {
      generation: 1,
      effectivePct: 68,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 3000,
    });
    expect(idle2.suppressHandoff).toBe(true);
    expect(idle2.emitAlertNow).toBe(false);
  });

  it('scenario B — low-baseline session that grows into threshold: never suppressed, no alert', () => {
    const captured = evaluateContextBaseline(EMPTY_STATE, {
      generation: 1,
      effectivePct: 20,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 1000,
    });
    expect(captured.state.baselinePct).toBe(20);
    expect(captured.suppressHandoff).toBe(false);
    expect(captured.emitAlertNow).toBe(false);

    // Real growth all the way past threshold — baseline stays pinned at the
    // original low capture, so suppression never triggers (baselinePct < handoff).
    const grown = evaluateContextBaseline(captured.state, {
      generation: 1,
      effectivePct: 62,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 5000,
    });
    expect(grown.suppressHandoff).toBe(false);
    expect(grown.emitAlertNow).toBe(false);
    expect(grown.state.baselinePct).toBe(20); // never recaptured
  });

  it('scenario C — born-above-threshold session that accumulates real work-fill: suppressed while idle, then hands off past the margin', () => {
    const captured = evaluateContextBaseline(EMPTY_STATE, {
      generation: 1,
      effectivePct: 65,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 1000,
    });
    expect(captured.suppressHandoff).toBe(true);

    // Small growth (3pts) — still under the 10pt margin, still suppressed.
    const smallGrowth = evaluateContextBaseline(captured.state, {
      generation: 1,
      effectivePct: 68,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 2000,
    });
    expect(smallGrowth.suppressHandoff).toBe(true);

    // Real work-fill: 11pts past the baseline — margin exceeded, handoff proceeds.
    const pastMargin = evaluateContextBaseline(smallGrowth.state, {
      generation: 1,
      effectivePct: 76,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 3000,
    });
    expect(pastMargin.suppressHandoff).toBe(false);
    expect(pastMargin.state.baselinePct).toBe(65); // baseline itself never moves
  });

  it('scenario D — a generation change resets state; the actual fix this task adds', () => {
    // Generation 1 is suppressed and has already alerted once.
    const gen1 = evaluateContextBaseline(EMPTY_STATE, {
      generation: 1,
      effectivePct: 90,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 1000,
    });
    expect(gen1.suppressHandoff).toBe(true);
    expect(gen1.emitAlertNow).toBe(true);

    // A NEW generation arrives (a real respawn) while the caller still holds
    // gen1's baselinePct/alertFiredAt values in its own fields — this is
    // exactly the upstream null-session_id leak scenario, except the
    // generation itself unambiguously tells us this is a fresh identity.
    // Even at the SAME raw effectivePct that was suppressed under gen1, the
    // new generation gets a fresh baseline capture and is alert-eligible again.
    const gen2First = evaluateContextBaseline(gen1.state, {
      generation: 2,
      effectivePct: 90,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 5000,
    });
    expect(gen2First.state.generation).toBe(2);
    expect(gen2First.state.baselinePct).toBe(90); // recaptured fresh, not inherited from gen1
    expect(gen2First.suppressHandoff).toBe(true); // still born-high under gen2 too
    expect(gen2First.emitAlertNow).toBe(true); // alert eligible again — gen1's firing did not leak forward
  });

  it('a session below threshold reaching the same generation twice does not recapture the baseline', () => {
    const first = evaluateContextBaseline(EMPTY_STATE, {
      generation: 1,
      effectivePct: 40,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 1000,
    });
    expect(first.state.baselinePct).toBe(40);

    const second = evaluateContextBaseline(first.state, {
      generation: 1,
      effectivePct: 55,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 2000,
    });
    expect(second.state.baselinePct).toBe(40); // unchanged — already captured for this generation
  });

  it('capturedBaselineNow: false (still within grace) never captures a baseline', () => {
    const decision = evaluateContextBaseline(EMPTY_STATE, {
      generation: 1,
      effectivePct: 90,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: false,
      nowMs: 1000,
    });
    expect(decision.state.baselinePct).toBeNull();
    expect(decision.suppressHandoff).toBe(false);
    expect(decision.emitAlertNow).toBe(false);
  });

  it('is a pure function — never mutates the input state object', () => {
    const state: ContextBaselineState = { generation: 1, baselinePct: 65, alertFiredAt: 1000 };
    const frozen = JSON.parse(JSON.stringify(state));
    evaluateContextBaseline(state, {
      generation: 1,
      effectivePct: 67,
      handoffThreshold: 60,
      workfillMarginPct: 10,
      capturedBaselineNow: true,
      nowMs: 2000,
    });
    expect(state).toEqual(frozen);
  });
});
