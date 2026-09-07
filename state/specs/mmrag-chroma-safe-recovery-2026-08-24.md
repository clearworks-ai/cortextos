---
title: mmrag Chroma safe recovery — Spec
project: cortextos
area: ai
type: spec
status: converged
mode: standard
ambiguity_score: n/a — intake clear
repo: /Users/joshweiss/code/cortextos
base-branch: origin/feat/cortextos-backup-dr
mockup: N/A — backend only
version: 1.1
date: 2026-08-24
keywords:
  - chroma
  - mmrag
  - recovery
  - rag
  - specify
---

# mmrag Chroma safe recovery — Spec

## 1. Goal

Produce a bounded, document-only recovery plan for the corrupted Chroma-backed cortextOS RAG store used by org `clearworksai` on instance `cortextos1`. Josh directed specify-only work on 2026-08-24: preserve the live store and cron JSON in this session, inspect topology read-only, and lock a recovery procedure that rebuilds onto a clean side persist directory and promotes only after independent verification. This spec does not implement crash-guard, does not open `PersistentClient` on live bytes, and does not mutate live store or crons.

**Mode:** standard. **Ambiguity:** n/a — intake clear.

**In scope:** writer/native-access freeze; immutable backup; corpus inventory; clean empty side-store rebuild; compatibility preflight; isolation and timeouts; bounded conservation; gold queries; independent verification; atomic promotion and rollback; canary; writer restoration; canonical collection identity.

**Explicitly out of scope:** implementing crash-guard v1–v3; in-place HNSW repair; using `_rebuild_collection` against live; recovering `personal` or leftover `chromadb.*` archives; recovering Auditmaster copied evidence under `/private/tmp`; vector-byte conservation oracle H6; automated crash-mid-swap fixture suite H5; this session mutating store, config, crons, processes, or packages.

**Brief / lineage:** Sibling of `state/specs/mmrag-chromadb-native-crash-guard-2026-08-24.md`, `...-v2-2026-08-24.md`, and `...-v3-2026-08-24.md`. Those files remain immutable failed/review evidence. This spec cites them and does not supersede them.

## 1b. Decisions (CONTEXT)

| ID | Area | Decision | Provenance | Settled by | Evidence | Locked by | Date |
|----|------|----------|------------|------------|----------|-----------|------|
| D-01 | Lineage | Sibling recovery spec. Cite crash-guard v1–v3 as immutable evidence. Do not implement crash-guard. Do not wait for crash-guard D0. | settled | grill | n/a | Josh | 2026-08-24 |
| D-02 | Target store | Recover only `cortextos1` / `clearworksai` live KB (`chromadb/`, `embedding-cache.sqlite`, `config.json`). Exclude `personal/chromadb`, leftover `chromadb.*` dirs, and Auditmaster tmp copies. | settled | grill | n/a | Josh | 2026-08-24 |
| D-03 | Writer freeze | Hold file plus optional `enabled=false` on the two `kb-reconcile-nightly` entries with byte-restore of those two JSON files. Do not rewrite cron job bodies. frank2 `weekly-synthesis` stays enabled; ingest must refuse the live store while the hold is up. | settled | grill | n/a | Josh | 2026-08-24 |
| D-04 | Rebuild mechanism | Forbid `_rebuild_collection` against live. Recovery builds a new empty side persist dir from corpus. Promotion is a journaled L/S/R rename after independent verification. | settled | grill | n/a | Josh | 2026-08-24 |
| D-05 | Collection identity | Rebuilt store emits `shared-clearworksai`. Config `default_collection: shared` is a naming bug. Promotion journals a config rewrite to `shared-clearworksai` so unscoped query cannot `get_or_create` a ghost `shared` collection. `agent-*` collections only if gated inventory proves a defined corpus. | settled | grill | n/a | Josh | 2026-08-24 |
| D-06 | Inventory gate | This specify run does not open `chroma.sqlite3`. A later authorized step may read SQLite metadata for collection names/ids only, never HNSW `count()` on live. | settled | grill | n/a | Josh | 2026-08-24 |
| D-07 | Freeze surface | Roast reshape: the hold is enforced at the sole `PersistentClient` factory. Queries must not collapse to empty success. Cron JSON bodies stay intact. | settled | roast | n/a | roast-council | 2026-08-24 |
| D-08 | Conservation bound | Roast reshape: conservation is source-file inventory versus side-store public export (ids/content/ordinals/provenance). It is not crash-guard H6 vector-byte oracles. Promotion is human-gated L/S/R rename with retained rollback copy, not the full v3 crash-mid-swap software suite. | settled | roast | n/a | roast-council | 2026-08-24 |
| D-09 | Authority | This artifact is document-only. No implementation, live probe, client construction, backup, freeze, promotion, or cron edit is authorized by this spec. A later explicit human L0 is required for any live epoch. Factory-hold code must exist (I1) before any live P1 freeze. | settled | roast | n/a | roast-council | 2026-08-24 |
| D-10 | Hold modes | Two modes in one hold file: `exclusive` refuses every live PersistentClient; after promotion `writers` allows isolated query/status/canary on the new live path and still refuses ingest/reconcile/delete/reset/`get_or_create` for a missing name. Dropping a hold file before I1 is a no-op. | settled | n/a | n/a | Josh | 2026-08-24 |
| D-11 | Cache isolation | Side-store workers set `MMRAG_EMBED_CACHE_PATH` to a side file. They never open the live `embedding-cache.sqlite` for write. Live cache may be copied read-only into the side cache before rebuild. | settled | n/a | n/a | Josh | 2026-08-24 |
| D-12 | Pre-backup drain | Backup waits until no process has live `chroma.sqlite3` open. Do not SIGKILL a process that may hold PersistentClient. S, L, and R are siblings under the knowledge-base root (same filesystem). Inventory uses the same `_is_ignored` rules as ingest. | settled | n/a | n/a | Josh | 2026-08-24 |

