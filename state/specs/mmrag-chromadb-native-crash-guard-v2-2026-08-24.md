# mmrag/Chroma native-crash guard v2

Status: REVIEW REQUIRED — DO NOT IMPLEMENT
Task: `task_1787575256702_63402543`
Supersedes for review only: `mmrag-chromadb-native-crash-guard-2026-08-24.md` SHA `4f4f74242b6b0dd0b7c25f799020a677c09bce641324af998d375c9cc8384ac3`

The v1 artifact remains immutable failed evidence. This v2 is a standalone specification; it authorizes no live probe, containment, repair, restart, package/runtime change, implementation, promotion, or rollback.

## 1. Goal and proven baseline

Prevent persisted Chroma/HNSW native state from crashing or silently degrading the fleet KB while preserving exact recovery and conservation evidence.

Proven in copied/temp state only:

- Python 3.14.7 + Chroma 1.5.7 copied Auditmaster collection exits 139 in `chromadb/api/rust.py:_count`.
- Existing Python 3.13.12 + Chroma 1.5.9 crashes on the same copied bytes with the same eight native offsets.
- Fresh Python 3.13.12 + Chroma 1.5.9 persisted 3072-d control passes create/count/query/reopen.
- SQLite `quick_check=ok` does not prove HNSW graph health.
- Evidence root: `/private/tmp/mmrag-sigsegv-20260824.Nftxm2`.
- Python/package-only remediation is disproven.

## 2. Runtime preflight

Before importing Chroma, resolve and emit a signed receipt containing:

- interpreter canonical path, version, file SHA-256;
- `chromadb` version;
- `chromadb_rust_bindings` canonical path, wheel ABI tag, file SHA-256;
- embedding model ID/revision, dimension, normalization and serialization settings;
- application/config schema versions;
- supported runtime tuple decision and policy version.

Unsupported or unprovable values return typed `UNSUPPORTED_RUNTIME` before any `PersistentClient` construction. A supported tuple never implies store health.

## 3. Canonical store identity and quarantine binding

For normalized organization `O`, canonical configuration defines:

- `org_id`;
- canonical live-store root;
- canonical stable lock path outside every swappable store;
- canonical quarantine key `(org_id, canonical_store_root_digest)`;
- quarantine state: `HEALTHY | QUARANTINED | REPAIR_CANDIDATE | PROMOTION_PENDING`;
- policy revision, reason code, evidence receipt hash, updated-at, authorized actor.

Configuration requirements:

1. Resolve every path with `realpath` before use.
2. Reject missing, unreadable, malformed, duplicate-key, unknown-field, wrong-owner, or permissive-mode configuration before client construction.
3. Reject live/side/rollback path equality.
4. Reject symlink or hardlink aliases: compare canonical paths, device/inode for roots and files, and recursively ensure side-tree regular files do not share inodes with the live tree.
5. Update configuration by same-directory temp file, file `fsync`, atomic rename, then parent-directory `fsync`.
6. A quarantine match returns typed `STORE_QUARANTINED` before importing/constructing Chroma.
7. Unknown store identity fails closed; no fallback to a default store.

## 4. Stable org-wide lock

Canonical lock: `$CTX_ROOT/state/kb-locks/<normalized-org>.lock`, parent `0700`, file `0600`, outside live/side/rollback trees.

- Same inode survives pointer/store swaps.
- Acquire before any SQLite backup, copy, `PersistentClient`, direct `mmrag`, dashboard KB operation, edge extraction, maintenance, reconcile, query, status, or ingest.
- Initial policy is exclusive for all operations.
- Bounded acquisition returns typed `LOCK_BUSY`.
- Owner receipt binds PID, process start identity, process group ID, operation, org, collection, acquired time and deadline.
- Stale detection verifies PID start identity; never remove a lock held by a live matching process.
- Release occurs only after every worker/process group is proven dead and all owned file descriptors are closed.

## 5. Complete call-path enforcement inventory

All paths below must call one shared guard entrypoint; lint/structural tests fail if they construct Chroma, invoke `mmrag.py`, or access the store outside it.

