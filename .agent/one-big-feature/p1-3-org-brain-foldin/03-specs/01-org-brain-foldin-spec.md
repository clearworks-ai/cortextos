# Spec 01 — org Brain fold-in swap (P1.3, D4 steps c–g)

Buildable directly by codexer. Context: `../01-research.md`, `../02-master-plan.md`.
D4 ACCEPTED 2026-07-31 — do not re-litigate the move-then-symlink design.
Steps (a)/(b) already done by Larry (snapshots + rsync mirror on disk) — do NOT redo them.

Working repo: `/Users/joshweiss/code/cortextos` (referred to as `<repo>` below).
Sibling repo: `~/code/knowledge-sync` — **read-only for this build; commit NOTHING there.**

## Evidence discipline (this spec's "tests")

This is a filesystem + one-line-config change — no new unit-test file. Instead, EVERY step
below has a verification command; paste the REAL output of each into the build notes /
completion message. A step without captured output is not done.

## Step 0 — branch

```bash
cd <repo> && git checkout main && git pull && git checkout -b feature/p1-3-org-brain-foldin
```
Never commit or push to `main`. Evidence: `git branch --show-current`.

## Step 1 — git rm the tracked directory (D4 step c, part 1)

```bash
git rm -r orgs/clearworksai/knowledge/
```
- Use `git rm -r`, not a bare filesystem delete — the tree is git-tracked (confirm first:
  `git ls-files orgs/clearworksai/knowledge/ | wc -l` — expect ~206... capture the actual number).
- Do NOT create any local `*.moved-aside-*` copy. Retention = cortextos git history + the
  byte-identical mirror already at `~/code/knowledge-sync/raw/areas/clearworks/org-brain/`
  (206 files, `diff -rq` verified empty this session — research §step (b)).
- Evidence: the `git ls-files | wc -l` count before, and `git status --short | head` after
  (all `D` rows), and `ls orgs/clearworksai/ | grep knowledge` showing the dir gone.

## Step 2 — relative symlink at the same path (D4 step c, part 2)

```bash
ln -s ../../../knowledge-sync/raw/areas/clearworks/org-brain orgs/clearworksai/knowledge
```
The relative target assumes cortextos and knowledge-sync are siblings under the same parent
(`~/code/`): the link lives inside `<repo>/orgs/clearworksai/`, so three `..` climb to
`~/code/`. **Verify, do not assume:**

```bash
readlink orgs/clearworksai/knowledge
realpath orgs/clearworksai/knowledge     # MUST print ~/code/knowledge-sync/raw/areas/clearworks/org-brain (expanded)
find orgs/clearworksai/knowledge/ -type f | wc -l   # MUST print 206
```
If `realpath` fails or the count ≠ 206, the relative depth is wrong — delete the link and
recompute the `../` depth until both checks pass. Then stage it:

```bash
git add orgs/clearworksai/knowledge
```
Evidence: output of all three commands above + `git status --short` showing the new symlink
staged (mode 120000).

## Step 3 — remove the redundant reconcile root (D4 step d)

File: `<repo>/knowledge-base/scripts/mmrag.py`, tuple at lines 135–139 (current):

```python
DEFAULT_RECONCILE_ROOTS = (
    Path.home() / "code" / "knowledge-sync" / "wiki",
    Path.home() / "code" / "knowledge-sync" / "raw",
    REPO_ROOT / "orgs" / "clearworksai" / "knowledge",
)
```

Delete ONLY line 138 (`REPO_ROOT / "orgs" / "clearworksai" / "knowledge",`). Result:

```python
DEFAULT_RECONCILE_ROOTS = (
    Path.home() / "code" / "knowledge-sync" / "wiki",
    Path.home() / "code" / "knowledge-sync" / "raw",
)
```

Why: mmrag canonicalizes `source_file` by resolved path (`_normalize_source_path`,
mmrag.py:1106-1108); the symlinked dir now resolves inside `knowledge-sync/raw`, which is
already root #2 — keeping root #3 double-lists the same resolved files. Touch NOTHING else in
mmrag.py. Evidence: `git diff knowledge-base/scripts/mmrag.py` (exactly one deleted line).

