# Master Plan: fix-ledger-buildchain-hash-collision

## Fix

Replaced the global `Map<artifact_sha256, LedgerRow>` in `buildChain()` with a
per-cursor helper `resolvePreviousRow(rows, cursor)` that filters predecessor
candidates by all of:

1. `row.slug === cursor.slug` — same slug only; cross-slug rows can no longer collide.
2. `row.artifact_sha256 === cursor.prev_sha256` — hash match to the cursor's
   previous-artifact pointer.
3. `row.ts <= cursor.ts` — predecessor must not be newer than the cursor.
4. `row.stage` in `allowedPreviousStages(cursor.stage)` — only legal stage transitions.

Among matches, the highest-`ts` row wins (sorted descending, take index 0).

## Fallback for error fidelity

When the primary filter resolves no valid predecessor, `buildChain()` runs a secondary
lookup — same slug + `artifact_sha256 === cursor.prev_sha256`, ignoring the ts and stage
constraints — so the correct specific error still surfaces instead of a generic
`CHAIN_BREAK`:

- Conflicting row fails signature verification → `BAD_SIG`.
- Conflicting row has `ts > cursor.ts` → `OUT_OF_ORDER` (non-increasing timestamps).
- Conflicting row's stage not in `allowedPreviousStages(cursor.stage)` → `OUT_OF_ORDER`
  (invalid stage transition).
- No conflicting row at all → `CHAIN_BREAK` as before.

This preserved the behavior the existing chain-integrity tests asserted.

## Verification

- Added regression test in `tests/unit/pipeline/ledger.test.ts`
  (`resolves prior rows by stage and timestamp when artifact hashes collide`): appends a
  hand-signed `review` row whose `artifact_sha256` equals the research artifact's hash,
  then verifies the `research → plan` chain still verifies OK and resolves the correct
  rows.
- Confirmed the full existing suite (18 tests) still passed.

## Delivery

Committed as `894885e` on branch `fix-ledger-buildchain-hash-collision`.
