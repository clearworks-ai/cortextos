# Immutable Review Receipt — mmrag/Chroma Native-Crash Guard v2

Review task: `task_1787577587481_81749273`

Reviewed v2 artifact: `/Users/joshweiss/code/cortextos/state/specs/mmrag-chromadb-native-crash-guard-v2-2026-08-24.md`

Reviewed v2 SHA-256: `d683bf74e205251dba4fe3a696bb31dca768427fa901ada67f3b5b29123ba2c9`

Independently reconfirmed v1 SHA-256: `4f4f74242b6b0dd0b7c25f799020a677c09bce641324af998d375c9cc8384ac3`

Disposition: **FAIL — 6 High, 3 Medium; no Critical.** The v2 artifact substantially addresses the v1 findings, but residual contradictions and bypasses prevent terminal closure. Revise and re-review; the live-action hold remains unchanged.

## High residual findings

1. **Review and implementation gates are circular.** Lines 271–280 prohibit implementation until isolated executable tests pass, while line 296 permits review passage only after executable artifacts exist. Those artifacts require the implementation currently forbidden. Separate document approval, implementation authorization, implementation acceptance, copied-data validation, and live-action authorization.

2. **Typed signal/timeout propagation contradicts itself.** Section 7 requires `WORKER_SIGNALED` (line 133) and smoke test 3 expects it (line 254), but section 10 maps signal and timeout to `STORE_UNHEALTHY` or `CONSERVATION_FAILED` (line 179). This breaks the H3 discriminated-result contract at lines 94–109 and closure matrix line 288. Preserve the originating typed worker result and, if needed, add a separate store-health classification field.

3. **The guard token/lock receipt remains forgeable or replayable by specification.** The owner receipt only binds descriptive fields (line 64), while `mmrag.py` rejects only a missing token/receipt (line 76). No normative rule requires signature verification, freshness, operation/org/store binding, active lock inode and ownership verification, or replay rejection. `INVALID_RECEIPT` exists at line 96 but has no forged/stale negative fixtures.

4. **H6 does not prove that live state was never transiently mutated and restored.** Lines 227–246 and test 16 at line 267 establish endpoint equality. Before/after manifests cannot exclude a temporary live write followed by restoration. A no-live-mutation claim requires enforced live-path write denial or continuous write/filesystem auditing for the proof interval, linked to the receipt.

5. **Promotion and rollback namespace transitions remain operationally ambiguous.** Lines 197–223 name phases but do not normatively define each source/destination rename and pointer transition. Reverse rollback is summarized only at line 223, and test 13 at line 264 does not explicitly cover every reverse-transaction crash cutpoint. Deterministic recovery cannot be derived for all intermediate namespaces.

6. **The H4 conservation oracle can be self-consistently wrong.** Lines 183–193 require strong per-ID evidence, but `authoritative SQLite/source rows` is ambiguous and the canonical numeric representation is not normatively encoded. A single faulty extractor/canonicalizer could produce both expected and actual ledgers and pass test 12. Require an independent oracle/extractor and a versioned byte-level canonicalization specification.

## Medium residual findings

7. **WAL snapshot equivalence is underspecified.** Lines 137–146 require SQLite online backup while saying WAL/SHM state is included. Online backup normally materializes a logical snapshot rather than preserving a byte-identical WAL tree. Test 10 at line 261 says only that the manifest matches, without defining logical row/page/snapshot equality.

8. **Promotion durability ordering can let metadata outrun the filesystem mutation.** Lines 210–214 write and fsync the phase receipt before fsyncing affected parent directories. After power loss, the receipt may claim a phase whose rename is not durable. Require filesystem mutation and directory fsync before committing the corresponding phase receipt, plus power-loss/fsync fault injection.

9. **Quarantine enforcement has a check/use race.** The inventory places quarantine preflight before lock acquisition (line 74), and line 53 only requires rejection before construction. It does not require quarantine transitions under the org lock or a locked re-read immediately before `PersistentClient`. Tests 5 and 8 do not exercise this race.

## Prior-finding closure matrix

| Prior finding | v2 mapping | Review disposition |
|---|---|---|
| H1 durable promotion/rollback | Sections 12, 14; matrix line 286 | **OPEN** — exact namespace transitions, reverse cutpoints, and fsync ordering remain incomplete |
| H2 timeout/reap before unlock | Section 7; tests 4–5; matrix line 287 | **CLOSED at specification level** |
| H3 typed non-success propagation | Sections 5–7 and 10; test 14; matrix line 288 | **OPEN** — line 179 contradicts `WORKER_SIGNALED`/`WORKER_TIMEOUT` |
| H4 exact conservation/provenance | Section 11; test 12; matrix line 289 | **OPEN** — authority and independent canonicalization oracle are not fixed |
| H5 lock-pinned WAL backup/path aliases | Sections 3 and 8; tests 9–10; matrix line 290 | **PARTIAL** — alias gates close, WAL equivalence remains ambiguous |
| H6 full proof before/after state | Section 13; test 16; matrix line 291 | **OPEN** — endpoint equality does not prove zero transient mutation |
| M7 every call path | Section 5; test 15; matrix line 292 | **OPEN** — token/receipt authenticity and replay bypass are untested |
| M8 canonical quarantine config | Sections 3–4; tests 5 and 8; matrix line 293 | **OPEN** — quarantine TOCTOU remains |
| M9 dimension and empty behavior | Sections 9–10; test 11; matrix line 294 | **CLOSED at specification level** |

## No-live-action attestation

This review was strictly document/hash-only. Reviewers did not query, ingest, count, probe, import or open `PersistentClient`, change configuration, crons, store bytes, processes, packages, containment, or implementation state. The only authorized write was this immutable review receipt. The live-action hold remains active.
