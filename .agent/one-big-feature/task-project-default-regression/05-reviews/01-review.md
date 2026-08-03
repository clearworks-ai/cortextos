# Adversarial Review — createTask() project-default-to-agent-name fix

Commit reviewed: `3c9cdaf` (`src/bus/task.ts`, `tests/unit/bus/task.test.ts`),
repo `/Users/joshweiss/code/cortextos`. Working tree was clean at review time
(no uncommitted diff), so `git show 3c9cdaf -- src/bus/task.ts
tests/unit/bus/task.test.ts` was used as the diff source.

## Verdict: PASS

## Checklist

**1. Diff matches the plan exactly — no scope drift, no extra edits. PASS**
`git show --stat 3c9cdaf` touches exactly two files: `src/bus/task.ts` (7
lines changed) and `tests/unit/bus/task.test.ts` (21 lines changed) — nothing
else. In `src/bus/task.ts`, the ternary

```
const project = requestedProject === '' && SYSTEM_TASK_CREATOR_RE.test(agentName)
  ? 'system'
  : requestedProject;
```

is replaced with exactly the plan's intended block:

```
let project = requestedProject;
if (requestedProject === '') {
  project = SYSTEM_TASK_CREATOR_RE.test(agentName) ? 'system' : agentName;
}
```

at the same hoisted call site inside `createTask()`, immediately after
`validatePriority(priority)`. No other line in `createTask()` (due-date
block, task object construction, locking/audit code) was touched.

In `tests/unit/bus/task.test.ts`: the pre-existing assertion
`expect(content.project).toBe('');` in the 'creates task with correct JSON
format' test was changed to `expect(content.project).toBe('paul');` exactly
as specified. The 3 new tests were added inside `describe('createTask', ...)`
immediately after the 'creates someday tasks without changing their derived
class' test, with the exact names and assertions from the plan:
- 'defaults an ordinary agent task project to the agent name when unset'
- 'preserves an explicit project when provided'
- 'keeps a defaulted agent-name project classified as build'

**2. No TypeScript `any` types introduced. PASS**
No `any` appears anywhere in the diff; `project` remains implicitly typed as
`string` (same as `requestedProject`).

**3. No `console.log` in committed code. PASS**
No `console.log` (or any console.* call) in either changed file's diff.

**4. All DB queries/storage methods include orgId (org isolation). N/A —
confirmed.**
This change is pure in-memory computation of a task-object field inside
`createTask()`; it does not touch any DB/storage-layer call, and no
org-scoping surface is affected.

**5. Unit tests included for new code paths (the 3 restored tests). PASS**
All 3 tests from the plan are present in the diff, correctly scoped inside
`describe('createTask', ...)`, and each asserts against the JSON written to
disk (`readFileSync(join(paths.taskDir, ...))`), consistent with the file's
existing test style.

**6. `classifyTask()` interaction confirmed safe (does not misclassify a
defaulted agent-name project). PASS**
Read `classifyTask()` (`src/bus/task.ts:90-109`). It classifies as `'system'`
only when `SYSTEM_TASK_CREATOR_RE.test(by)`, `task.project === 'system'`, or
`SYSTEM_TITLE_RE.test(title)`; as `'human'` only when `assigned_to` is
`'human'`/`'user'`, `task.project === 'human-tasks'`, or
`HUMAN_TITLE_RE.test(title)`; otherwise `'build'`. An ordinary defaulted
agent name (e.g. `'larry'`, `'paul'`) matches none of the `'system'` or
`'human'` conditions, so it falls through to `'build'` — exactly what the
third restored test (`'keeps a defaulted agent-name project classified as
build'`) asserts. The `SYSTEM_TASK_CREATOR_RE.test(agentName)` branch inside
the new `createTask()` code still routes system-creator agents to
`project = 'system'` first, so that path is unchanged and still classifies
as `'system'` via `classifyTask()`.

## Test run

`npx vitest run tests/unit/bus/task.test.ts` in `/Users/joshweiss/code/cortextos`:

```
Test Files  1 passed (1)
     Tests  141 passed (141)
```

All 141 tests green, including the 3 restored regression tests and the
updated `'paul'` assertion.

## Summary

| # | Check | Result |
|---|-------|--------|
| 1 | Diff matches plan exactly, no scope drift | PASS |
| 2 | No `any` types introduced | PASS |
| 3 | No `console.log` in committed code | PASS |
| 4 | Org isolation (orgId scoping) | N/A |
| 5 | Unit tests for new code paths (3 restored tests) | PASS |
| 6 | `classifyTask()` interaction confirmed safe | PASS |
| — | `npx vitest run tests/unit/bus/task.test.ts` | 141/141 PASS |

No bugs found. The change is narrowly scoped to the two planned files,
matches the approved plan's exact intended diff, is fully test-covered, and
does not alter `classifyTask()`'s behavior for the pre-existing `'system'`
and `'human-tasks'` special cases.
