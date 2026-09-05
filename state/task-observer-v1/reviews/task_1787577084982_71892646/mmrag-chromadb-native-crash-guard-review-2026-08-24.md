# Immutable Review Receipt — mmrag/Chroma Native-Crash Guard

Task: `task_1787577084982_71892646`

Reviewed artifact: `/Users/joshweiss/code/cortextos/state/specs/mmrag-chromadb-native-crash-guard-2026-08-24.md`

Reviewed artifact SHA-256: `4f4f74242b6b0dd0b7c25f799020a677c09bce641324af998d375c9cc8384ac3`

Disposition: **FAIL — 6 High, 3 Medium; no Critical. DO NOT IMPLEMENT YET.** Revise and re-review; the live-action hold remains unchanged.

## High findings

1. **Promotion is not failure-atomic.** FR-4 promotes before retaining the rollback pointer/receipt (lines 57–58) while promising every failure leaves live state unchanged (line 60). Require a durable rollback target and promotion intent before a same-filesystem swap, explicit fsync ordering, crash-cutpoint recovery, and verified finalization.

2. **Timeout does not prove worker death.** Lines 46 and 67 classify timeout and line 153 holds the lock through close, but the specification never requires process-group termination and reap before lock release. A timed-out child could outlive the lock and overlap the next operation. Require terminate-and-reap confirmation, with quarantine if death cannot be proven.

3. **Query failure remains semantically fail-open.** Line 74 forbids collapsing a signal failure to null only “without telemetry,” still permitting telemetry-backed empty/null evidence. Line 91 tests classification, not typed propagation through CLI, `queryKnowledgeBase`, retrieval hook, or dashboard. Every busy, unsupported, unhealthy, timeout, and signal result must remain a typed non-success end to end.

4. **SQL replay does not prove payload/vector conservation.** Lines 171–179 bind counts, IDs, metadata digests, dimension, and vector count, but not per-ID canonical document/chunk digests, embedding-value digests, or exact model/config provenance for regenerated vectors. Operability queries do not prove conservation.

5. **Source snapshot and side-store disjointness are unspecified.** Lines 52–55 and 169 do not require a lock-pinned SQLite backup including WAL state, canonical source/side path inequality, or rejection of symlink/hardlink aliasing. “Exact copy” at lines 13 and 86 lacks source/copy manifests and pre/post hashes.

6. **No evidence gate proves live state was untouched.** Lines 82 and 108–111 are policy assertions; line 89 hashes live state only for one side-probe failure case. Require before/after signed manifests for the live store tree and pointer, plus config and cron state, covering the entire proof run.

## Medium findings

7. **Trigger/call-site coverage is not closed.** Lines 131 and 133 defer edge-extraction and maintenance/canary classification; line 135 groups ad-hoc callers. Dashboard direct-mmrag routes are absent from the table. Although the below-CLI boundary rule at lines 138 and 153 is directionally correct, rollout lacks a source/behavioral gate proving every `PersistentClient` construction and direct `mmrag.py` entry traverses the same org lock.

8. **Reversible quarantine lacks enforceable semantics.** Lines 160 and 165 do not define the canonical quarantine key/store binding, atomic config update, malformed/unreadable-config behavior, or an acceptance test proving the hold fires before every client construction.

9. **Probe dimension discovery is unresolved.** Lines 38–44 require each collection dimension while lines 76–78 correctly reject `dimensionality=None` as corruption. Specify an authoritative non-HNSW dimension source and empty-collection behavior.

## Gate disposition

- Runtime compatibility preflight direction: **PASS**
- Store-boundary org-lock placement concept: **PASS, enforcement proof incomplete**
- Reversible containment options: **PRESENT, option-2 semantics incomplete**
- Fail-closed behavior: **FAIL**
- SQL-replay conservation: **FAIL**
- Side-store promotion and rollback evidence: **FAIL**
- Explicit no-live-mutation evidence: **FAIL**

Review execution was document/hash-only: no query, ingest, count, probe, `PersistentClient`, configuration or cron/store change, restart, or implementation was performed. The live-action hold remains active.
