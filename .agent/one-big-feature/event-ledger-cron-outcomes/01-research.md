# Event ledger and cron outcomes — Research

Status: COMPLETE

- `src/daemon/cron-scheduler.ts` records dispatch as `fired`; it cannot prove terminal job success.
- `src/daemon/cron-execution-log.ts` swallows write failures.
- `src/types/index.ts` only supports `fired | retried | failed`.
- `src/bus/cron-state.ts` is a latest-fire compatibility projection, not an append-only receipt chain.
- `src/utils/event-dedup.ts` is unlocked read-modify-write and cannot model accepted/duplicate/rejected/terminal receipts or transactional provider cursors.
- `src/cli/bus-reconcile.ts` converts malformed config to `{}`, hiding corruption.
- `src/bus/reconcile.ts` does not report runtime-only/scheduled-only jobs or definition drift.
- `src/bus/crons.ts` already exposes corruption and backup-fallback semantics to reuse.

