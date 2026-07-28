# Master Plan — fix-ledger-ts18048-narrowing

## Goal

Unblock PR#165 CI, which fails on `npm run typecheck` with:

```
src/pipeline/ledger.ts(1011,24): error TS18048: 'cursor' is possibly 'undefined'.
src/pipeline/ledger.ts(1012,35): error TS18048: 'cursor' is possibly 'undefined'.
```

Zero behavior change — this is a pure TypeScript type-narrowing fix.

## Root Cause

In `buildChain()` (src/pipeline/ledger.ts:970), `let cursor: LedgerRow | undefined` is
narrowed to `LedgerRow` inside the `while (cursor)` loop body, but the arrow-function
closure passed to `rows.filter(...)` at lines 1009-1013 cannot rely on that narrowing
across the closure boundary (`cursor` is a mutable `let`), so TS widens it back to
`LedgerRow | undefined` inside the callback.

## Steps

1. Edit `src/pipeline/ledger.ts` per spec `03-specs/01-narrow-cursor-in-conflicting-filter.md`:
   inside the `if (!prev) { ... }` block, add `const cur = cursor;` as the first line and
   use `cur.slug` / `cur.prev_sha256` in the filter predicate.
2. Run `npm run typecheck` — must be clean (the two TS18048 errors gone, no new errors).
3. Run `npm test` — full pass.
4. Commit and push on branch `fix-ledger-buildchain-hash-collision-v2` (the existing PR#165 branch).
5. Report the commit sha.

## Out of Scope

- No other changes to `src/pipeline/ledger.ts` — the surrounding logic of `buildChain()`,
  `resolvePreviousRow()`, and everything else in the file stays byte-identical.
- No changes to any other file.
