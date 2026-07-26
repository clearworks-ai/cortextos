# Spec 04 — Fast-checker cron-liveness assertion + job-liveness gate (Scope C)

## Problem
Nothing at runtime notices "crons.json says a cron should have fired and it didn't". The
register-path fixes (specs 02/03) make registration honest; this spec makes ONGOING firing
observable and self-healing.

## Where it lives
`src/daemon/fast-checker.ts` — the TS `FastChecker` class (header comment line 124:
"Replaces fast-checker.sh"; the shell script named in frank-reliability-fixes.md is its
ancestor). It already has: 1s `pollCycle()` (line ~299), `getLastCronFireAt()` (~1186,
reads cron-state.json via `readCronState(this.paths.stateDir)`), restart machinery
(`sessionRefresh()`), and a loop-stall circuit breaker (~1311-1322: 3 restarts/15min → 30min
pause). NOT a new launchd agent, NOT a new daemon.

## Change 1 — overdue-cron detector
New private method `checkCronLiveness(now: number)` called from the existing slow-cadence path
inside `pollCycle()` (throttle to once per 60s via a `cronLivenessLastCheckedAt` field — do
not stat files at 1Hz).

Logic per agent (the FastChecker instance is per-agent):
1. Read the agent's crons.json (`readCrons(agentName)` from `src/bus/crons.ts` — CTX_ROOT is
   set in the daemon process) and cron-state.json (already wired).
2. For each cron with `enabled: true`, compute expected latest fire:
   `lastFire = max(crons.json last_fired_at, last_fire_attempted_at, cron-state last_fire)`
   (same candidate set the scheduler uses, `cron-scheduler.ts:~400-408`).
3. Overdue predicate: `now - lastFire > scheduleIntervalMs + GRACE` where
   `GRACE = max(2 * CronScheduler.TICK_INTERVAL_MS, 5min)`. For 5-field cron exprs, compute
   the previous scheduled occurrence instead of intervalMs (reuse the schedule parser the
   scheduler uses — do not write a second parser). Never-fired crons: use `created_at` as the
   baseline so a brand-new 6h cron is not flagged at minute 1.
4. This satisfies Josh's ">=1 cron fired in last N min" intent without false-paging agents
   whose only crons are long-interval: N is derived per-cron from its own schedule, not a
   global constant.

## Change 2 — escalation ladder (reuse, don't invent)
On first overdue detection: log + call `agentManager.reloadCrons(agent)` equivalent via the
scheduler reference (self-heal — covers lost-signal). Still overdue on next check (cron now
2× overdue): fire the EXISTING restart path (`sessionRefresh()` / the same entry the
loop-stall watchdog uses) and count it against the EXISTING circuit breaker. Circuit tripped →
one Telegram page (through existing notify plumbing), then silence per SILENT-OK rules.
State: persist `cron-liveness.flag` (last-check + last-escalation ts) in `paths.stateDir` so
`--continue` restarts don't re-page — same pattern as the persisted circuit-breaker state
(fast-checker.ts ~205, ~1286-1296).

## Change 3 — build-time job-liveness gate (process artifact, small code)
Definition of done for ANY new cron (goes into template `cron-management` SKILL.md +
`templates/*/CLAUDE.md` cron section, same files touched by spec 01):
1. REGISTERED: `bus add-cron` exited 0 (which after spec 02 means live-in-scheduler).
2. FIRED: first fire visible via `bus list-crons <agent>` last-fire column (or execution log)
   — for long intervals, `bus fire-cron <agent> <name>` (handler exists, ipc-server.ts:737+)
   counts as the proof-fire.
3. CANARY-GREEN: the fire produced its intended side effect (agent-defined check).
A cron task may not be closed on step 1 alone. This is documentation + the SKILL checklist;
no new enforcement code in this OBF (hook enforcement can follow if agents keep skipping it).

## Edge cases
- Agent intentionally stopped / daemon shutting down: skip detector when the agent process is
  not running (FastChecker already knows run state).
- Disabled crons: skipped (predicate checks `enabled`).
- Firing-in-progress: `last_fire_attempted_at` is set pre-onFire (iter-11,
  cron-scheduler.ts loadCrons comment) — the candidate-max prevents flagging a long-running
  in-flight fire.
- Hermes agents: no daemon scheduler — detector must skip Hermes runtime agents entirely.
- Clock jumps (sleep/wake on the Mac Mini): if `now - lastCheck > 10min`, treat first check
  after wake as baseline-reset, don't page.

## Tests that prove it
- Unit (extend `tests/unit/daemon/fast-checker.test.ts`): fixture crons.json with a 30m cron
  whose last_fired_at is 90m ago → detector flags + reload called; 20m ago → silent;
  never-fired created 5m ago → silent; disabled → silent.
- Escalation: flagged twice consecutively → sessionRefresh invoked once, circuit-breaker
  counter incremented (mock, assert no real restart).
- Wake-skip: simulate 30min gap between checks → no page on first post-gap check.
