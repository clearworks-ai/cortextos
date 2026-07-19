# 02 — Master Plan: cron task-completion leak fix

Slug: `cron-task-completion-fix` · Repo: `~/code/cortextos` · Framework: one-big-feature
Design: LOCKED (frank2 option b, see `01-research.md`) — validator guard + state migration. Do not redesign.

## Goal

Stop monitoring crons from leaking bus tasks stuck `in_progress`. Two workstreams:

1. **Validator rule** (durable guard): `validateCronsPrompt` rejects any cron prompt that runs `create-task` + `update-task … in_progress` without a `complete-task` in the same prompt. Blocks NEW leaks at every `writeCrons` (src/bus/crons.ts:199).
2. **Migration script** (fix the ~108 existing leaky prompts): sweep `~/.cortextos/*/.cortextOS/state/agents/*/crons.json` (both roots: `cortextos1` + `default`) and strip the `TASK_ID=$(cortextos bus create-task "Cron: …" …); cortextos bus update-task $TASK_ID in_progress …;` bookkeeping segment from leaky prompts, leaving the rest intact.

## Files to touch

| File | Change | Anchor |
|------|--------|--------|
| `src/utils/cron-prompt-validator.ts` | Add `cron-task-leak-no-complete` pattern entry + optional per-pattern `hint` + exported `isCronTaskLeakPrompt()` predicate | pattern floor L21-26; throw site L103-114 |
| `scripts/migrate-cron-task-leak.ts` | NEW — one-shot migration, convention of `scripts/migrate-runtime-field.ts` (exported `runMigration`, tsx entrypoint) | — |
| `tests/unit/utils/cron-prompt-validator.test.ts` | Add lifecycle-leak test cases (existing vitest style: tmpdir CTX_ROOT, `vi.resetModules`, dynamic import) | file exists, extend |
| `tests/unit/scripts/migrate-cron-task-leak.test.ts` | NEW — mirrors `tests/unit/scripts/migrate-runtime-field.test.ts` style | — |

NOT touched: `src/bus/crons.ts` (the gate at L199 already calls `validateCronsPrompt`; no change needed), `src/daemon/agent-manager.ts`, `src/daemon/cron-scheduler.ts`, `src/cli/bus.ts` (`reconcile-crons` at L3049 uses `findBannedCronPrompts` and picks up the new pattern for free).

## Specs

- `03-specs/01-validator-rule.md` — regex, interface change, error message, tests.
- `03-specs/02-migration-script.md` — discovery, strip logic, dry-run/apply, atomic writes, tests.

## Test plan

- Validator: leak prompt (real larry `heartbeat` shape) rejected with pattern id; create+complete one-block prompt (usage-audit shape) allowed; no-task prompt (passive-heartbeat shape) allowed; existing Telegram floor + overlay tests keep passing unchanged (the `findBannedCronPrompts` match shape `{name, patternId}` must NOT change — existing test asserts `toEqual`).
- Migration: fixture crons.json with leaky + good + passive crons → leaky prompt stripped to exact expected string, good/passive byte-identical; single-quote `create-task 'Cron: …'` variant stripped; dry-run writes nothing; `--apply` writes atomically with `.bak`; second `--apply` is a no-op (idempotent); post-strip residue (`$TASK_ID` left over) → manual-review flag, original prompt preserved.

## Verification commands

```bash
npm run build
npm run typecheck
npm test -- tests/unit/utils/cron-prompt-validator.test.ts tests/unit/scripts/migrate-cron-task-leak.test.ts
npm test   # full suite — crons-io / crons-migration / cron-state / reconcile paths must stay green
# live proof (after merge, BEFORE daemon restart on new build):
npx tsx scripts/migrate-cron-task-leak.ts            # dry-run, prints planned strips (~108)
npx tsx scripts/migrate-cron-task-leak.ts --apply
npx tsx scripts/migrate-cron-task-leak.ts            # second dry-run must report 0 leaks
```

## Risk notes

1. **HARD ORDERING RISK — migration must run before (or immediately with) the validator going live.** Once the new binary is running, `writeCrons` (src/bus/crons.ts:199) throws on ANY write of an agent's cron array containing a leaky prompt. The daemon's post-fire bookkeeping (`cron-scheduler.ts:502-520` fire-count/timestamp update) and every `update-cron-fire` CLI call write through this gate — with ~108 leaky crons still in state, cron fires would start erroring fleet-wide. Sequence: merge → run migration `--apply` → restart daemon on new build. The migration is standalone tsx and does not require the new build to be deployed.
2. **Migration touches live runtime state** (`~/.cortextos/**` crons.json for 8+ live agents). Mitigations: default dry-run (`--apply` required to write), `atomicWriteSync(…, keepBak=true)` leaves `crons.json.bak` per file, strip is surgical (only the two bookkeeping commands), post-strip residue check refuses to write a cron it can't strip cleanly.
3. **False-positive risk on the validator**: the regex requires the literal CLI tokens `create-task`, `update-task…in_progress` (within 120 chars), and absence of `complete-task`. Verified against the live fleet inventory (01-research.md table): the match set is exactly the ~108 leaky crons; `usage-audit` (has `complete-task`) and `passive-heartbeat` (no `create-task`) do not match.
4. **Existing test compatibility**: `findBannedCronPrompts` return shape and the Telegram-pattern error message must stay byte-compatible (spec 01 keeps `{name, patternId}` and reproduces the exact current message text for the Telegram pattern via the `hint` field).
5. **Race with a firing cron during `--apply`**: writes are atomic (tmp+rename); a concurrent daemon read sees either old or new file, never a torn one. `readCrons` also recovers from `.bak` on parse failure. Acceptable; optionally run during a quiet window.

## Rollback

- **Code**: revert the PR (single commit revert; no schema/state format change — prompt strings only).
- **State**: per-file `crons.json.bak` written by `--apply`; restore by copying `.bak` over `crons.json` for any agent. Note: restoring leaky prompts while the new validator is live re-triggers risk #1 — pair a state rollback with a code rollback.
- **Validator only**: delete the `cron-task-leak-no-complete` entry from `BANNED_CRON_PROMPT_PATTERNS`; or hot-disable is NOT possible via overlay (overlay only adds patterns) — code revert is the path.
