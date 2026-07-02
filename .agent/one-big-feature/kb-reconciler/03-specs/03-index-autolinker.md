# Spec 03 — Index auto-linker

**File:** `knowledge-base/scripts/mmrag.py` (new `cmd_reindex_indexes` / phase of reconcile) — writes to `~/code/knowledge-sync/wiki/**/_index.md`
**Repo:** cortextos (script) + knowledge-sync (generated content, committed separately by the vault owner flow)
**Goal:** Stop `_index.md` files from silently listing a fraction of what exists. Josh's example: `intelligence/_index.md` lists 1 of ~60 files. An index that lies about its own contents is why "the info I need" is not discoverable even when it IS on disk.

## The problem
`_index.md` files are hand-maintained and drift. When new articles land in a wiki topic dir, nobody updates the index, so navigation + any index-driven retrieval misses them. This is a discoverability failure orthogonal to the RAG index but with the same root cause (manual, forward-only, drifts from disk).

## Scope (exact)

### 1. Managed-section marker
Define a fenced managed region inside each `_index.md`:
```
<!-- BEGIN AUTO-INDEX (managed by mmrag reindex — do not edit below) -->
... generated list ...
<!-- END AUTO-INDEX -->
```
Everything ABOVE the BEGIN marker is hand-curated prose and is PRESERVED verbatim. Only the region between the markers is regenerated. If a file has no markers yet, append the managed region at the end (never destroy existing content).

### 2. Generation logic
For each directory under `~/code/knowledge-sync/wiki/` that contains an `_index.md` (or should have one — a dir with ≥2 non-index `.md` files):
- Enumerate sibling `.md` files (exclude `_index.md` itself, exclude ignored paths via `_is_ignored`).
- For each, derive a title: frontmatter `title:` if present, else first `# H1`, else humanized filename.
- Emit a sorted markdown list of `- [[relative-path|Title]]` (shortest-path wiki-links, matching the vault's link style) plus a one-line description from frontmatter `description:`/`summary:` when present.
- Idempotent: regenerating with no disk change produces byte-identical managed region.

### 3. Subcommand + wiring
`reindex-indexes` subcommand: `--root <wiki dir>` (default `~/code/knowledge-sync/wiki`), `--dry-run` (print diff, write nothing), `--json` (report `{indexes_updated, files_linked, indexes_created}`). Call it as the final phase of the nightly `reconcile` cron (spec 02) so indexes refresh the same night new files are ingested.

## Acceptance
- `intelligence/_index.md` after a run lists ALL ~60 present files (not 1), with hand-written intro prose above the marker untouched.
- Idempotent: second run changes nothing (`indexes_updated=0`).
- A newly added `.md` file appears in its dir's `_index.md` managed region after the next run.
- Deleting a file removes its line on the next run.
- `--dry-run` writes nothing.

## Tests (`_test_clients/test_mmrag_reindex.py`)
- Fixture wiki dir with 3 articles + an `_index.md` with hand prose + empty managed region → run → all 3 linked, prose preserved.
- Add a 4th article → run → 4 linked.
- Remove 1 → run → 3 linked.
- No-marker `_index.md` → run → managed region appended, original body intact.
- Titles resolved from frontmatter, then H1, then filename (assert all three fallbacks).
- Idempotency: two consecutive runs → identical bytes.

## Constraints
NEVER touch content above the BEGIN marker. Never delete an `_index.md`. Generated links must use the vault's existing `[[wiki-link]]` shortest-path convention (see CLAUDE.md Knowledge-Sync rules). No stray debug prints. Writing to knowledge-sync is a content change (Larry-owned artifact type), but the SCRIPT lives in mmrag.py = production source → codexer + PR + Josh merge.
