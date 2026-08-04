# P3.0 Multica pilot preconditions — true-verify evidence

Re-run live, immediately before this emit, to confirm nothing drifted between the review stage
and this true-verify stage (~3 minutes apart):

```
$ npx vitest run tests/unit/bus/multica/
 Test Files  5 passed (5)
      Tests  52 passed (52)

$ npm run build
CJS Build success

$ node dist/cli.js bus multica-sync --dry-run
{"direction":"both","pushed_creates":131,"pushed_updates":0,"skipped":2447,
 "wrote_back":0,"imported":0,"errors":0,"dry_run":true}

$ git diff main -- src/bus/multica/
(empty)
$ git status --porcelain src/bus/multica/
(empty)

$ gh pr view 185 --repo clearworks-ai/cortextos --json state,mergeCommit
{"mergeCommit":{"oid":"5dcab617a8cbad8bfeb8e9799bc516ab27c423c9"},"state":"MERGED"}
```

## Chain of evidence

1. **Research** (`01-research.md`, `general-purpose`, ledger stage `research`): re-derived 3.0a
   (`poll.ts:426` `runReverseImport`, called unconditionally at `poll.ts:232-243` inside
   `runInboundPoll`) and 3.0b (`push.ts:120-181` orphan-reconcile with two guard rails) directly
   from source; full multica suite 52/52; live dry-run `errors:0`; PR #185 confirmed merged;
   upstream PRs #762/#772/#816 confirmed OPEN.
2. **Plan** (`02-master-plan.md`, subagent-authored, ledger stage `plan`): independently re-read
   the same files (its own line numbers, not copied from research), re-ran the same
   suite/build/dry-run, confirmed no code change required, wrote explicit non-goals (3.2/3.3/3.4
   out of scope for this pass).
3. **Specs** (`03-specs/spec-01-verify.md`, same subagent, ledger stage `specs`): a 6-item
   independent re-derivation checklist for the review stage, naming exact file/line/command
   targets and fail conditions for each.
4. **Review** (`04-review.md`, independent fresh subagent with zero prior context, ledger stage
   `review`): **PASS** — re-derived every item from primary sources itself, traced actual control
   flow (not just in-code comments) for both `push.ts` guard rails, read the full bodies of the
   two load-bearing tests (`poll.test.ts:265` crash-window re-link, `push.test.ts:360`
   no-duplicate-on-ledger-write-failure), confirmed clean build + typecheck + zero-error dry-run +
   empty diff vs `main`. Two trivial non-blocking line-drift notes only, no blocking findings.
5. **True-verify** (this doc): re-ran the same 5 highest-value checks live, immediately before
   this emit. All reproduce identically (vitest 52/52, clean build, dry-run `errors:0`, empty
   diff, PR #185 still MERGED). No regression, no drift.

## Outcome

**No-diff true-verify.** P3.0a (reverse-import) and P3.0b (duplicate-create recovery) are
confirmed already built, merged, live-wired into the code path the CLI/cron actually executes,
and test-covered — the MASTER-BUILD-PLAN.md v9 framing of these as NOT-YET-BUILT pilot
preconditions is stale. This VERIFY pass produces the pipeline receipt for
`p3-0-multica-preconditions`; it does not reopen or rebuild anything.

Delivered alongside this same slug, no separate PR:
- `state/fork-deltas.md` — 3.0c decision record: live with upstream PRs #762 (ack-path), #772
  (locked-inbox), #816 (full task IDs) — all confirmed OPEN — and re-evaluate cherry-picking any
  one of them if it is still open more than 2 weeks after the Multica pilot formally starts.
- 3.1 readiness confirmed as a status-only item, not executed further here: PR #185 (due_date
  truncation fix) merged (`5dcab617`), the 10-min cron spec exists at
  `.agent/one-big-feature/multica-task-bridge/03-specs/04-cron.md`, and installation is correctly
  gated on Josh's own manual dry-run → `--direction out` → `--direction in` round-trip
  confirmation in the Multica UI before the cron is scheduled — a deliberate human checkpoint
  distinct from this session's general no-approval-ping grant. Not executed in this session
  (`--direction out`/`--direction in` were not run for real); not blocking anything else.