## Step 4 — run reconcile against the updated roots (D4 step e)

Use the P1.1 mechanism, not a hand-rolled invocation:

```bash
<repo>/orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh
```
(or, if the wrapper is cron-context-only and fails outside it, run the same
`cortextos bus kb-*` / venv-python mmrag reconcile command the wrapper wraps — read the
wrapper's own lines to get the exact command; do not invent flags.)

Expected: new `raw/areas/clearworks/org-brain/` files indexed; NO stale-chunk deletion for the
old Brain path (it had 0 live chunks — research §step (a)). Evidence: full run output including
the counts row it appends to `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`
(paste the new ledger row: `tail -1` of the ledger).

## Step 5 — post-checks (D4 step f)

1. Re-run the SAME 5 kb-query questions recorded in
   `<repo>/orgs/clearworksai/agents/larry/state/p1.3-brain-migration/02-pre-migration-sample-citations.txt`
   (read the file for the exact queries; run each via the same `cortextos bus kb-query` /
   mmrag query command used there). **Pass bar: at least one answer cites a path under
   `raw/areas/clearworks/org-brain/`.** Pre-migration, zero did. Evidence: all 5 outputs,
   with the org-brain citation(s) highlighted.
2. `cortextos bus kb-collections` → diff against
   `.../p1.3-brain-migration/01-pre-migration-counts.txt` (pre: `shared-clearworksai` = 58873).
   **Pass bar: `shared-clearworksai` increased (roughly by the Brain's ingestible-file count —
   NOT an exact +206; some files are excluded by ingest rules) AND no other collection's count
   dropped unexpectedly.** Evidence: side-by-side counts + the delta.
3. Save both post-migration outputs next to the pre files, e.g.
   `.../p1.3-brain-migration/03-post-migration-counts.txt` and
   `.../04-post-migration-sample-citations.txt` (state dir — untracked is fine).

## Step 6 — hardcoded-reference sweep (report only)

```bash
grep -rn "orgs/clearworksai/knowledge" <repo> \
  --exclude-dir=.agent --exclude-dir=state --exclude-dir=worktrees \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist \
  | grep -v "knowledge-base" | grep -v "\.claude/worktrees"
```
(`knowledge-base` is a different path — filter those false positives; also ignore
`memory/fleet-activity` logs.) **Do NOT modify anything found — report each hit** with a
one-line verdict: (a) resolves fine through the symlink (expected for path consumers, e.g.
frank2 `scripts/orphan-meeting-audit.sh:4` defaulting to `.../knowledge/meetings`), or
(b) uses `Path.resolve()`-style canonicalization for IDENTITY (the mmrag pattern) → flag as a
possible second root-collision for Larry to review. Evidence: the grep output + verdict list.

## Step 7 — commit + push branch (NOT main, NO PR)

```bash
git add -A orgs/clearworksai/knowledge knowledge-base/scripts/mmrag.py
git commit -m "P1.3 org-brain fold-in: git-rm tracked knowledge/, relative symlink into knowledge-sync org-brain, drop redundant reconcile root"
git push -u origin feature/p1-3-org-brain-foldin
```
- Commit contents: the ~206 deletions, the one symlink (mode 120000), the one-line mmrag.py
  change. Nothing else. Evidence: `git show --stat HEAD | head -20` and
  `git diff main --stat | tail -5`.
- **Do NOT open the PR and do NOT merge.** Send the diff + all captured evidence back to Larry
  for adversarial review; Larry opens the PR, Josh merges.

## Rollback (if any post-check fails — D4 step g)

Reverse the move: `git checkout main -- orgs/clearworksai/knowledge` semantics on the branch
(restore the real dir, remove the symlink), restore the mmrag.py root line, re-run reconcile.
**Never** "just remove the symlink" — post-reconcile the index is keyed to the new paths.

## Out of scope (do not build)

Per-file routing of Brain content, deleting the knowledge-sync mirror, any knowledge-sync repo
commit, frank2 CLAUDE.md edits, changes to kb-reconcile-nightly.sh, any other mmrag.py change,
moved-aside local copies, the gbrain memory task, the Deal Debrief→Gmail task.