## 1c. Roast verdict

**RESHAPE** · confidence medium · 2026-08-24 · mode=code

Biggest risk: a writer-only hold leaves hook/bus/dashboard query paths opening live Chroma, collapsing SIGSEGV/timeout into empty hits, while `_rebuild_collection` or nightly reconcile still constructs `PersistentClient` on live bytes.

Cheapest 48-hour test (probe): confirm `_rebuild_collection` opens live `PersistentClient` and `queryKnowledgeBase` returns empty on spawn failure → ledger claims G-07, G-11.

Cheapest 48-hour test (demo): n/a (no UI) → D-09

Scores: Constitution 6/10 · YAGNI 4/10 · Contrarian 3/10 · Code-Researcher 5/10 · Operator 3/10

**Pivot taken:** keep the sibling recovery spec (D-01) but require factory-wide live-native refusal (D-07), fail-closed query semantics, document-only authority (D-09), and bounded conservation/promotion (D-08). Contrarian minority (hold+fail-closed forever until crash-guard ships) is recorded as a non-goal: recovery remains in scope, crash-guard implementation does not.

## 1d. Adversarial review

Round 1 · 2026-08-24 · visible Herdr/CCGram lane · grounding + logic · no hidden subagents · no live store or cron mutation.

Covered: FR-001 through FR-016 and ledger G-01 through G-28.

| Sev | Finding | Resolution |
|---|---|---|
| HIGH | FR-002 exclusive live-client refusal makes FR-012 canary on the new live path impossible | D-10 hold modes; FR-002 and FR-012 |
| HIGH | Side rebuild with default `MMRAG_DIR` writes live `embedding-cache.sqlite` (`_open_embed_cache` mkdir+CREATE) | D-11; FR-015 |
| HIGH | P1 hold file is a no-op until `get_chroma_client` checks it; matrix looked operational today | D-09/D-10; matrix I1 before P1 |
| HIGH | FR-005 inventory without `_is_ignored` cannot match ingest membership | D-12; FR-005 |
| HIGH | Unscoped post-restore query `get_or_create`s config name `shared`, creating a ghost collection | D-05; FR-014 |
| HIGH | Backup of `chroma.sqlite3` while another PersistentClient holds it is racy; SIGKILL can corrupt | D-12; FR-016 |
| MEDIUM | `cmd_query`/`cmd_status`/`cmd_collections` call `count()` (crash-guard SIGSEGV surface) | G-21; isolated workers; signal → fail |
| MEDIUM | `cmd_status` maps any Exception to `count=0` | G-28; fail-closed |
| MEDIUM | `kb-query.sh` and dashboard default instance `default`, not `cortextos1` | G-24; FR-014 |
| MEDIUM | Nightly comment says 3 roots; tuple has 2 (org Brain removed) | G-27; A-03 closed |
| LOW | Authored sqlite/cache/entry counts in G-02/G-14/G-17 will drift | Restated as dated observations plus recompute command |

No CRITICAL (no FALSE ledger row; constitution D-09 preserved). After folds: zero HIGH remain.

## 2. Constitution check

| Invariant | How this spec satisfies it |
|---|---|
| Planning lane must not mutate live store or crons | D-09; this session writes only this markdown file |
| Bus KB operations go through `src/bus/knowledge-base.ts` | Freeze and fail-closed rules bind `queryKnowledgeBase` / `ingestKnowledgeBase` as well as direct `mmrag.py` |
| File operations that swap stores must be atomic and recoverable | FR-011 same-parent rename with rollback copy; never in-place HNSW rewrite |
| Org tenancy | Target is canonical `clearworksai` only (D-02); collection `shared-clearworksai` (D-05) |
| Do not implement crash-guard from a recovery spec | D-01; crash-guard files remain byte-unchanged |
| Skills/config crons stay restorable | D-03: no cron body rewrites; optional enabled-flag flip is byte-restored |

No constitution waiver.

## 3. UI mockup

No UI surface; mockup gate N/A.

## 3b. Resolved intake questions

The first-reply open questions are closed. Planners must not re-ask them.

| Q | Question | Resolved default |
|---|---|---|
| Q1 | Lineage vs crash-guard v3 | Sibling spec. Cite v1–v3. Do not implement. Do not wait for D0. |
| Q2 | Recovery target | Only `cortextos1` / `clearworksai` live KB. |
| Q3 | Writer freeze | Hold file; optional `enabled=false` on two nightly jobs with byte-restore; no cron body rewrites. |
| Q4 | Rebuild mechanism | New empty side persist dir. Forbid live `_rebuild_collection`. |
| Q5 | Canonical collection | `shared-clearworksai`. |
| Q6 | Inventory during specify | Do not open live SQLite this run. Later gated metadata-only inventory is allowed. |

## 4. Requirements

### FR-001 — Document-only authority

**Requirement:** System MUST treat this spec as document-only authority. It MUST NOT be used as permission to open Chroma, freeze writers, copy the live store, edit crons, or promote namespaces.

