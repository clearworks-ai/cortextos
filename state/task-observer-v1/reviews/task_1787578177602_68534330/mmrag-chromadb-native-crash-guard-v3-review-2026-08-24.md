# Immutable Review Receipt — mmrag/Chroma Native-Crash Guard v3

Review task: `task_1787578177602_68534330`

Reviewed v3 artifact: `/Users/joshweiss/code/cortextos/state/specs/mmrag-chromadb-native-crash-guard-v3-2026-08-24.md`

Reviewed v3 SHA-256: `8c259e89f1075b2c5cb2738a0488a51d9c757f69ce6539dfa4177394e4f328bf`

Immutable chain reconfirmed:

- v2 SHA-256: `d683bf74e205251dba4fe3a696bb31dca768427fa901ada67f3b5b29123ba2c9`
- v1 SHA-256: `4f4f74242b6b0dd0b7c25f799020a677c09bce641324af998d375c9cc8384ac3`
- v2 review SHA-256: `04b31832360c1cbd2e4f51fc3aea07c26aac8cb4cd5665c57f3fe973ed16e423`

Disposition: **FAIL — 3 High, 1 Medium; no Critical.** The v3 amendment closes five of the nine v2 residuals at specification level, but the zero-High D0 condition is unmet. Revise and re-review; no implementation or live authority is emitted.

## High residual findings

1. **Receipt authentication offers an internally impossible HMAC path.** Line 53 permits either HMAC-SHA-256 or Ed25519 using a key unavailable to callers and child workers, while line 55 requires verification inside the sole `PersistentClient` factory immediately before use. If that factory is in the child worker, HMAC verification requires the same secret the specification says is unavailable there. Ed25519 can use a public verification key, but the alternative HMAC path cannot satisfy both requirements. Require Ed25519 with an explicit pinned public verification key/trust root in the factory, or move HMAC verification into an independently trusted guard that retains control through construction; do not leave the choice implementation-defined.

2. **The promotion/rollback namespace state machine still omits exact mutations.** Lines 78–84 define endpoint states but not the exact forward source-to-destination operations. In particular, `L=old, R=old` at line 80 becomes `L=absent, R=old` at line 81 without specifying where the former `L` moved or which operation is permitted. The pointer state at line 81 is alternative rather than singular. Lines 86–90 name reverse phases but do not define required `L/S/R/Q/pointer` state and exact mutation for each reverse phase. Crash recovery therefore remains underdetermined despite the cutpoint requirement.

3. **The conservation oracle permits a destination bypass.** Lines 94–109 require code independence, but Oracle B is candidate-controlled and is only described as exporting through the public interface. The specification does not constrain B's readable inputs to the rebuilt destination or deny access to the source and Oracle A's expected stream. B could synthesize correct canonical output while the destination is wrong and Comparator C would pass. Require an independently implemented destination reader in a process/capability sandbox with destination-only access and no source/A stream access.

## Medium residual finding

4. **The full-interval mutation journal lacks an explicit verifier-owned trust root.** Lines 66–68 require a separately owned watcher and signed final journal hash, but do not bind a verification key unavailable to the proof worker or authenticate each event/sequence record in an append chain. A replaced or forged final journal could report `dropped_events=0`. Bind watcher binary and capability to the operation, use a verifier-owned signing key, authenticate each append/sequence link, and attest startup and termination.

## V2 residual closure map

| V2 residual | V3 anchor | Disposition |
|---|---|---|
| H1 circular authority | Section 1, tests 1–2 | **CLOSED** |
| H2 typed-result contradiction | Section 2, test 3 | **CLOSED** |
| H3 receipt authentication/non-replay | Section 3, test 4 | **OPEN** — HMAC verification/key-availability contradiction |
| H4 full-interval transient-mutation proof | Section 4, test 5 | **PARTIAL** — controls exist, journal authenticity incomplete |
| H5 promotion/rollback namespace recovery | Sections 5 and 8, tests 6–7 and 10 | **OPEN** — endpoint states lack exact forward/reverse mutations |
| H6 independent conservation oracle | Section 6, test 8 | **OPEN** — destination exporter lacks input isolation |
| M7 WAL equivalence | Section 7, test 9 | **CLOSED** |
| M8 receipt-after-directory-fsync ordering | Sections 5 and 8, test 10 | **CLOSED** |
| M9 atomic lock-bound quarantine | Section 9, test 11 | **CLOSED** |

## No-live-action attestation

This review was strictly document/hash-only. Reviewers did not run any KB/runtime operation; query, ingest, count, or probe; import or open `PersistentClient`; change config, crons, store bytes, locks, processes, packages, containment, or implementation state; or perform promotion/rollback. The only authorized write was this immutable review receipt. V1, v2, v3, and prior review artifacts remained unchanged.
