# Research: fix-ledger-buildchain-hash-collision

## Root cause

`buildChain()` in `src/pipeline/ledger.ts` resolved a ledger row's predecessor via a
single global map built over every row in the ledger:

```ts
const byArtifact = new Map(rows.map((row) => [row.artifact_sha256, row]));
...
const prev = byArtifact.get(cursor.prev_sha256);
```

The map was keyed on `artifact_sha256` alone, spanning ALL slugs and all time. Because
`Map` construction is last-writer-wins, any two rows anywhere in the append-only ledger
that shared the same `artifact_sha256` (identical artifact bytes) collided: the later row
silently replaced the earlier one as the resolution target for that hash. From that point
forward, every predecessor lookup for that hash — for any slug — resolved to the wrong
row, corrupting chain verification.

## Failure characteristics

- The ledger is append-only, so once a colliding row landed, the corruption was permanent
  for that hash — verification of previously-good chains started failing.
- Collisions crossed slug boundaries: a row from an unrelated slug could hijack
  predecessor resolution for another slug's chain.
- Collisions crossed stage boundaries: a `review` row whose artifact bytes matched a
  `research` artifact shadowed the research row.
- The resulting failure surfaced as `CHAIN_BREAK` (or wrong-stage/OUT_OF_ORDER results),
  with no indication the real problem was hash-keyed lookup ambiguity.

## Production impact

Hit production twice on slug `meeting-intelligence-spec06b-cxportal-dual-write-clean`.
Root cause diagnosed and fix scoped under task `task_1785191310954_50265872`.

## Exact location

`src/pipeline/ledger.ts` — the old `byArtifact` map inside `buildChain()`, replaced by
what is now the `resolvePreviousRow()` function (immediately above `buildChain()`).
