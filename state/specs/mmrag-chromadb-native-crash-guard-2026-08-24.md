# mmrag/Chroma native-crash compatibility guard

Status: APPROVED by Larry for isolated implementation only
Task: `task_1787575256702_63402543`

## Goal

Prevent a corrupt or incompatible persisted Chroma HNSW segment from crashing fleet KB processes, without mutating live KB state, blind-retrying native failures, or treating a Python/package change as sufficient remediation.

## Proven baseline

- Current runtime: Python 3.14.7, Chroma 1.5.7, Node 22.22.3.
- An APFS copy of the exact Auditmaster collection deterministically exits 139 in `chromadb/api/rust.py:_count` with the same eight offsets as 28 macOS crash reports.
- The same copied bytes crash under an existing Python 3.13.12 + Chroma 1.5.9 environment.
- A fresh persisted 128-record, 3072-dimensional control passes create/count/query and separate-process reopen under Python 3.13.12 + Chroma 1.5.9.
- SQLite `quick_check=ok` does not prove HNSW graph health.
- Evidence root: `/private/tmp/mmrag-sigsegv-20260824.Nftxm2`.

## Functional requirements

### FR-1 Runtime compatibility preflight

Before importing Chroma, resolve and report:

- interpreter path/version and SHA-256;
- `chromadb` version;
- native `chromadb_rust_bindings` path, wheel ABI tag, and SHA-256;
- supported runtime tuple allowlist.

Unsupported tuples fail closed with a typed result. The guard must explicitly state that a supported tuple does not prove store health.

### FR-2 Stable org-wide lock

All local `PersistentClient` operations for an org share one stable lock inode outside the swappable store directory. Initial rollout serializes reads, status, reconcile, and writes exclusively. Lock acquisition has a bounded timeout and returns a typed busy result; it never retries silently.

### FR-3 Isolated persisted-store probe

Provide a subprocess probe that runs with `-X faulthandler` against a copied/side store and performs, for every collection:

1. open;
2. `count()`;
3. one bounded vector query using the collection dimension;
4. close;
5. separate-process reopen, count, and query.

Exit by signal, timeout, malformed output, count mismatch, or query failure is `STORE_UNHEALTHY`. Preserve command, runtime tuple, exit status/signal, stderr/faulthandler path, collection, and timestamps. Never retry a signal failure.

### FR-4 Side-store ingest and atomic promotion

Ingest/reconcile must not write directly to the live store:

1. acquire org lock;
2. clone/build a side store;
3. run SQLite `quick_check`;
4. run the isolated native probe;
5. verify expected collection counts, non-shrink rules, and source-row conservation;
6. atomically promote the validated side store while holding the lock;
7. retain a rollback pointer/receipt.

Any failure leaves the live store unchanged.

### FR-5 Node failure classification

The Node wrapper distinguishes:

- normal non-zero exit;
- timeout;
- `status:null` with `signal:SIGSEGV` or other signal;
- invalid JSON/receipt;
- lock busy;
- unsupported runtime;
- unhealthy store.

Signal failures preserve evidence and are terminal for that invocation. Query paths must not collapse them to `null` without telemetry.

### FR-6 No unsafe heuristic

Do not classify `index_metadata.pickle dimensionality=None` as corruption. It exists in all 13 local persisted production segments and the known-good fresh control.

## Smoke-test acceptance

All tests use temporary stores only.

1. Fresh persisted 3072-d control on selected Python 3.13/Chroma tuple: create/add/count/query/reopen PASS.
2. Python 3.12 supported tuple, when an existing environment is available: same PASS. The implementation must not install it automatically.
3. Exact copied corrupt store: subprocess reports `STORE_UNHEALTHY`, captures signal evidence, and performs zero retry.
4. Twenty serialized two-file ingests: no signal, timeout, count loss, or overlapping lock ownership.
5. Concurrent second process: bounded `LOCK_BUSY`, no store mutation.
6. Side-store probe failure: live-store tree hash unchanged.
7. Successful side-store promotion: expected tree/count receipt and rollback pointer exist.
8. Node tests cover every typed failure class.

## Rollout gate

No live rollout until:

- the guard and smoke suite pass in an isolated temp root;
- a SQL-replayed repaired copy of every live collection passes count/query/reopen;
- SQLite row counts, collection counts, and source-document conservation match;
- the exact runtime tuple and native SHA are pinned;
- a rollback rehearsal succeeds against copied state;
- independent review returns zero Critical/High findings.

Package upgrade or Python downgrade alone is not promotion evidence.

## Scope exclusions

- no live KB reads through the suspect native graph during implementation proof;
- no live-store write, repair, migration, swap, restart, reinstall, or blind retry;
- no deletion of crash reports or persisted segments;
- no rollout without a separate reviewed receipt and explicit authority.

## Exposure inventory — review required before containment

### Shared-store implementation call sites

