# Spec 04: CLI + Cron + Secrets + Wiring

**Feature**: multica-task-bridge
**Depends on**: spec01 (merged), spec02 (merged), spec03 (merged) — all confirmed live in `src/bus/multica/`
**Status**: Ready for dispatch

## Goal

Wire the already-landed `push.ts` + `poll.ts` shards into one deterministic CLI subcommand (`cortextos bus multica-sync`), add the `MULTICA_*` secret placeholders, and author (not install) the cron JSON snippet for Josh's manual rollout. No new sync logic — this shard is pure integration glue.

## Owner Files (exclusive — do not touch anything else)

- `src/bus/multica/index.ts` (new)
- `src/cli/bus.ts` (additive block only — one new `.command('multica-sync')` block; do not reformat/touch any existing command)
- `orgs/clearworksai/secrets.env.example` (additive block only)
- `.agent/one-big-feature/multica-task-bridge/03-specs/04-cron.md` (new — doc/patch artifact, NOT a live crons.json edit; path judgment call: master plan text says `.agent/.../04-cron.md`, this shard places it alongside the other spec docs under `03-specs/` for discoverability — matches the prior progress-log record of this same call)

Do not create or modify tests — spec05 owns `tests/unit/bus/multica/*` and any CLI-level test.

## Locked Contracts From Landed Shards (read-only reference, do not re-derive)

`src/bus/multica/types.ts` exports `SyncDirection = 'out' | 'in' | 'both'` and `SyncSummary`:
```ts
export interface SyncSummary {
  direction: SyncDirection;
  pushed_creates: number;
  pushed_updates: number;
  skipped: number;
  wrote_back: number;
  errors: number;
  dry_run: boolean;
}
```

`src/bus/multica/client.ts` exports:
- `resolveMulticaConfig(env?: Record<string, string | undefined>): MulticaConfig | null` — returns `null` (with one `console.warn`) if any required key (`MULTICA_BASE_URL`, `MULTICA_WEBHOOK_TOKEN`, `MULTICA_WEBHOOK_SECRET`, `MULTICA_WORKSPACE_ID`, `MULTICA_MEMBER_ID_JOSH`) is missing/unresolved. This is the no-secrets-safety path — do not add a second check for it.
- `createMulticaClient(config: MulticaConfig, fetchImpl?: typeof fetch): MulticaClient`

`src/bus/multica/sync-state.ts` exports:
- `createSyncStateStore(filePath?: string): SyncStateStore` — default param already resolves the correct ledger path; call with zero args.

`src/bus/multica/push.ts` exports:
- `runOutboundPush(paths: BusPaths, client: MulticaClient, store: SyncStateStore, config: MulticaConfig, options?: OutboundPushOptions): Promise<OutboundPushResult>`
- **Argument order: `(paths, client, store, config, options?)`**

`src/bus/multica/poll.ts` exports:
- `runInboundPoll(paths: BusPaths, config: MulticaConfig, client: MulticaClient, store: SyncStateStore, options?: { dryRun?: boolean }): Promise<InboundPollResult>`
- **Argument order: `(paths, config, client, store, options?)` — NOTE this is `client`/`store` transposed relative to `runOutboundPush`'s `client, store` order vs poll's `config, client, store`. Do not copy-paste one call signature into the other; verify each against its own export above.**

Master plan (`02-master-plan.md`, spec03 handoff §"Required Coordination Notes") locks the cycle ordering: **push runs before poll** in a combined `both` cycle. This is required for the loop-suppression behavior (poll evaluates against the pre-refresh ledger written by push) — do not parallelize or reorder.

## `src/bus/multica/index.ts` — New File

Export one orchestration function that both the CLI and (later) any other caller can use. It must:

