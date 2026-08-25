# mmrag/Chroma native-crash guard v3 — bounded residual amendment

Status: REVIEW REQUIRED — DO NOT IMPLEMENT
Task: `task_1787578001639_87247692`
Amends only the nine residuals in v2 review receipt SHA-256 `04b31832360c1cbd2e4f51fc3aea07c26aac8cb4cd5665c57f3fe973ed16e423`.
Normative base: `mmrag-chromadb-native-crash-guard-v2-2026-08-24.md` SHA-256 `d683bf74e205251dba4fe3a696bb31dca768427fa901ada67f3b5b29123ba2c9`.

V1, v2, and their review receipts remain immutable failed evidence. This v3 authorizes no implementation, live probe, client construction, store/config/cron/process/package mutation, promotion, rollback, containment, or restart. Where this amendment conflicts with v2, this amendment controls only the nine rows below. H2 and M9 remain closed and are not reopened.

## 1. Externally decidable acceptance and authority sequence (H1)

The prior circular rollout/review gate is replaced by five strictly ordered gates. No gate may use evidence produced by a later gate.

| Gate | Inputs allowed | Decision | Authority emitted |
|---|---|---|---|
| D0 document acceptance | frozen v2, frozen v3, review receipts, source inventory | independent reviewers determine zero Critical/High and structural completeness | `DOCUMENT_ACCEPTED` or `DOCUMENT_REJECTED`; no code authority |
| I0 implementation authorization | `DOCUMENT_ACCEPTED`, approved ownership/file plan | human/orchestrator authorizes isolated implementation only | permission to write implementation in isolated branch/worktree; no copied/live data access |
| I1 implementation acceptance | frozen implementation SHA plus synthetic fixtures and structural tests | independent reviewers determine conformance | `IMPLEMENTATION_ACCEPTED` or rejected; no live/copy authority |
| C0 copied-data validation authorization | `IMPLEMENTATION_ACCEPTED`, exact copy protocol, approved source paths | explicit authority for lock-pinned copy and copied-data tests | copied/temp evidence only; live writes denied |
| L0 live-action authorization | successful copied-data receipt, exact conservation, crash suite, rollback rehearsal, approved impact window | fresh explicit human authority | only the exact named live operation/epoch |

`D0` is decidable before implementation: its required evidence is this frozen specification, source/call-path inventory, schemas, deterministic static validator, and synthetic fixture definitions. Executable implementation tests are forbidden as D0 evidence and begin only after I0. A receipt claiming a later gate without all predecessor receipt hashes is `INVALID_RECEIPT`.

## 2. Single non-success contract (H2)

Every layer preserves one immutable originating operation result:

`OK | LOCK_BUSY | STORE_QUARANTINED | UNSUPPORTED_RUNTIME | WORKER_TIMEOUT | WORKER_SIGNALED | WORKER_EXITED | INVALID_RECEIPT | INVALID_CONFIG | CONSERVATION_FAILED | PROMOTION_RECOVERY_REQUIRED`.

`STORE_UNHEALTHY` is removed as an originating result. Health is a separate field:

`store_health = HEALTHY | UNHEALTHY | UNKNOWN | QUARANTINED`.

Rules:

1. Signal always returns `result=WORKER_SIGNALED`, the exact signal/core/faulthandler evidence, and `store_health=UNHEALTHY` unless the operation is a synthetic control.
2. Deadline always returns `result=WORKER_TIMEOUT`; `death_proven=false` forces `store_health=QUARANTINED`.
3. Count/digest/provenance mismatch returns `result=CONSERVATION_FAILED`, never signal/timeout.
4. Non-zero ordinary exit returns `result=WORKER_EXITED` with exit code.
5. Python, Node, bus, CLI, `queryKnowledgeBase`, retrieval hook, dashboard, cron, and telemetry preserve `result` byte-for-byte. They may enrich `store_health` and presentation, but never remap the originating result or replace it with empty/null success.
6. The discriminated JSON schema is versioned and reject-unknown; schema disagreement is `INVALID_RECEIPT`.

## 3. Authenticated, fresh, operation-bound guard capability (H3)

