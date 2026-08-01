# P1.3 — org-Brain fold-in — Research

## Source of truth (already Josh-decided, do not re-litigate)
- `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md` row P1.3
  (line 98): move `orgs/clearworksai/knowledge/` into knowledge-sync; symlink at the
  SkillTree-expected path (frank2 CLAUDE.md references `../../knowledge/`).
- `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/DECISIONS-FOR-JOSH.md` D4
  (line 107-115): **ACCEPTED** — move-then-symlink (Brain) with the explicit index sub-plan
  a-g. Josh decided 2026-07-31 11:44 PDT, binding.

## The mandatory index sub-plan (D4, steps a-g — verbatim from MASTER-BUILD-PLAN.md line 98)
mmrag canonicalizes `source_file` by RESOLVED path (mmrag.py:1106-1108 `_normalize_source_path`
-> `Path.resolve()`), so a move+symlink changes chunk identities, and a reconcile root that
resolves INSIDE another reconcile root double-covers the same files.

(a) pre-migration snapshot — per-collection counts + 5 sample kb-query citations, saved to disk.
(b) rsync copy + empty `diff -rq` (byte-identical mirror, additive, zero-risk).
(c) atomic swap — move original dir aside, drop symlink at the old path.
(d) update reconcile roots — REMOVE `orgs/clearworksai/knowledge` from
    `DEFAULT_RECONCILE_ROOTS` in `knowledge-base/scripts/mmrag.py` (currently line ~135)
    since it now resolves inside `knowledge-sync/raw`, already covered by that root.
    Double-listing would over-count / double-ingest the same resolved files.
(e) run reconcile — stale chunks under the old resolved path deleted, new paths indexed.
(f) post-checks — counts within expected delta, kb-query returns a hit citing a NEW path.
(g) rollback = reverse the move + restore the reconcile-roots line + re-run reconcile
    (NOT "remove the symlink alone" — after reconcile the index has re-keyed to new paths;
    deleting only the symlink leaves the index pointing at paths that resolve nowhere).

v8 plan note: Brain has 0 live chunks today (206 files on disk, unindexed), so step (e) has
no stale-Brain-chunk deletion this run — but the raw/wiki identity rule still applies to any
future move under knowledge-sync.

## Live verification already done THIS SESSION (Larry, before dispatch — do not redo)
- Source dir confirmed real (not already a symlink): `orgs/clearworksai/knowledge/` — 206 files,
  matches plan's expected Brain count. Subdirs: `clients/` (20 files), `transcripts/`, `playbooks/`,
  `meetings/`, plus root-level `company.md`, `offer.md`, `voice.md`, `stack.md`, `STATE.md`,
  `agentic-os.md`, `skilltree-skill-map.md`, `skilltree-system-brief.md`, `vip-clients.txt`.
- **Step (a) done**: `cortextos bus kb-collections` snapshot saved to
  `orgs/clearworksai/agents/larry/state/p1.3-brain-migration/01-pre-migration-counts.txt`
  (relevant collection: `shared-clearworksai` = 58873 docs). 5 sample `kb-query` citations saved
  to `.../02-pre-migration-sample-citations.txt` — confirmed ZERO hits cite any
  `orgs/clearworksai/knowledge/...` path today (matches the v8 "Brain 0 live chunks" note).
- **Step (b) done**: `rsync -a` mirrored `orgs/clearworksai/knowledge/` into
  `~/code/knowledge-sync/raw/areas/clearworks/org-brain/` (new destination — no existing
  `org-brain/` dir before this). `diff -rq` between source and destination: EMPTY (byte-identical,
  206 files both sides). This copy is additive only — the original directory is untouched, still
  live on disk, still git-tracked in cortextos, still working as the resolved path today.
