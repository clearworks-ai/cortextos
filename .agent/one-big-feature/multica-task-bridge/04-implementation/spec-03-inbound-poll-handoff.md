# Spec 03 Handoff: Inbound Poll + Write-Back

## Status
- Implemented with no intentional contract deviations from spec03 or the multica-task-bridge master plan.

## Changed Files
- `src/bus/multica/poll.ts`
- `.agent/one-big-feature/multica-task-bridge/04-implementation/spec-03-inbound-poll-handoff.md`

## Contract Confirmations
- `poll.ts` exports exactly:
  - `runInboundPoll`
  - `InboundPollResult`
  - `InboundAction`
  - `POLL_PAGE_SIZE`
  - `POLL_MAX_PAGES`
- `runInboundPoll(paths, config, client, store, options?)` never throws. Top-level failures degrade to `errors += 1` plus a warning and a normal resolve.
- `POLL_PAGE_SIZE` is `100` and `POLL_MAX_PAGES` is `20`.
- Pagination uses `client.listIssues({ limit, offset })` until a short page or the cap, and warns on cap-hit while proceeding with partial results.
- R4 id resolution uses the locked tolerant predicate:
  - `JSON.stringify(issue.context_refs).includes(taskId)`
  - title fallback: `issue.title.includes(taskId)`
  - duplicate matches warn and pick earliest `created_at`, then `id`.
- Loop suppression follows the locked pre-refresh ordering:
  - load ledger snapshot
  - decide against `last_seen_*` plus `last_pushed_status`
  - mutate bus task if needed
  - refresh `last_seen_multica_status` / `last_seen_multica_assignee_id` and resolved `multica_issue_id`
- Status write-back uses only the real bus mutators:
  - `completeTask(..., 'completed via Multica inbound sync')` for `done`
  - `cancelTask(..., 'cancelled via Multica inbound sync')` for `cancelled`
  - `updateTask(...)` for all other status writes
- Assignee write-back is narrowed exactly as required:
  - only `claimTask(paths, taskId, 'human')`
  - only when the bus task is `pending` and polled status maps to `in_progress`
  - all other Josh-assignee changes increment `skipped_assignee`, warn once, and refresh `last_seen_multica_assignee_id` so they do not re-warn next cycle
- `dryRun` performs zero mutators and zero ledger writes while still returning the planned `actions`.

## Required Coordination Notes
- **Cycle ordering assumption for spec04**: this implementation assumes **push then poll** inside a combined sync cycle. That ordering preserves the intended bounded echo suppression behavior because inbound evaluates against the pre-refresh ledger and can suppress the immediate status echo from the prior outbound push.
- **R4 live field-path remains unverified**: the implementation intentionally keeps the tolerant `context_refs` stringify-substring plus title fallback matcher. Spec05 guarded integration coverage and rollout verification still need to confirm where Multica actually echoes the `bus_task_id`.
- **Assignee narrowing limitation**: if Josh reassigns an issue in Multica **without** an accompanying `in_progress` status move, inbound sync will count `skipped_assignee` and warn, but it will not update bus `assigned_to`. That unsupported case still requires either a future `task.ts` reassign mutator or a master-plan amendment.
- **Bounded single-echo behavior**: an inbound status write-back can cause one convergent outbound push on the next cycle because `last_pushed_status` is still the pre-write value. That is expected stabilization behavior, not loop-thrash.

## Grep / Scope Proofs
- Forbidden operations are absent from `poll.ts`:
  - `rg -n "pushIssue|getTaskRuns|atomicWriteSync|writeFileSync|createTask|src/cli" src/bus/multica/poll.ts` returned no matches.
- Ledger push fields are read-only here:
  - `rg -n "last_pushed_status|last_pushed_hash|idempotency_key" src/bus/multica/poll.ts` shows only `last_pushed_status` reads used for echo suppression.

## Verification
- `npm run build` PASS
- `npm test` FAIL before/after this shard in the same baseline-red lanes; no new Multica-specific failure surfaced
  - summary: `14 failed | 195 passed | 3 skipped` files, `2 failed | 2805 passed | 72 skipped` tests
  - persistent unrelated failures:
    - `tests/integration/concurrent-cron-mutations.test.ts`
    - `tests/integration/phase5-e2e-simulation.test.ts`
    - dashboard / integration suites importing missing `next/server`, `react`, and `better-sqlite3`

## Cleanup Notes
- The temporary `node_modules -> /Users/joshweiss/code/cortextos/node_modules` symlink used for verification in the fresh worktree was removed after the build/test run.
- Test-generated timestamp churn in `.cortextOS/state/agents/alice/crons.json` and `.bak` was reverted so the final branch stays scoped to the Multica dispatch only.
