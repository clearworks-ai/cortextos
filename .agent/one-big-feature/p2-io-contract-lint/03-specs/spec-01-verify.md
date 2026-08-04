# Spec 01 — Independent REVIEW checklist for the P2 I/O-contract-lint (Deliverable #1) VERIFY pass

## Objective

This is a checklist for the REVIEW stage subagent (independent of, and running after, the plan
author, with no prior context from the planning session). The goal is to **independently
re-derive** the conclusion in `02-master-plan.md` from the same primary sources — not to re-read
the plan/research docs and agree with them. Every item below names the exact file/command to
inspect or run directly. If any item fails to reproduce, stop and flag it as a real finding rather
than adjusting the narrative to fit.

Work only inside the worktree
`/Users/joshweiss/code/cortextos/.claude/worktrees/p2-io-contract-lint` (branch
`p2-io-contract-lint`) for any file reads scoped to this checkout; PR/gh lookups hit the real
GitHub remote regardless of working directory. Do not touch the main checkout at
`/Users/joshweiss/code/cortextos` directly.

## Non-goals reminder (do not act on these, even if found)

- Do not verify, fake, or imply readiness for the P4.1-gated Wave-0 job-rollout done-conditions
  (Call Capture / Transcript Processing / Context Maintenance) — only their skills' I/O-contract
  heading is in scope, and that is already covered by items 3 and 4 below.
- Do not fix the dead `grep -q "interview" ... | grep -q "layout"` check at line 67 of
  `contract-lint.sh` — a disclosed, non-blocking script defect. Confirming it's still dead code
  (item 8 below) is in scope; patching it is not.
- Do not touch the 3 separately-tracked job-level spot-runs (Meeting Follow-Ups, Pre-Call
  Briefing, Status Updates).
- If none of the checks below turn up a genuine defect in deliverable #1 itself, the correct
  outcome is a **no-diff** true-verify receipt — do not manufacture a change to justify a PR.

## Checklist — re-derive from primary sources

1. **PR #194 merge state.** Run
   `gh pr view 194 --repo clearworks-ai/cortextos --json title,state,mergedAt,mergeCommit`.
   Confirm `state: "MERGED"`, `mergedAt: "2026-08-01T19:17:33Z"`, and
   `mergeCommit.oid: "cb663885249dbb215c25d8e8021180891c7ad277"`. Also run
   `git log --all --oneline | grep -i "io.contract\|contract.lint"` and confirm both
   `cb663885` (merge commit) and `0318310f` ("P2 W0: contract-lint.sh + I/O contract prepend (3
   repo-tracked skills)") appear in history.

2. **Live re-run of the lint script, exact count.** Run
   `orgs/clearworksai/agents/larry/bin/contract-lint.sh` directly (from
   `/Users/joshweiss/code/cortextos`, since the script hardcodes absolute paths under
   `/Users/joshweiss/code/cortextos/orgs/clearworksai/skills/` and
   `/Users/joshweiss/.claude/skills/`). Confirm the final line reads exactly
   `Results: 18 PASS, 0 FAIL`, the exit code (`echo $?` immediately after) is `0`, and every one
   of the 18 skills hardcoded in the `SKILLS=(...)` array (lines 9–28 of the script) produces a
   `PASS:` line — list them out and diff against the array to confirm none is silently missing
   from the output.

