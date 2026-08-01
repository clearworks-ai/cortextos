# P1.5 — Agent-memory topic files → index — Research

Source of truth (binding): ~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/
MASTER-BUILD-PLAN.md line 101 (P1.5): "Add `~/.claude/projects/-Users-joshweiss-code-cortextos/
memory/*.md` (distilled topic files, NOT raw transcripts) to ingest roots." P1 framing lines
85-113; done-condition block after the P1 table. Sibling precedent: P1.1 (`.agent/one-big-feature/
p1-1-kb-reconcile-cron/`), P1.2 (mirror_deliverables.py, commit 0721f95), P1.3
(`.agent/one-big-feature/p1-3-org-brain-foldin/`, merged — PRs #188/#184 lineage).

## What is in the memory dir (verified on disk 2026-07-31)

`~/.claude/projects/-Users-joshweiss-code-cortextos/memory/` — 750 entries, 3.7 MB total:

- **743 top-level `*.md` files** — the distilled topic files this item is about:
  445 `feedback_*` (corrections/rules), 132 `reference_*` (durable facts/procedures),
  109 `project_*` (decisions/status), 35 `incident_*` (verified root causes), 5 `user_*`
  (Josh preferences), 6 index files (`MEMORY.md` + `MEMORY-larry/frank2/codexer/archive.md` +
  `MEMORY-SPLIT-PROPOSAL.md`), ~11 dated/misc notes (`2026-07-31.md`, `daily-*.md`, etc.).
- **Subdir `handoffs/`** — 44 session-handoff snapshots (`handoff-<timestamp>.md`).
- **Subdir `memory-archive/`** — currently empty.
- **Non-md junk**: `context-budget-baseline.json`, `last_comms_check` (no ext),
  3× `MEMORY.md.bak-*` (suffixes like `.bak-pre-split`, not `.md`).

## Why the topic files are KB-worthy

They are exactly the corpus class the P1 consolidation wants in the index: durable,
cross-session, distilled facts about the org — client routing rules, verified incident root
causes, decided-don't-relitigate decisions, credential/ops procedures, Josh's preferences.
Every entry was written under the WAL protocol precisely because it must survive context
death. Today they are reachable only via the auto-memory injection of ONE Claude project
(cortextos main-repo sessions); kb-query cannot cite them, and agents in other cwd contexts
never see them. Indexing them closes that gap.

## Why raw jsonl transcripts stay excluded (binding, do not re-litigate)

Per the P1.6 line in the same table: "Raw 9.9 GB / 20,098 jsonl = archive only, NEVER
raw-ingest." Same principle here: the `.jsonl` conversation logs beside this memory dir
(under `~/.claude/projects/.../`) are raw session transcripts — undistilled, enormous, full
of stale mutable-state claims and PII-ish operational noise. The distillation path for
session signal is P1.6 (claude-mem exporter), a separate track. P1.5 touches ONLY the
already-distilled `memory/*.md` topic files. Nothing in this plan reads or ingests any
`.jsonl`.

`handoffs/*.md` are also excluded by this plan: they are per-session state snapshots, not
distilled durable knowledge, and MEMORY.md's own hot rule says "THE MISSION ANCHOR/HANDOFF
IS ALSO STALE RETRIEVAL." Indexing them would feed kb-query stale in-flight-state claims.
The plan line's own phrasing (`memory/*.md`, "distilled topic files") is a top-level glob —
subdirs are out.

## Current mmrag state (verified in source, post-P1.3)

- `DEFAULT_RECONCILE_ROOTS` (mmrag.py:135-138) = `~/code/knowledge-sync/wiki`,
  `~/code/knowledge-sync/raw`. (The org-Brain root was removed by P1.3 — merged.)
- Discovery: `_iter_reconcile_files` (mmrag.py:1440-1455) rglobs each root, drops dotfiles,
  then filters `_is_ignored` + `_is_supported_file`, and keys every file by
  `candidate.resolve()` (:1453). `_normalize_source_path` (:1105-1108) = `Path.resolve()`.
- `_is_ignored` (:1090-1102) rejects any path with a component in `IGNORE_DIR_PARTS`
  (:69-74) — **which contains `.claude`** (and also `archive`).
- Reconcile classification re-applies `_is_ignored` to every STORED source path
  (:1632, purge path :1554) and deletes chunks whose source is ignored.

## The two "obvious" designs are dead on arrival (this is the key finding)

1. **Literal root addition** (`Path.home()/".claude"/"projects"/…/"memory"` appended to
   `DEFAULT_RECONCILE_ROOTS`) — a NO-OP. Every candidate path contains the `.claude`
   component, so `_is_ignored` filters all 743 files at discovery (:1451). Zero ingested.
2. **P1.3-style symlink into knowledge-sync** (e.g. `raw/areas/clearworks/agent-memory` →
   `~/.claude/projects/.../memory`) — WORSE than a no-op, an ingest/purge oscillation:
   discovery sees the unresolved candidate under `raw/` (passes `_is_ignored`) but stores
   the RESOLVED path (:1453), which contains `.claude`; the next reconcile classifies every
   stored source as `ignored` (:1632) and deletes its chunks; then re-discovery re-ingests.
   Churn + wasted embedding spend every run. (Symlink-follow behavior of `rglob` is also
   Python-version-fragile, but the resolve-based purge alone kills this.) The P1.3 pattern
   worked because there the REAL files moved inside `knowledge-sync/raw` and the symlink
   pointed the OLD path at them — the reverse direction does not transfer.

Un-ignoring `.claude` (globally or via an allowlist carve-out in `_is_ignored`) was
considered and rejected: `_is_ignored` is identity-critical shared logic (discovery, purge,
reconcile classification, edge extraction all call it); a carve-out risks sweeping in other
`.claude` trees under existing roots and is a behavior change to the purge path for zero
gain over the mirror pattern below.

## Viable design — mirror into knowledge-sync (P1.2 / P1.6 precedent)

One-way mirror of top-level `memory/*.md` into
`~/code/knowledge-sync/raw/areas/clearworks/agent-memory/` (real files, not links), run as a
pre-step of the P1.1 nightly reconcile wrapper. The existing `raw` root then ingests them
with zero mmrag.py changes. This is exactly the already-decided architecture for the
adjacent stores: P1.6 (claude-mem exporter → `raw/areas/clearworks/session-memory/` → mmrag
ingests on reconcile) and P1.2 (mirror-then-migrate via mirror_deliverables.py). It also
keeps the P1 end-state sentence literally true: knowledge-sync = the files home, mmrag = the
index, the harness-owned memory dir = a live store reached by an importer. The memory dir
itself cannot move — its path is fixed by the Claude Code harness (auto-memory location) and
written by every agent session; relocating it risks fleet-wide memory-write breakage for an
opaque consumer.

## Double-index check (task-mandated)

- The original `~/.claude/.../memory/` paths can never be indexed (`.claude` ignore rule),
  so mirror + original is NOT a double-index — chunk identity exists only under the
  knowledge-sync mirror path.
- No existing root reaches the memory dir: `DEFAULT_RECONCILE_ROOTS` = wiki + raw only, and
  a symlink scan of knowledge-sync (`find -type l`, depth 4) found only `.venv-synth`
  interpreter links (and `.venv-synth` is in `IGNORE_DIR_PARTS` anyway). Spec includes a
  full-depth preflight re-check at build time.
- `raw/areas/clearworks/agent-memory/` collides with nothing: dir does not exist today, and
  P1.6 uses the distinct `session-memory/`.

## Frontmatter compatibility (task-mandated)

Memory topic files carry YAML frontmatter: `name`, `description`, nested `metadata:` block
(`node_type: memory`, `type: feedback|reference|…`, `originSessionId`). mmrag's
`_load_markdown_frontmatter` (:1206-1232) is a shallow `key: value` line parser — it reads
`description` (used as doc summary via `_document_title_and_summary` :1258-1264), tolerates
the nested block (indented lines parse as harmless extra keys; bare `metadata:` parses as
empty value), and falls back to the H1/humanized filename for title since there is no
`title:` key. **Fully compatible as-is — no frontmatter rewrite, no provenance merge needed**
(files are mirrored verbatim; provenance is the self-describing `agent-memory/` dir + the
mirror step in the nightly ledger). `_classify_doc_type` (:1135) will tag most files
`other` (files with "decision" in the name become `decision`) — acceptable, no change.

## Junk handling under the mirror filter (top-level `*.md` only)

`handoffs/`, `memory-archive/` (subdirs), `*.bak-*` (wrong suffix), `context-budget-baseline.json`,
`last_comms_check` — all excluded by the include-only-`*.md`, no-recursion mirror filter.
Note: even without the filter, `memory-archive` would NOT be caught by the `archive` ignore
entry (exact-component match ≠ substring), so the explicit filter is load-bearing.

## Scale / cost

743 files, ~3.5 MB text total. First-run embedding cost is trivial (mmrag's own tracker
prices ~$0.20/M embedding tokens → well under a dollar); nightly deltas are a handful of
changed topic files. No checkpoint/backlog concerns at this size.

## Out of scope (explicit)

- claude-mem / session summaries / anything `.jsonl` (P1.6).
- Other Claude projects' memory dirs (e.g. `-Users-joshweiss/memory`) — plan line names only
  the cortextos one.
- Any mmrag.py change, any change to how agents WRITE memory (WAL protocol untouched — the
  live dir stays canonical; the mirror is derived and disposable).
- Committing the mirrored files in the knowledge-sync git repo (vault's existing commit
  cadence owns that, same as every other agent write into raw/).
