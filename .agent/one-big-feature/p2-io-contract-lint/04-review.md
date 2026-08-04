# Review — P2 Deliverable #1 (contract-lint.sh) VERIFY pass

## VERDICT: PASS (true-verify, no-diff outcome) — with one non-blocking, disclosed finding

All 9 checklist items in `03-specs/spec-01-verify.md` reproduced exactly as claimed from primary
sources (live `gh`/`git` output, live script execution, live file greps, live doc counts). No
genuine defect was found in deliverable #1 itself. The one known issue (item 8, dead code at
line 67) is disclosed-and-out-of-scope per the spec's own Non-goals section, confirmed still dead
and confirmed not masking a real forbidden-content violation. No code was changed. This is a
correct no-diff true-verify outcome.

---

## Item-by-item

### 1. PR #194 merge state
Command:
```
gh pr view 194 --repo clearworks-ai/cortextos --json title,state,mergedAt,mergeCommit
```
Output:
```json
{"mergeCommit":{"oid":"cb663885249dbb215c25d8e8021180891c7ad277"},"mergedAt":"2026-08-01T19:17:33Z","state":"MERGED","title":"P2 W0: contract-lint.sh + I/O contract prepend (3 repo-tracked skills)"}
```
Matches expected `state: MERGED`, `mergedAt: 2026-08-01T19:17:33Z`, `mergeCommit.oid: cb663885...` exactly.

Command:
```
git log --all --oneline | grep -i "io.contract\|contract.lint"
```
Output:
```
cb663885 Merge pull request #194 from clearworks-ai/feature/p2-w0-contract-lint
0318310f P2 W0: contract-lint.sh + I/O contract prepend (3 repo-tracked skills)
```
Both `cb663885` (merge commit) and `0318310f` (content commit) present. **Confirmed.**

### 2. Live re-run of the lint script, exact count
Command (from `/Users/joshweiss/code/cortextos`):
```
orgs/clearworksai/agents/larry/bin/contract-lint.sh; echo "EXIT_CODE=$?"
```
Output: 18 `PASS:` lines (one per skill), final line `Results: 18 PASS, 0 FAIL`, `EXIT_CODE=0`.
The 18 `PASS:` lines in order: meeting-intelligence-engineer, knowledge-base,
deal-debrief-analyst, followup-coordinator, call-prep-researcher, inbox-manager,
proposal-writer, pricing-analyst, delivery-status-reporter, client-onboarding-manager,
billing-manager, pipeline-operations-manager, records-administrator, client-portal-manager,
customer-success-manager, company-research-analyst, vertical-analyst, playbook-writer —
diffed 1:1 against the `SKILLS=(...)` array (lines 9–28 of the script), zero missing, zero
extra. **Confirmed.**