3. **I/O Contract heading spot-check — repo-tracked path.** For at least 2 of the 18 skills,
   pick ones the script would resolve via the repo-tracked path
   (`orgs/clearworksai/skills/<skill>/SKILL.md`) if present — check with `ls
   orgs/clearworksai/skills/<skill>/SKILL.md` first for each of the 18 to find which ones
   actually resolve there (the research doc states PR #194 touched "3 repo-tracked skills").
   Run `grep -n "## I/O Contract" orgs/clearworksai/skills/<skill>/SKILL.md` for each and confirm
   a match, noting the line number.

4. **I/O Contract heading spot-check — global `~/.claude/skills` path.** For at least 4 of the 18
   skills that do NOT resolve via the repo-tracked path (confirmed absent in step 3's `ls` pass),
   run `grep -n "## I/O Contract" ~/.claude/skills/<skill>/SKILL.md` for each and confirm a match.
   Across the combined 6+ skills checked in items 3–4, confirm the heading lands at line 8 in
   every file (the research doc claims this consistently, as evidence of a mechanical prepend
   rather than organic content) — flag it as a finding (not necessarily a failure) if any file
   diverges from line 8.

5. **Forbidden-path check — zero matches, full set.** Run, for all 18 skills (not just the
   spot-checked subset), a loop equivalent to:
   `for s in <18 skill names>; do f=orgs/clearworksai/skills/$s/SKILL.md; [[ -f $f ]] || f=~/.claude/skills/$s/SKILL.md; grep -l "knowledge/company.md" "$f"; done`
   Confirm this produces **zero** output lines (no file matches the forbidden Altari path). This
   must be run against the full 18, not the item-3/4 subset, since it is the deliverable's core
   negative assertion.

6. **25-jobs-to-18-skills count claim.** Read
   `/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md`,
   the P2 job table. Count the total job rows and the count of distinct values in the `Skill`
   column. Confirm the job-row count is 25 and the distinct-skill count is 18, and confirm the
   distinct-skill set matches (as a set, order-independent) the `SKILLS=(...)` array in
   `contract-lint.sh` lines 9–28 exactly — no skill in the script that isn't in the table, and
   vice versa.

7. **No diff against main.** Run `git status` and `git diff main` (or `git diff origin/main`)
   scoped to `orgs/clearworksai/agents/larry/bin/contract-lint.sh` and to each of the 18 skills'
   `SKILL.md` files reachable under `orgs/clearworksai/skills/`. Confirm no uncommitted or
   pending diff exists anywhere in that scope — i.e. the live file state in this worktree matches
   what was merged in PR #194, with nothing silently drifted since. (Skills resolved via
   `~/.claude/skills/` are outside this repo's git tree by definition and are not expected to show
   in this diff — do not treat their absence from `git diff` as a gap.)

8. **Known script defect — confirm still dead code, do not fix.** Read line 67 of
   `orgs/clearworksai/agents/larry/bin/contract-lint.sh` directly:
   `grep -q "interview" "$SKILL_PATH" | grep -q "layout"`. Confirm by inspection that `grep -q`
   suppresses stdout, so the piped second `grep -q` always receives empty input and always
   returns non-zero — i.e. this FAIL branch is unreachable regardless of file content. Then run
   `grep -ln "interview" orgs/clearworksai/skills/*/SKILL.md ~/.claude/skills/{<18 skill names>}/SKILL.md 2>/dev/null`
   across all 18 resolved paths and confirm any matches found are legitimate content (e.g.
   onboarding-flow prose), not an actual Altari "interview layout" artifact — i.e. confirm the
   dead check is not currently masking a real forbidden-content violation. Do not edit the script.

9. **Job-rollout scope boundary respected.** Confirm no artifact produced in this VERIFY pass
   (this spec, the plan, or any resulting diff) references, depends on, or asserts readiness for
   the P4.1-gated Wave-0 job-rollout done-conditions (Call Capture / Transcript Processing /
   Context Maintenance actual pipeline behavior), and that `state/fleet-churn-debug/p2-blocked-on-p4.md`
   (if present) still reflects that item as open/tracked separately, not silently closed by this
   pass.

## Pass/fail criteria

- **PASS (true-verify, no-diff outcome):** All 9 items reproduce as stated above from primary
  sources, and no genuine defect is found in deliverable #1 itself (the lint script's core
  PASS/FAIL logic, its `SKILLS` array, or any of the 18 skills' `## I/O Contract` heading /
  forbidden-path state). The disclosed dead-code check in item 8 reproducing as dead-but-harmless
  is an expected, non-blocking finding, not a failure. Emit the true-verify pipeline receipt with
  a no-diff outcome.
- **FAIL / escalate:** Any item does not reproduce as stated (e.g. PR #194 is not actually MERGED
  on `clearworks-ai/cortextos`, the live script exits non-zero or reports fewer/more than 18
  PASS, a spot-checked `SKILL.md` is missing the `## I/O Contract` heading, a forbidden-path match
  is found, the 25-to-18 count doesn't reconcile against MASTER-BUILD-PLAN.md, or an uncommitted
  diff exists against `main`). In that case, do not mark true-verify — document the discrepancy
  precisely (which item, what was expected vs. found) and route back for a scoped fix, staying
  within deliverable #1's scope only (not the P4.1-gated job-rollout done-conditions or the
  disclosed dead-code check, both explicitly out of scope per the Non-goals above).
