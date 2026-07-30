# Spec 01: resolvePreviousRow

## Function

Added to `src/pipeline/ledger.ts`, directly above `buildChain()`:

```ts
function resolvePreviousRow(rows: LedgerRow[], cursor: LedgerRow): LedgerRow | undefined {
  const allowed = new Set(allowedPreviousStages(cursor.stage));
  return rows
    .filter((row) =>
      row.slug === cursor.slug &&
      row.artifact_sha256 === cursor.prev_sha256 &&
      row.ts <= cursor.ts &&
      allowed.has(row.stage))
    .sort((a, b) => b.ts - a.ts)[0];
}
```

## Call site

Inside `buildChain(rows, terminal, secret)`, the predecessor lookup

```ts
const prev = byArtifact.get(cursor.prev_sha256);
```

was replaced with

```ts
const prev = resolvePreviousRow(rows, cursor);
```

and the global map construction at the top of `buildChain()` —
`const byArtifact = new Map(rows.map((row) => [row.artifact_sha256, row]));` — was
deleted.

## Fallback block (error fidelity when primary filter finds no match)

Inside the `if (!prev)` branch, before returning `CHAIN_BREAK`, a secondary lookup finds
the highest-ts row matching same slug + hash only (ignoring ts/stage constraints):

```ts
const conflicting = rows
  .filter((row) =>
    row.slug === cursor.slug &&
    row.artifact_sha256 === cursor.prev_sha256)
  .sort((a, b) => b.ts - a.ts)[0];
```

If a conflicting row exists, it is checked in order:

1. `!verifyRowSignature(conflicting, secret)` → return
   `{ ok: false, code: 'BAD_SIG', detail: "Invalid signature on <slug>:<stage>" }`.
2. `conflicting.ts > cursor.ts` → return
   `{ ok: false, code: 'OUT_OF_ORDER', detail: "Non-increasing timestamps in <slug> chain" }`.
3. `!allowedPreviousStages(cursor.stage).includes(conflicting.stage)` → return
   `{ ok: false, code: 'OUT_OF_ORDER', detail: "Invalid <prevStage> -> <stage> transition for <slug>" }`.

If none of those match (or no conflicting row exists), the original `CHAIN_BREAK` return
fires unchanged.

## Regression test

`tests/unit/pipeline/ledger.test.ts` — `resolves prior rows by stage and timestamp when
artifact hashes collide`: emits `research` (ts 100) and `plan` (ts 200) rows for slug
`hard-spec-gate`, then appends a hand-signed `review` row (ts 300) whose
`artifact_sha256` equals `researchRow.artifact_sha256` and whose `prev_sha256` is the
plan artifact hash. `verifyChainDetailed({ slug: 'hard-spec-gate', throughStage: 'plan', ... })`
must return `ok: true` with stages `['research', 'plan']` and `rows[0].artifact_sha256`
equal to the research row's hash — proving the colliding later row no longer hijacks
predecessor resolution. Full suite (18 tests) passed with this change.
