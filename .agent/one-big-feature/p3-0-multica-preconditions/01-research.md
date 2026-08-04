# P3.0 Multica pilot preconditions — VERIFY-pass research (not a replan)

Dispatched by larry: MASTER-BUILD-PLAN.md v9 `## P3 · Multica task rail` frames 3.0a
(reverse-import) and 3.0b (duplicate-create recovery) as NOT-YET-BUILT pilot preconditions.
Larry flagged this framing as stale this session (same pattern as an earlier P4.1 staleness
catch) — live code inspection shows both are already implemented, wired in, and test-covered.
This doc independently re-derives that claim from primary sources, not from the dispatch prompt.

## 3.0a — Reverse-import: Multica-only issue → bus task

Plan's own done-condition: "scripted test: create an issue directly in Multica → next sync run
creates a linked bus task; assert link row + task exist."

- `src/bus/multica/poll.ts:426` — `function runReverseImport(...)` exists and is exported at
  module scope for testing (not a stub — real body, ~140 lines).
- **Genuinely called, not dead code.** `runInboundPoll` (the function the CLI/cron actually
  invokes) calls `runReverseImport(...)` at `poll.ts:232`, unconditionally, at the end of every
  inbound poll pass (after write-back/resolve-id handling), passing live `paths`, `config`,
  `store`, `state`, `busById`, `issueById`, `resolvedMatches`, `result`, `dryRun`, and
  `options?.importIdentity`. Confirmed by reading both the call site (`poll.ts:232-243`) and the
  function body (`poll.ts:426` onward) directly.
- Behavior matches the done-condition exactly: it iterates `issueById.values()`, skips any issue
  already in `linkedIssueIds` (built from `state.links` + already-resolved matches this run) and
  skips terminal (`done`/`cancelled`) issues, then either (a) heals a crash-window orphan (a bus
  task whose description already carries an `[multica-import:<issueId>]` marker from a prior
  run whose link-write never landed — re-links instead of duplicating), or (b) creates a new bus
  task for a genuinely new Multica-native issue and calls `store.upsertLink(...)` to persist the
  link, guarded by `identity` (skips with a one-time warning if no import identity is configured
  — a deliberate safety gate, not a bug).
- Test coverage, read directly in `tests/unit/bus/multica/poll.test.ts`: a dedicated
  `describe('runInboundPoll - reverse import', ...)` block (line 73) with 5 `it(...)` cases
  matching the plan's own done-condition almost verbatim: `imports an unlinked Multica issue
  exactly once` (86), `dry run imports nothing but reports the plan` (122), `does not re-import
  issues that already have a link` (181), `skips reverse import without identity` (253), `imports
  overdue Multica issue with computed default due_date instead of throwing` (313 — this is the
  PR #185 due_date-truncation interaction, also covered here).

## 3.0b — Duplicate-create recovery

Plan's own done-condition: "scripted test: simulate ledger-write failure after create → next run
detects the orphan by idempotency key/title match and links instead of duplicating; assert issue
count unchanged." The plan quotes `push.ts:164-166`'s own comment verbatim as the motivating gap
("REST creates have no server-side idempotency today...").

- Read `src/bus/multica/push.ts:120-181` directly. On the push side, before issuing a create, the
  code checks `!dryRun && existingIssueId === null && link?.pending_create` (a durable
  write-ahead marker written before the create call — not shown in this excerpt but referenced by
  the recovery block) — meaning: a marker exists (a create was attempted) but no linked issue id
  is recorded (the ledger write after create never landed, exactly the described failure mode).
- Recovery logic (lines 128-181): fetches all remote issues (`listAllIssues(client)`, cached
  per-run), filters candidates by `issue.title === marker.title && !linkedIssueIds.has(issue.id)`,
  sorts by `created_at` ascending, and on a match calls `store.upsertLink(task.id, {
  multica_issue_id: adopted.id, pending_create: null })` — this is the "ADOPTS the match instead
  of creating a duplicate" behavior described in the dispatch prompt, confirmed by direct
  read, not paraphrase.
- Failure-safety is real, not just happy-path: if the remote-issue fetch itself fails, the code
  records a `push_failed` outcome and explicitly `continue`s past the create ("Do NOT create
  blindly — that is exactly the duplicate path", `push.ts:148`, verbatim in-code comment); if the
  ledger write for the adopted link itself fails, it also `continue`s ("Marker survives; retried
  next run.", `push.ts:173`) rather than falling through to a duplicate create. Zero candidates
  found (the original create genuinely never landed) correctly falls through to a fresh create.
- Test coverage, read directly in `tests/unit/bus/multica/push.test.ts`: `re-creates when a
  pending marker exists but no orphan is found remotely` (409) and `does not adopt an issue
  already linked to another task` (430) exist alongside orphan-adoption-path tests (line 364
  onward, `Orphan test task`) — covering both the happy adoption path and the two guard rails
  (fetch-fails / already-linked) above.
- The `reason` union type itself documents the outcome as a first-class case:
  `push.ts:16` — `reason: 'new_task' | 'hash_changed' | 'hash_unchanged' | 'not_pushable' |
  'push_failed' | 'recovered_orphan'` — `'recovered_orphan'` is not an afterthought, it is a
  named, typed outcome the rest of the codebase (and presumably a future dashboard/report) can
  branch on.

## Full multica unit suite — re-run live, not taken on report

```
$ npx vitest run tests/unit/bus/multica/
 Test Files  5 passed (5)
      Tests  52 passed (52)
   Duration  342ms
