# P2 I/O-contract-lint (Deliverable #1) — VERIFY-pass master plan

Directive relayed by larry (cortextos guidance, 2026-08-03/04): deliverable #1 of P2 —
`contract-lint.sh` + the `## I/O Contract` heading prepended to all 25 priority P2 rollout jobs'
skills — is NOT part of the P4.1-gated bucket (Call Capture / Transcript Processing / Context
Maintenance job-rollout done-conditions, which genuinely depend on the not-yet-built P4.1
meeting-push pipeline). Deliverable #1 is fully independent of P4.1 and was explicitly named by
cortextos as the fastest phase-gate unblock to true-verify first. This is a **VERIFY pass, not a
build or replan**: confirm the already-merged state, do not propose new code changes, new
features, or a rebuild.

Grounded in `01-research.md` (read in full before this plan was written) — every fact cited below
traces to a primary source inspected directly in that doc, not to a self-report.

## Conclusion

**No code, skill-content, or config changes are required.** Deliverable #1 —
`orgs/clearworksai/agents/larry/bin/contract-lint.sh` — is committed and merged to `main` via PR
#194 (`clearworks-ai/cortextos`, merge commit `cb663885`, merged 2026-08-01T19:17:33Z), and it
exits 0 across all 18 unique skills backing the 25 priority P2 rollout jobs, each carrying the
`## I/O Contract` heading with no forbidden Altari legacy-template paths remaining. This is a
VERIFY pass: the deliverable of this item is a true-verify pipeline receipt, not a diff.

## Verification methodology

Every claim in `01-research.md` was established by direct inspection of a primary source, never by
trusting a prior agent's self-report or a planning doc's stated intent. This plan's methodology —
and what the next (REVIEW) stage must independently re-derive — rests on three converging lines of
evidence:

1. **Build/merge provenance.** `git log --all --oneline | grep -i "io.contract\|contract.lint"`
   shows PR #194 merged (`cb663885`) on top of the actual build commit (`0318310f`, "P2 W0:
   contract-lint.sh + I/O contract prepend (3 repo-tracked skills)"). `gh pr view 194 --repo
   clearworks-ai/cortextos --json title,state,mergedAt,mergeCommit` independently confirms
   `state: MERGED` against the real GitHub API, not a local branch claim. This proves the script
   is not merely staged in a branch or worktree — it is on `main`.

2. **Live re-execution of the script itself.** `orgs/clearworksai/agents/larry/bin/contract-lint.sh`
   was re-run live in the research session (not reused from a prior agent's self-report) and
   produced `18 PASS, 0 FAIL`, exit 0. This proves the mechanical check the deliverable's own
   done-condition specifies ("script committed + exits 0 on the wired set") is true today, not
   merely at merge time.

3. **Independent hand-verification of the script's substantive assertions**, without trusting the
   script's own logic to grade itself: `grep -n "## I/O Contract" <path>` was run by hand against
   all 18 resolved `SKILL.md` files (repo-tracked `orgs/clearworksai/skills/<skill>/SKILL.md`
   first, falling back to `~/.claude/skills/<skill>/SKILL.md` — the same resolution order the
   script itself uses) and confirmed the heading present at line 8 in every file (consistent with
   a mechanical prepend). `grep -n "knowledge/company.md" <path>` was run the same way and found
   zero matches across all 18 files. This step exists specifically because a lint script passing
   is not proof by itself if the script's checks are broken — the research doc found exactly one
   such case (below) and hand-verification confirmed it does not hide a real defect.

Each of these three lines is independently reproducible from primary sources by a reviewer with no
prior context; the spec for this item (`03-specs/spec-01-verify.md`) turns them into a numbered
checklist a fresh REVIEW-stage subagent must re-run itself.

### Known, disclosed script defect (non-blocking, not fixed here)

`contract-lint.sh` line 67 — `grep -q "interview" "$SKILL_PATH" | grep -q "layout"` — is dead code.
`grep -q` suppresses stdout by design, so the second `grep -q` always receives empty stdin and
always returns non-zero (no match); this branch can never fire regardless of file content. The
research doc independently grepped all 18 files for the literal string `interview` and found it
only in `knowledge-base` and `customer-success-manager`, both legitimate onboarding-flow content,
neither an Altari interview-layout artifact — so the broken check happens to not hide a real defect
today. This is recorded for the audit trail only. See Non-goals below: it is explicitly not in
scope to fix here.

## Non-goals (explicitly out of scope for this VERIFY pass)

- **The P4.1-gated Wave-0 job done-conditions** — Call Capture, Transcript Processing, Context
  Maintenance (backed by `meeting-intelligence-engineer` / `knowledge-base`). Their *I/O-contract
  heading* is already present and already counted in the 18/18 PASS above — that part is in scope
  and verified. Their actual pipeline behavior / job-rollout done-condition is a separate,
  still-open item gated on the not-yet-built P4.1 meeting-push pipeline, tracked at
  `state/fleet-churn-debug/p2-blocked-on-p4.md`. Do not verify, fake, or imply readiness for that
  separate done-condition here.
- **Fixing the dead `grep -q | grep -q` "interview layout" check** in `contract-lint.sh`. Real,
  disclosed, non-blocking (does not affect the current 18/18 PASS result or hide a live defect).
  Left untouched — a separate, optional hardening item, not part of deliverable #1's scope.
- **The 3 job-level spot-runs** — Meeting Follow-Ups (`followup-coordinator`), Pre-Call Briefing
  (`call-prep-researcher`), Status Updates (`delivery-status-reporter`). These are separately
  tracked in-progress items, not part of this VERIFY pass's true-verify chain. (Their skills are
  still correctly included in the 18/18 lint pass above — only their broader job-level rollout
  status is out of scope here.)

## What "done" means for this VERIFY pass

Done is a **true-verify pipeline receipt** (research → plan → specs → review → true-verify) for
the WAVE B / P2 tracking ledger, consisting of:

1. This plan (`02-master-plan.md`) plus the spec (`03-specs/spec-01-verify.md`) as the authored
   planning artifacts (this session).
2. An independent REVIEW stage — a separate, fresh subagent with no prior context from this
   session — that re-derives the same conclusion from the same primary sources per the checklist
   in `03-specs/spec-01-verify.md`, not a re-read-and-agree of this plan.
3. **No diff expected.** The correct, preferred outcome of this item is a no-diff true-verify
   receipt, since verification finds the deliverable already built, merged, and passing live. A
   diff should only occur if the independent review step turns up a genuine, narrowly-scoped
   defect in deliverable #1 itself (the lint script's core PASS/FAIL logic, or a skill missing the
   heading) — not either of the two disclosed non-blocking items in Non-goals above.
4. A pipeline-stage-emit / true-verify row recorded against this item's slug (`p2-io-contract-lint`)
   so the WAVE B ledger reflects a proven, re-derived verification rather than a self-report.
