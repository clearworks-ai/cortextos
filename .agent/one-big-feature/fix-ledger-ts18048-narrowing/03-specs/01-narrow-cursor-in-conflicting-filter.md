# Spec 01 — Narrow `cursor` in the conflicting-row filter

## Target File

`src/pipeline/ledger.ts`

## Location

Function `buildChain(rows: LedgerRow[], terminal: LedgerRow, secret: string): LedgerVerifyResult`
(starts at line 970) — the `if (!prev) { ... }` block around lines 1007-1013.

## Why

`cursor` is declared `let cursor: LedgerRow | undefined` (line 972). Its narrowing to
`LedgerRow` from the `while (cursor)` guard does not survive into the arrow-function
callback passed to `rows.filter(...)` (mutable `let` + closure boundary), so TS reports
TS18048 at lines 1011-1012. Capturing the already-narrowed value in a `const` fixes the
type error with zero runtime behavior change.

## Before

```ts
    const prev = resolvePreviousRow(rows, cursor);
    if (!prev) {
      const conflicting = rows
        .filter((row) =>
          row.slug === cursor.slug &&
          row.artifact_sha256 === cursor.prev_sha256)
        .sort((a, b) => b.ts - a.ts)[0];
```

## After

```ts
    const prev = resolvePreviousRow(rows, cursor);
    if (!prev) {
      const cur = cursor;
      const conflicting = rows
        .filter((row) =>
          row.slug === cur.slug &&
          row.artifact_sha256 === cur.prev_sha256)
        .sort((a, b) => b.ts - a.ts)[0];
```

Exactly two edits inside the `if (!prev) {` block:
1. Insert `const cur = cursor;` as the first statement of the block.
2. Replace `cursor.slug` → `cur.slug` and `cursor.prev_sha256` → `cur.prev_sha256`
   in the filter predicate only.

## Do Not Touch

- Nothing else in `buildChain()` changes — the rest of the `if (!prev)` block
  (the `conflicting` signature/timestamp/transition checks and the `CHAIN_BREAK`
  return) keeps using `cursor` as-is and stays byte-identical.
- No other function or line in `src/pipeline/ledger.ts` changes.
- No other file changes.

## Acceptance Criteria

- `npm run typecheck` — clean; the two TS18048 errors at ledger.ts(1011,24) and
  ledger.ts(1012,35) are gone and no new errors appear.
- `npm test` — full pass, no regressions.
