# Research — task-project-default-regression

## Bug
`createTask()` in `src/bus/task.ts` does not default an unset `project` to the
creating agent's name. Every task created without an explicit `--project` still
lands in the `(unassigned)` bucket (`src/cli/bus.ts:873` — `projectName ||
'(unassigned)'`), and `content.project` is stored as `''`.

## Root cause (verified 2026-08-02 — corrects the standing assumption this was a
"regression introduced by PR#218")

**PR #82** (`clearworks-ai/cortextos#82`, branch `feat/createtask-default-project`,
commit `34e4948`, authored 2026-07-06 by Josh Weiss + Claude Opus 4.8) contains the
correct fix:
```ts
let project = requestedProject;
if (requestedProject === '') {
  project = SYSTEM_TASK_CREATOR_RE.test(agentName) ? 'system' : agentName;
}
```
plus 3 regression tests and one updated assertion in `tests/unit/bus/task.test.ts`.

**PR #82 was never merged.** `git merge-base --is-ancestor 34e4948 HEAD` fails, and
`git branch --contains 34e4948` shows only the feature branch, not `main`. `gh pr
view 82 --repo clearworks-ai/cortextos` confirms `"state":"OPEN"`.

Because PR#82 never landed, `main` has carried the **pre-fix** ternary
continuously:
```ts
const project = requestedProject === '' && SYSTEM_TASK_CREATOR_RE.test(agentName)
  ? 'system'
  : requestedProject;   // <- '' stays '' instead of defaulting to agentName
```
Verified directly: `git show 091c793^:src/bus/task.ts` (the commit immediately
before PR#218's merge) already contains this exact pre-fix ternary near the bottom
of `createTask()` (originally added ~line 556, pre-hoist).

**PR #218** ("class-aware default due-date caps in createTask", merged
2026-08-02, mgmt-automation shard1) needed the `project` value earlier in the
function (to classify the task before computing the due-date cap), so it
**hoisted** this same still-broken ternary from the bottom of `createTask()` to
just after `validatePriority(priority)` (~line 735). It did not change the
ternary's logic — it moved already-broken code. There is no "revert" to speak
of: the fix was never on `main` for PR#218 to revert.

The 3 regression tests from PR#82 were likewise never on `main` — confirmed by
`tests/unit/bus/task.test.ts:99` still asserting the pre-fix behavior:
```ts
expect(content.project).toBe('');
```

## Live reproduction (2026-08-02, `npx tsx` against `src/bus/task.ts` on `main`)
```
$ npx tsx /tmp/repro_task_project.ts
project field: ""
BUG (does NOT default to agent name)
```
`createTask(paths, 'larry', 'acme', 'Test task, no explicit project')` stores
`project: ''` instead of `project: 'larry'`.

## Fix
Apply PR#82's fix logic at the **hoisted** location PR#218 introduced (line
~735 on current `main`), preserving PR#218's due-date-capping feature untouched:
```ts
let project = requestedProject;
if (requestedProject === '') {
  project = SYSTEM_TASK_CREATOR_RE.test(agentName) ? 'system' : agentName;
}
```

`classifyTask()` (line 90) only special-cases `project === 'system'` and
`project === 'human-tasks'` — an ordinary agent name in `project` does not
change classification, so this fix does not perturb PR#218's class-aware
due-date caps or any other `classifyTask` consumer. Verified by reading
`classifyTask()` and re-running the full existing `computeDefaultDueDate —
class-aware caps` / `createTask — class-aware default due dates` test blocks
after the fix (see 03-specs).

## Scope
- `src/bus/task.ts` — `createTask()` project-computation block (~5 lines, same
  hoisted location PR#218 put it)
- `tests/unit/bus/task.test.ts` — restore the 3 original PR#82 regression tests
  + update 1 existing assertion (`content.project` from `''` to `'paul'` in
  `'creates task with correct JSON format'`)

Grepped the full test file for any other `.project).toBe('')` assertions tied to
`createTask()` output — only the one at line 99. The other `project: ''`
occurrences (lines 911, 1068, 1798) are hand-built mock `Task` objects unrelated
to `createTask()`'s defaulting logic.

## PR #82 disposition
PR#82 is the original, still-open, never-merged fix. Once this new PR lands with
the fix applied at the current (post-#218-hoist) call site plus the restored
tests, PR#82 is superseded and should be closed by Josh referencing the new PR —
its diff no longer applies cleanly against `main` (the hoist moved the target
lines) and its content is fully subsumed by this fix.
