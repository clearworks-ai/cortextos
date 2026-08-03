# Master Plan — task-project-default-regression

## Problem
`createTask()` never defaults an unset `project` to the creating agent's name.
Tasks created without `--project` are stored with `project: ''` and rendered
under `(unassigned)` in `cortextos bus list-tasks` project grouping
(`src/cli/bus.ts:873`), instead of self-filing under the agent's own bucket.

## Root Cause (verified 2026-08-02 — see 01-research.md for full derivation)
PR#82 (`feat/createtask-default-project`, 2026-07-06) contains the correct fix
and 3 regression tests but was **never merged** — it is still an open PR against
`main`. `main` has carried the pre-fix ternary continuously. PR#218 (merged
2026-08-02) hoisted that still-broken ternary to an earlier point in
`createTask()` for its own (unrelated, legitimate) due-date-capping feature —
it did not revert anything, because the fix was never present to revert.

## Fix
Apply PR#82's fix logic in place, at the hoisted call site PR#218 established
(~`src/bus/task.ts:735`):
```ts
let project = requestedProject;
if (requestedProject === '') {
  project = SYSTEM_TASK_CREATOR_RE.test(agentName) ? 'system' : agentName;
}
```
`classifyTask()` only special-cases `project === 'system'` / `'human-tasks'`,
so defaulting to an ordinary agent name does not perturb PR#218's class-aware
due-date caps.

## Files Touched
- `src/bus/task.ts` — `createTask()` project-computation block only (~5 lines)
- `tests/unit/bus/task.test.ts` — restore PR#82's 3 regression tests + update 1
  existing assertion

## Done-Condition
- Live repro (`npx tsx` against `src/bus/task.ts`) flips: `createTask(paths,
  'larry', 'acme', 'Test task, no explicit project')` → `content.project ===
  'larry'` (was `''`)
- `npm run build` clean, `npm run typecheck` clean (tsup build does NOT run
  typecheck — must run both separately, per PR#199 lesson)
- `npm test` — full suite green, including the 3 restored regression tests:
  - defaults an ordinary agent task project to the agent name when unset
  - preserves an explicit project when provided
  - keeps a defaulted agent-name project classified as build
- No file outside `src/bus/task.ts` + `tests/unit/bus/task.test.ts` touched
- PR#218's class-aware due-date caps remain intact (existing `computeDefaultDueDate
  — class-aware caps` and `createTask — class-aware default due dates` test
  blocks still pass unchanged)

## Specs
- `03-specs/01-task-project-default-fix.md` — the single code + test change

## PR#82 / PR#218 / this PR relationship
- PR#82: original correct fix, open, unmerged since 2026-07-06. Superseded by
  this PR once merged — Josh should close #82 referencing the new PR (its diff
  targets the pre-hoist line location and no longer applies cleanly).
- PR#218: legitimate, unrelated due-date feature; merged cleanly; not being
  reverted. It exposed the pre-existing gap by needing `project` earlier, but
  it introduced no new bug.
- This PR: lands PR#82's fix at PR#218's hoisted location, restores the 3
  regression tests, keeps PR#218's feature intact.
