# OBF Master Plan — Wire `--priority` flag into `list-tasks` CLI

**Slug:** wire-priority-flag-listtasks
**Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature (single cohesive ~2-line CLI change, one repo, no schema/migration)
**Requested by:** frank2 (task_1783707168594_26521440) — gates frank2 queue-mgmt cron (task_1783626175076, sage spec)

## Problem
`listTasks(paths, filters)` in `src/bus/task.ts` already supports a `priority` filter
(`src/bus/task.ts:714` — `if (filters?.priority && task.priority !== filters.priority) continue;`).
The `list-tasks` CLI command (`src/cli/bus.ts:470`) does NOT expose a `--priority` option, so
callers cannot filter by priority. frank2's queue-mgmt cron needs `list-tasks --priority urgent`.

## Scope (verbatim)
Expose a `--priority <p>` option on the `list-tasks` command and pass it through to `listTasks`.
Nothing else. No output-format change, no new filter semantics — the filter already exists downstream.

## Acceptance
- `cortextos bus list-tasks --priority urgent` returns only urgent tasks.
- Invalid priority handled by the existing `Priority` type contract (no crash).
- `--priority` absent → behavior unchanged (all priorities shown).
- Unit test asserts the option is parsed and forwarded into the `listTasks` filter.

## Non-goals
- No change to `listTasks` filter logic (already correct).
- No validation UX beyond existing `Priority` union typing.

## Verify
`npm run build` clean + `npm test` (bus list-tasks tests pass).

## Lessons Consulted
- `feedback_obf_m2c1_gate_required` — single cohesive CLI change in one repo, no schema/multi-repo → one-big-feature (not full M2C1) is correct classification.
- `feedback_dispatch_creates_task_standing_rule` — pair the codexer dispatch with the existing bus task (task_1783707168594_26521440) so it isn't lost in queue.
- Coding-standards: no `any`, no `console.log`; match existing commander `.option` style. Do NOT re-implement the filter — `listTasks` at task.ts:714 already applies `filters.priority` (verified by reading source, not memory).