| Path | Required enforcement |
|---|---|
| `src/bus/knowledge-base.ts` query, ingest, collection/status | runtime/quarantine preflight, org lock, typed result propagation |
| `src/cli/bus.ts` KB CLI commands | render typed success/failure; stable documented exit enum |
| `knowledge-base/scripts/mmrag.py` every command and `PersistentClient` factory | refuse missing guard token/lock receipt; no alternate constructor |
| retrieval hook `src/hooks/hook-retrieval-enforcer.ts` | surface `KB_UNAVAILABLE` with reason; never inject empty evidence as a successful retrieval |
| dashboard KB API/routes/services | typed HTTP/service result; no `[]`, `null`, or empty-success substitution |
| `kb-reconcile-nightly.sh` and direct reconcile calls | shared guard, lock, side-store workflow |
| edge extraction | inventory whether it opens Chroma; require guard if yes and signed read receipt if no |
| maintenance/canary scripts | shared guard for any store access; source-only scans explicitly classified |
| heartbeat/onboarding/skill/ad-hoc `kb-ingest` | CLI guard transitively enforced |
| all `kb-query` callers | typed failure propagated through CLI/API/hook/dashboard |

Behavioral enforcement proof:

- repository scan allowlists exactly one `PersistentClient` factory and one native subprocess launcher;
- negative fixture adds a forbidden direct constructor/call and structural test fails;
- integration tests exercise CLI, bus function, retrieval hook, dashboard, reconcile, edge and maintenance paths with quarantined, lock-busy, signal and malformed-config results;
- source manifest binds every audited file SHA and call-site line/function identity.

## 6. Typed result contract end to end

Every operation returns one discriminated result:

`OK | LOCK_BUSY | STORE_QUARANTINED | UNSUPPORTED_RUNTIME | STORE_UNHEALTHY | WORKER_TIMEOUT | WORKER_SIGNALED | WORKER_EXITED | INVALID_RECEIPT | INVALID_CONFIG | CONSERVATION_FAILED | PROMOTION_RECOVERY_REQUIRED`.

Each non-success carries operation ID, org/store identity, phase, retryability (`false` for signal/timeout/unhealthy/invalid config), evidence path/hash, and user-safe summary.

Propagation requirements:

- Python emits one versioned JSON receipt to a dedicated descriptor/file, never mixed with logs.
- Node preserves `status`, `signal`, stderr/faulthandler, typed result and receipt hash.
- CLI exits with stable non-zero code and prints typed JSON/text.
- `queryKnowledgeBase` returns/throws a typed failure; it never returns `null`/`[]` as though retrieval succeeded.
- retrieval hook explicitly reports retrieval unavailable and omits any “retrieval succeeded” directive.
- dashboard returns a typed non-2xx API response and visible unavailable state.
- telemetry is additional evidence, never the only propagation surface.
- no non-success is retried implicitly.

## 7. Bounded worker and timeout lifecycle

Every native operation runs in a dedicated process group with `-X faulthandler` and a bounded deadline.

Timeout sequence:

1. mark `TERMINATION_STARTED` in the operation receipt;
2. send graceful termination to the process group;
3. wait bounded grace period;
4. if any member remains, send forced termination to the process group;
5. wait bounded reap period and `waitpid` every known child;
6. verify group death using PID plus process-start identity;
7. close pipes/descriptors and persist stderr/faulthandler hashes;
8. only then release the org lock.

If group death/reap cannot be proven:

- atomically set the canonical store quarantine state;
- return `WORKER_TIMEOUT` with `death_proven=false`;
- retain the org lock owner process or transfer to a dedicated quarantine lock keeper; never release ordinary access;
- require human-reviewed recovery. No new client may open the store.

Signal exit is `WORKER_SIGNALED`, terminal, zero retry.

## 8. Lock-pinned source backup and copy manifest

While holding the org lock and before any side build:

1. resolve and verify canonical live/side/rollback inequality and alias rejection;
2. checkpoint or use SQLite online backup API while the lock excludes application access;
3. include main DB plus WAL/SHM state in the backup protocol; record journal mode and checkpoint result;
4. file- and directory-`fsync` the completed source backup;
5. generate a signed copy manifest with relative path, type, mode, bytes, SHA-256, device/inode, symlink target (rejected for governed regular tree), source tree digest and backup tree digest;
6. independently rehash the backup before use.

