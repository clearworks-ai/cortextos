# Master Plan — OBF Ledger Specs Supersession

**Status:** DRAFT
**Scope:** Repair append-only OBF ledger artifact-kind mismatch blocking SEIU 521 July staging proof
**Implementation Scope Only:** Select latest verified row for each stage; add targeted supersession test

## Problem

`src/pipeline/ledger.ts:verifyOneBigFeatureArtifacts` hashes the specs directory but selects the first `specs` receipt. Earlier ledger history contains an immutable file-scoped specs receipt, and later directory-scoped correction must supersede it.

Current behavior breaks append-only ledger contracts:
- Ledger writes are immutable
- Artifact-kind changes (file → directory) are legitimate corrections
- But verification always picks the first row regardless of validity
- This blocks legitimate supersession via later directory-scoped receipts

## Root Cause

In `verifyOneBigFeatureArtifacts`, the code selects receipts by `stage` order but doesn't account for artifact-kind evolution. When a specs artifact transitions from file-scoped to directory-scoped, the earlier immutable file receipt is still selected even when invalid.

The selection logic:
1. Groups rows by stage
2. Selects first row for each stage (file vs directory ignored)
3. Compares artifact hash against that selection

This doesn't handle append-only corrections where:
- Original file-scoped receipt was valid at time of writing
- Later directory-scoped correction supersedes it
- Verification should select the latest valid row for each stage

## Solution

### Core Fix

Modify `verifyOneBigFeatureArtifacts` to select the latest verified row for each stage:
- `research`: select latest row with `stage === 'research'`
- `plan`: select latest row with `stage === 'plan'`  
- `specs`: select latest row with `stage === 'specs'`

Selection criteria:
- Group by stage
- Sort by timestamp descending
- Select most recent row for each stage
- Existing path/SHA checks remain against those selected rows

### Implementation Scope

**File: `src/pipeline/ledger.ts`**
- Modify `verifyOneBigFeatureArtifacts` function
- Change selection logic to pick latest verified row per stage
- Preserve all other verification logic unchanged
- No signature changes, no provenance changes
- Stage ordering preserved, artifact hashing preserved

**Test: `tests/unit/pipeline/ledger.test.ts`**
- Add targeted append-only supersession test
- Test scenario: earlier invalid file-scoped specs + later valid directory-scoped specs
- Verify both receipts coexist in ledger
- Verify latest verified row is selected
- Verify hash comparison succeeds with directory artifact

## Technical Approach

### Selection Logic Change

Current (broken):
```typescript
const receiptsByStage = rows.filter(r => r.stage === stage);
const receipt = receiptsByStage[0]; // Always first row
```

Fixed:
```typescript
const receiptsByStage = rows.filter(r => r.stage === stage);
const receipt = receiptsByStage.sort((a, b) => b.ts - a.ts)[0]; // Latest row
```

### Test Coverage

**Append-Only Supersession Test:**
1. Create ledger with two specs entries:
   - First: file-scoped, invalid artifact hash
   - Second: directory-scoped, valid artifact hash
2. Run `verifyOneBigFeatureArtifacts` with directory artifact
3. Verify success (latest directory row selected)
4. Verify first file row remains in ledger (immutable append-only)
5. Verify artifact hash matches selected directory row

### Invariants Preserved

- Signatures: unchanged
- Provenance: unchanged
- Stage ordering: unchanged
- Artifact hashing: unchanged
- SEIU implementation behavior: unchanged
- Ledger append-only contract: preserved
- File immutability: preserved

## Boundaries

### Files Allowed
- `/Users/joshweiss/code/cortextos/src/pipeline/ledger.ts` — selection logic fix only
- `/Users/joshweiss/code/cortextos/tests/unit/pipeline/ledger.test.ts` — supersession test only

### Files Forbidden
- `state/pipeline-ledger.jsonl` — no ledger rewrites
- Any other ledger or verification files
- SEIU workflow or implementation files

### Changes Forbidden
- No signature changes
- No provenance changes
- No stage order changes
- No artifact hashing changes
- No SEIU implementation behavior changes
- No ledger state mutation (append-only preserved)

## Acceptance Criteria

- `verifyOneBigFeatureArtifacts` selects latest verified row per stage
- Earlier file-scoped specs receipt coexists with later directory-scoped receipt
- Directory-scoped verification succeeds when latest row is directory-scoped
- Test proves append-only supersession works correctly
- All existing verification tests continue to pass
- SEIU July staging proof unblocked

## Success Metrics

- Append-only supersession test passes
- All existing ledger tests pass
- SEIU 521 July staging proof can verify directory-scoped specs
- No regressions in other verification flows
- Ledger immutability preserved

## Risk Mitigation

- Scope is minimal: only selection logic change
- Test coverage targeted: supersession scenario only
- All other verification logic unchanged
- Ledger state mutation forbidden (append-only preserved)
- No changes to signatures, provenance, or stage ordering

## Rollback

If verification regressions occur:
- Revert selection logic to original behavior
- Remove supersession test
- SEIU staging proof remains blocked (original behavior restored)
- No ledger state corruption (no rewrites attempted)