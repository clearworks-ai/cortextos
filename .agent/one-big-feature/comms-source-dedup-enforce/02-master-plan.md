# Master Plan — comms-source-dedup-enforce

Goal: end reworded-duplicate email notifications for GOOD, no 4th patch. Make source-dedup
NON-BYPASSABLE for comms-class email surfacing.

## Two-part fix
### Part A — wire automator (immediate stop)
Give automator the same protection frank2/pa run: route its email surfacing through
`cortextos bus comms-filter --namespace gmail` (or require `--source-key gmail:<messageId>` on
the send). Mirror comms-check-worker SKILL lines 64-70. Confirm exact emitter first (research open item).

### Part B — enforce at the chokepoint (durable, kills the class)
Make it structurally impossible to surface a comms email without source-dedup:
- Option B1 (preferred): in `send-telegram`/`send-message`, when a send is tagged comms-class
  (e.g. `--kind comms` or presence of an email surfacing), REQUIRE a valid `--source-key`; reject
  (or auto-route through event-dedup) if absent. Fail-CLOSED for comms, not fail-open.
- Option B2: a daemon-level comms send wrapper that every agent's comms skill must call, which
  always applies checkAndRecordSourceEvent. Update the shared `comms` skill template so all agents
  inherit it.
Decide B1 vs B2 in the spec after reading send-telegram internals (src/cli/bus.ts + src/telegram/*).

## Verify (mandatory, real replay — no self-report)
Replay the 3 Dr. Bob sends (same gmail message-id, 3 different bodies) through the fixed path;
assert exactly 1 surfaces, 2 suppressed. Unit test in tests/. Full `npm run build` + `npm test` green.

## Owners
- Part A automator skill/SYSTEM (.md) — Larry may author; land via PR.
- Part B src/*.ts (bus.ts, telegram/*, event-dedup) — codexer under GATE.
- Plan engine: Opus (Fable's spec is the thing that keyed on text; Josh informed, may veto to Fable).

## Gate
Josh: go = YES (2026-07-21 "who cares what time, do the work"). Merge to main still needs Josh OK.