**Acceptance:**
- WHEN an agent is executing this specify artifact THE SYSTEM SHALL refuse every live KB operation and every cron or store mutation.
- WHEN a later implementation or live epoch is requested THE SYSTEM SHALL require a fresh explicit human authorization naming the exact operation, not this spec's existence.

**Bucket:** A — process constraint only; no code change in this lane (G-01, G-02, G-16).

**Depends on claims:** G-01, G-02, G-16

**Verification:** Layer 1 — `git status` shows no live-store or cron path dirty from this run. Layer 6 — human L0 required before any later live epoch.

---

### FR-002 — Native-access freeze at the sole client factory

**Requirement:** System MUST enforce a hold file outside the swappable `chromadb/` directory at the sole `PersistentClient` factory so every live native open fails closed while recovery is in progress.

**Acceptance:**
- WHEN `NATIVE_HOLD` is mode `exclusive` THE SYSTEM SHALL refuse `PersistentClient` construction against the live chromadb path for every command, including query, status, ingest, reconcile, collections, delete, reset, and `get_or_create_collection`.
- WHEN `NATIVE_HOLD` is mode `writers` THE SYSTEM SHALL refuse ingest, reconcile, delete, reset, and `get_or_create` of a missing collection on the live path, and SHALL allow isolated query/status/canary against the live path.
- WHEN a caller is the approved side-store worker with an explicit side-dir capability THE SYSTEM SHALL allow construction only against the enumerated side path, never live, regardless of hold mode.
- WHEN query/ingest/hook/dashboard/cron hits a refusing hold THE SYSTEM SHALL return a typed non-success and MUST NOT return empty results, empty string, or `count=0` as success.
- WHEN `NATIVE_HOLD` is created before factory-hold code is deployed THE SYSTEM SHALL treat P1 as blocked (the file alone is a no-op).

**Bucket:** B — extend `get_chroma_client` in `knowledge-base/scripts/mmrag.py` and fail-closed wrappers in `src/bus/knowledge-base.ts`; dashboard search also constructs mmrag directly (G-06, G-11, G-12, G-20, G-22, G-28).

**Depends on claims:** G-06, G-11, G-12, G-20, G-22, G-28

**Verification:** Layer 1 — unit test that factory refuses live path when hold exists and that `queryKnowledgeBase` does not return `total: 0` as success. Layer 3 — reviewer who did not implement the factory change.

---

### FR-003 — Cron preservation

**Requirement:** System MUST freeze nightly reconcile without rewriting cron job bodies, and MUST restore those files byte-for-byte when writers are restored.

**Acceptance:**
- WHEN freeze is applied THE SYSTEM SHALL leave cron prompt/schedule text unchanged.
- WHEN `enabled=false` is used THE SYSTEM SHALL apply it only to `larry` and `larry-codex` `kb-reconcile-nightly` and SHALL retain a SHA-256 of each original file for restore.
- WHEN frank2 `weekly-synthesis` remains enabled THE SYSTEM SHALL still refuse live ingest via FR-002.

**Bucket:** B — operational procedure over existing `crons.json` files; no new cron schema (G-08, G-09).

**Depends on claims:** G-08, G-09

**Verification:** Layer 1 — `sha256sum` of the two cron files before freeze equals after restore. Layer 6 — human confirms no other cron bodies changed.

---

### FR-004 — Immutable backup

**Requirement:** System MUST take an immutable backup of the live KB surfaces before any later live epoch, without using that backup as a writable work copy.

**Acceptance:**
- WHEN backup is authorized THE SYSTEM SHALL snapshot live `chromadb/`, `config.json`, and `embedding-cache.sqlite` to a write-once tree on the same host, then fsync and record SHA-256 of the archive.
- WHEN FR-016 drain has not PASSed THE SYSTEM SHALL refuse to start the snapshot.
- WHEN fleet-hot-state backup is considered THE SYSTEM SHALL treat it as insufficient because it excludes `embedding-cache.sqlite` and prior `chromadb.bak/old/archived` trees.
- WHEN recovery work proceeds THE SYSTEM SHALL copy from the immutable backup into a disposable work tree if bytes are needed, never mutate the backup or live tree.

**Bucket:** B — existing `scripts/fleet-hot-state-backup.sh` is not sufficient; recovery needs its own snapshot command (G-14, G-15).

**Depends on claims:** G-14, G-15

**Verification:** Layer 1 — archive SHA-256 plus `tar -tzf` listing includes chromadb, config, and embedding-cache. Layer 3 — independent checksum of the archive.

---

### FR-005 — Corpus inventory

**Requirement:** System MUST inventory the authoritative ingest roots independently of Chroma.

**Acceptance:**
- WHEN inventory runs THE SYSTEM SHALL walk `DEFAULT_RECONCILE_ROOTS` (`~/code/knowledge-sync/wiki` and `~/code/knowledge-sync/raw`) using the same `_is_ignored` rules as ingest and emit a canonical file list (path, size, mtime, sha256) without opening Chroma.
- WHEN a file is ignored by `_is_ignored` THE SYSTEM SHALL omit it from Oracle A.
- WHEN a file is outside those roots THE SYSTEM SHALL exclude it from expected rebuild membership unless a later gated inventory (FR-006) proves an `agent-*` corpus.

**Bucket:** A — roots exist and ignore helper exists today (G-04, G-17, G-25, G-27).

**Depends on claims:** G-04, G-17, G-25, G-27

**Verification:** Layer 1 — inventory script exit 0 over the two roots. Layer 3 — second process re-hashes a sample of files.

---

### FR-006 — Gated SQLite name inventory

