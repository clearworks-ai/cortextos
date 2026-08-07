# Event ledger, shadow router, and cron outcomes

Status: APPROVED by Larry

## Goal

Create a locked, bounded, redacted receipt foundation that distinguishes notification acceptance, routing attempts, and terminal worker outcomes; add a shadow router that cannot enqueue work; and make cron inventory/outcomes truthful without breaking legacy consumers.

## Source targets

- New: `src/bus/event-delivery.ts`, `event-receipt-index.ts`, `shadow-router.ts`, `cron-outcome.ts`, `cron-inventory.ts`.
- New CLI: `src/cli/bus-event-receipts.ts`, `src/cli/bus-cron-inventory.ts`.
- Modify: `src/cli/bus.ts`, `src/daemon/cron-scheduler.ts`, `src/cli/bus-activity-ledger.ts`, `src/cli/bus-reconcile.ts`.
- Modify `src/types/index.ts` only for optional cron metadata (`owner`, `timeout_ms`, `expected_output`, `backstop_class`).

## Safety invariants

- PII-free canonical event IDs and bounded receipt records.
- Locked JSONL appends, rotation, atomic dedup/cursor index, and fail-closed writes.
- Router modes `off | shadow | active`; shadow accepts only an injected no-op sink and cannot reach `sendMessage`.
- Scheduler dispatch is never terminal success. Terminal receipts are separate; missing terminal receipt can reconcile to `timed_out`.
- Inventory is read-only, explicit about malformed/unreadable state, and never repairs registries.
- Legacy cron execution logs/state remain compatibility signals.

## Definition of done

Focused tests cover acceptance/duplicate/rejection, receipt failure, restart dedup, shadow non-routing, outcome transitions, inventory corruption/drift, and scheduler legacy compatibility. Typecheck/build/diff-check pass. No external state changes.

