# OBF Ledger Specs Supersession — Research

## Observed failure

The SEIU 521 July staging-proof planning chain contains a valid research row, a
valid plan row, and a specs row whose signed artifact is the file
`03-specs/spec.md`. The universal one-big-feature verifier instead computes the
artifact digest for the full `03-specs/` directory. It therefore rejects the
otherwise intact chain with `SCOPE_SHA_MISMATCH`.

## Existing contract

`describeArtifact` supports both files and directories. The OBF verifier uses
the `03-specs/` directory, and the existing ledger unit test emits `specs` with
that directory. Ledger rows are append-only and signature-checked; direct
modification of the recorded row would defeat that guarantee.

## Root cause

`verifyChainDetailed` selects the newest viable terminal receipt, but
`verifyOneBigFeatureArtifacts` selects the first row for each stage. A corrected
directory-scoped specs receipt can therefore be appended, but the OBF artifact
check continues to inspect the original file-scoped receipt.

## Required remediation

For each OBF artifact stage, the verifier must use the terminal chain's latest
receipt for that stage. This preserves append-only records and lets a newly
signed specs-directory receipt supersede an earlier invalid receipt without
relaxing signature, provenance, ordering, or artifact-digest validation.
