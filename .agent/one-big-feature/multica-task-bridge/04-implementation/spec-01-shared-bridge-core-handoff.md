# Spec 01 Handoff: Shared Bridge Core

## Status
- Implemented with no intentional contract deviations from spec01 or the master plan Shared Contracts table.

## Changed Files
- `src/bus/multica/types.ts`
- `src/bus/multica/mapping.ts`
- `src/bus/multica/client.ts`
- `src/bus/multica/sync-state.ts`
- `tests/unit/bus/multica/mapping.test.ts`
- `tests/unit/bus/multica/client.test.ts`
- `tests/unit/bus/multica/sync-state.test.ts`

## Contract Confirmations
- `types.ts` defines the shared Multica enums, payload/config/store interfaces, `SyncDirection`, `SyncSummary`, and `MULTICA_SECRET_KEYS` exactly in the spec-owned module instead of `src/types/index.ts`.
- `mapping.ts` exports total `Record` maps for `BUS_TO_MULTICA_STATUS`, `MULTICA_TO_BUS_STATUS`, and `BUS_TO_MULTICA_PRIORITY` with the locked enum mappings from spec01.
- `taskToIssuePayload()` emits `source: 'cortextos-bus'`, carries caller-selected `provenance`, preserves `bus_task_id`, and applies the v1 D5 assignment rule:
  - `assigned_to === 'human' || assigned_to === 'user'` => `assignee_type: 'member'`, `assignee_id: config.memberIdJosh`, `project_id: null`
  - any other assignee stays unassigned in v1 because there is no configured agent-id map
- `hashMappedFields()` hashes exactly these eight issue fields in fixed order:
  - `title`
  - `description`
  - `status`
  - `priority`
  - `assignee_type`
  - `assignee_id`
  - `project_id`
  - `due_date`
- `idempotencyKeyFor()` uses the locked format `cortextos-bus:${busTaskId}:${fieldHash.slice(0, 16)}`.
- `client.ts` exports `sign()`, `resolveMulticaConfig()`, `createMulticaClient()`, and `MulticaHttpError`.
- `sign()` matches the required `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}` contract.
- `createMulticaClient()` uses global `fetch` by default, injects `fetchImpl` for tests, signs the exact serialized POST body, sets `Idempotency-Key`, and surfaces non-2xx / transport failures as `MulticaHttpError`.
- `sync-state.ts` exports `createSyncStateStore()` with `load()`, `loadWithStatus()`, `save()`, `linkFor()`, and `upsertLink()`; writes use `atomicWriteSync(..., true)` and `upsertLink()` is wrapped in `withFileLockSync()`.

## Ledger / Config Details
- Default ledger path: `${process.env.CTX_ROOT ?? process.cwd()}/orgs/clearworksai/state/multica-bridge/sync-state.json`
- `resolveMulticaConfig()` resolution order:
  - explicit `env` argument first (default `process.env`)
  - then `${CTX_ROOT ?? process.cwd()}/orgs/clearworksai/secrets.env`
- Org secrets loading uses `loadEnvFileInto()`, which in current cortextos source resolves through `parseEnvFile()` + `resolveOpRefs()`.
- Required keys: `MULTICA_BASE_URL`, `MULTICA_WEBHOOK_TOKEN`, `MULTICA_WEBHOOK_SECRET`, `MULTICA_WORKSPACE_ID`, `MULTICA_MEMBER_ID_JOSH`
- Optional key: `MULTICA_READ_API_TOKEN`
- Missing required keys or unresolved `op://` values degrade to `null` config with a warning; no throw path was intentionally added in spec01.

## Tolerant Parse Assumptions To Verify Live
- `GET /api/issues` is accepted as either:
  - a bare array
  - or an object wrapping the array under `issues`, `data`, or `items`
- `GET /api/issues/{id}/task-runs` is accepted as either:
  - a bare array
  - or an object wrapping the array under `task_runs`, `taskRuns`, `data`, or `items`
- Invalid individual items are skipped with warnings rather than aborting the whole response parse.
- spec03/spec05 should verify the real Multica response envelope and narrow these assumptions if the live API is stricter.

## Verification
- `npm run build` PASS
- `npx vitest run tests/unit/bus/multica/mapping.test.ts tests/unit/bus/multica/client.test.ts tests/unit/bus/multica/sync-state.test.ts` PASS (`21/21`)
- `npm test` FAIL, but the failures remain outside spec01 ownership:
  - `tests/integration/concurrent-cron-mutations.test.ts` pinned known race failure
  - `tests/integration/phase5-e2e-simulation.test.ts` imports `next/server`
  - dashboard / integration suites failing on missing `next/server`, `react`, and `better-sqlite3`
  - final run summary: `14 failed | 194 passed | 3 skipped` files, `2 failed | 2800 passed | 72 skipped` tests
- No verification failure pointed at `src/bus/multica/*` or `tests/unit/bus/multica/*`.

## Risks / Notes For Follow-on Specs
- spec02/spec03 can rely on the shared contracts as implemented here; no contract amendment is required from this shard.
- The live Multica GET response envelope is still inferred by tolerant parsing and should be confirmed during spec03/spec05 live verification.
- Full-repo `npm test` is not green in this worktree because of unrelated dashboard dependency/test baseline failures; do not describe spec01 as having made the full suite green.

## Cleanup Notes
- A temporary `node_modules -> /Users/joshweiss/code/cortextos/node_modules` symlink was created only to rerun verification in the fresh worktree and was removed afterward.
- Current intended worktree content is the seven spec01 source/test paths above plus this handoff file.
