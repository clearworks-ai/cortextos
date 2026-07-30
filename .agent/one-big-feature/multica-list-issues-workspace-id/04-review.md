# Review 04 — multica listIssues workspace_id fix + --limit flag

Reviewer: architect (Opus). Independent review of `git diff origin/main...fix/multica-list-issues-workspace-id`.
Build: `npm run build` clean. Tests: `npx vitest run tests/unit/bus/multica/` → 4 files, 24 tests, all pass.

## Point 1 — workspace_id fix matches spec exactly

PASS. `src/bus/multica/client.ts:137` adds exactly one line:
`endpoint.searchParams.set('workspace_id', normalizedConfig.workspaceId);`
placed immediately after the URL construction at line 136 (`new URL(.../api/issues)`) and before the optional `limit`/`offset` handling — precisely as spec 01 step 1 requires. `normalizedConfig.workspaceId` is the correct field (defined at client.ts:102/111, and used the same way by the webhook/read paths). No other `MulticaClient` method touched (only `listIssues` changed in client.ts). Webhook/auth/retry behavior untouched. Matches spec 01 non-goals.

Test update (`tests/unit/bus/multica/client.test.ts`): the error-path assertion now expects the endpoint string with `?workspace_id=workspace-123` (line 109 of test), and the success-path test now parses the outbound URL and asserts `workspace_id === config.workspaceId`, plus `limit=10` / `offset=5` (lines 140-145). This actually asserts the new behavior, not just existence.

## Point 2 — --limit flag matches its handoff doc

PASS on every sub-point:

- Interface addition: `OutboundPushOptions.limit?: number` (push.ts:9); `runMulticaSync` options gain `limit?: number` (index.ts:29 in diff); CLI option added (bus.ts:1260).
- Break condition counts only actual pushes, not skips: `hasReachedPushLimit` (push.ts:193-200) tests `result.pushed_creates + result.pushed_updates >= limit`. Both skip paths (`not_pushable` push.ts:69-82, `hash_unchanged` push.ts:92-105) `continue` without incrementing, so skips never advance the counter. The top-of-loop guard (push.ts:63) only fires once the *push* counter has reached limit. Correct.
- `>=` semantics / `limit:0` = push nothing: `hasReachedPushLimit` uses `>=`, so with `limit:0` the top-of-loop guard (push.ts:63) is true on the first iteration (`0+0 >= 0`) and breaks before any processing → empty plan, zero pushes. Verified by test scenario 3 (`plan` toEqual `[]`, `pushedTaskIds` length 0).
- NOT applied to inbound poll: `runInboundPoll` (index.ts:55) is called with `{ dryRun }` only — no `limit` threaded. Correct per handoff line 28.
- CLI validation matches `--direction` style: both use `console.error(...)` + `process.exit(1)` (bus.ts:1262-1265 for direction, 1268-1274 for limit). The limit check additionally uses a `/^\d+$/` regex so non-numeric / negative / zero input is rejected with "Must be a positive integer." Note: the CLI rejects `--limit 0` as invalid, while `runOutboundPush(limit:0)` still means "push nothing" at the function level — this is consistent, not contradictory: the handoff's `limit:0` behavior is a function-level edge case (master-plan lines 48-50), and the CLI's "positive integer" validation is master-plan line 33. Both hold.

## Point 3 — no out-of-scope files touched

PASS. `git diff --name-only` returns exactly the 6 permitted files: client.ts, index.ts, push.ts, cli/bus.ts, client.test.ts, push.test.ts. `types.ts` and `mapping.ts` are NOT modified (handoff non-goal). client.ts is touched only by commit 8e0d452 (the workspace_id fix that owns it), not by the limit feature.

## Point 4 — correctness bugs

None found. Detailed trace:

- No off-by-one. Two break sites exist: the top-of-loop guard (push.ts:63) and post-increment breaks (push.ts:122 dry-run, push.ts:155 live). The post-increment breaks are a redundant-but-safe early exit; even if removed, the top-of-loop guard would catch the reached limit on the next iteration before processing. Neither double-processes a task nor pushes one over limit. With limit N and >N pushable tasks, exactly N pushes occur (verified: scenario 1, limit 20 → 10 creates + 10 updates = 20, and `pushedTaskIds` length 20).
- `hasReachedPushLimit` is null-safe: guards `typeof limit === 'number' && Number.isFinite(limit)` before comparing, so `undefined` limit (no cap) always returns false and every pushable task is pushed (scenario 2). `NaN`/Infinity can't reach the function anyway because the CLI regex-validates, but the `Number.isFinite` guard defends the direct-call path too.
- Correct param name `workspace_id` (snake_case on the wire, matching the read-init pattern of the other calls).
- No type errors (build passes, strict mode). The test's fake `MulticaClient` is annotated with the real interface type, so it must implement `pushIssue`/`listIssues`/`getTaskRuns` (types.ts:120-125) — it does; no type hole masked.
- No race condition: the loop is sequential `await` per task; the limit counter is a plain field mutated in the same async context.

## Point 5 — test coverage actually asserts behavior

PASS. `tests/unit/bus/multica/push.test.ts` (new, 184 lines) has three real assertions, not smoke tests:
1. "caps outbound pushes at the provided limit without counting skipped tasks" — seeds 1 hash-unchanged (skip) task + 10 creates + 12 update-eligible tasks, runs with `limit:20`, asserts `pushed_creates===10`, `pushed_updates===10`, total 20, `skipped===1`, `pushedTaskIds` length 20, and that the skip task appears in the plan with `action:'skip'`, `reason:'hash_unchanged'`. This directly proves skips don't count toward limit.
2. "pushes every pushable task when no limit is provided" — 2 creates + 1 update, no limit, asserts all 3 pushed, 0 skipped.
3. "pushes nothing when the limit is zero" — asserts empty plan and zero pushes.

Ordering is made deterministic via explicit `created_at`/`updated_at` timestamps, matching the module's oldest-first universe reversal — so the assertions are stable, not accidental.

---

VERDICT: PASS
