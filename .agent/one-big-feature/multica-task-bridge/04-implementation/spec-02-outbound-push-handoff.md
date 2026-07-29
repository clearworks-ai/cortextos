# Spec 02 Handoff: Outbound Push

## Status
- Implemented with no intentional contract deviations from spec02 or the master plan.

## Changed Files
- `src/bus/multica/push.ts`
- `.agent/one-big-feature/multica-task-bridge/04-implementation/spec-02-outbound-push-handoff.md`

## Contract Confirmations
- `src/bus/multica/push.ts` exports exactly:
  - `runOutboundPush(paths, client, store, config, options?)`
  - `OutboundPushOptions`
  - `OutboundPlanEntry`
  - `OutboundPushResult`
- Implemented shapes match the locked spec exactly:

```ts
export interface OutboundPushOptions {
  dryRun?: boolean;
  provenanceFor?: (task: Task) => 'meeting-pipeline' | 'bus';
}

export interface OutboundPlanEntry {
  bus_task_id: string;
  title: string;
  action: 'create' | 'update' | 'skip';
  reason: 'new_task' | 'hash_changed' | 'hash_unchanged' | 'not_pushable' | 'push_failed';
  outcome: 'pushed' | 'planned' | 'skipped' | 'error';
  field_hash: string | null;
  idempotency_key: string | null;
  error: string | null;
}

export interface OutboundPushResult {
  pushed_creates: number;
  pushed_updates: number;
  skipped: number;
  errors: number;
  dry_run: boolean;
  plan: OutboundPlanEntry[];
}
```

- `runOutboundPush()` is sequential only: one task at a time, no batching, no parallel requests, no retries/backoff.
- `runOutboundPush()` never rejects on per-task failures. Any `pushIssue()` or `upsertLink()` failure is caught per task, counted in `errors`, recorded in `plan`, warned once, and the loop continues.
- Ledger writes happen only through `store.upsertLink()` and only after a confirmed 2xx push. The patch written is limited to:
  - `last_pushed_hash`
  - `last_pushed_status`
  - `idempotency_key`
- `push.ts` never writes or resolves `multica_issue_id`, and never writes `last_seen_multica_*`.

## Spec01 Behaviors Relied On
- `taskToIssuePayload()` / `hashMappedFields()` / `idempotencyKeyFor()` match the spec01 contracts as landed.
- `hashMappedFields()` hashes only the eight `issue` fields and does not hash `action`, so create/update hashes remain comparable across runs.
- `createSyncStateStore().upsertLink()` provides the required merge semantics, so no direct ledger file access was needed.
- `createMulticaClient().pushIssue()` as landed returns `{ status }` on success and throws `MulticaHttpError` on non-2xx or transport failure.
- `push.ts` still keeps the defensive 2xx guard:
  - if `pushIssue()` ever returns a non-2xx status instead of throwing, `runOutboundPush()` throws locally before any ledger write.

## In-Scope Filter Implemented
- Cancelled tasks are fetched explicitly via:

```ts
const visible = listTasks(paths);
const cancelled = listTasks(paths, { status: 'cancelled' });
const universe = [...visible, ...cancelled].reverse();
```

- Per-task decision predicate implemented:

```ts
const link = state.links[task.id];

if (!link && !OPEN_TASK_STATUSES.has(task.status)) {
  // skip / not_pushable
}

const action = link === undefined || (
  link.multica_issue_id === null && link.last_pushed_hash === null
)
  ? 'create'
  : 'update';

if (link?.last_pushed_hash === fieldHash) {
  // skip / hash_unchanged
}
```

- Resulting behavior:
  - unlinked + open (`pending`, `in_progress`, `blocked`, `waiting`) => create candidate
  - unlinked + `someday` / `completed` / `cancelled` => skip with `reason: 'not_pushable'`
  - linked + any status => create/update action rule above, then hash-gated push or skip
  - linked-but-absent tasks => no plan entry, no ledger mutation

## Grep Proof
- Command outputs from the required purity checks:

```text
task import
2:import { listTasks, OPEN_TASK_STATUSES } from '../task.js';

forbidden bus mutator imports

cli imports

direct fetch

direct fs
```

- These confirm:
  - only `listTasks` and `OPEN_TASK_STATUSES` are imported from `src/bus/task.ts`
  - no bus mutator imports
  - no CLI imports
  - no direct `fetch`
  - no direct filesystem access

## Spec05 Note
- This shard intentionally added no tests; `tests/unit/bus/multica/push.test.ts` remains spec05-owned.
- spec05 should assert:
  - new open task + no link => one `create` push, correct idempotency key, 2xx ledger patch with `multica_issue_id` still `null`
  - unchanged linked task => no push, `skipped++`, `reason: 'hash_unchanged'`
  - changed linked task => `update`, hash refreshed on 2xx
  - linked task moved to `completed`, `cancelled`, or `someday` => one final `update`, then hash-skip on the next run
  - unlinked `completed` / `cancelled` / `someday` => no push, `reason: 'not_pushable'`
  - `multica_issue_id` set + `last_pushed_hash: null` => `update`, never `create`
  - thrown `MulticaHttpError` (401 or `status: 0`) => `errors++`, no ledger write, loop continues
  - mock client returns non-2xx without throwing => defensive guard treats it as failure, no ledger write
  - `dryRun: true` => zero network calls, zero ledger mutation, planned counts/plan match the real run
  - two consecutive unchanged real runs => second run pushes nothing and writes nothing
  - `provenanceFor` override => `meeting-pipeline` only when supplied by the caller
- Test conventions reference:
  - vitest
  - temp `BusPaths` fixture via `mkdtempSync(join(tmpdir(), ...))`
  - `rmSync` teardown
  - mock the `MulticaClient` object directly instead of mocking `fetchImpl`

## Risks / Future Work
- Archived or compacted linked tasks are intentionally left in the ledger if they no longer appear in the task universe. Ledger GC for archived tasks remains out of scope and should be handled later.
- Accepted edge noted in code: if a linked task disappears from the task universe before its terminal status is ever pushed, this module has no object to reconcile. Given the 10-minute cron cadence versus the 7-day archive window, that remains an accepted low-risk edge.

## Verification
- `npm run build` PASS in `/private/tmp/codexer-multica-spec02`
- A temporary `node_modules -> /Users/joshweiss/code/cortextos/node_modules` symlink was created only to run the build in the fresh worktree and was removed immediately afterward.

## Cleanup Notes
- No files outside the owned write scope were modified.
- `package.json` was untouched and no runtime dependencies were added.
