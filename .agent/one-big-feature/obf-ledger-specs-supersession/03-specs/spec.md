# Spec — OBF Ledger Specs Supersession

**Status:** DRAFT
**Scope:** Repair append-only OBF ledger artifact-kind mismatch blocking SEIU 521 July staging proof
**Implementation Scope Only:** Select latest verified row for each stage; add targeted supersession test

## Contract

`verifyOneBigFeatureArtifacts` must select the latest verified row for each stage (`research`, `plan`, `specs`). Its existing path/SHA checks remain against those selected rows. No ledger rewrites, no provenance/stage-order relaxations, and no SEIU workflow changes.

## Implementation Specification

### File: `src/pipeline/ledger.ts`

**Function: `verifyOneBigFeatureArtifacts`**

Current problematic pattern (to be fixed):
```typescript
// BROKEN: Always selects first row regardless of artifact-kind
const stageRows = rows.filter(row => row.stage === stage);
const receipt = stageRows[0];
```

Required fix pattern:
```typescript
// FIXED: Select latest verified row per stage
const stageRows = rows.filter(row => row.stage === stage);
const receipt = stageRows.sort((a, b) => b.ts - a.ts)[0];
```

**Selection Logic Requirements:**
1. Group rows by stage (`research`, `plan`, `specs`)
2. Sort each group by timestamp descending
3. Select most recent row for each stage
4. Use selected rows for existing path/SHA verification
5. Preserve all other verification logic unchanged

**Invariants Preserved:**
- Signature verification: unchanged
- Provenance validation: unchanged
- Stage ordering: unchanged
- Artifact hashing: unchanged
- All SEIU implementation behavior: unchanged

### File: `tests/unit/pipeline/ledger.test.ts`

**Test: `appendOnlySupersession`**

**Test Scenario:**
1. Create test ledger with two specs entries:
   - Entry 1: file-scoped specs with invalid artifact hash
   - Entry 2: directory-scoped specs with valid artifact hash
2. Generate directory artifact hash for verification
3. Run `verifyOneBigFeatureArtifacts` with directory artifact
4. Verify success (latest directory row selected over invalid file row)
5. Verify first file row remains in ledger (append-only immutability)

**Test Requirements:**
```typescript
describe('appendOnlySupersession', () => {
  it('selects latest verified row when artifact-kind evolves from file to directory', () => {
    // Arrange: Create ledger with file-scoped then directory-scoped specs
    const fileSpecsRow: LedgerRow = {
      slug: 'test-slug',
      stage: 'specs' as const,
      ts: 1000000,
      artifact_sha256: 'file-scoped-hash',
      prev_sha256: 'base-hash',
      sig: 'signature',
      artifact_kind: 'file', // File-scoped
    };

    const dirSpecsRow: LedgerRow = {
      slug: 'test-slug',
      stage: 'specs' as const,
      ts: 2000000, // Later timestamp
      artifact_sha256: 'dir-scoped-hash',
      prev_sha256: 'file-scoped-hash',
      sig: 'signature',
      artifact_kind: 'directory', // Directory-scoped
    };

    // Act: Verify with directory artifact
    const result = verifyOneBigFeatureArtifacts(ledgerRows, specsDirPath);

    // Assert: Success with latest directory row selected
    expect(result.ok).toBe(true);
    expect(result.selectedRow).toBe(dirSpecsRow); // Latest row selected
    expect(result.artifactHash).toBe('dir-scoped-hash');
  });
});
```

**Validation Assertions:**
- Latest directory row is selected (not earlier file row)
- Artifact hash matches selected directory row
- Verification succeeds with directory artifact
- Both rows remain in ledger (append-only preserved)
- No ledger rewrites or mutations occur

## Implementation Constraints

### Selection Logic Requirements

1. **Latest Row Selection:** Must select most recent timestamp for each stage
2. **Stage Preservation:** Must group by stage before selection
3. **Artifact-Kind Agnostic:** Selection must not depend on artifact kind
4. **Downstream Compatibility:** Selected rows feed existing verification logic unchanged

### Test Requirements

1. **Append-Only Proof:** Test must demonstrate both rows coexist
2. **Supersession Validation:** Test proves later row supersedes earlier row
3. **Artifact-Kind Evolution:** Test covers file → directory transition
4. **No Regression:** All existing verification tests continue to pass

### Forbidden Changes

1. **No Ledger Rewrites:** Cannot modify `state/pipeline-ledger.jsonl`
2. **No Signature Changes:** Signature verification must remain identical
3. **No Provenance Changes:** Provenance validation must remain identical
4. **No Stage Order Changes:** Stage ordering must remain identical
5. **No SEIU Changes:** No modifications to SEIU workflow or implementation

## Acceptance Matrix

| Scenario | Expected Result |
|---|---|
| Latest directory row exists | Directory row selected, verification succeeds |
| Latest row is file-scoped | File row selected, verification succeeds |
| Multiple rows for same stage | Most recent timestamp row selected |
| File → directory evolution | Latest directory row supersedes earlier file row |
| Directory → file evolution | Latest file row supersedes earlier directory row |
| Append-only immutability | Earlier rows remain in ledger unchanged |
| SEIU July staging proof | Directory-scoped specs verification succeeds |

## Verification Requirements

### Test Coverage

- `appendOnlySupersession` test passes
- All existing `verifyOneBigFeatureArtifacts` tests pass
- No regressions in other ledger verification flows
- SEIU July staging proof can verify directory-scoped specs

### Code Quality

- TypeScript compilation succeeds
- No linting errors
- No breaking changes to public API
- Selection logic is deterministic and consistent

### Behavioral Verification

- Latest timestamp row always selected per stage
- Artifact-kind transition handled correctly
- Append-only ledger contract preserved
- No ledger state mutations occur

## Stop Conditions

- Any regression in existing verification tests
- Selection logic not deterministic
- Append-only immutability violated
- Signature or provenance changes introduced
- SEIU workflow behavior altered
- Ledger state mutation occurs

## Success Criteria

- `verifyOneBigFeatureArtifacts` selects latest verified row per stage
- Append-only supersession test proves file → directory evolution
- All existing verification tests continue to pass
- SEIU 521 July staging proof unblocked
- No regressions in other verification flows
- Ledger append-only contract preserved

## Technical Notes

### Artifact-Kind Evolution

Artifact-kind changes are legitimate corrections in OBF:
- File-scoped → Directory-scoped: structure refinements
- Directory-scoped → File-scoped: simplifications
- Both are append-only corrections, not deletions

### Selection Logic Impact

The fix ensures verification always uses the latest verified state:
- Earlier file receipt may have been valid at time of writing
- Later directory correction supersedes it
- Verification should use latest valid state for each stage

### Ledger Immutability

The ledger remains append-only:
- No rows are ever deleted or modified
- Earlier rows remain as historical record
- Later rows supersede earlier rows through selection logic
- This preserves audit trail and provenance chain