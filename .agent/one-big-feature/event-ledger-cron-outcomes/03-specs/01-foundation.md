# Spec 01 — Fleet event and cron foundation

Status: APPROVED by Larry

## Create

1. `src/bus/event-delivery.ts`: strict versioned receipt schema; canonical PII-free IDs; ingress dispositions `accepted | duplicate | rejected | ignored_disabled`; processing states `started | succeeded | failed | needs_human | resync_required | resynced`; locked bounded JSONL append and rotation. Active/shadow routing must fail closed when the receipt cannot be written.
2. `src/bus/event-receipt-index.ts`: locked atomic dedup and cursor/high-water index with restart-safe compare/update operations. Do not reuse the unlocked communications/event dedup ledger.
3. `src/bus/shadow-router.ts`: mode `off | shadow | active`; shadow requires an injected no-op sink, records the proposed route, and has no code path to `sendMessage` or worker spawn.
4. `src/bus/cron-outcome.ts`: states `scheduled | started | dispatched | succeeded | failed | skipped | timed_out | needs_human`; separate stable `run_id` from attempt/retry; reconciliation marks missing terminal receipts timed out.
5. `src/bus/cron-inventory.ts`: pure comparison of config declarations, runtime processes, and daemon schedules; findings for malformed/unreadable input, declared-only, runtime-only, scheduled-only, and definition mismatch.
6. `src/cli/bus-event-receipts.ts`: record/query bounded terminal worker receipts.
7. `src/cli/bus-cron-inventory.ts`: read-only `--json` inventory; never repairs state.

## Modify

- Register both CLIs in `src/cli/bus.ts` following existing patterns.
- Extend `src/daemon/cron-scheduler.ts` to emit `scheduled`, `started`, `dispatched`, and dispatch-failure outcomes while retaining the legacy execution log. Never translate dispatch success into terminal success.
- Add only optional cron metadata to `src/types/index.ts`: `owner`, `timeout_ms`, `expected_output`, `backstop_class`.
- Make `src/cli/bus-activity-ledger.ts` consume new terminal receipts while keeping old logs as compatibility signals.
- Make `src/cli/bus-reconcile.ts` surface malformed configuration instead of substituting `{}`.

## Tests

- New unit tests for all five bus modules.
- Extend `tests/unit/daemon/cron-scheduler.test.ts` and `tests/unit/bus/activity-ledger.test.ts`.
- Test concurrent duplicate acceptance, restart replay, write failure/no route, shadow no-op-only contract, lifecycle ordering, terminal timeout, explicit malformed inventory, and legacy compatibility.
- Run focused Vitest files, `npm run typecheck`, `npm run build`, and `git diff --check`.

## Non-goals

No Gmail/Calendar endpoints, JWT verification, watch calls, provider cursors, PA/Frank adapters, plist/cron/config changes, live routing, or provider resources. Those land in subsequent stacked branches after this foundation passes.
