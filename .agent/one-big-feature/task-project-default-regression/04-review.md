# Review: fix/task-project-default-regression (commit 3c9cdaf)

## VERDICT: PASS

## Checklist

**1. Scope** — PASS. `git show 3c9cdaf --stat` confirms the commit touches exactly two files:
`src/bus/task.ts` (+4/-3) and `tests/unit/bus/task.test.ts` (+21/-1). No other files are part of
this commit (the shared-checkout `git status` shows unrelated dirty state in other agents'
directories, but none of it is in commit 3c9cdaf itself).

**2. Correctness of the fix** — PASS. Old code:
```js
const project = requestedProject === '' && SYSTEM_TASK_CREATOR_RE.test(agentName)
  ? 'system' : requestedProject;
```
New code:
```js
let project = requestedProject;
if (requestedProject === '') {
  project = SYSTEM_TASK_CREATOR_RE.test(agentName) ? 'system' : agentName;
}
```
Explicit `project` always wins (only the `requestedProject === ''` branch is touched). System-creator
agents (matching `/^(transcript-scanner|comms-check|session-save|heartbeat)-/`) still get `'system'`.
All other agents now get `agentName` instead of `''`. Traced downstream: `classifyTask()` only
compares `task.project` against the literal strings `'system'` and `'human-tasks'`; an ordinary
agent name will never accidentally collide with those, so classification and the class-aware
due-date computation are unaffected. `resolveTaskOwner()` is called earlier in the function using
the raw `requestedProject` (unchanged by this diff), so its behavior is untouched. `ensureEpicTask`
matches `task.project === slug` — irrelevant here since slugs aren't bare agent names. No other
caller of `project` was broken.

**3. No `any` type** — PASS. Grepped all added lines (`git show 3c9cdaf | grep '^+' | grep -i any`) — no hits.

**4. No `console.log`** — PASS. Same grep for `console.log` — no hits.

**5. Tests genuinely exercise the previously-broken path** — PASS, traced manually against the old
ternary:
- Modified test (line ~99, agent `'paul'`, no project): old code → `SYSTEM_TASK_CREATOR_RE.test('paul')`
  is false → `project = requestedProject = ''`. New assertion `expect(content.project).toBe('paul')`
  would have FAILED under old code. Confirmed regression test.
- New test "defaults an ordinary agent task project to the agent name when unset" (agent `'larry'`):
  same trace, old code yields `''`, test expects `'larry'` — would have FAILED under old code.
- New test "keeps a defaulted agent-name project classified as build": same defaulting path, also
  would have FAILED under old code (asserts `project === 'larry'`).
- New test "preserves an explicit project when provided" (`project: 'my-epic'`): old code already
  handled this correctly (`requestedProject !== ''` short-circuits to `requestedProject`), so this
  one would have PASSED even pre-fix — it's a non-regression sanity check, not itself proof of the
  bug, but it's a reasonable inclusion to guard the "explicit wins" contract.
- Pre-existing test "auto-tags system-spawned tasks when project is unset" (agent
  `'comms-check-999'`) still passes under both old and new code, confirming the system-creator path
  wasn't broken by this change.

**6. Test suite run** — PASS. `npx vitest run tests/unit/bus/task.test.ts`:
```
Test Files  1 passed (1)
     Tests  141 passed (141)
```
All 141 tests in the file pass, including the 3 new/modified assertions.

**7. Other findings** — None material. The commit message accurately cites the provenance (PR#82
never merged, PR#218 hoisted the still-broken ternary). The `let`-with-reassignment style is a
minor stylistic choice vs. a ternary but is fine and arguably more readable given the two-branch
logic. No safety, scoping, or hygiene issues found.