**Requirement:** System MUST NOT open live `chroma.sqlite3` during specify. A later authorized metadata-only inventory MAY list collection names/ids from SQLite and MUST NOT call HNSW `count()` or construct `PersistentClient` on live.

**Acceptance:**
- WHEN this specify run is executing THE SYSTEM SHALL not open live SQLite or Chroma.
- WHEN a later C0/L0 inventory is authorized THE SYSTEM SHALL use read-only SQLite against a lock-pinned copy, not live, and SHALL record names/ids only.

**Bucket:** A — live SQLite exists; collection names remain unread (G-02, G-18).

**Depends on claims:** G-02, G-18

**Verification:** Layer 1 — this spec's session `lsof`/process list shows no python PersistentClient against live. Layer 6 — human authorizes any later copy+sqlite step.

---

### FR-007 — Clean side-store rebuild

**Requirement:** System MUST rebuild into a new empty persist directory and MUST NOT call `_rebuild_collection` against the live dir.

**Acceptance:**
- WHEN rebuild starts THE SYSTEM SHALL create an empty sibling persist dir that is not `chromadb/`, not `chromadb.rebuild-*` produced by live `_rebuild_collection`, and not a copy of live HNSW bytes.
- WHEN `_rebuild_collection` would open `get_chroma_client(chroma_dir=live_dir)` THE SYSTEM SHALL refuse that path for recovery.
- WHEN ingest into the side store runs THE SYSTEM SHALL write only the side chromadb path and the side embedding-cache path from FR-015.

**Bucket:** B — new recovery driver required; existing `_rebuild_collection` opens live (G-07).

**Depends on claims:** G-07, G-06, G-23

**Verification:** Layer 1 — structural test that recovery driver never passes live_dir to `get_chroma_client`. Layer 3 — reviewer greps the recovery driver for live path.

---

### FR-008 — Compatibility and isolation

**Requirement:** System MUST preflight runtime compatibility and run side-store native work in an isolated subprocess with timeouts and no silent retry on signal.

**Acceptance:**
- WHEN side-store work starts THE SYSTEM SHALL record interpreter path/version, `chromadb` version, and native binding identity, and SHALL fail closed on unsupported tuples.
- WHEN a supported tuple is recorded THE SYSTEM SHALL NOT treat that as proof the live store is healthy.
- WHEN the worker exceeds its deadline or exits on signal THE SYSTEM SHALL return typed `WORKER_TIMEOUT` or `WORKER_SIGNALED` and MUST NOT retry the same live or side bytes.
- WHEN `cmd_query` or `cmd_status` would call `collection.count()` THE SYSTEM SHALL run that call only inside the isolated worker so a signal cannot hit the fleet process.

**Bucket:** B — new wrapper around existing venv python; query/status already call `count()` (G-10, G-21, G-28).

**Depends on claims:** G-10, G-21, G-28

**Verification:** Layer 1 — timeout test kills a hung worker and asserts no retry. Layer 3 — independent review of timeout constants vs bus 30000 ms and hook 12000 ms.

---

### FR-009 — Bounded conservation

**Requirement:** System MUST prove the side store conserved the inventoried corpus without sharing a canonicalizer with the builder and without requiring crash-guard vector-byte oracles.

**Acceptance:**
- WHEN conservation runs THE SYSTEM SHALL compare Oracle A (source file inventory from FR-005) to Oracle B (side-store public export of ids, source paths, chunk ordinals, and text hashes) using Comparator C with no Chroma import.
- WHEN counts, source-path sets, or ordinals disagree THE SYSTEM SHALL fail conservation and MUST NOT promote.
- WHEN vector-bit equality is requested THE SYSTEM SHALL defer it as crash-guard H6, out of scope here.

**Bucket:** B — new comparators; corpus roots and ignore helper exist (G-04, G-17, G-25).

**Depends on claims:** G-04, G-17, G-25

**Verification:** Layer 1 — comparator exit 0 on a fixture of known files; exit non-zero when one file is dropped. Layer 3 — reviewer who did not write Oracle B.

---

### FR-010 — Gold queries and independent verification

**Requirement:** System MUST freeze gold queries from corpus documents (not live retrieval) and MUST require a reviewer who did not build the recovery to score them against the side store before promotion.

**Acceptance:**
- WHEN gold queries are authored THE SYSTEM SHALL derive expected source paths from wiki/raw files, not from live `kb-query`.
- WHEN the builder's side-store queries pass THE SYSTEM SHALL still require an independent reviewer to re-run the same frozen queries against the side store.
- WHEN independent review finds a miss or wrong source THE SYSTEM SHALL refuse promotion.

**Bucket:** B — query CLI exists; live query is unsafe and fail-open today (G-03, G-10, G-11).

**Depends on claims:** G-03, G-10, G-11

**Verification:** Layer 3 — named reviewer distinct from implementer. Layer 1 — frozen gold-query file hashed before rebuild equals the file used at review.

---

### FR-011 — Atomic promotion and rollback

**Requirement:** System MUST promote the validated side persist dir onto the live path with a retained rollback copy, and MUST restore live from that copy on failure.