### 3. I/O Contract heading — repo-tracked path
First resolved which of the 18 skills exist under `orgs/clearworksai/skills/<skill>/SKILL.md`:
exactly 3 do — `meeting-intelligence-engineer`, `knowledge-base`, `followup-coordinator`
(matches the PR title's "3 repo-tracked skills" claim). Ran
`grep -n "## I/O Contract" orgs/clearworksai/skills/<skill>/SKILL.md` for all 3:
```
meeting-intelligence-engineer: 8:## I/O Contract
knowledge-base:                8:## I/O Contract
followup-coordinator:          8:## I/O Contract
```
**Confirmed** (all 3, not just the required 2 minimum).

### 4. I/O Contract heading — global `~/.claude/skills` path
Ran `grep -n "## I/O Contract" ~/.claude/skills/<skill>/SKILL.md` for 6 of the remaining 15
(exceeds the required minimum of 4): `deal-debrief-analyst`, `call-prep-researcher`,
`inbox-manager`, `proposal-writer`, `pricing-analyst`, `delivery-status-reporter` — all 6
matched at `8:## I/O Contract`. Combined with item 3, all 9 spot-checked files land the
heading at line 8, consistent with a mechanical prepend. **Confirmed, no divergence found.**

### 5. Forbidden-path check — zero matches, full 18
Ran, for all 18 skills (resolving repo-tracked-first-else-global per the script's own logic):
```bash
for s in <18 skills>; do
  f=orgs/clearworksai/skills/$s/SKILL.md
  [[ -f $f ]] || f=~/.claude/skills/$s/SKILL.md
  grep -l "knowledge/company.md" "$f"
done
```
Output: zero lines. **Confirmed — zero forbidden-path matches across the full 18, not just the spot-checked subset.**

### 6. 25-jobs-to-18-skills count claim
Read `/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md`,
P2 section (lines 147–212): Wave-0 table (3 rows, lines 161–163) + Wave 1–3 table (22 rows,
lines 173–194) = **25 job rows**, machine-counted (`grep -c '^|'` over both tables extracted by
line range) — matches the doc's own stated "Rollout totals: 25 jobs" (line 198).

Extracted the `Skill` column from all 25 rows, split the one compound cell
(`company-research-analyst + vertical-analyst`) into two, deduped: **18 distinct skill names.**

Diffed that 18-name set against the script's `SKILLS=(...)` array (lines 9–28, extracted fresh
via `sed`, sorted): `diff` produced **zero output** — the sets are identical, no skill in the
script absent from the table and vice versa. **Confirmed.**

### 7. No diff against main
Scoped `git status`/`git diff main` to exactly `orgs/clearworksai/agents/larry/bin/contract-lint.sh`
plus the 3 repo-tracked `SKILL.md` files (the only 3 of the 18 that live under
`orgs/clearworksai/skills/`), run from inside the worktree
(`/Users/joshweiss/code/cortextos/.claude/worktrees/p2-io-contract-lint`, branch
`p2-io-contract-lint`):
```
git status --porcelain -- <4 scoped paths>   → (empty)
git diff main -- <4 scoped paths>            → (empty)
```
**Confirmed clean, no drift since PR #194 merged.**

Note: an unscoped `git status`/`git diff main` over the entire `orgs/clearworksai/skills/`
tree does show live, unrelated in-flight changes (an `outputs-router` untracked manifest file
and a `mirror_deliverables.py`/test diff for an `ext_in` allow-list feature) — these belong to a
different, separately-tracked workstream (outputs-router / p1-2-deliverables-foldin per repo
history) and touch none of the 18 job-rollout skills or `contract-lint.sh`. Correctly excluded
per the spec's exact scoping language ("scoped to contract-lint.sh and to each of the 18
skills' SKILL.md files").

### 8. Known script defect — confirm still dead code, not fixed
Read line 67 directly:
```
  if grep -q "interview" "$SKILL_PATH" | grep -q "layout"; then
```
By inspection: `grep -q` suppresses stdout on a match; piped into a second `grep -q "layout"`
that therefore always receives empty stdin, always exits non-zero → the `if` is always false →
the FAIL branch is unreachable regardless of file content. Verified this behavior directly with
a synthetic test file containing the literal string "interview layout":
`grep -q "interview" file | grep -q "layout"` → false branch, confirmed dead.

Then ran `grep -ln "interview"` across the resolved path for all 18 skills: 2 files matched —
`orgs/clearworksai/skills/knowledge-base/SKILL.md` and `~/.claude/skills/customer-success-manager/SKILL.md`.
Inspected context on both:
- `knowledge-base/SKILL.md`: "the core files written by **interviewing** you", "You **interview**,
  you write, you confirm", "### Step 2 · **Interview**" — legitimate onboarding-flow prose about
  the skill interviewing the end user, not an Altari "interview layout" artifact.
- `customer-success-manager/SKILL.md`: "...or your own answers to its **interview**" — same,
  legitimate onboarding prose.

Checked for "layout" in the same two files: the only match in each is line 9, the I/O-contract
prepend text itself ("Never Altari's assumed **layout**"), unrelated to and not adjacent to the
"interview" occurrences. **Confirmed: dead code reproduces as dead, and it is not currently
masking a real forbidden-content violation.** Per the spec's Non-goals, this is documented, not
fixed.

### 9. Job-rollout scope boundary respected
This review's own artifacts (this spec, this file) assert nothing about the P4.1-gated Wave-0
job-rollout done-conditions (Call Capture / Transcript Processing / Context Maintenance) — scope
stayed on the I/O-contract-heading/forbidden-path check only, as instructed.

Checked for `state/fleet-churn-debug/p2-blocked-on-p4.md`: **does not exist** (searched repo root
and worktree). The spec's wording is conditional ("if present"), so a missing file is not itself
a failure. Found the tracking intent instead in
`state/fleet-churn-debug/P2-SCOPING-CALL.md` (line 3): "P4.1-gated P2 jobs documented
verify-after-P4.1 (`state/fleet-churn-debug/p2-blocked-on-p4.md`), NOT faked" — i.e. that file is
a planned-but-not-yet-created artifact for a separate future pass, not something this VERIFY pass
silently closed. **No scope-boundary violation found.**

---

## Summary of findings

- **Blocking:** none.
- **Non-blocking (disclosed, matches spec's own Non-goals):** the dead `grep -q | grep -q` check
  at `contract-lint.sh:67` is confirmed still unreachable and confirmed not masking any real
  forbidden-content match today. Per spec, not fixed in this pass.
- **Informational:** an unrelated, separately-tracked workstream (outputs-router
  `ext_in`/dirmap changes) has live uncommitted diffs in the same `orgs/clearworksai/skills/`
  tree at review time — irrelevant to deliverable #1's scope, noted only to explain why an
  unscoped `git diff` over the whole skills tree is not clean while the scoped one is.

## Recommendation

**True-verify, no-diff outcome.** All 9 checklist items reproduced from primary sources exactly
as claimed in `02-master-plan.md`/`01-research.md`. No code, script, or skill file changes are
required or were made. Emit the true-verify pipeline receipt for `p2-io-contract-lint` as
no-diff. Do not escalate; do not route back for a fix.
