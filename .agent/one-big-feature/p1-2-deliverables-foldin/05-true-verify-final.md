# P1.2 deliverables-foldin — TRUE VERIFY (re-signed after shared-checkout ledger wipe)

Slug: `p1-2-deliverables-foldin`. Run directly by larry (main-thread, not delegated), isolated
worktree `/Users/joshweiss/code/cortextos/.claude/worktrees/agent-a1493b5e60758c827`,
2026-08-03.

## Why this receipt exists

A teammate ran `git reset --hard origin/main` directly in the shared main checkout mid-lane,
silently wiping several uncommitted `state/pipeline-ledger.jsonl` rows for this slug (and
others). The underlying work (two real bugfixes + a real data fold-in execution) was never lost
— it lives on disk and in merged PRs — but the ledger receipt proving it went through the
pipeline was never committed to git, so it could vanish again. This is a fresh, independently
re-derived true-verify pass, run from an isolated worktree, whose ledger row will be committed
and ride a PR so it can't be silently wiped again.

## What I independently re-checked this session (before any subagent was spawned)

**1. Both bugfixes confirmed on `main`:**
```
$ git log --oneline -5 -- orgs/clearworksai/skills/outputs-router/mirror_deliverables.py
bbcd416 fix(outputs-router): plan_subcommand excludes name_glob files (not just dir_parts) (#250)
9666c14 fix(outputs-router): REPO_ROOT off-by-one — 4 dirs up, not 3 (#248)
0721f95 P1.2 deliverables-foldin: mirror_deliverables.py tool
```
Main checkout `git status` clean, up to date with origin/main.

**2. Re-ran `plan` against the real, live corpus (read-only, from the main checkout since the
gitignored `deliverables/` dirs don't exist in this isolated worktree — they were never
git-tracked, confirmed via `git ls-files orgs/clearworksai/agents/auditmaster/deliverables`
returning 0 files):**
```
$ cd orgs/clearworksai/skills/outputs-router && python3 mirror_deliverables.py plan --out /tmp/p1-2-real-verify-plan.jsonl
plan complete: {"planned": 817, "excluded": 3}
```
820 total rows. Programmatic check: `planned` rows with `target=None` → **0** (the exact
invariant PR #248/#250 fixed). This matches the 817/3/820 figures claimed by prior evidence
docs exactly — independently re-derived, not copied.

**3. Spot-checked 8 randomly-sampled (seed 42) planned target files against the real, already-
executed mirror output on disk** (`~/code/knowledge-sync/raw/...` — the `mirror --execute` run
already happened for real earlier this session; I did NOT re-run `--execute`, only read-only
`plan`/`verify`/`ls`/`diff` per instruction):
```
EXISTS: raw/areas/clearworks/clients/studio-pch/studio-pch/99-studio-pch-final-report-BRANDED.md
EXISTS: raw/areas/clearworks/clients/ocg/ocg/report/08-kpi-index.md
EXISTS: raw/areas/clearworks/clients/rrk/rrk/transcripts/RRK-Ashlyn-Audit-Interview.md
EXISTS: raw/sessions/deliverables-mirror/larry/productize/auditos-raw-source-import-plan.md
EXISTS: raw/areas/clearworks/clients/alloi/alloi/leadership-interview-transcript.txt
EXISTS: raw/areas/clearworks/clients/alloi/alloi/alloi-capture-setup-plan.md
EXISTS: raw/resources/reference/clearworks/deliverables-mirror/auditmaster/teaching/skool-deck-outline.md
EXISTS: raw/areas/clearworks/clients/logic-tcg/logic-tcg/transcripts/john-thread.json
```
8/8 exist. All within expected content-type buckets per dirmap (client/session/sop).

**4. Ran the tool's own `verify` subcommand against the real execution manifest**
(`orgs/clearworksai/skills/outputs-router/manifests/p1-2-mirror-manifest.jsonl`, 820 rows,
{'mirrored': 817, 'excluded': 3}):
```
$ python3 mirror_deliverables.py verify --manifest manifests/p1-2-mirror-manifest.jsonl
FAIL: 3 failing rows:
  auditmaster/deliverables/ocg/ocg-osint-brief.md: provenance-stripped diff non-empty
  auditmaster/deliverables/logic-tcg/research-msp-taxonomy.md: provenance-stripped diff non-empty
  auditmaster/deliverables/msia/research-nonprofit-audit-taxonomy.md: provenance-stripped diff non-empty
(real exit code: 1)
```

**I investigated this myself rather than accepting the prior claim at face value.** Root cause,
confirmed by reading `merge_frontmatter()` and `strip_provenance_frontmatter()` in
`mirror_deliverables.py` and diffing all 3 files directly:

- All 3 source files already carry their own pre-existing `date:` frontmatter key (e.g.
  `ocg-osint-brief.md` has `date: 2026-07-10` in its original YAML block, confirmed via
  `head -10` on the source file).
- `merge_frontmatter()` (the actual copy-time logic) correctly detects `date` already exists and
  skips re-adding it — the target file's merged frontmatter is correct (only 4 new lines added:
  `agent`, `job`, `source-task`, `mirror-of`).
