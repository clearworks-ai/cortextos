# P2 Deliverable #1 (contract-lint.sh) — true-verify evidence

Re-run live, at true-verify time (not reused from the review subagent's earlier output), to
confirm nothing drifted between review and true-verify:

```
$ orgs/clearworksai/agents/larry/bin/contract-lint.sh
... (18 PASS lines) ...
Results: 18 PASS, 0 FAIL
EXIT=0

$ gh pr view 194 --repo clearworks-ai/cortextos --json state,mergedAt,mergeCommit
{"mergeCommit":{"oid":"cb663885249dbb215c25d8e8021180891c7ad277"},
 "mergedAt":"2026-08-01T19:17:33Z","state":"MERGED"}

$ git diff main -- orgs/clearworksai/agents/larry/bin/contract-lint.sh \
    orgs/clearworksai/skills/meeting-intelligence-engineer/SKILL.md \
    orgs/clearworksai/skills/knowledge-base/SKILL.md \
    orgs/clearworksai/skills/followup-coordinator/SKILL.md
(empty — no diff needed against main, scoped to the lint script + the 3 repo-tracked skills)

$ git status --porcelain -- <same 4 paths>
(empty)
```

## Chain of evidence (full)

1. **Research** (`01-research.md`, runner `general-purpose`, ledger row ts 1785813557):
   deliverable #1 (contract-lint.sh + I/O Contract heading on 18 unique skills backing the 25
   priority P2 jobs) already built and merged (PR #194); live re-run confirmed 18/18 PASS;
   documented one non-blocking script robustness finding (dead `grep -q | grep -q` "interview
   layout" check, confirmed harmless).
2. **Plan** (`02-master-plan.md`, subagent-authored via Write, ledger row ts 1785813678):
   conclusion — no code/skill-content change required; verification methodology; explicit
   non-goals (P4.1-gated Wave-0 job done-conditions, the dead-code fix, the 3 separately-tracked
   job spot-runs all out of scope).
3. **Specs** (`03-specs/spec-01-verify.md`, same subagent, ledger row ts 1785813688): 9-item
   independent-reproduction checklist for the review stage, covering PR merge state, live script
   re-run, heading spot-checks across both resolution paths, full-set forbidden-path check,
   25-jobs-to-18-skills reconciliation against MASTER-BUILD-PLAN.md, no-diff confirmation, the
   known dead-code check, and scope-boundary respect.
4. **Review** (`04-review.md`, independent fresh subagent with no prior context, ledger row ts
   1785813885): **PASS (true-verify, no-diff outcome)**. All 9 checklist items independently
   reproduced from primary sources: `gh pr view 194` confirmed MERGED; live script run reproduced
   `18 PASS, 0 FAIL` / exit 0 with the PASS list diffed 1:1 against the script's own `SKILLS`
   array; I/O Contract heading confirmed at line 8 in 9 spot-checked skills (all 3 repo-tracked +
   6 of the 15 global-path skills); zero `knowledge/company.md` matches across the full 18;
   MASTER-BUILD-PLAN.md P2 table reconciled to exactly 25 job rows / 18 distinct skills, set-
   identical to the script's array; scoped `git diff main` clean (an unrelated, separately-tracked
   outputs-router workstream diff exists elsewhere in the same directory tree but touches none of
   the 18 skills or the lint script); the dead line-67 check confirmed still unreachable via a
   synthetic repro and confirmed not currently masking any real forbidden-content violation; no
   scope creep into the P4.1-gated job-rollout done-conditions.
5. **True-verify (this doc)**: re-ran the 3 highest-value checks live, immediately before this
   emit, to rule out drift since the review subagent ran: lint script exit/count, PR merge state,
   and scoped diff-against-main. All reproduce identically. No regression.

## Outcome

**No-diff true-verify.** P2 Deliverable #1 (`contract-lint.sh` + the `## I/O Contract` heading
prepended across all 18 unique skills backing the 25 priority P2 rollout jobs) is confirmed built,
merged (PR #194), and passing live: `contract-lint.sh` exits 0 with 18/18 PASS, the heading is
present in every skill at a consistent line 8, no forbidden Altari paths remain, and the 25-to-18
job/skill mapping reconciles against `MASTER-BUILD-PLAN.md`. This VERIFY pass produces the P2
pipeline receipt for `p2-io-contract-lint`; it does not reopen, rebuild, or diff against the merged
work.

One disclosed, non-blocking finding carried forward for the record (not fixed, not blocking):
`contract-lint.sh:67`'s `grep -q "interview" ... | grep -q "layout"` forbidden-content check is
dead code (the first `grep -q` suppresses stdout, so the piped second `grep -q` always sees empty
input and never matches) — confirmed via a synthetic repro to always evaluate false, and confirmed
today it is not masking any real forbidden-content violation across the 18 skills. A future,
separately-scoped hardening pass could replace it with a single `grep -qi "interview layout"` (or
equivalent) if this class of Altari-template leftover ever needs real protection.

Explicitly NOT covered by this receipt (per cortextos's guidance and the WAVE-0 P4.1 circular
dependency): the Wave-0 foundation jobs' actual pipeline done-conditions (Call Capture / Transcript
Processing / Context Maintenance), which depend on the not-yet-built P4.1 meeting-push pipeline.
Those remain tracked separately and are written up in
`state/fleet-churn-debug/p2-blocked-on-p4.md` as a distinct item, not silently closed by this pass.

A receipt-only PR (no functional diff, adds this
`.agent/one-big-feature/p2-io-contract-lint/` verify documentation) will be opened from branch
`p2-io-contract-lint` per the provenance requirement (branch name == slug, no prefix).
