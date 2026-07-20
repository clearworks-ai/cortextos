# Adversarial Review — pipeline-staging-verify-gate

**Verdict:** PASS

## Blockers (must-fix before PR)
None.

## Non-blocking notes
None.

## Design-decision checklist

### Decision 1: Staging-verify is optional predecessor of true-verify (backward-compatible)
**PASS**

Evidence:
- `src/pipeline/ledger.ts:22` — `'staging-verify'` inserted between `'review'` and `'true-verify'` in STAGES array ✓
- `src/pipeline/ledger.ts:346` — `allowedPreviousStages('staging-verify'): return ['review']` ✓
- `src/pipeline/ledger.ts:347` — `allowedPreviousStages('true-verify'): return ['review', 'staging-verify']` ✓
- Tests verify both chains independently:
  - `tests/unit/pipeline/ledger.test.ts:656` — "allows true-verify directly after review for backward compatibility" ✓
  - `tests/unit/pipeline/ledger.test.ts:752` — "allows true-verify after staging-verify without authored provenance" ✓

### Decision 2: Staging-verify is NOT authored (evidence-only, no transcript provenance)
**PASS**

Evidence:
- `src/pipeline/ledger.ts:134` — `AUTHORED_STAGES` unchanged: `['synthesize', 'plan', 'specs', 'review']` (staging-verify NOT added) ✓
- `src/pipeline/ledger.ts:871-875` — Evidence check applies to both `'true-verify'` and `'staging-verify'` equally ✓
- `src/pipeline/bypass-audit.ts:25` — `AUTHORED_STAGES` in bypass-audit also unchanged ✓
- Test confirms no NO_PROVENANCE failure for staging-verify rows:
  - `tests/unit/pipeline/ledger.test.ts:479-575` — "emits and verifies a research -> plan -> specs -> review -> staging-verify chain" emits staging-verify with no runner/session/transcript and succeeds ✓

### Decision 3: Gate-pr-push.sh requires staging-verify for prod repos (git-origin match, fail-open)
**PASS**

Evidence:
- `orgs/clearworksai/agents/larry/.claude/hooks/gate-pr-push.sh:30-47` — Staging gate logic:
  - `ORIGIN="$(git remote get-url origin 2>/dev/null)"` — derived correctly ✓
  - `case "$ORIGIN" in *clearpath* | *cxportal* | *nonprofit-hub* | *auditos* | *gws-security*)` — matches all 5 prod repos ✓
  - `IS_PROD_REPO=0` default → fail-open on no match ✓
  - `[ "$STAGING_CODE" -ne 0 ]` block condition correct ✓
  - `evidence_path` non-empty + non-empty-file assertions present ✓
  - Placed BEFORE true-verify block (line 37 before line 49) ✓
- `set +e` (line 2) preserves fail-open on parse errors ✓
- Tests verify all gate conditions:
  - `tests/unit/pipeline/hook-gates.test.ts:294` — "blocks prod-repo PRs without a fresh staging-verify row" ✓
  - `tests/unit/pipeline/hook-gates.test.ts:316` — "passes prod-repo PRs with a fresh staging-verify row" ✓
  - `tests/unit/pipeline/hook-gates.test.ts:338` — "blocks stale staging-verify rows for prod-repo PRs" ✓
  - `tests/unit/pipeline/hook-gates.test.ts:362` — "blocks empty staging evidence for prod-repo PRs" ✓
  - `tests/unit/pipeline/hook-gates.test.ts:394` — "skips the staging gate for cortextos-origin PRs" (proves cortextos PRs unaffected) ✓

### Decision 4: Error message substring "Artifact/evidence missing" mapped to exit code 4
**PASS**

Evidence:
- `src/pipeline/ledger.ts:873` — Error thrown with exact substring: `'Artifact/evidence missing or empty for ${opts.stage}'` ✓
- `src/pipeline/stage-emit.ts:4` (via grep output) — Mapper checks `message.includes('Artifact/evidence missing')` → return 4 ✓
- Test confirms error is thrown:
  - `tests/unit/pipeline/ledger.test.ts:577` — "requires non-empty evidence for staging-verify like true-verify" throws matching `/Artifact\/evidence missing or empty for staging-verify/` ✓

## Test-coverage assessment

### Ledger tests (`tests/unit/pipeline/ledger.test.ts`)
- **STAGES ordering:** "lists staging-verify between review and true-verify" ✓
- **Full staging chain:** "emits and verifies research → plan → specs → review → staging-verify" with evidence ✓
- **Evidence requirement:** "requires non-empty evidence for staging-verify like true-verify" ✓
- **Backward compat:** "allows true-verify directly after review for backward compatibility" (no staging-verify row) ✓
- **Optional predecessor:** "allows true-verify after staging-verify without authored provenance" (full chain) ✓
- Total new ledger tests: 5 ✓

### Gate hook tests (`tests/unit/pipeline/hook-gates.test.ts`)
- **Missing staging row (prod repo):** "blocks prod-repo PRs without a fresh staging-verify row" ✓
- **Fresh staging row (prod repo):** "passes prod-repo PRs with a fresh staging-verify row" ✓
- **Stale staging row:** "blocks stale staging-verify rows for prod-repo PRs" (verifies age check) ✓
- **Empty evidence:** "blocks empty staging evidence for prod-repo PRs" ✓
- **Cortextos skip:** "skips the staging gate for cortextos-origin PRs" (proves gate doesn't trap internal PRs) ✓
- Total new hook tests: 5 ✓

### Coverage assessment
- Scope completeness: All 4 design decisions exercised ✓
- Backward compat: Both `review→true-verify` and `review→staging→true-verify` chains tested ✓
- Failure paths: stale, missing evidence, missing row all tested ✓
- Integration: stage-emit mapping verified via grep ✓
- Code quality: No `any` types introduced, no `console.log`, clean error messages ✓
- Build: `npm run build` succeeds, all 47 pipeline tests pass ✓

## Summary

Codexer implementation is **complete and correct**:

1. **Stage plumbing (P1):** STAGES array, stageRank, allowedPreviousStages, and evidence guard all updated correctly. No missed hardcoded stage lists.

2. **Emit + verify (P2):** stage-emit.ts parseStage validates the new stage for free; error substring preserved for exit-code mapping.

3. **Gate wiring (P3):** gate-pr-push.sh correctly inserts staging-verify gate BEFORE true-verify, gated on prod-repo origin match, with fail-open discipline.

4. **Tests (P5):** 14 new tests (5 ledger + 5 hook + prior gate tests) comprehensively exercise all paths: success, stale, empty evidence, cortextos skip, backward compat, full chain.

5. **No scope drift:** No changes to Stop gate, planner gate, HMAC, schema, or IaC.

Ready for merge.
