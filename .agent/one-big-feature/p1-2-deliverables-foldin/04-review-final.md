# Independent Adversarial Review — mirror_deliverables.py fixes (PR #248, PR #250)

Reviewer: fresh independent pass, no memory of prior planning. Repo: clearworks-ai/cortextos.

## 1. Commits on main / clean status

```
$ git log --oneline -5 -- orgs/clearworksai/skills/outputs-router/mirror_deliverables.py
bbcd416 fix(outputs-router): plan_subcommand excludes name_glob files (not just dir_parts) (#250)
9666c14 fix(outputs-router): REPO_ROOT off-by-one — 4 dirs up, not 3 (#248)
0721f95 P1.2 deliverables-foldin: mirror_deliverables.py tool
```

Both target commits confirmed present in history for this file. Worktree branch tracks main
(`worktree-agent-a1493b5e60758c827`), status clean aside from unrelated `state/pipeline-ledger.jsonl`
noise and untracked planning docs — nothing touching the file under review. Confirmed separately
that the primary checkout at `/Users/joshweiss/code/cortextos` is also on `main`, up to date with
origin, with the same two commits.

## 2. Code read — independent verification

**2a. REPO_ROOT (line 75):**
```python
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
```
Four `".."` args. `os.path.dirname(__file__)` = `.../orgs/clearworksai/skills/outputs-router`.
Walking up 4: `skills` → `clearworksai` → `orgs` → repo root. Confirmed correct by direct computation:

```
$ python3 -c "... os.path.abspath(os.path.join(d, '..','..','..','..'))"
computed REPO_ROOT: /Users/joshweiss/code/cortextos/.claude/worktrees/agent-a1493b5e60758c827
```

Matches the actual repo root for that file's location. Correct.

**2b. plan_subcommand name_glob exclusion (lines 290–386):**
Reviewed the full function. Before appending any manifest row, it now computes `exclusion_reason`
by checking `dirmap["exclude"]["dir_parts"]` first, then (only if still `None`)
`dirmap["exclude"]["name_globs"]` against `source_basename`. Only if `exclusion_reason is None` does
it call `compute_target_path(...)` and mark `status="planned"`; otherwise it appends
`target: None, status: "excluded", reason: exclusion_reason`. This closes the gap where a
name_glob-only match (e.g. `.gitignore`, `*.pyc` outside `__pycache__`) previously fell through to
the `else` branch and got `status="planned"` with a null target (crash risk downstream in
`mirror_subcommand`'s `os.path.exists(target_path)`). Confirmed by reading `git show bbcd416` diff —
matches the PR's stated fix exactly.

## 3. Live run against real corpus

Note: this worktree's `orgs/clearworksai/agents/*/deliverables/` dirs do not exist — they are
gitignored, per-agent local state (`.gitignore:17` excludes `orgs/clearworksai/*` deliverables
paths), so a fresh worktree checkout has no deliverables data to walk. Ran the tool instead against
the primary checkout (`/Users/joshweiss/code/cortextos`), which is on `main` at the same two commits
and holds the real ~820-file corpus.

```
$ cd /Users/joshweiss/code/cortextos/orgs/clearworksai/skills/outputs-router
$ python3 mirror_deliverables.py plan --out /tmp/review-verify-plan.jsonl
plan complete: {"planned": 817, "excluded": 3}
```

Matches the claimed 817/3 split exactly (no drift observed).

```
$ python3 -c "
import json
rows=[json.loads(l) for l in open('/tmp/review-verify-plan.jsonl')]
print('total rows:', len(rows))
print('null-target-planned:', len([r for r in rows if r['status']=='planned' and not r['target']]))
"
total rows: 820
null-target-planned: 0
```

Zero planned rows with a null target — bug 2 confirmed fixed. The 3 excluded rows inspected by hand:
one `.gitignore` (name_glob match) and two `__pycache__/*.pyc` (dir_part match) — both exclusion
paths exercised and correct.

## 4. Test suite

```
$ cd /Users/joshweiss/code/cortextos/orgs/clearworksai/skills/outputs-router
$ python3 -m pytest tests/ -v
tests/test_mirror_deliverables.py::test_t1_md_with_existing_frontmatter PASSED
tests/test_mirror_deliverables.py::test_t2_md_without_frontmatter PASSED
tests/test_mirror_deliverables.py::test_t3_binary_with_provenance_sidecar PASSED
tests/test_mirror_deliverables.py::test_t4_target_exists_different_content PASSED
tests/test_mirror_deliverables.py::test_t5_idempotent_mirror PASSED
tests/test_mirror_deliverables.py::test_t6_excluded_files PASSED
tests/test_mirror_deliverables.py::test_t7_plan_fixture_tree PASSED
tests/test_mirror_deliverables.py::test_t8_tamper_detection PASSED
tests/test_mirror_deliverables.py::test_t9_unmapped_path_detection PASSED
tests/test_mirror_deliverables.py::test_t10_basename_collision PASSED
tests/test_mirror_deliverables.py::test_t11_plan_excludes_name_glob_files PASSED
============================== 11 passed in 0.02s ==============================
```

11/11 passed, including the new `test_t11_plan_excludes_name_glob_files` added by PR #250 for the
second bug. (First attempt run from the worktree's repo root failed with
`ModuleNotFoundError: No module named 'mirror_deliverables'` — that's a `sys.path`/cwd artifact of
running pytest from a different rootdir than the package lives in, not a code defect; running from
inside `outputs-router/` resolves it cleanly and is the documented/intended invocation.)

## Findings / caveats

- No code defects found in either diff. Both fixes are minimal, targeted, and match their stated
  intent exactly.
- The worktree used for this review does not itself contain the real deliverables data (gitignored,
  local-only) — live verification against real data had to be run from the primary checkout
  (`/Users/joshweiss/code/cortextos`), which is on the same commit as this worktree for the file in
  question. This is an environment quirk of gitignored per-agent state in git worktrees, not a bug
  in the reviewed code.
- Numbers matched the PR's own claimed verification exactly (817 planned / 3 excluded / 820 total /
  0 null-target-planned / 11 pytest passes) — no drift.

## VERDICT: PASS

Both bugs are genuinely fixed, verified independently via direct code reading, live run against the
real ~820-file corpus, and full test suite pass. No rubber-stamping — findings are based on my own
commands and their actual output, pasted above.
