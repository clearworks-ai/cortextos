# Spec 01 — Stage vocabulary + signed-ledger support for `staging-verify`

**File(s):** `src/pipeline/ledger.ts`, `src/pipeline/stage-emit.ts`, `src/pipeline/bypass-audit.ts`
**Verify:** `npm run build && npm test`

## Change
1. `src/pipeline/ledger.ts:15-24` — insert `'staging-verify'` into `STAGES` **between `'review'` and `'true-verify'`**:
   ```ts
   export const STAGES = [
     'research','synthesize','plan','specs','implement','review',
     'staging-verify',
     'true-verify','exempt',
   ] as const;
   ```
   `Stage` type derives automatically. No other change to signing/HMAC.

2. `src/pipeline/stage-emit.ts` — `parseStage` (line ~59) already validates against `STAGES`, so `--stage staging-verify` and `--through staging-verify` are accepted once (1) lands. Confirm the usage string (line ~71) needs no hardcoded stage list edit; if it enumerates stages, add `staging-verify`.

3. `src/pipeline/bypass-audit.ts` — audit stage-order logic (`AUTHORED_STAGES` line 25, the `row.stage === 'plan'|'specs'` branches ~520-522, ~868, and `throughStage` union types line 632/676/742/787/808). `staging-verify` is NOT an authored/planner stage — it is an execution-evidence stage like `true-verify`. Wherever `'true-verify'` is handled as a downstream verify checkpoint, `staging-verify` must be recognized as the checkpoint that PRECEDES it in ordering. Do NOT add it to `AUTHORED_STAGES`.

## Ordering contract
Chain order: `... implement → review → staging-verify → true-verify → (pr)`. A `--through staging-verify` walk must succeed independently of whether `true-verify` exists yet (staging-verify happens first).

## Tests (add to existing pipeline test file, mirror `bypass-audit.test.ts` patterns)
- `STAGES` includes `staging-verify` at the correct index.
- `parseStage('staging-verify')` returns it; `parseStage('bogus')` still throws.
- A signed chain `research→...→review→staging-verify` verifies via `--through staging-verify`.
- `staging-verify` is NOT treated as an authored/planner stage by bypass-audit (no false provenance bypass).

## No-gos
- No change to HMAC/secret handling, `provenance_mode`, or transcript-tamper detection.
- No reordering of existing stage constants (append-in-place only, between review and true-verify).