```
5 files: `client.test.ts`, `mapping.test.ts`, `poll.test.ts`, `push.test.ts`,
`sync-state.test.ts`. All 52 pass, including the 3.0a/3.0b-specific cases enumerated above.

## Live dry-run against production Multica — re-run live

```
$ npm run build   # clean TypeScript compile, no errors
$ node dist/cli.js bus multica-sync --dry-run
{"direction":"both","pushed_creates":131,"pushed_updates":0,"skipped":2444,"wrote_back":0,
 "imported":0,"errors":0,"dry_run":true}
```
Zero errors against live Multica credentials. `imported: 0` in this specific dry-run is expected
and not a red flag: it means no unlinked Multica-native issues exist in the current sandbox/board
right now for 3.0a to import — it does not mean the reverse-import path is unexercised (that is
covered by the 5 scripted `poll.test.ts` cases above, which construct the unlinked-issue
condition deliberately). `pushed_creates: 131` / `skipped: 2444` matches a real, large,
already-synced task population.

## 3.0c — Transport-wart fallback plan (upstream dependencies)

Plan text: upstream fixes `grandamenium/cortextos#762` (ack-path), `#772` (locked-inbox), `#816`
(full task IDs) are named as external dependencies the pilot should not wait for. Fallback rule
per the plan: "cherry-pick the PR branch onto our fork if it stalls >2 weeks after pilot start, or
live with the wart (each is an annoyance, not a data-loss bug)."

Live upstream state, checked directly via `gh pr view <n> --repo grandamenium/cortextos`:

| PR | Title | State |
|---|---|---|
| #762 | fix(bus/daemon): ack-path defects — reply_to send-time ack, dual-dir ackInbox, DEFERRED_CONFIRM with payload attribution | OPEN |
| #772 | fix(bus): a locked inbox must never look like an empty one | OPEN |
| #816 | fix(cli): list-tasks renders full ids + supports --project filter | OPEN |

All 3 confirmed still OPEN. The Multica pilot has not formally started yet (3.1's cron is still
awaiting Josh's manual round-trip, see below), so the plan's own ">2 weeks after pilot start"
clock has not started either. Per the plan's own fallback rule, the correct decision right now is
to live with all 3 warts and record that decision (see `state/fork-deltas.md`, written alongside
this receipt), re-evaluating cherry-picking any one of them if it is still open more than 2 weeks
after the pilot formally starts.

## 3.1 readiness — status only, not executed here

- `gh pr view 185 --repo clearworks-ai/cortextos --json state,mergeCommit` →
  `{"state":"MERGED","mergeCommit":{"oid":"5dcab617a8cbad8bfeb8e9799bc516ab27c423c9"}}` —
  confirmed merged independently (matches larry's live check this session).
- `.agent/one-big-feature/multica-task-bridge/03-specs/04-cron.md` exists on disk (confirmed via
  `ls`) — the 10-min cron spec for `cortextos bus multica-sync` (`src/cli/bus.ts:1256`) is
  already written.
- The cron spec's own design requires Josh to personally run a clean dry-run → `--direction out`
  → `--direction in` round-trip in the Multica UI before the cron is installed. This is a
  deliberate human checkpoint distinct from this session's general no-approval-ping grant (which
  covers routine build/review/merge, not a live two-way sync against real production client task
  data). Not executed here — `--direction out`/`--direction in` were NOT run for real in this
  session; only `--dry-run` (read-only, safe) was exercised.

## Verdict

3.0a and 3.0b are both already built, genuinely wired into the code path the cron/CLI actually
executes (not dead/orphaned functions), covered by passing scripted tests matching the plan's own
done-conditions, and exercised successfully in a live zero-error dry-run against production
Multica. No code changes are required for either item. 3.0c is a decision-record item, not a code
item — recorded in `state/fork-deltas.md`. 3.1 is merged/spec-ready and correctly gated on Josh's
own manual round-trip, not blocked on anything from this receipt.
