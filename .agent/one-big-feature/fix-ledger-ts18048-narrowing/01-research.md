# Research — fix-ledger-ts18048-narrowing

## Trigger
PR#165 (`fix-ledger-buildchain-hash-collision-v2`) CI job "Build & Type Check" fails:

```
src/pipeline/ledger.ts(1011,24): error TS18048: 'cursor' is possibly 'undefined'.
src/pipeline/ledger.ts(1012,35): error TS18048: 'cursor' is possibly 'undefined'.
```

## Root cause
`buildChain()` (`src/pipeline/ledger.ts:970`) declares `let cursor: LedgerRow | undefined = terminal;` and loops `while (cursor) { ... }`. Inside the loop body, direct references to `cursor` narrow fine. But inside the arrow-function closure passed to `rows.filter(...)` at line ~1009-1012 (built when `resolvePreviousRow` returns falsy, to find a conflicting row), TypeScript cannot guarantee `cursor` is still non-undefined by the time the closure runs — `let`-bound narrowing does not cross closure boundaries — so it widens back to `LedgerRow | undefined` inside the callback, tripping `noUncheckedIndexedAccess`/strict-null TS18048.

## Scope
Pure type-narrowing fix, no behavior change. Compare with the sibling function `resolvePreviousRow` (ledger.ts:959) which takes `cursor: LedgerRow` as a plain (non-optional) parameter — no closure-narrowing problem there because the param type is already non-optional.

## Fix shape
Inside the `if (!prev) { ... }` block (ledger.ts ~1008-1013), capture `cursor` into a new `const cur = cursor;` right before the `rows.filter(...)` call, then reference `cur.slug` / `cur.prev_sha256` inside the filter predicate instead of `cursor.slug` / `cursor.prev_sha256`. `const` bindings narrow correctly across closures.