1. Call `resolveMulticaConfig()`. If `null`, return a `SyncSummary` with all counters `0`, `dry_run` as passed through, `errors: 0` (this is the no-secrets-safety path — a missing config is NOT an error condition per the master plan's R2/Validation #6; log one warning via `console.warn`, already done inside `resolveMulticaConfig`, do not double-warn) and return immediately — no client/store construction, no throw.
2. Otherwise construct `createMulticaClient(config)` and `createSyncStateStore()` once and reuse both across push and poll.
3. Run push (if `direction` is `'out'` or `'both'`) then poll (if `direction` is `'in'` or `'both'`), in that order, passing `dryRun` through to both.
4. Merge results into one `SyncSummary`:
   - `pushed_creates` / `pushed_updates` / push-side `skipped` / push-side `errors` from `OutboundPushResult` (when push ran, else `0`)
   - `wrote_back` from `InboundPollResult.wrote_back` (when poll ran, else `0`)
   - `skipped` = push `skipped` + poll `skipped` + poll `skipped_assignee` (when each ran)
   - `errors` = push `errors` + poll `errors`
   - `dry_run` = the passed-through flag
   - `direction` = the passed-through direction
5. Function signature: `export async function runMulticaSync(paths: BusPaths, options: { direction: SyncDirection; dryRun?: boolean }): Promise<SyncSummary>`. This function must never throw — any unexpected error from push/poll (both already catch their own per-item errors per spec02/spec03, but guard the outer call anyway) is caught, counted in `errors`, logged once via `console.warn`, and a summary is still returned. This is what makes the CLI command safe for a cron to fire unattended (master plan R2).

## `src/cli/bus.ts` — Additive Block

Add one new command, in the same style as the existing `sweep-due-tasks` block (see `src/cli/bus.ts:1197`, mirrors `--dry-run` flag handling and `resolveEnv()` / `resolvePaths()` usage):

```ts
busCommand
  .command('multica-sync')
  .description('Two-way sync between cortextOS bus tasks and Multica issues (push open tasks out, poll Multica status/assignee changes back in)')
  .option('--dry-run', 'Preview the sync plan without pushing, polling writes, or ledger mutation')
  .option('--direction <d>', 'Sync direction: out | in | both', 'both')
  .action(async (opts: { dryRun?: boolean; direction: string }) => {
    if (!['out', 'in', 'both'].includes(opts.direction)) {
      console.error(`Invalid --direction '${opts.direction}'. Must be one of: out, in, both`);
      process.exit(1);
    }

    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const summary = await runMulticaSync(paths, {
      direction: opts.direction as SyncDirection,
      dryRun: opts.dryRun === true,
    });

    if (!opts.dryRun) {
      logEvent(paths, env.agentName, env.org, 'agent_activity', 'multica_sync_completed', 'info', {
        direction: summary.direction,
        pushed_creates: summary.pushed_creates,
        pushed_updates: summary.pushed_updates,
        wrote_back: summary.wrote_back,
        errors: summary.errors,
      });
    }

    console.log(JSON.stringify(summary));
  });
```

Add the import line alongside the other `../bus/*` imports near the top of `src/cli/bus.ts`:
```ts
import { runMulticaSync } from '../bus/multica/index.js';
import type { SyncDirection } from '../bus/multica/types.js';
```

This satisfies the master plan's CLI contract: `cortextos bus multica-sync [--dry-run] [--direction out|in|both]` prints one-line JSON, exits 0 on success (no explicit `process.exit(0)` needed — commander's default action-complete exit is already 0; only the `--direction` validation error path calls `process.exit(1)`).

Agent-activity feed scoping (master plan "Agent-activity feed" section): the `logEvent(..., 'agent_activity', 'multica_sync_completed', ...)` call above is the full v1 scope — task-status-only, one event per non-dry-run sync cycle. Do not add per-task events, do not stream `event.ts` beyond this one call.

## `orgs/clearworksai/secrets.env.example` — Additive Block

Append (do not reorder existing keys, do not fill in real values — this file is the example/template):