The shared guard creates an unforgeable single-operation capability only after acquiring the canonical org lock. A receipt contains:

- `receipt_version`, random 256-bit `nonce`, `issued_at`, `expires_at`, monotonic `epoch`;
- exact `operation_id`, normalized `org_id`, operation kind, collection set;
- canonical store-root digest and live lock path device/inode;
- lock owner PID plus process-start identity and process-group ID;
- frozen implementation artifact SHA and policy/schema revisions;
- BLAKE3/SHA-256 digest of every field above;
- HMAC-SHA-256 or Ed25519 signature from a key unavailable to callers and child workers.

Verification occurs inside the sole `PersistentClient` factory immediately before use and under the still-held lock. It must prove signature, constant-time digest equality, nonce freshness, unexpired deadline, exact operation/org/store/artifact/epoch match, current lock inode, current owner identity, and unused state.

The guard atomically records nonce consumption in a lock-protected 0600 replay ledger before client construction. Reuse, stale epoch, wrong operation, wrong org/store, wrong artifact, expired receipt, forged signature, changed lock inode/owner, absent replay ledger, or ledger write/fsync failure returns `INVALID_RECEIPT` before client construction. Child capability derivation is explicit, signed, parent-bound, narrower in operation scope, and single-use.

Required negatives: forged field, forged signature, copied receipt across org/store/operation, replay, expired receipt, stale epoch, replaced lock inode, PID-reuse/start mismatch, and missing/unwritable replay ledger.

## 4. No transient live mutation during proof interval (H4)

Endpoint before/after equality is necessary but insufficient. Every dry-run/copied-data proof establishes interval `[proof_start, proof_end]` and enforces both controls:

1. **Kernel-enforced write denial:** the proof worker runs without write capability to canonical live store, pointer, config, cron, rollback and production namespace paths. Allowed writable roots are an enumerated temp/side allowlist. A preflight negative write to each governed live root must fail before proof work.
2. **Independent mutation journal:** a separately owned watcher records filesystem events plus periodic full tree/pointer/config/cron hashes for every governed surface, starting before the first proof worker and ending after worker death and final manifest. Watcher identity/binary SHA, coverage roots, sequence numbers, dropped-event count, start/end monotonic times and signed journal hash bind to the operation.

PASS requires kernel denial active for the whole interval, watcher continuity with `dropped_events=0`, no governed mutation event, and matching before/after manifests. Any watcher gap, overflow, path coverage mismatch, capability drift, mutation-and-restore event, or inability to prove interval containment is `INVALID_RECEIPT`; the proof cannot claim no live mutation.

## 5. Complete promotion/rollback namespace state machine (H5)

Canonical same-filesystem namespaces are fixed in intent: `L` (live), `S` (validated side), `R` (rollback), `T` (temporary pointer/config), and stable external intent/receipt directory `J`. Unknown extra namespace or alias is recovery-required.

Every phase follows: validate pre-state hashes -> filesystem mutation -> fsync mutated file/tree -> fsync every affected parent directory -> atomically write+fsync receipt in `J` -> fsync `J` parent -> advance state. A receipt never precedes namespace durability.

| Durable phase | Required namespace/pointer state | Recovery after crash |
|---|---|---|
| `PREPARED` | `L=old`, `S=new`, `R=absent`, pointer->`L` | discard operation or resume validation; `L` remains active |
| `INTENT_DURABLE` | same; signed intent in `J` binds all hashes/actions | resume only if every hash still matches; else quarantine |
| `ROLLBACK_DURABLE` | `L=old`, `S=new`, `R=old` verified independent durable copy | resume promotion or retain old live |
| `LIVE_MOVED` | `L=absent`, `S=new`, `R=old`, pointer still resolves old identity or is transaction-blocked | rename `R->L`, fsync, restore pointer; never construct client before recovery |
| `SIDE_PROMOTED` | `L=new`, `S=absent`, `R=old`, pointer transaction-blocked/old | if `L` hash=new, proceed pointer commit; otherwise restore `R->L` and quarantine |
| `POINTER_COMMITTED` | pointer->new `L`, `R=old` | validate new live; on failure execute reverse transaction |
| `FINALIZED` | pointer->new `L`, `R=old` retained by policy, terminal receipt durable | ordinary access allowed only after final validation receipt |