| Surface | Current behavior | Exposure |
|---|---|---|
| `src/bus/knowledge-base.ts:136-199` `queryKnowledgeBase` | Synchronously spawns repo-venv `mmrag.py query` against the org store; catches process failure for the caller. | Any agent query or retrieval hook can open the same persisted graph while another process writes. A signal can be collapsed into an empty/null retrieval result. |
| `src/bus/knowledge-base.ts:283-365` `ingestKnowledgeBase` | Synchronously spawns `mmrag.py ingest`; store root is shared per org. | Serial only inside one Node process. Multiple agents can write concurrently; native signal throws without structured classification. |
| `src/cli/bus.ts:2529-2670` KB commands | Public CLI exposes query, ingest, and collection/status paths. | Ad hoc human/agent calls bypass any fleet-wide serialization because no stable org lock exists. |
| `knowledge-base/scripts/mmrag.py:508-510` | Creates a local `chromadb.PersistentClient` for the shared directory. | Reads and writes reach native HNSW state directly. Client lifecycle is process-local. |
| `mmrag.py:1628+`, `2917+` reconcile | Reconciles files into the local collection and supports rebuild/fresh/force modes. | Long-running writer can overlap queries, heartbeat ingests, or another reconcile. |
| `src/hooks/hook-retrieval-enforcer.ts:185` | Automatically calls `cortextos bus kb-query` before eligible responses. | High-frequency implicit readers exist across agent sessions, not only explicit KB tasks. |

### Scheduled and lifecycle writers/readers

| Trigger | Location | Operation |
|---|---|---|
| Agent heartbeat/session memory ingestion | agent/orchestrator `HEARTBEAT.md` and `AGENTS-REFERENCE.md` templates; installed agent copies | `kb-ingest MEMORY.md + daily memory --force`; potentially one writer per enabled agent heartbeat. |
| Nightly reconcile | `orgs/clearworksai/agents/larry/config.json` cron `kb-reconcile-nightly`; `larry/bin/kb-reconcile-nightly.sh:20-25` | Background direct `mmrag.py reconcile --json --yes`, then edge extraction. Can run for hours. |
| Nightly memory feed | `larry/config.json` cron `claude-mem-export` | Writes source markdown consumed by the later reconcile; not itself a Chroma writer, but expands the next reconcile workload. |
| Nightly maintenance | `larry/config.json` cron `kb-maintenance-sweep` | Reads reconcile ledger and launches background maintenance/canary work; must be classified per subcommand before rollout. |
| Onboarding/bootstrap | installed/templates `ONBOARDING.md` | Initial `kb-ingest`; can coincide with normal fleet traffic. |
| Skill-driven/ad hoc ingest | `community/skills/knowledge-base`, `memory`, `obsidian-log`, `nighttime-mode`, agent-local copies | Explicit research/output ingestion from any agent. |
| Automatic retrieval | `hook-retrieval-enforcer` | Implicit `kb-query` on user prompts across concurrent agents. |

The inventory is open-ended at the policy layer: any caller of the public CLI is a potential reader/writer. The lock must therefore sit below CLI call sites at the shared store boundary, not in individual crons or skills.

### Stable lock identity

For org `O`, use a canonical lock outside the swappable Chroma directory, for example:

`$CTX_ROOT/state/kb-locks/<normalized-O>.lock`

Requirements:

- resolve and validate `$CTX_ROOT` and normalized org before use;
- create parent mode `0700`, lock file mode `0600`;
- same inode across live/side-store swaps;
- include owner PID, process start identity, operation, collection, acquired time, and deadline in a separate diagnostic receipt; the lock primitive, not the receipt contents, owns exclusion;
- bounded acquisition timeout; stale-owner detection must verify PID start identity and never delete a live owner lock;
- acquire before any `PersistentClient` construction and hold through close/promotion.

Initial safest policy is one exclusive lock for query, status/count, ingest, reconcile, repair-copy build, and promotion. A later read/write lock optimization requires separate stress evidence.

### Reversible containment options (no action authorized)

1. **Application-level write hold:** make ingest/reconcile return typed `STORE_QUARANTINED` for the affected org/collection while queries remain unchanged. Reversible by config. Risk: queries can still SIGSEGV on the corrupt graph, so this is insufficient alone.
2. **Application-level all-native-operation hold:** fail closed before `PersistentClient` construction for the affected org, preserving source files and SQLite/HNSW bytes. Reversible by config and safest against further crashes, but temporarily removes local KB retrieval.
3. **Disable scheduled writers only:** pause nightly reconcile and heartbeat ingestion while leaving ad hoc CLI/hook reads. Reversible, but incomplete because ad hoc writers remain callable and readers still crash.
4. **Route reads to a validated side copy:** only after clone probe passes. Reversible by pointer swap; unavailable for the currently corrupt Auditmaster copy until SQL replay repair is validated.
5. **Process isolation without hold:** wrap every call in a child so the daemon survives SIGSEGV. This contains blast radius but does not protect persisted bytes and must not be presented as remediation.

Recommended pre-implementation containment for review: option 2, scoped to the proven affected org/store, only after Frank2 approves the exact exposure inventory and user-visible degradation. Until then, make no live-state/config/cron change.

### SQL-replay conservation gate

A repair candidate must be created from authoritative SQLite/source rows into a fresh side collection, never by copying the failing HNSW segment. The receipt must bind:

- source SQLite SHA and `quick_check` result;
- collection names and IDs;
- source row/document/chunk/embedding counts;
- deterministic IDs and metadata digests;
- embedding dimension and vector count;
- rebuilt side-store tree manifest;
- count/query/reopen probe receipt per collection;
- zero missing, duplicate, or extra IDs;
- rollback pointer to the untouched original bytes.

Promotion remains blocked until every collection passes this conservation gate and independent review.
