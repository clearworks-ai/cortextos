# P1.3 — org Brain fold-in — Master Plan

Builds on: P1.1 kb-reconcile-nightly (PR #188, wrapper
`orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh`, ledger
`orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`) and reconcile-root PR #184
(added the Brain root to `DEFAULT_RECONCILE_ROOTS` — this build now removes it as redundant).
Research: `01-research.md`. Spec: `03-specs/01-org-brain-foldin-spec.md`.
Decision authority: DECISIONS-FOR-JOSH.md **D4 — ACCEPTED 2026-07-31**, sub-plan steps a–g
approved verbatim; MASTER-BUILD-PLAN.md row P1.3. Do not re-litigate.

## Scope of THIS build — D4 steps (c) through (g) only

Steps (a) and (b) are **already done by Larry this session** (research §"Live verification
already done") — prerequisites satisfied, do not redo:
- **(a) done:** pre-migration snapshot on disk —
  `orgs/clearworksai/agents/larry/state/p1.3-brain-migration/01-pre-migration-counts.txt`
  (`shared-clearworksai` = 58873 docs) and `.../02-pre-migration-sample-citations.txt`
  (5 kb-query samples; ZERO cite `orgs/clearworksai/knowledge/` today — Brain has 0 live chunks).
- **(b) done:** `rsync -a` mirror to `~/code/knowledge-sync/raw/areas/clearworks/org-brain/`;
  `diff -rq` EMPTY, 206 files both sides. Original dir untouched and still git-tracked.

Deliverable of this build: the cortextos-side swap — `git rm -r` the tracked
`orgs/clearworksai/knowledge/`, relative symlink at the same path into the knowledge-sync
mirror, remove the now-redundant Brain entry from `DEFAULT_RECONCILE_ROOTS` (mmrag.py:138),
run reconcile, prove the post-checks, on a feature branch. Josh merges the PR.

**Explicitly OUT of scope** (research §"Explicitly OUT of scope"):
- Per-file content-type routing of Brain files (that's P1.0/P1.2 semantics — P1.3 is a
  whole-directory move+symlink).
- Retiring the org-brain mirror or purging cortextos git history of the old path.
- Editing frank2's CLAUDE.md `../../knowledge/` reference (must keep working through the
  symlink; touch only if post-check proves it broken).
- A local `*.moved-aside-*` retention copy — git history + the knowledge-sync mirror ARE the
  retention (research item 1).
- The two unrelated queued tasks (gbrain memory fix — closed; Deal Debrief→Gmail — pending Josh).

## Phases

### Phase 1 — atomic swap (D4 step c)
- Feature branch `feature/p1-3-org-brain-foldin` off current `main`. Never push main.
- `git rm -r orgs/clearworksai/knowledge/` (git removal, NOT bare `rm -rf` first — the tree
  is tracked; history is the rollback copy).
- Create relative symlink `orgs/clearworksai/knowledge` →
  `../../../knowledge-sync/raw/areas/clearworks/org-brain`; verify with `realpath` that it
  resolves to the mirror and lists exactly 206 files. If verification fails, fix the relative
  depth — the 206-file listing is the gate, not the assumed path string.

### Phase 2 — reconcile-root edit (D4 step d)
- `knowledge-base/scripts/mmrag.py`: delete ONLY the
  `REPO_ROOT / "orgs" / "clearworksai" / "knowledge"` line (currently :138) from
  `DEFAULT_RECONCILE_ROOTS`. The two knowledge-sync roots stay — the symlinked path now
  resolves inside `knowledge-sync/raw` (mmrag keys chunks by `Path.resolve()`, mmrag.py:1106-1108),
  so keeping the third root would double-cover the same resolved files.

### Phase 3 — reconcile + post-checks (D4 steps e, f)
- Run the P1.1 reconcile path (`kb-reconcile-nightly.sh` or the `cortextos bus kb-*` /
  mmrag invocation it wraps) against the updated roots; capture the counts row as evidence.
  v8 note: Brain had 0 live chunks, so no stale-chunk deletion is expected this run — the new
  org-brain paths get indexed fresh.
- Re-run the 5 sample kb-queries from `02-pre-migration-sample-citations.txt`: ≥1 must cite a
  `raw/areas/clearworks/org-brain/...` path. Re-run `cortextos bus kb-collections`, diff against
  `01-pre-migration-counts.txt`: `shared-clearworksai` up by roughly the ingestible-file count
  (NOT exactly +206 — some files excluded by ingest rules); no other collection drops.
- Repo-wide grep for `orgs/clearworksai/knowledge` (excluding `.agent/`, `state/`,
  `.claude/worktrees/`, build artifacts) — REPORT findings only, no silent fixes. Known hit to
  expect: frank2 `scripts/orphan-meeting-audit.sh:4` defaults to `.../knowledge/meetings` —
  resolves fine through the symlink; flag any `Path.resolve()`-for-identity usage as a
  possible second root-collision to review.

### Phase 4 — land
- Commit + push the branch with all evidence pasted into the build notes. Codexer sends the
  diff back for Larry's adversarial review; **Larry opens the PR, Josh merges** — codexer does
  neither.
- "Tests" for this slug = the real verification command outputs at each step (filesystem +
  one-line-config change; no new unit-test file expected — research item 7).

## Rollback (D4 step g — procedural, binding)
Reverse the move (restore the real directory from git / the mirror) + restore the
`DEFAULT_RECONCILE_ROOTS` line + re-run reconcile. **NOT "remove the symlink alone"** — after
reconcile the index has re-keyed to the new resolved paths; deleting only the symlink leaves
the index pointing at paths that resolve nowhere.

## Risks
- **Wrong relative symlink depth** — mitigated: `realpath` + 206-file listing is a hard gate in
  the spec before anything else proceeds.
- **Double-cover if the root edit is missed/partial** — mitigated: spec pins the exact line;
  post-check count diff would surface over-counting.
- **A hardcoded old-path consumer breaks** — mitigated: symlink sits at the identical path
  (that's the design); grep step reports rather than mutates; frank2 CLAUDE.md untouched.
- **knowledge-sync mirror drifts before merge** — low: mirror is byte-identical as of step (b)
  this session; the swap makes knowledge-sync the single live copy, ending drift.
