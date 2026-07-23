# Spec 01 — enforce source-dedup on comms email surfacing

## Scope (verbatim intent)
Automator email notifications must dedupe on the Gmail SOURCE EVENT (message-id), not on rendered
text, and this must be non-bypassable so no agent skill can surface a comms email without it.

## Acceptance criteria
1. Automator's email-surface path pipes Gmail fetch JSON through `cortextos bus comms-filter
   --namespace gmail` (mirrors frank2/pa comms-check-worker), OR passes `--source-key gmail:<messageId>`.
2. Chokepoint enforcement (Part B): a comms-class send WITHOUT a valid source-key is rejected or
   auto-deduped — fail-CLOSED for comms. Non-comms sends unchanged (fail-open preserved).
3. Replay test: 3 bodies / 1 message-id → exactly 1 surfaces. Committed in tests/.
4. `npm run build` clean, `npm test` all green, no `any`, no `console.log`.
5. Shared `comms` skill template updated so every agent inherits the dedup pipe (prevents regressing
   the next new agent).

## Files (confirm at build, grounded starting points)
- src/cli/bus.ts (comms-filter ~3178; send-telegram/send-message --source-key ~1550)
- src/telegram/dedup.ts, src/utils/event-dedup.ts
- orgs/clearworksai/agents/automator/.claude/skills/comms/SKILL.md (+ SYSTEM.md email-surface duty)
- templates/agent/.claude/skills/comms/ (shared template) — verify path
- tests/ — new replay test

## Out of scope
Meeting-commitments "Commitment Due" worker (separate emitter; only touch if it shares the leak).