**Acceptance:**
- WHEN promotion is authorized THE SYSTEM SHALL require FR-009 PASS, FR-010 PASS, hold still active, and human L0.
- WHEN promotion runs THE SYSTEM SHALL rename live `chromadb` to sibling rollback `R`, rename sibling side `S` to live `L`, fsync parents, and write a durable receipt. S, L, and R SHALL share the knowledge-base parent directory (same filesystem). Hold file stays outside `chromadb/` so it survives the rename. Promotion SHALL also journal `config.json` `default_collection` to `shared-clearworksai`.
- WHEN promotion crashes after live is absent THE SYSTEM SHALL restore `R` to live and restore prior config bytes before any client construction.
- WHEN rollback is requested after a bad canary THE SYSTEM SHALL reverse the rename and config journal without deleting ambiguous bytes.

**Bucket:** B — existing `_rebuild_collection` swap is not acceptable because it opens live first (G-07).

**Depends on claims:** G-07, G-01, G-19, G-26

**Verification:** Layer 1 — dry-run fixture of the rename sequence on temp dirs. Layer 3 — independent review of crash-between-rename cases.

---

### FR-012 — Canary

**Requirement:** System MUST canary the promoted live store with the frozen gold queries under the hold still active for writers, then only lift the hold after canary PASS.

**Acceptance:**
- WHEN promotion receipt is durable THE SYSTEM SHALL downgrade hold mode from `exclusive` to `writers`, then run gold queries against the new live path in an isolated worker with FR-008 timeouts.
- WHEN the canary worker returns `WORKER_SIGNALED` or `WORKER_TIMEOUT` THE SYSTEM SHALL execute FR-011 rollback and set hold mode back to `exclusive`.
- WHEN canary misses expected sources THE SYSTEM SHALL execute FR-011 rollback and keep the hold.
- WHEN canary PASSES THE SYSTEM SHALL still keep hold mode `writers` until FR-013 restore.
- WHEN canary is invoked THE SYSTEM SHALL pin `CTX_INSTANCE_ID=cortextos1` and MUST NOT use dashboard search or `kb-query.sh` default instance.

**Bucket:** B — uses existing query entry `queryKnowledgeBase` only after fail-closed semantics from FR-002 exist (G-03, G-11, G-21, G-24).

**Depends on claims:** G-03, G-11, G-21, G-24

**Verification:** Layer 1 — canary command returns non-success on a deliberately wrong collection name. Layer 3 — independent observer of canary transcript.

---

### FR-013 — Writer restoration

**Requirement:** System MUST restore writers only after canary PASS by removing the hold and restoring cron bytes.

**Acceptance:**
- WHEN canary has not PASSed THE SYSTEM SHALL refuse hold removal.
- WHEN restore runs THE SYSTEM SHALL delete `NATIVE_HOLD`, restore the two cron files to their pre-freeze SHA-256, and leave frank2 cron bodies untouched.
- WHEN restore completes THE SYSTEM SHALL record a terminal receipt; a subsequent live native open is then ordinary access.

**Bucket:** B — inverse of FR-002 and FR-003 (G-08, G-16).

**Depends on claims:** G-08, G-16

**Verification:** Layer 1 — SHA-256 of cron files matches pre-freeze hashes; hold file absent. Layer 6 — human confirms nightly schedule still `37 3 * * *`.

---

### FR-014 — Canonical identity and instance pin

**Requirement:** System MUST rebuild and query `shared-clearworksai` on instance `cortextos1`, and MUST pin `CTX_INSTANCE_ID=cortextos1` for recovery workers so the `default` fallback cannot point at a missing store.

**Acceptance:**
- WHEN recovery workers start THE SYSTEM SHALL export `CTX_INSTANCE_ID=cortextos1` and `MMRAG_DIR` to the clearworksai knowledge-base root, and MUST NOT rely on `kb-query.sh` or dashboard `default`.
- WHEN collection name is omitted after promotion THE SYSTEM SHALL use `shared-clearworksai` because `config.json` was journaled in FR-011, not because of the pre-recovery `shared` value.
- WHEN `agent-*` collections lack a proven corpus THE SYSTEM SHALL omit them from rebuild.

**Bucket:** B — naming split exists today between TS, reconcile default, config, and shell/dashboard defaults (G-01, G-03, G-04, G-05, G-19, G-24).

**Depends on claims:** G-01, G-03, G-04, G-05, G-19, G-24

**Verification:** Layer 1 — recovery driver prints pinned instance and collection before any client construction. Layer 3 — reviewer confirms no `:-default` fallback remains in the recovery driver.

---

### FR-015 — Embedding-cache isolation

**Requirement:** System MUST give the side-store worker its own embedding-cache file so rebuild cannot write the live cache.

**Acceptance:**
- WHEN a side worker starts THE SYSTEM SHALL set `MMRAG_EMBED_CACHE_PATH` to a path under the side work tree, not `MMRAG_DIR/embedding-cache.sqlite`.
- WHEN the live cache is reused THE SYSTEM SHALL copy it into the side cache path before any embed write, then treat the copy as side-owned.
- WHEN the hold is active THE SYSTEM SHALL refuse `_open_embed_cache` against the live cache path.

**Bucket:** B — cache path is overridable today but defaults to the live file and creates tables on open (G-13, G-23).

**Depends on claims:** G-13, G-23

**Verification:** Layer 1 — unit test that side worker env does not resolve to the live cache path. Layer 3 — reviewer confirms live cache mtime unchanged during a fixture rebuild.

---

### FR-016 — Pre-backup process drain

**Requirement:** System MUST prove no process holds live `chroma.sqlite3` before snapshot, and MUST NOT SIGKILL a process that may own PersistentClient.

