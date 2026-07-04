# Spec 01 — cron-prompt-guard

Repo: `/Users/joshweiss/code/cortextos` · Framework: one-big-feature · Slug: `cron-prompt-guard`
Task: task_1783047641385_86467766 (frank2 escalation)

## Verified source anchors (read this session)
- Choke point: `writeCrons(agentName, crons: CronDefinition[]): void` — `src/bus/crons.ts:197-204`. The ONLY persist path.
  - Body: builds `envelope: CronsFile = { updated_at, crons }` then `atomicWriteSync(filePath, JSON.stringify(envelope, null, 2), /* keepBak */ true)`.
  - Callers: `addCron()` L211-220, `removeCron()` L228-239, `updateCron()` L250-267 (all wrapped in `withFileLockSync`), plus the migration path in `src/daemon/cron-migration.ts`.
- Field to scan: `CronDefinition.prompt` — `src/types/index.ts:335` ("The prompt text injected into the agent PTY when the cron fires."). Type block `CronDefinition` ~L300-436.
- CLI error handling already present: add/update-cron handlers in `src/cli/bus.ts` catch and report thrown Errors with a non-zero exit — a thrown validator Error surfaces cleanly without extra wiring.
- Atomic write helper: `src/utils/atomic.ts` (`atomicWriteSync`) — do not modify.

## Part A — validator util (CORE)
New file: `src/utils/cron-prompt-validator.ts`.
- Export `const BANNED_CRON_PROMPT_PATTERNS: readonly RegExp[]` — the compiled-in hard floor. Seed entry (case-insensitive, whitespace-tolerant) matching the confirmed banned prompt:
  - "send" … "(full|entire|all|complete)" … "(human )?task list" … "(via )?telegram"
  - Suggested regex: `/send\b[\s\S]{0,40}\b(full|entire|all|complete)\b[\s\S]{0,40}\b(human\s+)?task\s+list\b[\s\S]{0,40}\btelegram\b/i`
  - Keep each pattern as its own named entry (e.g. `{ id: 'full-human-task-list-telegram', re: /…/ }`) so additions are one line and the reject message can name the matched id.
- Optional per-instance overlay: if `state/cron-banned-patterns.json` exists under the resolved ctx root, load additional patterns (array of `{ id, source, flags? }`) and append to the floor. Malformed/missing file → ignore (floor still applies). Do NOT let a bad overlay throw at import time.
- Export `validateCronsPrompt(crons: CronDefinition[]): void` — for each cron, test `cron.prompt` against every pattern; on first match, `throw new Error(...)` with a message naming the offending cron `name` and the matched pattern `id`, e.g.:
  `Refusing to write cron "human-tasks-check": prompt matches banned pattern "full-human-task-list-telegram". This prompt was blocked to prevent a known Telegram-spam recurrence. Edit the prompt or update state/cron-banned-patterns.json.`
- Also export a non-throwing `findBannedCronPrompts(crons): Array<{ name: string; patternId: string }>` used by the retroactive sweep (Part C) so the sweep can report all offenders without throwing.

## Part B — wire into the choke point
- At the TOP of `writeCrons()` in `src/bus/crons.ts:197`, BEFORE building the envelope / calling `atomicWriteSync`, call `validateCronsPrompt(crons)`.
- Import from `../utils/cron-prompt-validator.js` (match the existing `.js` ESM import style, e.g. `import { atomicWriteSync } from '../utils/atomic.js'`).
- Because add/update/remove and migration all funnel through `writeCrons`, this is the only wiring needed for full coverage.

## Part C — retroactive sweep (read-only)
- New CLI subcommand under the existing `bus` command surface (mirror how other cron subcommands are registered in `src/cli/bus.ts`): `reconcile-crons` (or `check-cron-prompts`).
  - Sweep mode: iterate all agents (reuse whatever agent-enumeration helper the daemon/cli already uses; do not hand-roll a new dir walk if one exists), read each live `crons.json` via `readCrons(agent)`, run `findBannedCronPrompts`, and print a report of offenders (`agent / cron name / patternId`) or "CLEAN". Read-only — never writes.
- Part B of the seed (drift reconciler): also diff `config.json` vs live `crons.json` per agent and LOG divergence via the existing `log-event` path (does NOT auto-apply). If scoping pressure, deliver the banned-prompt sweep first and the config-vs-crons drift diff as a follow-up within this same spec — note in the diff which was completed.

## Tests (sit beside existing)
- Unit — `tests/unit/bus/crons-io.test.ts` (or the nearest existing crons IO test; if none, `tests/unit/utils/cron-prompt-validator.test.ts`):
  - `writeCrons` throws on a banned prompt; passes a clean prompt.
  - Case-insensitive + whitespace/newline variants of the banned prompt are caught.
  - `addCron`/`updateCron` propagate the throw (banned prompt rejected end-to-end).
- CLI — `tests/unit/cli/bus-crons.test.ts` (or nearest): `add-cron`/`update-cron` with a banned prompt exits non-zero with the descriptive message.
- Integration — `tests/integration/crons-migration.test.ts` (or nearest migration test): `migrate-crons --force` with a banned prompt in `config.json` is rejected by the `writeCrons` guard.
- Overlay: a `cron-banned-patterns.json` with an extra pattern causes that pattern to be enforced; a malformed overlay is ignored (floor still enforced).

## Constraints (adversarial-review checklist)
- No `any`. No `console.log` (CLI report uses the existing output/print convention in `src/cli/bus.ts`).
- Do not modify `atomicWriteSync` or the envelope shape.
- Do not change daemon fire semantics or migration idempotency.
- ESM `.js` import specifiers. TypeScript strict clean (`npm run build`). `npm test` green.
- Reject (throw), do NOT silently strip.

## Scope items → coverage map (SCOPE_LOCK)
1. validateCronsPrompt + extensible list → Part A.
2. Wire into writeCrons() → Part B.
3. Confirmed banned pattern → Part A seed regex.
4. Reject-with-message (not strip) → Part A throw.
5. Retroactive sweep → Part C.
6. Config-vs-crons drift reconciler → Part C (phase-2 acceptable, note in diff).
7. Unit + CLI + integration tests → Tests section.
8. Fleet-wide → inherent to per-write choke point.
