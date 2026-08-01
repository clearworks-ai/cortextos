# Adversarial Review: spec02 (outbound push) + spec03 (inbound poll)

Reviewer: larry (independent verification, worktree `/private/tmp/codexer-multica-spec02-03`, commits `438e032` + `30c6836`)
Date: 2026-07-29

## Verdict

**PASS** — both modules conform to their specs point-by-point, strict-mode/typecheck clean, scope is exactly the 4 declared files, and the test-suite red is verified pre-existing (failing lanes are missing dashboard deps + two pinned tests, zero importers of the new modules exist anywhere).

## Spec Conformance

### Spec 02 — `src/bus/multica/push.ts` (184 lines)

| Criterion | Result | Evidence |
|---|---|---|
| AC1 Exports exactly `runOutboundPush`, `OutboundPushOptions`, `OutboundPlanEntry`, `OutboundPushResult`, locked shapes | PASS | push.ts:7–38 — shapes byte-match the Provided Contracts table (all 7 `OutboundPlanEntry` fields, all 6 result fields incl. `SyncSummary`-aligned count names, verified against spec01's landed `SyncSummary` in types.ts:128) |
| AC2 Bus read-only | PASS | Only `src/bus/task.ts` imports are `listTasks`, `OPEN_TASK_STATUSES` (push.ts:2). Grep-verified: zero mutator imports, zero `src/cli/` imports, no direct `fetch`, no direct fs — ledger touched only via injected `store` |
| AC3 Scope filter matches step 2 | PASS | `listTasks(paths)` + explicit `listTasks(paths, { status: 'cancelled' })`, `.reverse()` for oldest-first (push.ts:44–47, comment present). Unlinked + `!OPEN_TASK_STATUSES.has(status)` → `skip`/`not_pushable` (line 63); linked-any-status falls through to hash gate; linked-but-absent tasks produce no entry (loop iterates the task universe, not the ledger) |
| AC4 Create/update/skip decision incl. null-field edges | PASS | `action = 'create'` iff no link OR (`multica_issue_id === null && last_pushed_hash === null`) (lines 78–82) — the spec03-seeded link (`id` set + null hash) correctly yields `'update'`; pushed-but-unresolved (`hash` set, `id` null) yields `'update'`. `reason: 'new_task'` exactly when `action === 'create'` (line 101). `multica_issue_id` never written |
| AC5 Ledger writes only after 2xx, only 3 fields | PASS | `upsertLink` (lines 129–133) inside try, after `pushIssue` + defensive `status < 200 || status >= 300` throw guard (lines 121–127, real `MulticaHttpError` construction — signature matches client.ts:75). Patch is exactly `{last_pushed_hash, last_pushed_status, idempotency_key}` — never `multica_issue_id`/`last_seen_*` |
| AC6 Never rejects per-task | PASS | Whole push+ledger-write in one per-task try/catch; catch does `errors++`, plan entry `reason: 'push_failed'`/`outcome: 'error'` with ~300-char-truncated message (truncateErrorMessage, line 181), one `console.warn`, `continue`. Crash-safety comment present (lines 160–161) |
| AC7 Dry-run: zero network, zero ledger writes | PASS | dryRun branch (lines 104–117) records `outcome: 'planned'` and counts would-push, `continue` before any `pushIssue`/`upsertLink` |
| AC8 Idempotent by construction | PASS | Unchanged state → hash-match skip; `idempotencyKeyFor` is pure fn of (task.id, hash) — verified in landed mapping.ts:95; hash excludes `action` (mapping.ts:79–92 hashes exactly the eight `issue` subfields — Stop Condition 2 does not fire) |
| AC9 Sequential, one request per task | PASS | Plain sequential `for...of` with `await` per task; no `Promise.all`, no batching, no retries |
| AC10 No new deps, only owned file, build/test | PASS | `package.json` untouched; commit `438e032` touches only push.ts + its handoff. Build/test: see below |

Handoff `spec-02-outbound-push-handoff.md` covers all six required items (a)–(f), including grep-proofs, the as-built `pushIssue` throw-on-non-2xx confirmation, the pasted in-scope predicate, spec05 test-behavior list, and the ledger-GC future-work note.

### Spec 03 — `src/bus/multica/poll.ts` (327 lines)

| Criterion | Result | Evidence |
|---|---|---|
| AC1 Exports exactly `runInboundPoll`, `InboundPollResult`, `InboundAction`, `POLL_PAGE_SIZE=100`, `POLL_MAX_PAGES=20` | PASS | poll.ts:13–32, 39–45. Types defined in poll.ts itself, not added to spec01's types.ts. Signature order `(paths, config, client, store, options?)` matches the locked contract |
| AC2 Loop suppression S1–S3 verbatim + normative ordering | PASS | S1 (line 114), S2 with `expected_from_push` null-handling (lines 110–115), S3 (line 116). Ordering: fetch (line 50) → state load AFTER fetch (line 56) → decide vs pre-refresh snapshot → apply → `refreshObservedLink` last (line 195), for every evaluated link with a resolved issue incl. full no-ops. No-issue-found links get `skipped` with NO refresh (lines 88–91), per step 4a |
| AC3 Mutations only via real mutators; `completeTask` for done, `cancelTask` for cancelled | PASS | `applyStatusWriteBack` (lines 241–257) dispatches `completeTask(..., 'completed via Multica inbound sync')` / `cancelTask(..., 'cancelled via Multica inbound sync')` / `updateTask`. Zero direct task-file writes (grep-verified: no `writeFileSync`/`atomicWriteSync`) |
| AC4 Assignee write-back only via `claimTask(paths, id, 'human')` under A1–A4 | PASS | A1–A4 at lines 123–136 (`shouldClaim` additionally requires `shouldWriteStatus` per the spec's step-5 claim path "S1–S3 all true with target 'in_progress' AND A1–A4"). A1–A3-true/A4-false → `skipped_assignee++` + one warn (lines 137–142, 186–193); `last_seen_multica_assignee_id` refreshed so no re-warn. A3-as-S2-analogue comment present (lines 125–126) |
| AC5 Never writes `last_pushed_status`/`last_pushed_hash`/`idempotency_key`, no priority write-back | PASS | Grep: `last_pushed_status` appears only as a READ in the S2 computation (lines 110–112); no `last_pushed_hash`/`idempotency_key` tokens at all; no priority map imported or applied inbound |
| AC6 Never throws | PASS | `fetchAllIssues` catches all errors (incl. `MulticaHttpError` status 0) → `null` → `errors: 1` + normal resolve (lines 50–54); each mutator call in its own try/catch (`errors++`, warn, continue); whole body in a top-level try/catch (lines 199–203) |
| AC7 Dry-run: zero mutations, zero ledger saves, full `actions` | PASS | Actions pushed unconditionally; mutators and `refreshObservedLink` both gated on `!dryRun` (lines 153, 173, 301–303) |
| AC8 Pagination 100/page, cap 20, warn-and-proceed; unlinked Multica issues ignored | PASS | `fetchAllIssues` (lines 206–239) matches the spec pseudocode exactly incl. short-page early return and cap warning; main loop iterates `state.links`, never `issues` — no bus-task creation |
| AC9 Only owned file, no new deps | PASS | Commit `30c6836` touches only poll.ts + its handoff; `package.json` untouched |
| R4 resolution | PASS | Tolerant predicate `JSON.stringify(issue.context_refs).includes(taskId) || issue.title.includes(taskId)` (line 276); duplicate match → warn with all ids + earliest `created_at` (NaN-safe epoch parse, `id` tiebreak) (lines 259–292); scan only over null-id links; dry-run computes but doesn't save the id patch |
| Task-runs decision | PASS | `getTaskRuns` never imported or called (grep-verified) |
| Terminal guards | PASS | `listTasks` default view = archived/cancelled guard (missing task → skip + refresh, step 4b); explicit `task.status === 'completed'` write-back-immunity (lines 101–105, step 4c) |

Handoff `spec-03-inbound-poll-handoff.md` covers all five required items (a)–(e): push-then-poll cycle-ordering flag for spec04, R4 live field-path UNVERIFIED flag, the A4 assignee-narrowing limitation restated with the concrete unsupported case, and the bounded-single-echo note.

Spec01 as-built cross-check: all consumed contracts verified against the landed code (`MulticaClient`/`SyncStateStore` interfaces live in spec01's types.ts — importing them from `./types.js` is correct, not drift; `MulticaHttpError(message, status, endpoint)` ctor matches; `BUS_TO_MULTICA_STATUS`/`MULTICA_TO_BUS_STATUS` are total over 7/7 statuses; `hashMappedFields` is action-independent). Spec01 handoff records no deviations. No Stop Condition in either spec fires.

## Scope Check

- `git diff --stat origin/main...HEAD`: exactly 4 files, 722 insertions, 0 deletions — `src/bus/multica/push.ts` (184), `src/bus/multica/poll.ts` (327), two handoff docs. No production file outside the owned set touched. No `package.json`/lockfile change, zero new dependencies.
- Working tree clean after commits (the only churn during my verification was test-generated `.cortextOS/state/agents/alice/crons.json{,.bak}` timestamps from running the suite — reverted; the spec03 handoff documents the same churn was reverted by the writer).
- Strict mode: `tsconfig.json` `"strict": true`; independent `npx tsc --noEmit` → exit 0, zero diagnostics. No `any` (typed or cast) in either file. No `console.log` — only `console.warn` degradation warnings, matching the established `crons.ts`/spec01 pattern.
- No scope creep found: no CLI parsing, no cron logic, no retries/backoff, no meeting-pipeline heuristics (marker comment present, push.ts:40–41), no bus-task creation from Multica issues, no `multica_issue_id` writes from push.ts, no `last_pushed_*` writes from poll.ts.

## Build/Test Verification (independent run)

Run by me in `/private/tmp/codexer-multica-spec02-03` after a fresh `npm install` (worktree had no `node_modules`):

- `npm run build` (tsup): **PASS** — "Build success in 67ms".
- `npx tsc --noEmit`: **PASS** — exit 0 (tsup does not typecheck, so I ran this separately; codexer's "strict clean" claim holds).
- `npm test` (vitest): **Test Files 14 failed | 195 passed | 3 skipped (212); Tests 2 failed | 2805 passed | 72 skipped (2879)** — exactly matching codexer's claimed numbers.

**Baseline-red claim CONFIRMED as genuinely pre-existing**, on three independent grounds:

1. **Zero importers**: `grep -rn "multica/push|multica/poll" src tests dashboard` returns no matches outside `src/bus/multica/` itself — nothing in the repo imports the new modules yet (spec04 wires the CLI later), so they cannot affect any existing test by construction.
2. **Failure causes are unrelated**: the 12 collection failures are all `Cannot find package 'next/server'` (9), `'better-sqlite3'` (2), `'react'` (1) in dashboard `__tests__` suites and phase4/phase5 integration suites — dashboard deps not installed at repo root, nothing to do with `src/bus/multica/*`.
3. **The 2 actual test failures are the two named pinned tests**: `tests/integration/concurrent-cron-mutations.test.ts` (test name literally reads "(pinned, expected to FAIL pre-fix)", fails on daemon-scheduler state) and `tests/integration/phase5-e2e-simulation.test.ts` Scenario 7 (fails on the same missing `next/server` import at line 1233).

Full 14-file failure list (my run): `dashboard/src/app/api/comms/__tests__/routes.test.ts`, `dashboard/src/app/api/tasks/*` suite, `dashboard/src/app/api/workflows/crons/__tests__/executions-export.test.ts`, `.../fire-route.test.ts`, `dashboard/src/app/api/workflows/health/__tests__/health-route.test.ts`, `dashboard/src/components/tasks/__tests__/kanban-board.test.ts`, `dashboard/src/lib/__tests__/cost-parser-codex.test.ts`, `.../cost-parser.test.ts`, `.../sync.test.ts`, `tests/integration/concurrent-cron-mutations.test.ts`, `phase4-dashboard-backtest.test.ts`, `phase4-performance.test.ts`, `phase5-e2e-simulation.test.ts`, `phase5-user-journeys.test.ts`.

## Issues Found

None blocking. Three minor observations (no action required before merge; worth carrying into spec04/spec05 context):

1. **poll.ts records an `InboundAction` even when the subsequent mutator throws** (action pushed before the try at lines 145/165) — so on a claim/update failure, `actions` contains an entry whose mutation did not land while `errors` increments and `wrote_back` does not. The spec's `InboundAction` definition ("one entry per planned/performed action") permits this reading, but spec04's `--dry-run`-vs-real output and spec05's assertions should treat `wrote_back`, not `actions.length`, as the count of landed mutations.
2. **Spec-gap edge (matches spec literally, noting for the record)**: if A1–A4 all hold but S1–S3 do not (e.g. S2 suppresses a status echo while the assignee genuinely changed to Josh on a still-pending task), the cycle neither claims nor counts `skipped_assignee` (the warn path requires `!A4`) — the assignee change is silently absorbed into `last_seen_*`. The spec's step-5 path enumeration has the same hole; the implementation follows the spec's claim-path definition ("S1–S3 all true … AND A1–A4 all true") exactly. Practically self-healing (a later status change re-triggers), but spec05 may want a pinning test.
3. **push.ts `not_pushable` entries increment `skipped`** — the spec's step 2 labels these `skip`/`not_pushable` without explicitly assigning a counter; folding them into `skipped` is the natural `SyncSummary`-aligned reading and matches the plan-entry `outcome: 'skipped'`. Spec04 should just be aware `skipped` = hash-unchanged + not-pushable combined.
