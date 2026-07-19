# 01 — Research: cron task-completion leak

## Bug
Monitoring crons leak bus tasks stuck in `in_progress`. Each fire runs `TASK_ID=$(create-task "Cron: X"); update-task $TASK_ID in_progress` but never `complete-task`. 31+9 recently bulk-closed by frank2/muse. Source task: `task_1784422726412_80395603`.

## Root cause (decisive)
The leaky prompts split `TASK_ID=$(create-task ...)` and any completion across **separate agent Bash tool calls**. Shell state does NOT persist between an agent's Bash calls, so `$TASK_ID` is empty by the time a `complete-task` would run — even if one were appended. That is *why* they leak. The correct patterns run all task bookkeeping in **one bash block**:
- `passive-heartbeat` (larry) — creates NO task, just `update-cron-fire` + `update-heartbeat` + `log-event`. No leak.
- `usage-audit` (larry) — create + in_progress + `complete-task` all in one block. No leak.

## Fix surface (file:line)
### Source — validator (durable guard)
- `src/utils/cron-prompt-validator.ts` — `validateCronsPrompt(crons)`. Currently only rejects one banned pattern (`full-human-task-list-telegram`, ~L21-26). NO rule for task-lifecycle leak. Called from `src/bus/crons.ts:199` `writeCrons()` — runs on every add/update-cron write. Read-only audit variant `findBannedCronPrompts` used at `src/cli/bus.ts:3049` (`reconcile-crons`).
- Importers: `src/bus/crons.ts:23`, `src/cli/bus.ts:39`.

### Source — cron firing (context only, NOT the fix)
- `src/daemon/agent-manager.ts:1323-1364` `onFire(cron)` — reads `cron.prompt` verbatim (L1324), wraps `[CRON FIRED {ts}] {name}: {prompt}` (L1330), injects into agent PTY (L1353). No post-processing, no task tracking. Daemon never sees `$TASK_ID`.
- `src/daemon/cron-scheduler.ts:500` `fireWithRetry(...)`. Post-fire (L502-520) updates fire count/timestamp only — no task completion hook. Confirms daemon-side auto-complete is NOT viable (task id invisible to daemon).

### Runtime state — the leak inventory (migration target)
Leaky = prompt has `update-task ... in_progress` WITHOUT `complete-task`. Across both roots (`~/.cortextos/cortextos1` + `~/.cortextos/default`), `state/agents/*/crons.json`:

| agent | leaky crons |
|-------|-------------|
| frank2 | 32 |
| sage | 20 |
| larry | 18 |
| muse | 9 |
| crm | 9 |
| pa | 8 |
| maven | 6 |
| hunter | 6 |

**~108 distinct per-agent cron entries.** Examples: larry `heartbeat`, `repo-health`, `uptime-check`, `dependency-audit`, `pr-review-reminder`, `test-status`, `upstream-sync`, `playwright-coverage`.

### Existing tests
- `tests/unit/utils/cron-prompt-validator.test.ts` — banned-pattern + overlay tests. No lifecycle test.
- `tests/unit/bus/crons-io.test.ts`, `tests/integration/crons-migration.test.ts`, `tests/unit/bus/cron-state.test.ts`, `tests/unit/bus/crons-schema.test.ts`.

## Design decision (frank2 option b)
Monitoring crons should NOT create a bus task per fire — the fire is already recorded by `update-cron-fire` + `log-event`. The task is pure noise.
1. **Validator rule** — reject a cron prompt that `create-task`s + marks `in_progress` without a `complete-task` in the same prompt. Prevents new leaks at write time.
2. **Migration** — strip the `TASK_ID=$(create-task "Cron: ...")` + `update-task $TASK_ID in_progress` bookkeeping lines from the ~108 leaky prompts (they become passive-heartbeat-shaped). Crons that already complete correctly (usage-audit) are left untouched.

## Plan engine
Fable 5 HIGH (frank2-delegated 2026-07-19T05:23Z; Josh quiet overnight, authorized autonomous pick). Bounded mechanical fix.