- knowledge-sync repo: the new `raw/areas/clearworks/org-brain/` shows as untracked
  (`git status --porcelain`); knowledge-sync commits directly to main via its own established
  `auto: sync <hostname> <timestamp>` cadence (confirmed via `git log` — NOT gated by the
  cortextos PR/main-push hard rule, this is that repo's normal working pattern) — committing
  this addition directly to knowledge-sync main is consistent with existing practice, not a
  gate violation.

## What remains (c)-(g) — THIS is the scope for codexer to build, in cortextos repo ONLY
`orgs/clearworksai/knowledge/` is git-TRACKED inside the `cortextos` repo (`git ls-files` confirms,
e.g. `orgs/clearworksai/knowledge/clients/alloi.md`). cortextos is on `main` — the hard rule
"never commit to main directly, always PR" applies. This build must land on a feature branch and
open a PR; Josh merges.

1. Remove the tracked `orgs/clearworksai/knowledge/` directory from git (`git rm -r`) — NOT a
   bare filesystem delete; git history already preserves it, and the byte-identical mirror
   already lives in knowledge-sync (separately git-tracked there) — this satisfies the plan's
   "30-day retention of the moved-aside original" via git history + the mirrored copy, so do
   NOT also create a local `*.moved-aside-*` directory on disk (redundant, adds clutter+drift
   risk vs the two durable copies already in place).
2. Add a symlink at the exact same path, `orgs/clearworksai/knowledge`, pointing at
   `~/code/knowledge-sync/raw/areas/clearworks/org-brain` — use a RELATIVE symlink target
   (both repos are siblings under `~/code/`, single-machine per the plan's SPOF note) so the
   symlink is portable and doesn't bake in the literal home-directory path. Compute correctly:
   the symlink lives at `orgs/clearworksai/knowledge` inside the cortextos repo root; the
   relative path from that location to the sibling repo is
   `../../../knowledge-sync/raw/areas/clearworks/org-brain` (verify with `readlink -f` /
   `realpath` after creating it — must resolve to the exact destination and list 206 files).
3. Edit `knowledge-base/scripts/mmrag.py` — remove the
   `REPO_ROOT / "orgs" / "clearworksai" / "knowledge"` entry from the `DEFAULT_RECONCILE_ROOTS`
   tuple (currently 3 entries: knowledge-sync/wiki, knowledge-sync/raw, and this one — remove
   only the third; the first two are untouched and already cover the new symlinked location
   since it resolves inside knowledge-sync/raw).
4. Run the reconcile (via the same `kb-reconcile-nightly.sh` / `cortextos bus kb-*` path P1.1
   built and fixed this session, or the direct mmrag reconcile invocation it wraps) against the
   updated roots, capture the run's counts row as evidence.
5. Post-check (step f): re-run the same 5 `kb-query` sample queries from
   `02-pre-migration-sample-citations.txt` — at least one must now cite a path under
   `raw/areas/clearworks/org-brain/...` (a NEW path, proving the reconcile picked up the moved
   content through the new root, not the removed one). Also re-run `kb-collections` and diff
   counts against the pre-migration snapshot — expect `shared-clearworksai` count to increase by
   roughly the Brain's ingestible file count (not exactly 206 — some are `.txt`/binary/excluded
   per existing ingest rules; do not treat an exact +206 as the bar, treat "counts increased,
   no other collection's count dropped unexpectedly" as the bar).
6. Verify no other code/config in the cortextos repo hardcodes the OLD absolute path in a way
   that would break post-symlink (grep for `orgs/clearworksai/knowledge` across the repo,
   excluding `.agent/`, `state/`, worktrees, and this planning dir) — anything found should
   still resolve fine through the symlink (that's the whole point of symlinking at the same
   path), but flag any place that does a `Path.resolve()` on it strictly for identity purposes
   (mirroring the mmrag.py case) as a possible second reconcile-root-style collision to review,
   don't silently "fix" unrelated code.
7. Tests / proof: this is a file-system + one-line-config change, not application logic — "tests"
   here means the executed verification commands in steps (a) pre-check (already done, attach
   the two saved files as evidence) through (f) post-check above, with real command output
   captured, not just a stated summary. No new automated test file is expected for this slug.

## Explicitly OUT of scope for this build
- Any per-file content-type routing of the Brain's files into other knowledge-sync homes
  (that's what P1.0/P1.2 do for deliverables; P1.3 per the plan text is a whole-directory
  move+symlink, not a per-file router pass).
- Retiring the `org-brain` mirror or deleting the cortextos git history of the old path.
- Editing frank2's CLAUDE.md reference (`../../knowledge/`) — it should keep working unchanged
  through the symlink; do not touch it unless the post-check proves it broken.
- The two unrelated queued tasks (gbrain self-contradiction memory fix — already applied and
  closed this session; Deal Debrief -> Gmail scope fork — pending a separate Josh answer).