```
MULTICA_BASE_URL=
MULTICA_WEBHOOK_TOKEN=
MULTICA_WEBHOOK_SECRET=
MULTICA_READ_API_TOKEN=
MULTICA_WORKSPACE_ID=
MULTICA_MEMBER_ID_JOSH=
```

Add a one-line comment above the block noting these are resolved via `resolveMulticaConfig()` / `MULTICA_SECRET_KEYS` (`src/bus/multica/types.ts`) and installed by Josh into `orgs/clearworksai/secrets.env` per the master plan's Rollout Plan step 2 — do not add op:// placeholder values, Josh supplies those himself from his self-hosted Multica instance.

## `.agent/one-big-feature/multica-task-bridge/03-specs/04-cron.md` — Doc/Patch Artifact

This is documentation for Josh to install manually per Rollout Plan step 5 — it must NOT be applied to any live `crons.json` by this shard or by codexer. Write a markdown file containing:

1. A one-paragraph explanation: this cron is not installed automatically; Josh installs it only after a clean manual round-trip (`--dry-run`, then `--direction out`, then `--direction in`) per the master plan Rollout Plan.
2. The exact cron JSON object to add to larry's `crons.json`, following the `refresh-briefs-dashboard` SILENT-OK pattern (self-reschedule via `update-cron-fire`):

```json
{
  "name": "multica-sync",
  "prompt": "cortextos bus update-cron-fire multica-sync --interval 10m 2>/dev/null; SILENT-OK sync: run exactly this one bash command and nothing else, then respond OK (no Telegram, no other work): cortextos bus multica-sync --direction both",
  "schedule": "10m",
  "enabled": true,
  "description": "Two-way sync between cortextOS bus tasks and Multica issues (push open tasks, poll status/assignee changes back)"
}
```

3. A short checklist mirroring Rollout Plan steps 2-6 (secrets installed → dry-run inspected → `--direction out` confirmed in Multica UI → `--direction in` confirmed → cron installed at 10m → one day watched for loop-thrash via `agent_activity` events / `cron-execution.log`).

## Explicitly Out of Scope For This Shard

- Installing the cron into any live `crons.json` (Josh does this manually, Rollout Plan step 5).
- Installing real `MULTICA_*` secret values (Josh does this, Rollout Plan step 2).
- Any change to `push.ts`, `poll.ts`, `mapping.ts`, `client.ts`, `sync-state.ts`, or `types.ts` — those are spec01-03, already merged and locked. If you believe one of their exports doesn't support the integration described above, STOP and report the mismatch rather than editing an owned file out of scope.
- Tests (spec05).
- Full-event-stream agent-activity (explicitly deferred in master plan, task-status-only v1 only).

## Validation

1. `npm run build` — TypeScript strict, clean. No `any`.
2. Manual smoke (no secrets installed in this environment — expected path): `cortextos bus multica-sync --dry-run` exits 0, prints a `SyncSummary` JSON line with all counters `0` and no thrown error (proves the no-secrets-safety path, master plan Validation #6).
3. Manual smoke: `cortextos bus multica-sync --direction bogus` exits 1 with the invalid-direction error, no JSON printed.
4. Confirm `src/bus/multica/index.ts` imports only from sibling `src/bus/multica/*` modules (no new imports of `../task.ts` mutators — those stay inside `push.ts`/`poll.ts` per their existing ownership).
5. Grep proof `src/cli/bus.ts` diff touches only the new command block + two new import lines — no reformatting of unrelated commands.

## Handoff Requirements

Same shape as spec01-03 handoffs (`.agent/one-big-feature/multica-task-bridge/04-implementation/spec-04-cli-cron-secrets-handoff.md`): Status, Changed Files, Contract Confirmations (confirm the exact `runMulticaSync` signature landed, confirm push-then-poll ordering preserved, confirm no-secrets path returns zero-count summary without throwing), Verification (build output), Risks/Notes for spec05.
