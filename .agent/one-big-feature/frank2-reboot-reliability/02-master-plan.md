# 02-master-plan — frank2-reboot-reliability

## Confirmed root cause (evidence, not hypothesis)

frank2 was disabled 2026-07-26T01:37Z after a reboot loop (~1min-scale cycles, context
regrowing 75K→149K tokens/reboot, ~880K cache_creation tokens burned). Live evidence:

- `~/.cortextos/cortextos1/logs/frank2/restarts.log` + `crashes.log`: from
  2026-07-25T21:56 UTC (the exact minute PR #144 "cron-register-reliability" merged, commit
  `4131b6b`) through disable at 01:37Z, `crashes.log` shows repeating
  `type=session-refresh reason=session-time-cap rollover` entries at an almost exact
  **15-minute cadence** (e.g. 01:19:46 → 01:34:50 → 01:37:14 — the last gap breaks the 15min
  floor entirely, confirming loss of control).
- `~/.cortextos/cortextos1/state/frank2/cron-state.json`: the `pre-meeting-brief-page` cron
  (15m interval per `orgs/clearworksai/agents/frank2/config.json`) has `last_fire:
  2026-07-12T07:50:59Z` — **13+ days stale**, a separate pre-existing cron-dispatch bug. That
  staleness is what PR #144's new liveness detector is (correctly) flagging as overdue.
- `src/daemon/fast-checker.ts:1206-1266` — `checkCronLiveness()` (added by PR #144, Phase 6):
  on the 2nd consecutive overdue check it escalates via
  `this.agent.sessionRefresh().catch(...)` (line 1265) — a bare `--continue` restart
  (`src/daemon/agent-process.ts:456-478`, "Restart with --continue (session refresh)").
  Compare the other two watchdogs in the SAME file, which both call `hardRestart(...)`
  (writes `.force-fresh` + `.restart-planned`, forcing a real fresh/no-`--continue` restart —
  `src/bus/system.ts:78-89`) **before** `sessionRefresh()`:
  - `forceLoopStallRestart()` (line ~1378-1397): `hardRestart(...)` then `sessionRefresh()`.
  - `forceContextRestart()` (line ~1749-1822): `hardRestart(...)` then `sessionRefresh()`.
  `checkCronLiveness()`'s escalation (line 1264-1265) is missing the `hardRestart()` call —
  the spec that shipped it (`.agent/one-big-feature/cron-register-reliability/03-specs/04-fastchecker-cron-liveness.md`,
  "Change 2") explicitly says to reuse "the same entry the loop-stall watchdog uses" and to
  "count it against the EXISTING circuit breaker" — **neither happened**. The implementation
  diverged from its own spec.
- Consequence: every `--continue` restart reloads the full prior conversation history
  (documented in-repo at `agent-process.ts:851-856`, the image-poison comment: "every
  `--continue` restart reloads the same conversation history"). Because restarting the agent
  cannot fix why `pre-meeting-brief-page` stopped updating its own fire state (that is a
  scheduler/dispatch-side bug, not a context/session bug), the cron is STILL overdue on the
  very next check, and `checkCronLiveness()` re-escalates again — bounded only by its own
  15-minute `cronLivenessLastEscalationAt` cooldown (line 1262), which has **no circuit
  breaker**, unlike `ctxCircuitBrokenAt` (context restarts, 3-in-15min → 30min pause) and
  `stallCircuitBrokenAt` (loop-stall restarts, same shape). It retries forever, once every 15
  minutes, each time reloading and re-accumulating the same growing history via `--continue`.
  That is the token-bleed.
- This is a bug newly INTRODUCED by PR #144's Phase 6 addition, not something PR #144 should
  already have fixed for frank2's case — the merge timestamp and the onset of the loop line up
  to the minute.

**Not the root cause** (ruled out with evidence): the fast-checker's Tier 2/Tier 3
context-percentage handoff mechanism (`checkContextStatus`, `forceContextRestart`) already
pre-arms `.force-fresh` before every restart it triggers and behaves correctly in these logs —
its restarts show up correctly labeled `type=planned-restart` with real reasons
(`context handoff at 82%`, etc.) in `crashes.log`. It is not looping on its own. `config.json`
`ctx_warning_threshold`/`ctx_handoff_threshold` (70/80) have never changed in git history for
frank2 — the 60→70/80 threshold-alignment idea from the earlier diagnosis is a real but
separate/lower-priority tuning question, not this incident's cause, and is explicitly OUT of
scope here (also because frank2's `config.json` is git-tracked and any fix must live in daemon
logic, per the task brief).

## Scope (locked)

Fix `checkCronLiveness()`'s escalation path in `src/daemon/fast-checker.ts` so it:
1. Uses a real fresh restart (`hardRestart()` + `sessionRefresh()`, matching
   `forceLoopStallRestart`/`forceContextRestart`) instead of a bare `--continue` `sessionRefresh()`.
2. Has its own persisted circuit breaker (3 escalations in 15min → 30min pause + one Telegram
   page identifying the specific stuck cron by name), mirroring `ctxCircuitBrokenAt`/
   `stallCircuitBrokenAt` and their `.ctx-circuit.json`/`.stall-circuit.json` persistence
   pattern exactly (new file `.cron-liveness-circuit.json`).
3. Survives daemon restarts (persisted to disk, loaded in the constructor like the other two).

This is a **daemon-logic-only** fix. It does not touch any agent's `config.json` (frank2's or
anyone else's) — no risk of clobber-on-sync. It does not touch the register-path work from PR
#144 Phases 0-5 (add-cron reload-verify, instance-dir guard, in-memory-cron removal,
kb-job-run) or `evaluateCronLiveness()`'s overdue predicate itself (`src/daemon/cron-liveness.ts`
is correct and already has full unit coverage — leave it alone). Framework: **one-big-feature**
(single file, single existing repo, additive change, no schema/multi-repo work).