**Acceptance:**
- WHEN backup is requested THE SYSTEM SHALL list openers of live `chroma.sqlite3` and WAL/SHM if present.
- WHEN any opener remains THE SYSTEM SHALL wait for a bounded drain deadline, then fail FR-004 rather than SIGKILL.
- WHEN drain PASSES THE SYSTEM SHALL record the empty-opener receipt as a predecessor of the backup SHA-256.

**Bucket:** B — freeze plus drain; no process-kill API exists in mmrag today (G-02, G-16).

**Depends on claims:** G-02, G-16

**Verification:** Layer 1 — fixture with a dummy flock/open fails drain. Layer 6 — human confirms no live mmrag PID before L0 backup.

## 4b. Acceptance matrix

| Phase | Name | FR | Pass evidence | Fail action |
|---|---|---|---|---|
| I1 | Factory-hold implementation accepted | FR-002 | Isolated tests: exclusive hold refuses live client; writers hold refuses ingest/`get_or_create`; query fail-closed | No live P1 |
| P0 | Document only | FR-001 | This spec committed; live store/cron bytes unchanged | Stop; no live work |
| P1 | Freeze native live opens | FR-002, FR-003, FR-014, FR-016 | I1 done; hold mode `exclusive`; cron bodies unchanged; instance pinned; no live sqlite openers | Do not backup or rebuild |
| P2 | Immutable backup | FR-004, FR-016 | Drain receipt; archive SHA-256 includes chromadb, config, embedding-cache | Abort; leave hold in place |
| P3 | Corpus inventory | FR-005, FR-006 | File list for wiki+raw after `_is_ignored`; no live PersistentClient | Abort |
| P4 | Side rebuild | FR-007, FR-008, FR-015 | Empty side dir populated; side cache path; no live client; timeout/signal typed | Destroy side dir; live untouched |
| P5 | Conservation | FR-009 | Comparator C exit 0 on ids/paths/ordinals | Do not promote |
| P6 | Gold + independent review | FR-010 | Frozen queries scored by non-builder against side store | Do not promote |
| P7 | Promote or rollback | FR-011 | Receipt: L=new, R=old, config `shared-clearworksai`, hold still `exclusive` then downgrade | Restore R to L and prior config |
| P8 | Canary | FR-012 | Hold mode `writers`; gold queries hit expected sources on new live; no signal | Rollback FR-011; hold `exclusive` |
| P9 | Restore writers | FR-013 | Hold gone; cron SHA-256 restored | Keep hold; do not enable nightly |

No phase may use evidence produced by a later phase. A receipt that skips a predecessor is invalid.

## 5. API contracts

No HTTP endpoint is a recovery control plane. Existing dashboard search is out of scope and is not invoked by this spec. Canary uses `cortextos bus kb-query` after FR-002 fail-closed semantics exist.

## 6. MCP tool contracts

No MCP tools are named.

## 7. Grounding Ledger

