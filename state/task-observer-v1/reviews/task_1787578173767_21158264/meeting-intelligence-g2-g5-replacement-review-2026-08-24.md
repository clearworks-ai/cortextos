# Merged terminal receipt — meeting-intelligence G2–G5 replacement review

Review task: `task_1787578173767_21158264`

Frozen manifest: `/Users/joshweiss/code/cortextos-worktrees/specify-meeting-intelligence-20260823/state/specs/contracts/meeting-intelligence-compatibility-manifest.json`

Manifest SHA-256: `49a86d2d8c472e677c92cd968a047d2a0286657cd3d27d74c2557bcd036b9c2e`

Manifest mode/bytes: `0400` / `29913`

Scope authority: G1 remains closed/PASS and was rehashed for drift only. This review reopens exactly G2–G5. It does not review superseded packets and authorizes no Goalify, implementation, provider/capture, merge/push/deploy, production, recovery or external action.

## Terminal disposition

**Specify CONVERGED: NO — NOT CONVERGED.**

Merged severity: **1 Critical / 0 High / 0 Medium / 0 Low.**

| Gate | Disposition | Severity | Basis |
|---|---|---:|---|
| G1 trust-root/content authority | preserved PASS | 0C/0H | authority-root golden rehash remains exact at `454a5dddb567fd6c4b5f44bdc4f16bdf6601a09f68643a423a49eeb486440171`; no reopened review |
| G2 CRM exact-write/readback/readiness | PASS | 0C/0H | exact five-operation domain, bidirectional request/durable/delivery/readback set equality, empty/partial/extra/duplicate/orphan attacks and 20 per-operation mismatch negatives replay green |
| G3 transition/retry/lease/lineage | PASS | 0C/0H | UNKNOWN reconciliation, immutable retry window, attempt/fence advancement, LEASED expiry/schedule invariants, terminal carry-forward and predecessor-bound correction attacks replay green |
| G4 Fireflies ingress/relay/pre-record | PASS | 0C/0H | state-specific relay shapes, externally pinned verification config, keyed auth/replay, ordered chronology, distinct auth-vs-processing failure and quarantine lifecycle attacks replay green |
| G5 rich B/C, PA, freshness, semantic quality, product contract | **FAIL** | **1C/0H** | 10 governed Briefs spec/product artifacts are not independently recoverable from any declared root or the pinned Briefs commit; the full 75-artifact packet and cross-repo product contract therefore do not exist as frozen reviewable bytes |

## Independent replay evidence

### Exact manifest and governed CortextOS bytes

- Manifest path, SHA, mode and bytes match the freeze authority.
- CortextOS repository HEAD matches pinned base `15defb1307df39f2df77522e70737c46dac52079`.
- All 65 governed CortextOS contract/spec artifacts match manifest SHA-256, byte count and mode.
- Validator SHA-256 matches `9035cf78405f0606ee47ebe95fd16458b54af7f0e9f0e5cb3d8fb2a3863b4351`.
- Negative fixture SHA-256 matches `5f2d89822a34686b28cf6f39f87bdea18522f6a2903bfed23126761bb38668e1`.

### Runtime trust pins and validator

Validator replay used exactly:

- `MEETING_AUTHORITY_ROOT_DIGEST=98cf10a485937fde4abfa104f2ebc69631faa90ff7cdd4f71beb55f8abd72100`
- `FIREFLIES_VERIFICATION_CONFIG_DIGEST=10c067d772450f32c52e8de7e16b3f409ae2f4fb7e31ac72d3c043a0020bc30b`
- `COVERAGE_CLOCK_AUTHORITY_DIGEST=c2c32ef422d602145572b96972e4e03352d43fb307581c73258bc1bf58a1ba3d`

Result: `pass=true`, 0 positive errors, 53/53 schema negatives pass, 145/145 adversarial cases pass. Replacing the coverage-clock pin with `wrong` exits 1.

### G1 drift-only rehash

`meeting-authority-root-v1.golden.json` remains SHA-256 `454a5dddb567fd6c4b5f44bdc4f16bdf6601a09f68643a423a49eeb486440171`, matching the manifest and preserved G1 PASS authority.

## Critical G5 conservation failure

The manifest governs 75 artifacts: 65 in CortextOS and 10 in Briefs. The 10 Briefs paths are absent from `/Users/joshweiss/code/briefs`; its current HEAD is `a805aaf1060ab51af5349c2bf1ee39418ad9fc45`, not the declared base. More importantly, direct Git-object queries against the declared base `5b521f2e4f0ec8655643b16641f41202705d7d6b` show that none of the 10 paths exists in that commit. A search under `/Users/joshweiss/code` found no alternate checkout/worktree containing the two anchor paths.

Missing governed paths:

1. `docs/specs/meeting-intelligence-crm-surface-standard-2026-08-24.md`
2. `docs/superpowers/specs/mockups/crm-interaction-intelligence.html`
3. `docs/superpowers/specs/mockups/crm-interaction-intelligence.html.approved.json`
4. `docs/superpowers/prototypes/meeting-intelligence-layout/ANSWER.md`
5. `docs/superpowers/prototypes/meeting-intelligence-layout/approval-manifest.json`
6. `docs/superpowers/prototypes/meeting-intelligence-layout/index.html`
7. `docs/superpowers/prototypes/meeting-intelligence-layout/styles.css`
8. `docs/superpowers/prototypes/meeting-intelligence-layout/states.html`
9. `docs/superpowers/prototypes/meeting-intelligence-layout/variants/b.html`
10. `docs/superpowers/prototypes/meeting-intelligence-layout/variants/c.html`

This independently corroborates the manifest's own `validation.cross_repo_vendored_bundle_equality = "not_run"`. The freeze claim that 75 governed artifacts rehash exactly is therefore not reproducible. Because G5's typed rich-B surface, product contract and cross-repo consumer proof depend on these exact bytes, missing all 10 is Critical and blocks overall Specify convergence even though the local validator suite is green.

## Required bounded correction

Issue a new versioned freeze only after:

1. the exact 10 Briefs bytes are restored at an immutable, reachable Briefs commit or separately immutable artifact root;
2. the manifest binds that reachable root/commit and each path/SHA/bytes/mode;
3. independent 75/75 rehash succeeds from the declared roots;
4. `cross_repo_vendored_bundle_equality` is executed and PASS, not `not_run`;
5. the G5 validator/product-contract replay is rerun against those exact restored bytes.

G2–G4 should remain closed at PASS unless their governed bytes drift. G1 remains preserved PASS and must not reopen.

## No-mutation attestation

This review was read-only against all governed bytes. It performed file/Git-object rehashes and local validator execution only. It did not edit governed artifacts, run Goalify, implement code, access providers/captures, merge/push/deploy, mutate production, perform recovery or external action. The only new byte surface is this review receipt plus ordinary task/observer bookkeeping.
