# Superseding Immutable Review Receipt — mmrag/Chroma Native-Crash Guard v3

Review task: `task_1787578177602_68534330`

This receipt supersedes the earlier v3 review receipt without modifying it. The second independent review track completed after the earlier receipt was sealed and identified additional High residuals.

Reviewed v3 artifact: `/Users/joshweiss/code/cortextos/state/specs/mmrag-chromadb-native-crash-guard-v3-2026-08-24.md`

Reviewed v3 SHA-256: `8c259e89f1075b2c5cb2738a0488a51d9c757f69ce6539dfa4177394e4f328bf`

Immutable chain reconfirmed:

- v2 SHA-256: `d683bf74e205251dba4fe3a696bb31dca768427fa901ada67f3b5b29123ba2c9`
- v1 SHA-256: `4f4f74242b6b0dd0b7c25f799020a677c09bce641324af998d375c9cc8384ac3`
- v2 review SHA-256: `04b31832360c1cbd2e4f51fc3aea07c26aac8cb4cd5665c57f3fe973ed16e423`

Disposition: **FAIL — 6 High, 1 Medium; no Critical.** The zero-High D0 condition is unmet. Revise and re-review; no implementation or live authority is emitted.

## High residual findings

1. **D0 retains an executable-evidence ambiguity.** Line 22 requires a deterministic static validator as D0 evidence while forbidding executable implementation tests; line 148 says implementation-artifact absence cannot block D0. The validator is not explicitly defined as pre-existing independent reviewer tooling with a frozen SHA, so D0 may still require executable evidence unavailable before I0. Define the validator as independent D0 tooling or make its schemas/expected outputs document-only.

2. **Timeout and signal precedence conflicts.** Line 36 says a signal always returns `WORKER_SIGNALED`; line 37 says a deadline always returns `WORKER_TIMEOUT`. The inherited timeout procedure sends SIGTERM/SIGKILL, satisfying both rules. Specify first-cause precedence: a deadline-initiated termination remains `WORKER_TIMEOUT`, with termination signal recorded separately; only an exogenous signal originates `WORKER_SIGNALED`.

3. **The permitted HMAC verification path conflicts with child key isolation.** Line 53 permits HMAC-SHA-256 or Ed25519 using a key unavailable to callers and child workers, while line 55 requires verification inside the sole `PersistentClient` factory. A child-side HMAC verifier needs the same secret prohibited there. Require Ed25519 with a pinned public verification key, or move HMAC verification into a trusted guard retaining control through construction.

4. **Signed-receipt and replay-ledger authority is incomplete.** Lines 52–53 do not define canonical signed bytes, select one digest algorithm, or explicitly require the signature to cover the complete canonical receipt. Lines 55–57 do not fix the replay-ledger canonical path/identity or protect it against rollback to an older valid state, which could make a consumed nonce appear unused. Specify canonical encoding, one digest/signature scheme, complete-field coverage, and monotonic rollback-resistant ledger anchoring.

5. **Promotion/rollback namespace transitions remain underdetermined.** Lines 78–84 define endpoint states but not exact source-to-destination forward mutations. The transition from `L=old,R=old` to `L=absent,R=old` leaves the former `L` disposition undefined, and line 81 permits alternative pointer states. Lines 86–90 name reverse phases without defining exact `L/S/R/Q/pointer` state and mutation per phase. Crash recovery cannot be uniquely derived.

6. **The destination conservation oracle is not input-isolated.** Lines 94–109 require code independence, but Oracle B is candidate-controlled and not constrained to destination-only readable inputs. It could read source or Oracle A's expected stream and emit correct canonical output while the rebuilt destination is wrong. Require an independently implemented destination reader in a process/capability sandbox with destination-only access.

## Medium residual finding

7. **Mutation-journal authenticity is incomplete.** Lines 66–68 require a separately owned watcher and signed final journal hash, but do not define a verifier-owned trust root unavailable to the proof worker or authenticate each event/sequence increment in an append chain. Bind watcher capability/key to the operation and attest startup, each append, continuity, and termination.

## V2 residual closure map

| V2 residual | V3 disposition |
|---|---|
| Circular authority | **OPEN** — D0 static-validator authority remains ambiguous |
| Typed result contract | **OPEN** — deadline-triggered signals have conflicting originating results |
| Receipt authentication/non-replay | **OPEN** — HMAC isolation contradiction plus incomplete canonical signature/ledger rollback protection |
| Full-interval transient-mutation proof | **PARTIAL** — enforcement exists, journal trust chain incomplete |
| Promotion/rollback namespace recovery | **OPEN** — exact forward/reverse mutations absent |
| Independent conservation oracle | **OPEN** — destination reader lacks enforced input isolation |
| WAL equivalence | **CLOSED at specification level** |
| Receipt-after-directory-fsync ordering | **CLOSED at specification level** |
| Atomic lock-bound quarantine | **CLOSED at specification level** |

Identifier note: lines 8 and 174 say H2/M9 remain closed while sections 2 and 9 reuse those identifiers for amended v2 residuals. Disambiguate legacy-v1 versus v2-residual identifiers in the next revision.

## No-live-action attestation

Both review tracks were strictly document/hash-only. Reviewers did not run any KB/runtime operation; query, ingest, count, or probe; import or open `PersistentClient`; change configuration, crons, store bytes, locks, processes, packages, containment, or implementation state; or perform promotion/rollback. The only authorized writes were immutable review receipts. V1, v2, v3, and prior review artifacts remained unchanged.
