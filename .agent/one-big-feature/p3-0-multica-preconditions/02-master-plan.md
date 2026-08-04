# P3.0 Multica pilot preconditions — VERIFY-pass master plan

## What this is

MASTER-BUILD-PLAN.md v9's `## P3 · Multica task rail` lists two items — 3.0a
(reverse-import: a Multica-only issue should become a linked bus task) and 3.0b
(duplicate-create recovery: if a create succeeds but the ledger write fails, the
next sync run should detect the orphan and link it instead of creating a
duplicate) — as **not-yet-built** preconditions blocking the Multica pilot.

The 01-research.md receipt in this same directory flagged that framing as stale:
live code inspection shows both are already implemented, wired into the code
path the CLI/cron actually executes, and covered by passing scripted tests. This
plan does not take that verdict on report. It independently re-reads the same
primary sources, re-runs the same commands, and records what THIS pass actually
found, so the chain of custody from source → claim is unbroken and a later,
independent reviewer (a fresh subagent with zero context, working only from
`03-specs/spec-01-verify.md`) can reproduce every claim from scratch.

## Verification methodology — what I inspected, and what I found

All of the following were read/run directly in this session, in this worktree
(`/Users/joshweiss/code/cortextos/.claude/worktrees/agent-a55b90009ab5b79d1`),
not copied from the research doc:

1. **`src/bus/multica/poll.ts`** — `runInboundPoll` is defined at **line 59**
   (`export async function runInboundPoll(`). `runReverseImport` is defined at
   **line 426** (`function runReverseImport(`), a real ~140-line body, not a
   stub. The call site is at **lines 232-243**: inside `runInboundPoll`'s main
   `try` block, `runReverseImport(paths, config, store, state, busById,
   issueById, resolvedMatches, result, dryRun, options?.importIdentity)` is
   invoked unconditionally — no feature flag, no conditional guard — immediately
   before `return result;` at line 245. This is a genuine call in the live
   inbound-poll path, not dead code reachable only from a test harness.

2. **`src/bus/multica/push.ts`** — the orphan-reconcile block lives inside
   `runOutboundPush` (defined at line 32), at **lines 125-181**. The entry guard
   at **line 128** is `if (!dryRun && existingIssueId === null &&
   link?.pending_create)` — i.e. a durable write-ahead marker exists (a create
   was attempted) but no linked issue id was ever persisted (the classic
   post-create-ledger-write-failure orphan). On a hit, it fetches all remote
   issues once per run (`listAllIssues(client)`, lines 130-133, cached in
   `remoteIssues`), filters by `issue.title === marker.title &&
   !linkedIssueIds.has(issue.id)` and sorts oldest-first (lines 151-153), and on
   a match calls `store.upsertLink(task.id, { multica_issue_id: adopted.id,
   pending_create: null })` (line 158) — adopting the existing remote issue
   instead of creating a duplicate. Two guard rails confirmed by direct read:
   - **Fetch failure does not create**: lines 134-149, `catch` block records a
     `push_failed` plan entry and `continue`s past the create, with the in-code
     comment at line 148, `// Do NOT create blindly — that is exactly the
     duplicate path.`
   - **Ledger-write failure (on the adopted link) does not create**: lines
     159-174, `catch` block records `push_failed` and `continue`s, comment at
     line 173, `// Marker survives; retried next run.`
   - Zero remote candidates correctly falls through to a fresh create (comment
     at lines 179-180).
   - The `OutboundPlanEntry.reason` union at **line 16** carries
     `'recovered_orphan'` as a first-class, named outcome, not an ad hoc string.

