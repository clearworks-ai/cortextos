# P1.5 — Agent-memory topic files → index — Master Plan (OBF-lite, exempt)

Source of truth: MASTER-BUILD-PLAN.md line 101 (P1.5). Research: `01-research.md` (read it —
the "two obvious designs are dead" finding drives everything below). Spec:
`03-specs/01-agent-memory-mirror-spec.md`.

## Scope (why OBF-lite exempt, not full M2C1)

Single repo (cortextos), no schema migration, no `src/` change, no new subsystem, no
mmrag.py change. Deliverable = one small mirror script + a 2-part edit to the existing P1.1
nightly wrapper. Divergence budget respected: all code under `orgs/clearworksai/` (same rule
P1.1/P1.2 followed).

## The design (decided by research, not re-decidable at build time)

**Mirror, not root.** A literal `DEFAULT_RECONCILE_ROOTS` addition is a no-op
(`.claude` ∈ `IGNORE_DIR_PARTS`, mmrag.py:69-74 → every file filtered at discovery,
mmrag.py:1451), and a P1.3-style symlink into `raw/` produces an ingest→purge oscillation
(chunks keyed by `Path.resolve()` at :1453 → stored source contains `.claude` → purged as
`ignored` at :1632 on the next run). So P1.5 ships the P1.2/P1.6 importer pattern instead:

1. **New script** `orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh` — one-way
   rsync of TOP-LEVEL `*.md` only (no recursion, `--delete` so renames/prunes propagate)
   from `~/.claude/projects/-Users-joshweiss-code-cortextos/memory/` to
   `~/code/knowledge-sync/raw/areas/clearworks/agent-memory/`. Excludes by construction:
   `handoffs/`, `memory-archive/`, `*.bak-*`, `.json`, and (per the binding P1.6 principle)
   every `.jsonl` transcript — none are ever read.
2. **Wrapper edit** `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` — call the
   mirror script as Step 0 (before reconcile), add a `memory_mirror` object to the nightly
   JSONL counts row, and fold mirror success into the existing `green` boolean. The already-
   configured `raw` reconcile root then ingests the mirror — **no mmrag.py edit, no new cron**
   (piggybacks the P1.1 `kb-reconcile-nightly` cron larry already owns).

**Flagged divergence from the plan line's literal wording** ("Add … to ingest roots"): the
intent (topic files reach the index) is delivered via the existing `raw` root + mirror,
because the literal root addition provably ingests zero files. The alternative (carving a
`.claude` exception into `_is_ignored`) mutates identity/purge logic shared by discovery,
purge, and edge extraction — rejected as high-risk for zero functional gain. The PR
description must state this divergence; Josh's merge is the sign-off (same paper-trail
pattern as P1.1's cron-owner flag).

## Why the memory dir itself doesn't move (vs P1.3 which DID move the Brain)

The path is fixed by the Claude Code harness (auto-memory for the cortextos project) and is
written by every agent session under the WAL protocol. The harness is an opaque consumer we
don't control — a move+symlink gamble risks fleet-wide memory-write breakage. P1's "files
home" sentence is satisfied the same way P1.6 satisfies it: live external store → importer →
knowledge-sync → index. The live dir stays canonical; the mirror is derived + disposable.

## Phases

### Phase 1 — mirror script (spec §Step 1)
Standalone, idempotent, safe to run any time. Emits a one-line JSON result
(`{"mirrored": N, "deleted": M, "source_count": K, "exit": 0}`) so both the wrapper and a
human can consume it. Refuses to run if the source dir is missing (exit non-zero — never
`--delete` against an empty source, which would wipe the mirror).

### Phase 2 — wrapper integration (spec §Step 2)
Step 0 in `kb-reconcile-nightly.sh` + `memory_mirror` ledger field + `green` includes
`memory_mirror.exit == 0`. Mirror failure = red row = existing P1.1 escalation path
(next cron fire Telegrams Josh on a red/missing row — no new alerting needed).

### Phase 3 — first run + proof (spec §Steps 3-5)
Run mirror + reconcile once manually (same invocation the cron uses), capture evidence:
mirror count == source top-level `*.md` count (743 at research time), chroma chunk count
for `%/raw/areas/clearworks/agent-memory/%` > 0, one kb-query answer citing an
`agent-memory/` path for a memory-only fact, green ledger row.

### Phase 4 — land
Feature branch `feature/p1-5-agent-memory-index` (branch == slug, PR-gate rule), codexer
returns diff + evidence for Larry's adversarial review, Larry opens the PR to
`clearworks-ai/cortextos`, Josh merges. Never main direct.

## Done-condition (machine-checkable)

1. `ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory/*.md | wc -l` equals
   `ls ~/.claude/projects/-Users-joshweiss-code-cortextos/memory/*.md | wc -l` (≥ 700).
2. Index has the files: chroma sqlite aggregation (P1 done-block pattern) —
   `sqlite3 "$MMRAG_DIR/chroma/chroma.sqlite3" "SELECT COUNT(DISTINCT string_value) FROM
   embedding_metadata WHERE key='source_file' AND string_value LIKE
   '%/raw/areas/clearworks/agent-memory/%';"` returns > 0 (expected ≈ file count; exact
   table/path verified at build time against the live db — fallback proof is the reconcile
   JSON's `new_files` ≥ mirrored count on first run).
3. Retrieval works: `cortextos bus kb-query` on a memory-only fact (spec names the query)
   returns a hit citing a `raw/areas/clearworks/agent-memory/...` path.
4. Nightly ledger row (`orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`)
   contains `memory_mirror` with `exit: 0` and `green: true`.
5. Negative check: zero chunks whose `source_file` contains `/.claude/` and zero chunks
   citing `handoffs/` — proves no transcript/session-state leakage and no double-index.

## Risks

- **`--delete` against a wrong/empty source wipes the mirror** → mitigated: script hard-fails
  unless source dir exists AND contains ≥ 1 top-level `*.md`; reconcile would treat a wipe as
  `removed_files` (recoverable by re-running — the live dir is canonical).
- **Mirror drift between nightly runs** → accepted: ≤ 24 h staleness for a corpus whose hot
  index (MEMORY.md) is already auto-injected into sessions; kb-query is the cold path.
- **Stale mutable-state claims inside topic files surface via kb-query** → accepted +
  already governed by the fleet-wide MUTABLE-FACT = HYPOTHESIS rule; excluding `handoffs/`
  removes the worst offender class.
- **knowledge-sync git noise (743 new untracked files)** → accepted: identical to every
  other agent write into `raw/`; vault commit cadence owns it. Script never runs `git` in
  knowledge-sync.

## File ownership

Codexer owns:
- `orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh` (new)
- `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` (Step-0 call + ledger field +
  green computation — surgical edit)

NOT touched: `knowledge-base/scripts/mmrag.py`, anything in `src/`, larry `config.json`
(existing cron already fires the wrapper), frank2 anything, the live memory dir (read-only
source), knowledge-sync git state, anything `.jsonl`.