| ID | Claim | Probe | Evidence | Verdict |
|----|-------|-------|----------|---------|
| G-01 | Live KB root is `~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base` with `default_collection` `shared` | `cat ~/.cortextos/state/ACTIVE_INSTANCE`; `cat .../knowledge-base/config.json` | ACTIVE_INSTANCE=`cortextos1`; config embedding_dimensions 3072 and default_collection `shared` | VERIFIED |
| G-02 | Live `chromadb/` contains `chroma.sqlite3`; this specify run did not open it as a database | `ls` of live chromadb; python `Path.is_file` / `stat` | `chroma.sqlite3` is a regular file. Recompute size at use time with `stat -f%z`. Observed 2026-08-24 during specify. No PersistentClient invoked | VERIFIED |
| G-03 | `queryKnowledgeBase` queries collection `shared-${org}` via `mmrag.py query` | `src/bus/knowledge-base.ts` lines 136-218 | `collections.push(\`shared-${org}\`)`; spawns mmrag query with `--collection` | VERIFIED |
| G-04 | Reconcile default collection is `shared-clearworksai` and roots are wiki+raw | `knowledge-base/scripts/mmrag.py` lines 134-138 | `DEFAULT_RECONCILE_COLLECTION = "shared-clearworksai"`; roots `knowledge-sync/wiki` and `knowledge-sync/raw` | VERIFIED |
| G-05 | Nightly script sets `MMRAG_DIR` with `CTX_INSTANCE_ID:-default` then runs `mmrag.py reconcile --json --yes` | `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` lines 14 and 21 | `export MMRAG_DIR="$HOME/.cortextos/${CTX_INSTANCE_ID:-default}/orgs/clearworksai/knowledge-base"`; python reconcile `--json --yes` | VERIFIED |
| G-06 | The only `chromadb.PersistentClient` constructor in the live tree is `get_chroma_client`, with no hold check | `knowledge-base/scripts/mmrag.py` lines 508-510; rg PersistentClient excluding `.agent-worktrees` | `return chromadb.PersistentClient(path=str(chroma_dir or CHROMADB_DIR))`; no FileLock/fcntl/flock in mmrag.py | VERIFIED |
| G-07 | `_rebuild_collection` constructs a live client and `count()`s live before swap | `knowledge-base/scripts/mmrag.py` lines 1847-1851 and 1950-1957 | `live_client = get_chroma_client(chroma_dir=live_dir)` then `existing_collection.count()`; later `shutil.move` live then temp | VERIFIED |
| G-08 | Live larry and larry-codex `kb-reconcile-nightly` are enabled at `37 3 * * *` | python parse of `~/.cortextos/cortextos1/.cortextOS/state/agents/larry{,-codex}/crons.json` | both jobs `"enabled": true` `"schedule": "37 3 * * *"` | VERIFIED |
| G-09 | frank2 `weekly-synthesis` prompt may call `kb-ingest` | rg `kb-ingest` in frank2 live `crons.json` | prompt contains `cortextos bus kb-ingest where appropriate` | VERIFIED |
| G-10 | Retrieval hook `kbQuery` uses 12000 ms timeout and returns empty string on failure | `src/hooks/hook-retrieval-enforcer.ts` lines 174-190 | `timeout: 12000`; `catch { return ''; }` | VERIFIED |
| G-11 | `queryKnowledgeBase` uses 30000 ms timeout and returns empty results on spawn failure | `src/bus/knowledge-base.ts` lines 176-185 and 263-277 | `timeout: 30000`; catch returns `{ results: [], total: 0 }` | VERIFIED |
| G-12 | `ingestKnowledgeBase` writes `shared-${org}` with no hold check | `src/bus/knowledge-base.ts` lines 283-363 | collection `shared-${org}`; `execFileSync` ingest; no NATIVE_HOLD | VERIFIED |
| G-13 | Embedding cache default path is `MMRAG_DIR/embedding-cache.sqlite` and is overridable | `knowledge-base/scripts/mmrag.py` lines 155, 517-521 | `DEFAULT_EMBED_CACHE_FILENAME = "embedding-cache.sqlite"`; `_embed_cache_path` honors `MMRAG_EMBED_CACHE_PATH` | VERIFIED |
| G-14 | Live embedding-cache.sqlite exists as a regular file beside chromadb, not inside it | python `Path.is_file` on live `embedding-cache.sqlite` | file exists under knowledge-base root. Recompute size with `stat -f%z`. Observed 2026-08-24 | VERIFIED |
| G-15 | `fleet-hot-state-backup.sh` includes live chromadb and excludes embedding-cache plus chromadb.bak/old/archived | `scripts/fleet-hot-state-backup.sh` lines 64-69 and 86-89 | include chromadb+config+media; exclude `embedding-cache.sqlite` and `chromadb.bak/old/archived-*` | VERIFIED |
| G-16 | No NATIVE_HOLD, WRITE_HOLD, or `.writer-hold` file exists on the live KB root | python `Path.exists` for those three names | all False | VERIFIED |
| G-17 | Corpus roots wiki and raw exist as directories | python `Path.is_dir` | both exist. Top-level `iterdir` counts are not a file inventory; recompute with a walk plus `_is_ignored` | VERIFIED |
| G-18 | Live collection names were not read this session | specify session constraint; no chroma/sqlite query executed | directory listing only; collection list unread | VERIFIED |
| G-19 | Query/status/list/delete fall back to config `default_collection` or `default`, not `shared-clearworksai` | `knowledge-base/scripts/mmrag.py` lines 2846, 3492, 3624, 3729, 3777, 3823 | `args.collection or config.get("default_collection", "default")` | VERIFIED |
| G-20 | Dashboard search route constructs MMRAG env and invokes `mmrag.py` directly | `dashboard/src/app/api/kb/search/route.ts` lines 75-106 | sets `MMRAG_DIR` / `MMRAG_CHROMADB_DIR` / `MMRAG_CONFIG`; pythonPath + mmragPath | VERIFIED |
| G-21 | `cmd_query` calls `collection.count()` before search; `cmd_collections` calls `count()` per collection | `knowledge-base/scripts/mmrag.py` lines 3495 and 3816-3818 | `if collection.count() == 0`; `print(..., col.count())` | VERIFIED |
| G-22 | `get_chroma_collection` uses `get_or_create_collection`, so a query with a missing name creates a collection | `knowledge-base/scripts/mmrag.py` lines 500-505 | `return client.get_or_create_collection(name=collection_name, metadata={"hnsw:space": "cosine"})` | VERIFIED |
| G-23 | `_open_embed_cache` creates parent dirs and CREATE TABLE on the resolved cache path | `knowledge-base/scripts/mmrag.py` lines 524-551 | `cache_path.parent.mkdir(parents=True, exist_ok=True)` then `CREATE TABLE IF NOT EXISTS embedding_cache` | VERIFIED |
| G-24 | `kb-query.sh` and dashboard default instance id is `default`, not `cortextos1` | `bus/kb-query.sh` line 36; `dashboard/src/lib/config.ts` line 14 | `INSTANCE_ID="${CTX_INSTANCE_ID:-default}"`; `process.env.CTX_INSTANCE_ID ?? 'default'` | VERIFIED |
| G-25 | Ingest ignore helper is `_is_ignored` over `IGNORE_DIR_PARTS` and `IGNORE_FILE_EXTS` | `knowledge-base/scripts/mmrag.py` lines 69-76 and 1119-1131 | dir parts include `.git`, `node_modules`, `archive`; file ext `.lock`, `.log`, `.tmp` | VERIFIED |
| G-26 | `_sibling_work_dir` places rebuild/old dirs as siblings of the live chromadb directory | `knowledge-base/scripts/mmrag.py` lines 938-948 | `parent / f"{stem}.{kind}-{timestamp}-{pid}-{counter}"` | VERIFIED |
| G-27 | Nightly script comment says 3 reconcile roots; the tuple has 2 | `kb-reconcile-nightly.sh` line 20 comment vs `mmrag.py` 135-138 | comment `all 3 DEFAULT_RECONCILE_ROOTS`; tuple is wiki and raw only | VERIFIED |
| G-28 | `cmd_status` maps any Exception while counting to `count = 0` | `knowledge-base/scripts/mmrag.py` lines 3731-3735 | `except Exception: count = 0` | VERIFIED |