The side store is built only from the verified backup/source corpus. It must never reuse copied failing HNSW segment files or hardlinks.

## 9. Authoritative dimension and empty collections

Vector dimension comes from this precedence, never HNSW metadata:

1. signed collection configuration bound to embedding model revision;
2. authoritative source embedding rows, all non-null vectors agreeing on one dimension;
3. versioned application schema default only for a brand-new empty collection.

Conflict, mixed dimension, missing provenance, or disagreement is `CONSERVATION_FAILED`.

Empty collection behavior:

- count must equal zero in SQLite/source authority;
- no query vector is issued;
- probe performs open/count/close and separate-process reopen/count;
- the receipt states `query=NOT_APPLICABLE_EMPTY` and binds the configured model/dimension provenance;
- an empty HNSW directory is neither required nor trusted as authority.

## 10. Per-collection child-process clone probe

Against copied/side state only, for every collection:

1. run source/backup conservation precheck;
2. child-process open;
3. count;
4. for non-empty collection, select a deterministic authoritative source vector and run one bounded query;
5. close and prove worker death;
6. new child-process reopen/count/query;
7. compare counts/IDs/result invariants;
8. persist signed receipt and logs.

Signal, timeout, malformed output, dimension uncertainty, count mismatch or query failure is `STORE_UNHEALTHY` or `CONSERVATION_FAILED`, never retry.

## 11. SQL replay and exact conservation

Repair candidate is rebuilt into a fresh side collection from authoritative SQLite/source rows. For each collection and every canonical ID, bind:

- canonical document ID and deterministic ordering;
- canonical document content digest;
- each chunk ID, ordinal, text/content digest and metadata canonical-JSON digest;
- embedding value digest over canonical numeric representation, vector dimension and vector count;
- exact embedding model provider/ID/revision, tokenizer/chunker version/config, normalization, float precision/endianness and serialization algorithm;
- source file/row provenance digest;
- rebuilt record/metadata/embedding digests.

Conservation requires exact set equality of IDs and per-ID digests; aggregate counts alone cannot pass. Zero missing, extra, duplicate, reordered-with-changed-ordinal, or provenance-mismatched items.

## 12. Durable promotion transaction and rollback

Promotion is a crash-recoverable state machine stored outside swappable trees:

`PREPARED -> INTENT_DURABLE -> LIVE_MOVED -> SIDE_PROMOTED -> POINTER_COMMITTED -> FINALIZED`

Before mutation, while holding the lock:

1. verify validated side and rollback target on the same filesystem as live;
2. create durable rollback target from the exact live tree;
3. rehash and `fsync` every rollback file and directory;
4. write signed promotion intent binding operation ID, live/side/rollback canonical paths and tree hashes, expected pointer/config/cron before state, and recovery action per phase;
5. file-`fsync`, atomic rename, parent-directory `fsync` the intent;
6. only then perform same-filesystem renames.

After each rename or pointer/config update:

- write and `fsync` the phase receipt;
- `fsync` affected parent directories;
- crash-cutpoint tests terminate after every durable step.

Startup/recovery reads the intent before any client construction and deterministically:

- restores live from rollback if side was not fully promoted;
- completes pointer commit only when live tree equals validated side hash;
- quarantines ambiguous/hash-mismatched state;
- never deletes rollback until `FINALIZED` and retention policy permits.

Finalization requires live reopen/count/query, conservation recheck, signed after manifest, then durable `FINALIZED` receipt. Rollback is an explicit reverse transaction with the same fsync and manifest rules.

## 13. Full-run before/after evidence

Before the first proof action, capture a signed manifest of:

- live store tree and active pointer identity;
- rollback and side path absence/presence;
- canonical quarantine/config file;
- org lock inode/mode/state;
- relevant cron definitions, enabled state and schedule;
- runtime tuple and native binary;
- audited source/call-path file hashes.

After the proof, capture the same surfaces. The receipt must prove:

- live tree/pointer unchanged for failed/dry-run tests;
- config changed only by the named atomic transition, or unchanged;
- cron definitions/enabled state unchanged;
- no unexpected process remains;
- temp/side/rollback artifacts match declared disposition;
- every before/after manifest is signed/hash-linked to the operation.

No proof may claim “no live mutation” without these before/after manifests.

## 14. Deterministic smoke and crash-cutpoint suite

All tests use temporary/copy stores only.

1. Fresh persisted 3072-d control on selected supported tuple: create/add/count/query/reopen.
2. Existing Python 3.12 environment, if present without install: same; otherwise explicit NOT_RUN.
3. Exact corrupt copy: `WORKER_SIGNALED`, signal evidence preserved, zero retry.
4. Timeout fixture: graceful/forced process-group termination and reap proven before lock release.
5. Unkillable/death-unproven fixture: quarantine set, normal lock access remains unavailable.
6. Twenty serialized two-file ingests: no overlap, signal, timeout or conservation loss.
7. Concurrent process: `LOCK_BUSY`, zero mutation.
8. Malformed/unreadable quarantine config: fail before client construction.
9. Path equality, symlink and hardlink alias fixtures: rejected.
10. SQLite WAL backup fixture: source backup reopens and manifest matches.
11. Empty collection: count/reopen pass, query N/A with authoritative dimension provenance.
12. Per-ID digest mutation fixtures: document, chunk, metadata, embedding value and model/config mismatches each fail.
13. Crash after every promotion state/cutpoint: deterministic completion, rollback or quarantine; never ambiguous live pointer.
14. CLI, bus API, query function, retrieval hook and dashboard each surface every typed failure without empty/null success.
15. Structural bypass fixture: forbidden direct Chroma/mmrag call fails enforcement test.
16. Signed before/after live/pointer/config/cron manifests prove zero unauthorized change.

## 15. Rollout gate

No implementation or live rollout until:

- this v2 receives independent zero-Critical/zero-High review;
- implementation plan and exact file ownership are approved;
- isolated tests above pass;
- SQL-replayed copy of every live collection passes exact per-ID conservation and probes;
- runtime/native/config/source manifests are pinned;
- crash-cutpoint recovery and rollback rehearsals pass;
- containment user-impact and rollback are separately approved;
- live action receives fresh explicit authority.

## 16. Deterministic review-closure matrix

| Finding | Required closure | Normative sections | Deterministic evidence |
|---|---|---|---|
| H1 durable rollback/promotion/crash recovery | rollback durable before swap; intent; fsync; phase recovery/finalization | §12 | same-filesystem path proof, hashes, intent/phase receipts, every crash cutpoint, rollback/finalization receipts |
| H2 timeout/reap before unlock | terminate process group, reap, verify death; quarantine when unproven | §7 | graceful/forced/death-unproven fixtures, PID-start proof, lock-release ordering receipt |
| H3 typed non-success propagation | typed result through Python, Node, CLI, query, hook, dashboard | §6, §5 | integration matrix for every result; empty/null-success negative fixtures |
| H4 exact conservation/provenance | per-ID document/chunk/embedding digest and exact model/config provenance | §11 | per-ID set-equality ledger; one mutation fixture per digest/provenance field |
| H5 lock-pinned WAL backup/path aliases | lock-pinned SQLite backup incl. WAL; inequality; symlink/hardlink rejection; copy manifests | §8, §3 | WAL fixture, device/inode and realpath negative fixtures, signed tree manifests |
| H6 full proof before/after state | signed live tree/pointer/config/cron manifests | §13 | hash-linked before/after receipts proving exact allowed delta |
| M7 every call path | exhaustive inventory plus source/behavior enforcement | §5 | source manifest, sole-factory/launcher scan, injected bypass failure, path integration tests |
| M8 canonical quarantine config | org/store key, atomic config, malformed fail-closed, pre-client hold | §3 | config parser/update tests and client-construction spy proving zero call |
| M9 dimension and empty behavior | non-HNSW authority; deterministic empty N/A behavior | §9, §10 | source/config dimension fixtures, mixed/missing conflict tests, empty reopen receipt |

Review passes only if every row's artifacts exist on exact frozen bytes and both structural and executable checks pass.