Reverse rollback is separately journaled:

`RB_INTENT_DURABLE -> RB_NEW_MOVED -> RB_OLD_RESTORED -> RB_POINTER_COMMITTED -> RB_FINALIZED`.

It binds a quarantine namespace `Q` for displaced new live; it never overwrites `R`, never deletes ambiguous bytes, and specifies the same mutation/fsync/receipt ordering. Startup blocks all client construction, reads the last durable phase, inventories `L/S/R/Q/pointer`, and applies the table. Every forward and reverse phase, including crashes between mutation, directory fsync, receipt rename, and `J` directory fsync, has a power-loss fixture with exactly one outcome: resume, restore old live, or quarantine.

## 6. Independently derived conservation oracle (H6)

Expected and rebuilt ledgers must not share extraction, canonicalization, query, serialization, or executable code.

- **Oracle A (source):** a pinned read-only SQLite CLI/independent language implementation reads authoritative normalized source tables directly using a frozen query manifest and emits canonical bytes.
- **Oracle B (destination):** the candidate implementation exports rebuilt Chroma records through its public read interface.
- **Comparator C:** a third minimal executable compares the two byte streams and has no database/client imports.

Canonical encoding version `CW-KB-CONSERVATION-1` is normative:

- UTF-8; NFC strings; length-prefixed fields; IDs sorted by unsigned UTF-8 bytes;
- integers as minimal signed decimal ASCII; booleans `0|1`; null explicit;
- metadata as RFC 8785 JCS after rejecting duplicate keys/non-finite numbers;
- vectors as declared IEEE-754 binary32 or binary64 little-endian bytes, preserving signed zero and rejecting NaN/infinity, preceded by dimension and precision tags;
- chunk order encoded by explicit ordinal, never traversal order;
- model/provider/revision/chunker/tokenizer/normalization/config digests included per collection.

Oracle A, exporter B and comparator C have separate frozen SHAs and separately generated fixtures. Differential fixtures are hand-authored canonical byte/golden digest cases, plus mutations to ID, content, chunk ordinal, metadata, vector bit, dimension and provenance. PASS requires exact byte-stream digest and per-ID equality. Shared library/import/module/transitive dependency between A and B canonicalization paths is a structural failure.

## 7. WAL snapshot equivalence (M7)

The governed backup is a **logical SQLite snapshot**, not a byte-identical copy of source WAL/SHM files.

Under the org lock:

1. record source DB/WAL/SHM path metadata, journal mode, page size, schema/user/data versions and pre-backup quick/integrity results;
2. open source read-only and execute SQLite online backup into a new destination main DB;
3. finish/close backup, fsync destination DB and parent directory; destination WAL/SHM must be absent after clean close or be separately explained and empty/checkpointed;
4. reopen destination read-only and compare schema objects, table/index definitions, row counts, primary-key sets, and Oracle-A `CW-KB-CONSERVATION-1` digest to the locked source snapshot;
5. run `quick_check` and `integrity_check` on destination.

Equivalence means identical logical schema plus identical canonical authoritative rows at the same captured source transaction boundary. Source WAL/SHM bytes are evidence inputs only; they are not copied segment-for-segment and are not required to match destination bytes. Any source change counter drift during the locked backup, incomplete checkpoint/backup status, or logical mismatch fails.

## 8. Durability-before-receipt ordering (M8)

For every promotion and rollback phase, the only valid order is:

`mutate namespace/pointer -> fsync mutated file/tree -> fsync all affected parent directories -> write+fsync phase receipt temp -> rename receipt -> fsync receipt parent -> expose next phase`.

Crash injection is required after every arrow and within multi-directory fsync sets. Recovery trusts a phase receipt only when it also re-verifies the receipt's required namespace hashes and pointer state; otherwise it derives state from the namespace table and quarantines ambiguity. A receipt whose claimed mutation is not durable is invalid evidence, never authority to continue.

## 9. Atomic lock-bound quarantine decision (M9)