Probed against: local filesystem and repo at branch `feat/cortextos-backup-dr` @ `e5c78ad4` plus this review pass, 2026-08-24. Read-only. No PersistentClient, no query, no ingest, no cron write.

## 8. Feasibility summary

| Bucket | FRs | Meaning |
|---|---|---|
| A — buildable as procedure/constraint now | FR-001, FR-005, FR-006 | Document-only authority, corpus roots, ignore helper, inventory gate |
| B — needs work in existing code | FR-002, FR-003, FR-004, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016 | Factory hold modes, fail-closed bus/hook, recovery driver, backup+drain, cache isolation, comparators, promotion, canary, restore |
| C — needs new schema/data | — | none |
| D — needs a capability we lack | — | none; crash-guard implementation is an explicit non-goal, not a missing prerequisite for this document |

Reader / index / projection for B work: freeze is read by every native open (reader = factory); backup/inventory/gold files are the projection; promotion receipt is the durable index of which bytes are live.

## 9. Accepted assumptions

| ID | Assumption | Why unprobed | Owner | Settles when |
|----|-----------|--------------|-------|--------------|
| A-01 | Live Chroma collections include `shared-clearworksai` as the fleet query target | D-06 forbids opening live SQLite/Chroma this run (G-18) | Josh | Gated copy+sqlite name inventory after C0 |
| A-02 | `agent-*` collections either have no distinct corpus or can wait | Collection names unread | Josh | Same gated inventory as A-01 |
| A-04 | Roast Contrarian hold-forever-until-crash-guard is rejected | Conflicts with locked D-01 recovery-in-scope | Josh | Reopen only if L0 is refused |

G-18 is VERIFIED as a session fact (unread), not as a statement of collection contents. A-01 owns the unread contents.

## 10. Non-functional requirements

| ID | Requirement | Measure |
|---|---|---|
| NFR-1 | This specify run makes zero live mutations | `git status` plus live KB mtime not caused by this session's writes |
| NFR-2 | Side-store workers have a hard timeout | Distinct from bus 30000 ms query timeout and hook 12000 ms; no silent retry on signal (G-10, G-11) |
| NFR-3 | Hold file mode 0600, path outside `chromadb/` | Survives L/S/R rename |
| NFR-4 | Backup includes embedding-cache | Fleet backup exclusion is not acceptable (G-14, G-15) |
| NFR-5 | Fail-closed over fail-open | Empty `kb-query` / empty hook string / `cmd_status count=0` is not a freeze PASS (G-10, G-11, G-28) |
| NFR-6 | Isolation | Side worker has no write capability to live chromadb, live embedding-cache, cron JSON, or backup tree (G-23) |
| NFR-7 | Gold/canary embeddings are metered Gemini calls | Bound cost before L0; over $2 ask; workers pin `cortextos1` |

## 11. Open follow-ups

| Item | Notes |
|---|---|
| Crash-guard v3 still REVIEW REQUIRED | Immutable evidence. Not implemented here. |
| Fail-open query/hook/status | FR-002/FR-012 require a later code change; current behavior is G-10, G-11, G-28 |
| Nightly `:-default` fallback | FR-014 pins recovery workers; the production script still has the fallback (G-05) |
| Stale "3 roots" comment | G-27; code has two roots; do not add a third |
| Dashboard direct mmrag | G-20; freeze must cover it via factory, not via bus alone |
| Leftover `chromadb.old-*` / `.bak-*` / `.archived-*` | Out of recovery target; do not delete in this spec |
| `links.sqlite` / `kb-extract-edges` | Nightly step 2 is not Chroma; out of this recovery |
| `media/` cache dir | Not in D-02; not required for wiki/raw text rebuild |

## 12. Handoff notes

**For `/goalify`:** Status is `converged` for the document. Do not start live freeze/backup/rebuild. Next is a separate I0 implementation authorization for factory-hold code, then I1 tests, then human L0 for a named live epoch.

**For `writing-plans`:** Copy Global Constraints verbatim:

- No PersistentClient on live bytes except canary under hold mode `writers`.
- No `_rebuild_collection` against live.
- Hold at `get_chroma_client` with modes `exclusive` then `writers`; hold file outside `chromadb/`.
- Collection `shared-clearworksai`; instance `cortextos1`; journal config default on promote.
- Side worker uses a side `MMRAG_EMBED_CACHE_PATH`.
- Backup only after drain; include `embedding-cache.sqlite`.
- Inventory uses `_is_ignored`.
- Conservation is file-inventory vs side export, not crash-guard H6.
- Cron bodies are immutable; optional enabled-flag flip is byte-restored.
- This spec is not live authority. I1 before P1.

**For plan mode:** Start from §4, §4b, and §7. Do not re-litigate D-01–D-12.

## Changelog

- **2026-08-24** — v1.1. Adversarial round 1 (visible Herdr/CCGram lane; grounding plus logic; no hidden subagents) covered FR-001–FR-016. Folded hold modes, cache isolation, drain, ignore-filter, config identity, same-FS rename. Ledger G-01–G-28 VERIFIED, 0 FALSE. 2026-08-24 converged with zero CRITICAL/HIGH.
- **2026-08-24** — v1.0. Mode=standard. Ambiguity=n/a — intake clear. Q1–Q6 accepted as listed defaults. Roast RESHAPE folded as D-07–D-09. Probed 20 claims. Status was draft-pre-adversarial.
