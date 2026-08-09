# WS1/WS2 execution evidence — 2026-08-08

## Current result: implementation green; live worker receipt remains unclaimed

The loop did not stop at the first red gate. WS1/WS2 implementation is now present in the
daemon and is covered by isolated acceptance tests. WS3 fanout/staging remains intentionally
out of scope for this bounded goal.

### Implemented

- `src/daemon/pipeline-run-store.ts`: atomic revisioned run projection, append-only event log,
  per-run file locking, and CAS conflict detection.
- `src/daemon/pipeline-supervisor.ts`: singleton lock, claim/dispatch, heartbeat, lease expiry
  reclaim, retry budget, fencing tokens, stale-receipt rejection, blocker receipts, and
  `pipeline_dispatch/v1` events.
- `src/daemon/agent-manager.ts`: daemon startup/shutdown owns one supervisor and dispatches
  through the existing signed bus inbox; no second bridge or listener is started.
- `tests/unit/daemon/pipeline-supervisor.test.ts`: claim/trace, lease-reclaim/stale-receipt,
  and current-fence completion cases.

### Verification

- `npx tsc --noEmit` → pass.
- `npm run build` → pass.
- Focused daemon/primitive gate → **50/50 tests passed** across 4 files.
- AgentManager focused regression gate → **36/36 tests passed** across 2 files.
- Earlier post-ABI-repair full suite → **3314 passed, 4 skipped** (recorded before this
  supervisor wiring change).

### Environment-only red results

A subsequent unrestricted full-suite attempt produced 41 failures from sandboxed network/socket
operations (`listen EPERM` on loopback and Unix sockets), plus existing hook/staging timeout
fixtures. Those failures do not touch the supervisor tests or TypeScript build. The full suite
must be rerun in the normal test environment with loopback permission before final acceptance.

### Remaining hard gate

The implementation has not fabricated a live Larry worker reply or signed terminal plan row.
To close WS1/WS2, create the isolated signed research predecessor, dispatch exactly one `plan`
workstream through the bus, capture Larry/Codex's runtime reply, emit the worker-dispatch plan
ledger row, then exercise restart/reclaim and stale-receipt rejection against that same run.
