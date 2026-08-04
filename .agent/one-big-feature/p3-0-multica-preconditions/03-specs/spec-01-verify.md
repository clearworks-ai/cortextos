# spec-01-verify — Independent re-verification checklist (P3.0 Multica preconditions)

## Purpose

This checklist is for a **fresh subagent with zero prior context** on this
task. Do not read `02-master-plan.md`'s prose as a source of truth — treat its
claims as hypotheses to re-derive independently from the primary sources named
below. Every item names the exact file, line range, or command to inspect/run
so you don't have to guess or search. Work in the worktree:
`/Users/joshweiss/code/cortextos/.claude/worktrees/agent-a55b90009ab5b79d1`
(confirm this is where you actually are before running anything — `pwd`).

Goal: confirm (or refute) that P3.0a (reverse-import) and P3.0b
(duplicate-create recovery) are already implemented, wired into the live code
path, and test-covered — with no code change required. If you find a genuine
discrepancy, **do not paper over it** — document it precisely and flag for
escalation instead of rubber-stamping.

---

## 1. `runReverseImport` exists and is called unconditionally from `runInboundPoll`

- Open `src/bus/multica/poll.ts`.
- Confirm `export async function runInboundPoll(` is defined starting at
  **line 59**. If the line number differs in your checkout, note the actual
  line and continue — line drift alone is not a failure, a missing/renamed
  function is.
- Confirm `function runReverseImport(` is defined at **line 426**, with a real
  function body (not a one-line stub, not `throw new Error('not implemented')`
  or similar).
- Inside `runInboundPoll`, confirm there is a call `runReverseImport(paths,
  config, store, state, busById, issueById, resolvedMatches, result, dryRun,
  options?.importIdentity)` at **lines 232-243**, and that:
  - It is inside the function's main execution path (not inside an `if
    (someFeatureFlag)` block, not inside a comment, not inside a test-only
    branch).
  - It is unconditional — no gating condition wraps the call itself.
  - It appears before the function's `return result;` (line 245 in this
    checkout).
- **Fail condition**: the call is missing, is commented out, is gated behind a
  flag that defaults off, or `runReverseImport` is a stub/no-op.

## 2. Orphan-adoption logic in `push.ts` + two guard rails

- Open `src/bus/multica/push.ts`.
- Confirm `export async function runOutboundPush(` is defined starting at
  **line 32**.
- Confirm the `OutboundPlanEntry.reason` union type at **line 16** includes
  `'recovered_orphan'` as a listed literal.
- Confirm the orphan-reconcile block sits at roughly **lines 125-181**, gated
  by the condition at **line 128**: `if (!dryRun && existingIssueId === null &&
  link?.pending_create)`.
- Confirm the block:
  - Fetches remote issues via `listAllIssues(client)` (around lines 130-133),
    cached in a `remoteIssues` variable so it only happens once per run.
  - Filters remote issues by `issue.title === marker.title &&
    !linkedIssueIds.has(issue.id)` and sorts by `created_at` ascending (around
    lines 151-153).
  - On a match, calls `store.upsertLink(task.id, { multica_issue_id:
    adopted.id, pending_create: null })` (around line 158) — this is the
    "adopt instead of duplicate-create" behavior.
- **Guard rail A — fetch failure must not create.** Confirm the `catch` around
  the `listAllIssues` call (around lines 134-149) records an error/`push_failed`
  outcome and `continue`s past the create for that task, rather than falling
  through to a create call. Look for the in-code comment near line 148 (`Do NOT
  create blindly`) as a marker, but verify the actual control flow, not just
  the comment.
- **Guard rail B — ledger-write failure (on the adopted link) must not create.**
  Confirm the `catch` around the `store.upsertLink(...)` call for the adopted
  match (around lines 159-174) also records an error and `continue`s, rather
  than falling through to create a duplicate. Look for the comment near line
  173 (`Marker survives; retried next run.`) as a marker, but verify the actual
  control flow.
- Confirm the "zero candidates" case (no remote orphan found) correctly falls
  through to the normal create path below the block (around lines 179-183),
  i.e. genuinely-lost creates still get retried, they don't silently vanish.
- **Fail condition**: either guard rail is missing (i.e. a fetch failure or a
  failed ledger write on the adopted link falls through to an actual create
  call, producing a duplicate), or the match logic doesn't check
  `linkedIssueIds` (which would let it steal an issue already linked to a
  different task).

## 3. Re-run the multica unit suite

```bash
npx vitest run tests/unit/bus/multica/
```

- Confirm all 5 files pass: `client.test.ts`, `mapping.test.ts`,
  `poll.test.ts`, `push.test.ts`, `sync-state.test.ts`.
- Confirm the total pass count. As of this spec's authoring it was **52/52**.
  If your count differs, note the actual number — a changed count (not just a
  renumbering) is worth flagging.
- Specifically confirm these tests exist and pass (do not just trust the
  aggregate count — spot-check the actual test bodies):
  - `tests/unit/bus/multica/poll.test.ts`, inside `describe('runInboundPoll -
    reverse import', ...)` (around line 73): the case
    `'re-links crash-window orphan instead of duplicating'` (around line 265).
  - `tests/unit/bus/multica/push.test.ts`, inside `describe('multica outbound
    push', ...)` (around line 134): the case `'does not create a duplicate
    issue when the ledger write fails after a successful create'` (around line
    360) — read its body; it should run `runOutboundPush` twice with a flaky
    store that fails the post-create ledger write on run 1, and assert
    `createdTaskIds` stays at length 1 across both runs (i.e. no duplicate
    create happened on run 2).
- **Fail condition**: any test fails, or either of the two named tests above
  doesn't exist / doesn't actually assert no-duplicate behavior.

## 4. Clean build + live dry-run

```bash
npm run build
node dist/cli.js bus multica-sync --dry-run
```

- Confirm the build completes with no TypeScript errors.
- Confirm the dry-run JSON output has `"errors":0`. This hits live Multica
  credentials but is read-only/dry-run — safe to run.
- `imported` may legitimately be `0` (no unlinked Multica-native issues in the
  current board right now) — this is not a failure, the reverse-import path's
  correctness is established by the scripted tests in item 3, not by this
  live run producing a nonzero import count.
- **Fail condition**: build fails, or dry-run returns nonzero `errors`.

## 5. Confirm no source diff is needed

```bash
git diff main -- src/bus/multica/
git status --porcelain src/bus/multica/
```

- Both commands should return empty output in this worktree.
- **Fail condition**: either command shows a diff/untracked change — if so,
  identify what it is and whether it's related to this task before concluding
  anything.

## 6. Pass / fail criteria

- **PASS** → no-diff true-verify outcome: all of items 1-5 reproduce as
  described above (function exists and is called unconditionally, both guard
  rails are real, 52/52 tests pass including the two named cases, clean build
  + zero-error dry-run, no source diff). Sign off with your own re-derived
  line numbers/output, not by citing this spec's numbers back.
- **FAIL / escalate** → if ANY item does not reproduce (missing call site,
  missing/weakened guard rail, a failing test, a build error, nonzero dry-run
  errors, or an unexpected diff), do not rubber-stamp. Document the exact
  discrepancy (what you expected per this checklist vs. what you actually
  found, with file:line or command output) and escalate rather than silently
  treating the plan's conclusion as authoritative.