## Phase 1 — circuit-broken fresh restart for cron-liveness escalation (spec 01)

- File: `src/daemon/fast-checker.ts`.
- Add `cronLivenessCircuitRestarts: number[]`, `cronLivenessCircuitBrokenAt: number | null`,
  `cronLivenessCircuitFile: string` fields (next to the existing `cronLiveness*` fields,
  ~line 187-189) and `loadCronLivenessCircuit()`/`saveCronLivenessCircuit()` methods that are
  byte-for-byte the same shape as `loadStallCircuit()`/`saveStallCircuit()` (~line 1356-1376).
  Wire the file path + load call into the constructor next to the other two
  (~line 210-214): `this.cronLivenessCircuitFile = join(paths.stateDir,
  '.cron-liveness-circuit.json'); this.loadCronLivenessCircuit();`.
- Add a circuit-breaker check at the TOP of `checkCronLiveness()` (before the 60s throttle is
  fine either order, but must run before any escalation), matching the reset-after-30min shape
  used by `checkContextStatus()` (~1484-1494) and `evaluateStallWatchdog()` (~1404-1413):
  if `cronLivenessCircuitBrokenAt` is set and less than 30min old, return early (skip the
  whole check that cycle); if ≥30min old, reset arrays/brokenAt and log the reset.
- Replace the escalation body (currently just lines 1264-1265) with a new private method
  `forceCronLivenessRestart(cronName: string, reason: string): void` that:
  1. Filters `cronLivenessCircuitRestarts` to the last 15min, and if it already has 3+ entries:
     sets `cronLivenessCircuitBrokenAt = now`, saves, sends ONE Telegram message (only if
     `this.telegramApi && this.chatId`, same guard style as `forceLoopStallRestart`) naming
     the specific cron and pointing at `logs/<agent>/restarts.log`, and returns WITHOUT
     restarting (mirrors `forceLoopStallRestart`'s trip branch exactly).
  2. Otherwise: pushes `now`, saves, calls `hardRestart(this.paths, this.agent.name,
     \`CRON-LIVENESS-RESTART: ${reason}\`)`, then `this.agent.sessionRefresh().catch(err =>
     this.log(...))` — same two-call sequence as `forceLoopStallRestart`
     (fast-checker.ts:1395-1396) and `forceContextRestart` (fast-checker.ts:1809-1821).
  Call this from `checkCronLiveness()`'s escalation branch (replacing lines 1264-1265) with the
  specific `cron.name` that was found overdue (thread it through — today `anyOverdue` is a bare
  boolean; keep the first overdue cron's name from the loop for the message).
- Reset `cronLivenessOverdueStreak` on a successful escalation is unnecessary (already handled:
  a fresh restart pre-arms `.force-fresh`, the process restarts, and per the standing comment
  at `forceContextRestart` — "sessionRefresh() does stop()+start() on the same AgentProcess and
  does NOT recreate this FastChecker" — `cronLivenessOverdueStreak` and
  `cronLivenessLastEscalationAt` persist across THAT restart, which is what already enforces
  the existing 15-minute re-escalation floor; do not change that timing behavior, only the
  restart mechanism and the circuit breaker on top of it).
- Do not touch `evaluateCronLiveness()` / `cron-liveness.ts` — it is correct and fully tested.

## Verify plan

- `npm run build && npm test` green (existing `tests/unit/daemon/cron-liveness.test.ts` and
  `tests/unit/daemon/fast-checker.test.ts` stall/context circuit-breaker tests must still pass
  unmodified — they are the regression guard for PR #144's prior work).
- New unit tests (see spec 01) proving: (a) 2nd-consecutive-overdue escalation now calls
  `hardRestart` before `sessionRefresh` (mock-verify call order/args, same style as
  `fast-checker.test.ts:441-462`); (b) 3 escalations within 15min trips the circuit, sends one
  Telegram message, and does NOT call `hardRestart` a 4th time; (c) circuit resets after 30min
  simulated elapse; (d) circuit state persists via the `.cron-liveness-circuit.json` file
  (write with one FastChecker instance, construct a second pointed at the same `paths.stateDir`,
  confirm it inherits the broken state) — mirrors how `.ctx-circuit.json`/`.stall-circuit.json`
  are proven persisted today.
- No live-frank2 proof required for this PR (frank2 stays disabled until Larry does a
  Josh-visible re-enable + observation window) — this is a daemon-side fix verified by the
  test suite; a synthetic overdue-cron fixture in the daemon repo's own tests is the correct
  proof surface, not frank2's live state.

## Explicitly out of scope (flag, don't fix here)

- Why `pre-meeting-brief-page` itself stopped updating its fire state on 2026-07-12 (13+ days
  before this incident) is a SEPARATE bug in the cron dispatch/self-report path. Restarting the
  agent was never going to fix it; that's exactly why the missing circuit breaker mattered. File
  a follow-up to investigate `pre-meeting-brief-page`'s dispatch specifically once frank2 is
  back online and can be observed cleanly (the circuit breaker built here will at minimum stop
  it from burning the fleet's tokens while that gets triaged).
- `ctx_warning_threshold`/`ctx_handoff_threshold` alignment to larry's 60/70 (currently frank2 is
  70/80) — real question, not this incident's cause, not blocking re-enable.
