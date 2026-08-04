# P2 I/O-contract-lint — VERIFY-pass research (not a replan)

Directive from larry (relaying cortextos guidance, 2026-08-03/04): P2's done-conditions split into
two buckets. **Deliverable #1 — contract-lint.sh + the I/O Contract heading prepended to all 25
priority P2 skills — is NOT in the P4.1-gated bucket** (that bucket is Call Capture / Transcript
Processing / Context Maintenance, which genuinely depend on the not-yet-built P4.1 meeting-push
pipeline). Deliverable #1 is fully independent of P4.1 and cortextos explicitly asked, by name, for
its true-verify receipt to be emitted first as the fastest phase-gate unblock. This is a VERIFY
pass: confirm the already-built state, do not replan or rebuild.

## What deliverable #1 actually is (source: MASTER-BUILD-PLAN.md)

`~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md`, P2 section:

> Every rollout job gets the same I/O contract prepended to its skill's SKILL.md: INPUT —
> `cortextos bus kb-query` first, then the consolidated files home, never Altari's assumed layout.
> OUTPUT — artifact filed BY CONTENT TYPE into the knowledge-sync taxonomy via the P1.0 router
> (provenance in frontmatter) or KB writeback PLUS a structured row.

> **contract-lint — NEW BUILD ITEM:** a ~30-line script,
> `orgs/clearworksai/scripts/contract-lint.sh`: for each of the 25 rollout skills, assert (grep)
> the I/O contract block is present AND no forbidden Altari paths (`knowledge/company.md`,
> interview layout, etc.) remain; exit non-zero on any miss. It does not exist today — it is
> **deliverable #1 of P2** and its own done-condition is "script committed + exits 0 on the wired
> set."

> **Done-condition (machine-checkable):** `contract-lint.sh` exits 0 across all 25 skills; ...

The P2 job table lists 25 rollout jobs (Wave 0 foundation: Call Capture, Transcript Processing,
Context Maintenance; Waves 1–3: Post-Call Debrief, Meeting Follow-Ups, Follow-Up Drafting,
Pre-Call Briefing, Email Triage, Proposal Generation, Pricing Support, Status Updates, Kickoff
Pack, Invoice Generation, Payment Tracking, Collections, CRM Hygiene, Pipeline Reporting,
Forecasting, CRM Sync, Portal Sync, Health Scoring, QBR Prep, Renewals & Expansion, Company
Deep-Dive [2 skills], SOP Generation). Several jobs share one skill (e.g. billing-manager covers
Invoice Generation/Payment Tracking/Collections; pipeline-operations-manager covers CRM
Hygiene/Pipeline Reporting/Forecasting; customer-success-manager covers Health Scoring/QBR
Prep/Renewals; deal-debrief-analyst covers Post-Call Debrief/Follow-Up Drafting;
meeting-intelligence-engineer covers Call Capture/Transcript Processing). The 25 job rows
therefore map onto **18 unique skills** — this is stated explicitly in
`orgs/clearworksai/agents/larry/bin/contract-lint.sh`'s own header comment ("25 job-rows map to 18
unique skills (some skills cover multiple jobs)") and independently reproduces by counting unique
`Skill` column values in the MASTER-BUILD-PLAN.md P2 table.

## Ground truth: is deliverable #1 already built? — verified directly, not taken on report

**Yes.** Two independent lines of evidence:

### 1. Git history — the build already merged
```
$ git log --all --oneline | grep -i "io.contract\|contract.lint"
cb663885 Merge pull request #194 from clearworks-ai/feature/p2-w0-contract-lint
0318310f P2 W0: contract-lint.sh + I/O contract prepend (3 repo-tracked skills)
$ gh pr view 194 --repo clearworks-ai/cortextos --json title,state,mergedAt,mergeCommit
{"mergeCommit":{"oid":"cb663885249dbb215c25d8e8021180891c7ad277"},
 "mergedAt":"2026-08-01T19:17:33Z","state":"MERGED",
 "title":"P2 W0: contract-lint.sh + I/O contract prepend (3 repo-tracked skills)"}
```
PR #194 is MERGED to `clearworks-ai/cortextos` main. (The title says "3 repo-tracked skills" —
that refers to the 3 of the 18 skills that live in `orgs/clearworksai/skills/` rather than the
global `~/.claude/skills/` catalog; the remaining 15 skills already carried the heading via a
separate, earlier fleet-wide skills edit tracked in shared memory as
`project_p2_global_skills_io_contract_approved_2026-08-01`. Both routes converge on the same
end state: all 18 unique SKILL.md files carry the heading.)