- `strip_provenance_frontmatter()` (used only by `verify`'s diff check) strips **any** line
  matching one of the 5 injected key names (`agent`, `job`, `source-task`, `date`, `mirror-of`)
  regardless of whether that specific line was actually injected — so it also strips the
  target's pre-existing `date:` line (which the source still has), creating a spurious
  stripped-target vs. source mismatch.
- **Full `diff` of source vs. target for `ocg-osint-brief.md`** confirms this is the *only*
  difference: `diff` shows exactly 4 added lines (the intended new frontmatter keys) and zero
  other differences across all 204/208 lines. The mirrored content is byte-correct; only the
  `verify` subcommand's diff-stripping logic is over-broad.

This is a real, narrow, pre-existing bug in `strip_provenance_frontmatter()` — not introduced by
PR #248 or #250, not a data-corruption issue, and out of scope to fix in this pass (no code
change authorized here; this pass is a provenance re-sign of already-completed work). Flagging
as a non-blocking follow-up, consistent with the prior evidence docs already on disk in the main
checkout (`state/verify-evidence/p1-2-deliverables-foldin-real-execution-true-verify.txt`,
`.agent/one-big-feature/p1-2-deliverables-foldin/06-fold-in-execution-evidence.md`) — my
independent re-derivation matches those docs' numbers and root-cause analysis exactly, which I
take as corroboration, not as a substitute for having checked it myself.

## Verdict

- Bug 1 (REPO_ROOT off-by-one, PR #248): FIXED, merged, independently re-confirmed working
  (plan against real corpus now returns 817/3/820, not 0/0).
- Bug 2 (name_globs exclusion gap, PR #250): FIXED, merged, independently re-confirmed working
  (zero `planned` rows with `target=None`).
- Real data fold-in (`mirror --execute` against the live 817-file corpus): already executed for
  real this session (not re-run by me — read-only checks only, per instruction). 817/817
  mirrored, 0 errors, 0 conflicts, spot-checked 8/8 files present and correctly routed.
- `verify` subcommand: 3/817 (0.37%) false-positive flags, root-caused to a narrow pre-existing
  key-name-collision bug in `strip_provenance_frontmatter()`, confirmed via direct file diff to
  be a verify-tool defect, not a data-correctness defect. Non-blocking, flagged as follow-up.

**TRUE-VERIFY: PASS.** The numbers match the prior claim exactly (817 mirrored + 3 excluded =
820, matching the independently-recounted live corpus), and I did not simply accept that
match — I re-ran `plan` and `verify` myself from scratch, spot-checked real files on disk, and
independently traced the verify false-positive to its root cause in the source code rather than
citing the prior doc's explanation unverified.
