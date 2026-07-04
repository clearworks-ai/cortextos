# Master Plan — cron-prompt-guard (banned-prompt validator at the cron write choke point)

## Problem (verified, not assumed)
A banned prompt — "send the full HUMAN task list via Telegram" — keeps resurfacing on the `human-tasks-check` cron (and once on `check-approvals`). It has been hand-patched 3+ times. Josh is frustrated at the repeats and wants a durable, mechanical fix, not another hotfix.

frank2's original theory was that `config.json` was silently replaying into `crons.json`. **That is NOT happening** — verified against cortextos source this session:
- The live daemon fires from `~/.cortextos/<instance>/.cortextOS/state/agents/<agent>/crons.json` (path helper `cronsPathFor()` in `src/bus/crons-schema.ts`).
- The `config.json` → `crons.json` migration exists ONLY as an explicit, one-shot, marker-guarded path (`src/daemon/cron-migration.ts` `migrateCronsForAgent()`; CLI `migrate-crons` in `src/cli/bus.ts`; idempotency marker `.crons-migrated`). It never runs on daemon startup or per-message, and never modifies the original `config.json`.
- **Conclusion:** there is no silent replay. The banned prompt re-enters via some explicit write (an agent re-adding it, a `--force` migration, or a stale hand-add). The exact re-add source is still unconfirmed — so the fix must be **source-agnostic**: a backstop at the single write path that no caller can bypass.

## Approach
Add a **banned-pattern validator at the single cron persist choke point**, `writeCrons(agentName, crons)` in `src/bus/crons.ts:197-204`. This is the ONLY function that persists crons — it is called by `addCron()` (L218), `removeCron()` (L236), `updateCron()` (L264), and the migration path. Validating at the top of `writeCrons()`, before `atomicWriteSync()`, catches EVERY write for EVERY agent automatically, including `migrate-crons --force`.

Why this is the real fix:
- **Choke-point-enforced** — no agent, worker, or migration can persist a banned cron prompt; the check lives in the write itself, not in caller discipline.
- **Fleet-wide for free** — per-write means every agent is covered without per-agent wiring.
- **Extensible** — banned patterns live in one exported const (hard floor, compiled in), optionally augmented by a per-instance `state/cron-banned-patterns.json` so new patterns are a data change, not a code change.
- **Fails loud** — REJECT (throw a descriptive Error naming the cron + matched pattern) rather than silently stripping (which could leave an empty-prompt cron). CLI handlers already catch+report thrown Errors, so the message surfaces cleanly.

## Scope
IN:
1. `validateCronsPrompt(crons)` util + extensible banned-pattern list (compiled-in floor + optional per-instance JSON overlay).
2. Wire into `writeCrons()` before persist — covers add/update/remove/migration.
3. The confirmed banned pattern: send the full/entire/all/complete (HUMAN) task list via Telegram (case-insensitive, whitespace-tolerant).
4. Reject-with-message behavior (names cron + matched pattern), NOT silent strip.
5. Retroactive read-only sweep across all agents' live `crons.json` to detect any banned prompt already present; report offenders.
6. Drift reconciler (Part B) that diffs `config.json` vs live `crons.json` per agent and LOGS divergence via `log-event` (does not auto-apply) — may be sequenced as phase 2 if codexer scopes Part A first.
7. Unit + CLI + integration tests.
8. Fleet-wide coverage (all agents) — inherent to the per-write design.

OUT: any change that auto-rewrites existing crons; removing or altering the existing migration semantics; changing daemon fire behavior.

## Shards
- `03-specs/01-cron-prompt-guard.md` — the validator util + banned list, the `writeCrons()` guard, the retroactive sweep CLI, the reconciler (Part B), and the tests.

## Acceptance
1. `npm run build` clean, `npm test` green including new banned-prompt tests.
2. `writeCrons()` (and therefore add/update-cron and `migrate-crons --force`) throws a descriptive Error when any `cron.prompt` matches a banned pattern; a clean prompt passes; case/whitespace variants are caught.
3. Retroactive sweep run across the live fleet reports offenders (expected: CLEAN — verified no banned prompt live this session).
4. No `any`, no `console.log`; org/instance-safe; atomic-write path unchanged.

## Risk + mitigation
- Over-broad regex false-positives a legitimate cron → patterns are narrow and specific; per-instance JSON overlay lets Josh tune without a deploy; reject message names the exact matched pattern so a false positive is diagnosable.
- Throwing in `writeCrons()` could surprise a caller that didn't expect it → all existing callers already run inside CLI try/catch or file-lock wrappers that propagate errors cleanly; behavior is fail-closed by design (Josh's stated preference: durable block over silent recurrence).