### 2. Live re-run of `contract-lint.sh` — independently re-executed this session, not reused from
a prior agent's self-report
```
$ orgs/clearworksai/agents/larry/bin/contract-lint.sh
PASS: meeting-intelligence-engineer
PASS: knowledge-base
PASS: deal-debrief-analyst
PASS: followup-coordinator
PASS: call-prep-researcher
PASS: inbox-manager
PASS: proposal-writer
PASS: pricing-analyst
PASS: delivery-status-reporter
PASS: client-onboarding-manager
PASS: billing-manager
PASS: pipeline-operations-manager
PASS: records-administrator
PASS: client-portal-manager
PASS: customer-success-manager
PASS: company-research-analyst
PASS: vertical-analyst
PASS: playbook-writer

Results: 18 PASS, 0 FAIL
```
Exit code 0. All 18 unique skills backing the 25 priority P2 jobs PASS.

### 3. Independently re-derived the same result WITHOUT trusting the script's own logic
Read the script (`orgs/clearworksai/agents/larry/bin/contract-lint.sh`) in full first, then
re-checked its two substantive assertions by hand against each of the 18 `SKILL.md` files
(resolving repo-tracked `orgs/clearworksai/skills/<skill>/SKILL.md` first, falling back to
`~/.claude/skills/<skill>/SKILL.md`, exactly matching the script's own resolution order):

- `grep -n "## I/O Contract" <path>` — **all 18 files** have the heading, and it lands at line 8
  in every single case (consistent with a mechanical prepend, not organic content).
- `grep -n "knowledge/company.md" <path>` — **zero matches** across all 18 files (forbidden Altari
  path genuinely absent, not just uncaught).

**One script robustness finding, non-blocking:** the script's second forbidden-content check —
`grep -q "interview" "$SKILL_PATH" | grep -q "layout"` (line 67) — is dead code. `grep -q`
suppresses stdout by design, so the second `grep -q` always receives empty stdin and always
returns non-zero (no match), meaning this branch can never fire regardless of file content; it is
effectively unreachable and provides no actual protection against an "interview layout" reference
appearing in a skill. This does not affect the deliverable's substance: independently grepping all
18 files for the literal string `interview` finds it only in `knowledge-base` (legitimate content —
"Step 2 · Interview", part of that skill's own onboarding flow, not an Altari-layout leftover) and
`customer-success-manager` (legitimate content — "your own answers to its interview"); neither is
an Altari interview-layout artifact. So the broken check happens to not hide any real defect today,
but the check itself does not do what its authors intended. Recorded for the audit trail; not a
reason to fail this VERIFY pass, and not touched here (fixing a dead assertion inside an already-
merged, already-passing lint script is a separate, optional hardening item, not part of this
item's scope).

## Non-goals (explicitly out of scope for this VERIFY pass)

- **Wave 0 foundation jobs (Call Capture, Transcript Processing, Context Maintenance) — the
  meeting-intelligence-engineer/knowledge-base skills.** Per cortextos's explicit guidance, these
  three jobs' *done-conditions* (not their I/O-contract heading, which is already present and
  already counted in the 18/18 PASS above) genuinely depend on the not-yet-built P4.1 meeting-push
  pipeline. This item only verifies deliverable #1 (the contract-lint script + heading prepend),
  which is fully built and independent of P4.1. Do not verify or fake receipts for the P4.1-gated
  *job-rollout* done-conditions themselves — that is a separate, still-open tracking item written
  up to `state/fleet-churn-debug/p2-blocked-on-p4.md`.
- **The 3 job-level spot-runs** (Meeting Follow-Ups/followup-coordinator, Pre-Call
  Briefing/call-prep-researcher, Status Updates/delivery-status-reporter) — separately in progress,
  not part of this item's true-verify chain.
- **Fixing the dead `grep -q | grep -q` check** in `contract-lint.sh` — a real but non-blocking
  script defect, noted above, left untouched (no functional impact on the 18/18 PASS result).

## Verdict

Deliverable #1 of P2 — `contract-lint.sh` exists, is committed (PR #194, merged), and exits 0
across all 18 unique skills backing the 25 priority P2 rollout jobs, each carrying the `## I/O
Contract` heading with no forbidden Altari paths — is **already built and independently
re-verified live**, not taken on report. No `src/`, skill-content, or script changes are required.
This VERIFY pass produces a true-verify pipeline receipt (research → plan → specs → review →
true-verify) for the WAVE B / P2 tracking ledger; it does not reopen or rebuild the merged work.
