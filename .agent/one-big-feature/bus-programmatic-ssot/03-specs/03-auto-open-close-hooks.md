# Spec 03 — Auto-OPEN / Auto-CLOSE epic hooks (bus-programmatic-ssot #8)

## Why
Categorization + provenance shipped (#80), but 184/187 build tasks are `project=(unassigned)`.
Nothing files a build to its epic at plan/dispatch time, so `bus list-tasks --by-project` is mostly
one giant `(unassigned)` bucket. This spec adds the two idempotent primitives that make every build
dispatch self-file to its epic (OPEN) and let a landed PR retire that epic (CLOSE). Reaper cron
(task-reaper) already handles staleness — do NOT rebuild close machinery; add only these two keyed
primitives.

## Repo
`~/code/cortextos` — framework=one-big-feature, slug=bus-programmatic-ssot.

## Split
- **Codexer writes** (this spec): `src/bus/task.ts` + `src/cli/bus.ts` + unit tests. TS hook logic only.
- **Larry writes** (NOT this spec, follow-up after diff passes): the `gate-codexer-planning.sh` call
  line + M2C1/OBF `SKILL.md` instruction edits. Do not touch shell hooks or skill md.

## Scope — codexer, exactly two idempotent CLI subcommands + their lib functions

### A. `ensureEpicTask(paths, agentName, org, slug, opts)` in `src/bus/task.ts`
Idempotent OPEN. Semantics:
- Look for an existing non-archived task whose `project === slug` AND `status !== 'completed'`
  AND `status !== 'cancelled'`. Match on the **exact** `project` field (the slug), scanning the
  active task store the same way `listTasks` reads it — reuse the existing loader, do not add a new
  index file.
- If one exists → return `{ id, created: false }` (no mutation, no second task).
- If none exists → `createTask(...)` a single epic anchor:
  - `title`: `Epic: <slug>`
  - `project`: `<slug>`  (so `classifyTask` returns `build` — slug is never `system`/`human-tasks`)
  - `assignee`: `opts.assignee ?? agentName`
  - `priority`: `opts.priority ?? 'normal'`
  - `description`: `opts.description ?? ''` (callers pass e.g. `framework=one-big-feature repo=<path>`)
  - return `{ id, created: true }`.
- Pure: no Telegram, no side effects beyond the one task write.

CLI: `bus ensure-epic-task <slug>` with `--assignee`, `--priority`, `--desc`. Prints the epic task id
(existing or new). Exit 0 in both cases. Safe to call on every dispatch.

### B. `closeEpic(paths, slug, opts)` in `src/bus/task.ts`
Idempotent CLOSE. Semantics:
- Find all non-archived tasks with `project === slug` and `status` in {`pending`,`in_progress`,`blocked`,`waiting`}.
- `completeTask(...)` each (reuse existing `completeTask`; do not inline status writes) with
  result string `opts.result ?? 'epic closed (slug landed)'`.
- Return `{ closed: <count> }`. If zero matched → `{ closed: 0 }`, exit 0 (idempotent — safe to re-run).
- `--dry-run` flag: print what WOULD close, mutate nothing.

CLI: `bus close-epic <slug>` with `--result`, `--dry-run`. Prints closed count.

## Constraints (hook-enforced house rules)
- TypeScript strict — no `any`, no `console.log` inside lib functions (CLI action may `console.log` the
  result line, matching existing `create-task`/`complete-task` command style).
- No new storage file, no schema field — `project` already exists on `Task`. This is read+write over the
  existing store only.
- Reuse `createTask`, `completeTask`, and the existing active-task loader. No duplicate task-scan code.
- Atomic writes via the existing task write path (same as createTask/completeTask).

## Tests (required, in `tests/unit/bus/`)
1. `ensureEpicTask` creates exactly one epic when none exists; second call returns `created:false`
   and the task count does not grow.
2. `ensureEpicTask` epic classifies as `build` (assert `classifyTask` === `'build'`).
3. `ensureEpicTask` ignores a completed/cancelled same-slug task and creates a fresh epic (a landed
   epic should not block re-opening a new cycle of the same slug).
4. `closeEpic` completes all open children of the slug and returns the count; re-run returns `closed:0`.
5. `closeEpic --dry-run` mutates nothing.

## Out of scope (Larry follow-up, do NOT build here)
- gate-codexer-planning.sh calling `ensure-epic-task` at pass-time.
- M2C1/OBF SKILL.md edits telling frameworks to call these.
- Auto-invoking close on PR merge (merge is Josh-gated; close primitive is enough for now).
- Draining the 184 existing unassigned (one-time backfill = separate, after primitives land).

## Deliverable
Diff (task.ts + bus.ts + tests) back to Larry for adversarial review. No commit, no push.
