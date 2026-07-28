# Adversarial Review — fix-ledger-buildchain-hash-collision

**Commit:** 894885e (`fix: resolve ledger buildChain predecessor by slug+stage+ts, not global hash map`)
**Branch:** fix-ledger-buildchain-hash-collision
**Files:** src/pipeline/ledger.ts, tests/unit/pipeline/ledger.test.ts
**Reviewer:** architect (Opus)
**Date:** 2026-07-27

## Verdict: APPROVED

The fix is correct, minimal, and provably closes the reported collision bug. The regression test is a genuine red→green test (verified it fails on the pre-fix source). Build compiles clean, full ledger suite passes 18/18. No blocking issues.

---

## What the fix does (verified in full file context)

- Deletes the global `const byArtifact = new Map(rows.map((row) => [row.artifact_sha256, row]))` (was old ledger.ts:957) that keyed a single map by `artifact_sha256` across all slugs and all time — last-writer-wins on any byte collision.
- Adds `resolvePreviousRow(rows, cursor)` (ledger.ts:959-968) which filters candidates by: `slug === cursor.slug` **AND** `artifact_sha256 === cursor.prev_sha256` **AND** `ts <= cursor.ts` **AND** `stage ∈ allowedPreviousStages(cursor.stage)`, then picks highest-ts. This is the correct predecessor scoping.
- Replaces the map lookup at ledger.ts:1007 with `resolvePreviousRow`.
- Adds a fallback diagnostic block (ledger.ts:1008-1042): when no valid predecessor resolves, it looks for a same-slug same-hash "conflicting" row and, if found, returns a specific `BAD_SIG` / `OUT_OF_ORDER` instead of a blanket `CHAIN_BREAK`, preserving the granularity the old integrity tests expect.

## Correctness checks performed (adversarial)

1. **Signature-verification asymmetry — SAFE.** `resolvePreviousRow` does *not* call `verifyRowSignature`, unlike the emit-time `latestPreviousRow` (ledger.ts:352-358). This is not exploitable: the resolved `prev` becomes `cursor` (ledger.ts:1050) and the very next loop iteration verifies its signature at the top of the loop (ledger.ts:977) *before* any break. A forged predecessor — including a forged `prev_sha256 === GENESIS` terminator — is caught, because the GENESIS break (ledger.ts:1006) executes only after line 977's check. No path exits the loop consuming an unverified row.

2. **Infinite-loop / cycle safety — SAFE.** `ts <= cursor.ts` is inclusive, raising a theoretical self/cycle concern. Ruled out: `allowedPreviousStages(s)` never contains `s` itself (ledger.ts:338-350), so a row can never resolve itself or another row of its own stage as predecessor. The strict stage-rank monotonic guard (`stageRank(cursor.stage) >= lastRank` → OUT_OF_ORDER, ledger.ts:995) forces strictly-decreasing, floor-bounded rank each hop, guaranteeing termination.

3. **Same-second ties — CONSISTENT.** Inclusive `ts <=` in resolution pairs with the strict `cursor.ts > lastTs` top-of-loop guard (ledger.ts:988) and the documented intent (comment ledger.ts:984-987) that same-second rapid emits are legitimate. Coherent.

4. **Fallback block — diagnostic only, sound.** Every branch in ledger.ts:1008-1042 returns a failure result; it only refines the failure *code*. Minor cosmetic note (non-blocking): it inspects only the single highest-ts conflicting row, so with multiple mixed-problem conflicts the reported code may not be the "worst" one — but `verifyChainDetailed` iterates all terminal candidates keeping `bestFailure`, and the ok/not-ok verdict is unaffected. Not a soundness issue.

## Regression test quality — genuine, not tautological

Test `resolves prior rows by stage and timestamp when artifact hashes collide` (ledger.test.ts:928-981) builds research(ts=100) → plan(ts=200), then appends a signed `review`(ts=300) whose `artifact_sha256` deliberately collides with the research row's hash, and verifies `throughStage: 'plan'`.

- **Proven to fail on buggy code:** I copied the new test over the pre-fix `src/pipeline/ledger.ts` (894885e~1) and ran it — this exact test FAILED (`expected false to be true`, ledger.test.ts:977), 17 passed / 1 failed. Under the old global map, `byArtifact.get(researchSha)` returned the higher-ts review row, so plan's predecessor resolved to a `review` stage → OUT_OF_ORDER, chain rejected.
- **Passes on the fix** because `resolvePreviousRow` filters by `allowedPreviousStages('plan') = ['research','synthesize']`, excluding the review collision and correctly selecting research.
- Asserts both the stage sequence `['research','plan']` and that `rows[0].artifact_sha256` is the research hash — pins the actual resolution, not just `ok`.

## Verification evidence (run myself)

```
$ git checkout fix-ledger-buildchain-hash-collision -q && git log --oneline -1
894885e fix: resolve ledger buildChain predecessor by slug+stage+ts, not global hash map

$ npx vitest run tests/unit/pipeline/ledger.test.ts
 Test Files  1 passed (1)
      Tests  18 passed (18)
   Duration  259ms

$ npm run build
 CJS ⚡️ Build success in 66ms   (clean, no TS errors)

# Regression proof: new test against OLD (894885e~1) ledger.ts source
 FAIL  ... resolves prior rows by stage and timestamp when artifact hashes collide
 AssertionError: expected false to be true  (ledger.test.ts:977)
 Test Files  1 failed (1)
      Tests  1 failed | 17 passed (18)

# Source restored to committed state; git status clean; re-ran → 18 passed (18)
```

## Blocking issues
None.

## Non-blocking observations
- (cosmetic) Fallback block reports the failure code of only the highest-ts conflicting row; verdict correctness is unaffected.
- (optional hardening) `resolvePreviousRow` relies on the next-iteration signature check for forged-row rejection. Adding a `verifyRowSignature` filter inside `resolvePreviousRow` (matching `latestPreviousRow`) would make it defense-in-depth and self-evidently safe in isolation, but is not required for correctness.