All quarantine reads/transitions occur under the canonical org lock. Required client-open sequence:

1. runtime/config syntax preflight without constructing/importing Chroma;
2. acquire canonical org lock;
3. re-resolve canonical store identity and re-read quarantine config from disk;
4. verify config signature/version/mode/owner, operation/store/org/epoch, and absence of a newer durable quarantine intent;
5. atomically consume the signed guard capability and bind the decision to the current config digest/epoch;
6. construct the sole `PersistentClient` before releasing or downgrading nothing—the initial policy remains exclusive.

Quarantine transitions use compare-and-swap on `(org_id, store_digest, epoch, config_digest)` while holding the same lock, followed by file and parent-directory fsync. Concurrent quarantine writers either serialize or fail `LOCK_BUSY`. A fixture pauses between initial preflight and lock acquisition while another process quarantines the store; the locked re-read must return `STORE_QUARANTINED` and the client-construction spy count must remain zero.

## 10. Bounded v3 deterministic tests

1. D0 review succeeds or fails using only frozen document/source inventory/static schema fixtures; executable implementation artifact absence cannot block D0.
2. Gate-order fixture rejects I1/C0/L0 receipts missing predecessor hashes or authority.
3. Signal, timeout, ordinary exit and conservation mismatch preserve exact originating result through every layer while health remains separate.
4. Every forged/replayed/cross-bound/stale receipt fixture returns `INVALID_RECEIPT` before client construction.
5. Proof worker live-root write attempts fail; mutation watcher detects create/write/rename/delete/restore and any journal gap/overflow.
6. Forward promotion crashes at every mutation/fsync/receipt boundary recover by the namespace table.
7. Reverse rollback crashes at every boundary recover without overwriting old or new evidence.
8. Oracle separation structural test proves no shared canonicalizer/dependency; golden and differential fixtures fail on every governed field mutation.
9. WAL fixture with active source WAL produces a logically equivalent destination while byte-different WAL state is correctly accepted; row/schema drift fails.
10. Receipt-before-directory-fsync fault cannot advance phase.
11. Quarantine TOCTOU fixture changes state between preflight and lock; locked re-read blocks client construction.

## 11. Exact residual closure matrix

| Residual | Closure | Normative anchor | Deterministic evidence |
|---|---|---|---|
| H1 circular gate | five externally decidable gates; D0 uses no implementation evidence | §1 | tests 1–2 |
| H2 typed contradiction | immutable originating result; separate health field; remove originating `STORE_UNHEALTHY` | §2 | test 3 across Python/Node/bus/CLI/query/hook/dashboard/cron |
| H3 forge/replay | signed single-use capability bound to operation/store/org/artifact/epoch and live lock identity | §3 | test 4 plus client-construction spy |
| H4 transient mutation | kernel write denial plus continuous independent journal over full interval | §4 | test 5, including mutate-and-restore and watcher-gap failures |
| H5 namespace recovery | complete forward/reverse namespace tables and recovery at every phase | §5, §8 | tests 6–7 and power-loss boundaries |
| H6 shared wrong oracle | three independent executables and normative byte encoding | §6 | test 8/golden/differential fixtures |
| M7 WAL equivalence | logical transaction-bound snapshot; WAL/SHM evidence semantics explicit | §7 | test 9 |
| M8 receipt outruns fsync | directory durability precedes phase receipt | §5, §8 | test 10 and every-arrow crash injection |
| M9 quarantine TOCTOU | locked re-read, CAS transition, capability bound to config epoch | §9 | test 11 with zero client construction |

Review passes only if all nine rows are fully satisfied on this exact frozen v3 SHA with zero Critical/High. H2 and M9 from the prior review remain closed at specification level and are not reopened by this bounded amendment.

## 12. No-live-state attestation

Authoring this amendment changed only this new specification file and ordinary task/memory bookkeeping. It did not query, ingest, count, probe, import or construct Chroma/PersistentClient; change live/copy store bytes, KB configuration, cron definitions, locks, processes, packages, runtime, containment or implementation; or perform promotion/rollback. V1, v2 and all review receipts remain byte-unchanged.