3. **Test coverage, read directly, not summarized:**
   - `tests/unit/bus/multica/poll.test.ts`: `describe('runInboundPoll - reverse
     import', ...)` opens at **line 73**. I counted **9** `it(...)` cases in
     that describe block before the next `describe` opens at line 354 (lines
     86, 122, 144, 181, 209, 223, 253, 265, 313) — more than the 5 the research
     doc named; the extra 4 (144, 209, 223, 265) are additional due-date and
     assignee/write-back edge cases in the same block, not a discrepancy, just
     a fuller count on my independent pass. Line 265,
     `'re-links crash-window orphan instead of duplicating'`, is the case that
     directly matches the plan's own done-condition language.
   - `tests/unit/bus/multica/push.test.ts`: `describe('multica outbound push',
     ...)` opens at **line 134**. Orphan-adoption-specific cases confirmed by
     direct read: line 360 `'does not create a duplicate issue when the ledger
     write fails after a successful create'` (constructs the exact failure mode
     via a `createFlakyStore` helper, runs the sync twice, and asserts
     `createdTaskIds` stays at length 1 across both runs — i.e. no duplicate),
     line 392 `'aborts the create when the write-ahead marker cannot be
     persisted'`, line 409 `'re-creates when a pending marker exists but no
     orphan is found remotely'`, line 430 `'does not adopt an issue already
     linked to another task'`.

4. **Full multica unit suite, re-run live this session:**
   ```
   $ npx vitest run tests/unit/bus/multica/
    Test Files  5 passed (5)
         Tests  52 passed (52)
      Duration  290ms
   ```
   Matches the research doc's 52/52 pass count exactly (files: `client.test.ts`,
   `mapping.test.ts`, `poll.test.ts`, `push.test.ts`, `sync-state.test.ts`).

5. **Clean build + live dry-run, re-run live this session:**
   ```
   $ npm run build            # clean TypeScript compile, no errors
   $ node dist/cli.js bus multica-sync --dry-run
   {"direction":"both","pushed_creates":131,"pushed_updates":0,"skipped":2445,
    "wrote_back":0,"imported":0,"errors":0,"dry_run":true}
   ```
   `errors: 0` against live Multica credentials, read-only (`--dry-run`), safe.
   `skipped: 2445` here vs `2444` in the research doc's earlier run — a
   one-task drift consistent with normal task-population churn between the two
   sessions, not a functional discrepancy. `imported: 0` is expected: it means
   no unlinked Multica-native issues exist in the current board right now, not
   that the reverse-import path is unexercised (that is what the 9 scripted
   `poll.test.ts` cases above cover deliberately).

6. **No source diff exists for this pass:**
   ```
   $ git diff main -- src/bus/multica/
   (empty)
   $ git status --porcelain src/bus/multica/
   (empty)
   ```
   Confirms this VERIFY pass has not modified, and does not need to modify, any
   file under `src/bus/multica/`.

## Conclusion

Independently re-deriving all of the above (not assuming the research doc's
conclusion) confirms it: **3.0a and 3.0b are both already built**, wired into
the exact code path the CLI/cron executes (`runInboundPoll` → `runReverseImport`
unconditionally; `runOutboundPush`'s orphan-reconcile block gated correctly on
`pending_create` with no linked issue), covered by passing scripted tests that
match the plan's own stated done-conditions, and exercised successfully in a
live zero-error dry-run against production Multica. **No code or config change
is required for either item.** This is this pass's own finding, reached by
independently reading the same files and re-running the same commands — not an
assumption carried over from the research doc.

## Non-goals

This VERIFY pass does **not** build or touch:
- **3.2** — routing split (out of scope)
- **3.3** — bidirectional done-state handling (out of scope)
- **3.4** — legacy-path migration (out of scope)

These are separate, future items on the P3 rail. Nothing in this pass implies
they are also done; they were not inspected here.

3.0c (transport-wart fallback decisions for upstream PRs #762/#772/#816) and 3.1
(cron readiness) are also out of scope for this doc — they are decision-record
and status items respectively, already addressed in 01-research.md and
`state/fork-deltas.md`, and involve no code change either.

## What "done" means for this VERIFY pass

- A signed pipeline receipt covering the full chain: research (01, already
  written and signed) → plan (this doc) → specs (`03-specs/spec-01-verify.md`)
  → review → true-verify.
- The expected, and so-far-confirmed, outcome is **no diff**: the independent
  review stage (a separate subagent, working only from the spec file, with zero
  context from this plan's prose) re-derives the same facts from the same
  primary sources and confirms no wiring defect exists.
- The only condition under which this produces a code change is if that
  independent review step finds a **genuine wiring defect** (not a cosmetic or
  style nit) — in which case the fix must be a small, narrowly-scoped PR
  targeted only at the specific defect found, not a rewrite or expansion of
  scope.
