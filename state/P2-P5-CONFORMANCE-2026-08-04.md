# P2/P5 Conformance Test — Partial Salvage from Dead Workflow (2026-08-04)

## ⚠️ READ THIS FIRST — bigger caveat than previously believed

This is NOT a completed conformance report. It is a manual salvage of 6 killed-mid-run subagent
transcripts from Workflow run `wf_4a802604-256` (task `wrozo9p2p`), launched from session
`df58f3af` which ran out of credits.

**Correction to the record:** it was previously believed the workflow's "Test" phase (phase 1 of
4: Test → Verify → Crons → Report) had *completed* for all 6 batches, with only Verify/Crons/Report
left unrun. That is false. **None of the 6 batch agents ever reached their required
StructuredOutput schema call.** Every one of the 6 transcripts was killed mid-tool-call-sequence —
still running Bash/Read/Write to build fixtures or inspect code — when the parent session's
credits ran out. Zero PASS/FAIL verdicts were ever issued by the workflow itself. Every finding
below was hand-extracted from raw, incomplete transcripts, not a certified schema result.

**Treat nothing below as a verdict.** Treat it as "what a test agent had discovered so far, in its
own words and tool output, before it was cut off." Some of it is solid and load-bearing (file:line,
grep counts, real timestamps). Some of it is a dead end (a shell bug stopped the single most
valuable comparison one command short of a result).

## Batch progress (how far each got before cutoff)

| Batch (file) | Skills | Reached | Verdict issued? |
|---|---|---|---|
| meeting (`agent-adc5453bd752dcd66`) | meeting-intelligence-engineer, deal-debrief-analyst | Read both specs → built fixture → ran meeting-intelligence-engineer Step 4 → ran deal-debrief-analyst → started the meeting-writeback-worker vs ff-extractor comparison, died one command past a real partial result | **No.** Furthest of the 6 but still no schema output. |
| crm (`agent-a6e3ec3fd42d3d8f9`) | records-administrator, pipeline-operations-manager, client-portal-manager | Read specs → investigated the "66 events" live-emission claim → found likely test-fixture leakage → checked cron wiring/git history → started executing pipeline-operations-manager | No. |
| knowledge (`agent-ae9f09b18d38b9546`) | knowledge-base, company-research-analyst, vertical-analyst, playbook-writer | Read all 4 specs → built fixtures → started executing knowledge-base (real scratch artifacts exist) | No. |
| sales (`agent-a5b78a9258f97c821`) | proposal-writer, pricing-analyst | Read specs → checked I/O contract infra → built fixtures (with the mandated edge-case commitment) | No. |
| meeting-adjacent (`agent-aae4cbae3d508e558`) | call-prep-researcher, followup-coordinator, inbox-manager | Read specs → started building fixtures | No. |
| delivery (`agent-a1727de6588200718`) | delivery-status-reporter, client-onboarding-manager, customer-success-manager, billing-manager | Still in pre-flight: checking approvals/logs, hit a `kb-query` org-arg error, was reading `company.md`/`voice.md` for billing-manager context | No. Least progressed of the 6 — never built a single fixture. |

No verdict table (conformance/wiring per skill) exists. Do not construct one from this file by
inference — none of the 18 skills has a certified result.

---

## 1. The meeting-writeback-worker vs ff-extractor.py comparison (partial — the run that mattered most)

This was explicitly called out in the workflow script as "the single most valuable result in this
whole run — it decides whether the fix is 'wire the existing correct worker' or 'write new code'."
It did not finish, but it got close enough to produce one real, usable data point.

**Fixture built** (`state/skill-tests/meeting-writeback-worker/fixture/ff-writeback-A-faithful.json`) —
a synthetic meeting payload in the exact `run_full()` output shape, with three `next_steps`,
deliberately covering the three cases that matter:

| id | text | owner | deadline | why it's there |
|---|---|---|---|---|
| fx-1 | "Analyze the six ops-lead interviews and send Dana Okafor and Mark Reyes emails with Mark on copy" | `""` | `""` | THE target case — verbatim analog of the real dropped commitment ("it'll be a day or so, but I'm going to analyze the interviews and send them both emails with Mark on copy") |
| fx-2 | "Send the current routing spreadsheet with real volumes" | `"Sarah Chen"` | `"2026-08-06"` | control — named owner + date, should always survive |
| fx-3 | "Revisit the SLA language" | `""` | `""` | decision-with-no-task-attached edge case |

**What was actually proven:** a Python simulation of `ff-extractor.py`'s `ACTION_ITEMS_PROMPT`
drop rule (L99-104: keep only if `owner.strip()` AND `deadline.strip()` are both non-empty) run
against fixture A:
```
B next_steps kept: ['fx-2']
```
Confirms in a fresh, independent test: ff-extractor's rule drops **both** fx-1 (the target
commitment) and fx-3 (the ownerless decision), keeping only fx-2. This corroborates the earlier
finding in `state/MEETING-CHAIN-AUDIT-2026-08-04.md` (link 10) with a second, independent method.

**What did NOT get proven — the actually-decisive half:** whether `meeting-writeback-worker`'s
*own* embedded code, run against the same fixture, keeps fx-1 (which would mean the fix is "wire
the existing correct worker" — cheap) or also drops it (which would mean "write new code" —
expensive). The agent extracted the worker's embedded implementation verbatim
(`sed -n '67,493p' .../meeting-writeback-worker/SKILL.md > worker-step3-verbatim.py`, 427 lines,
confirmed non-empty) and built two run directories (`runA`, `runB`) to execute it against the
faithful fixture and the ff-extractor-simulated (post-drop) fixture side by side — then the setup
command failed:
```
sed: 1: "s#^ROOT = Path("/Users/ ...": bad flag in substitute command: 'S'
```
(a macOS BSD-sed quoting bug in the *test agent's own harness script*, not a defect in the worker
code itself — the extracted 427-line file exists and is presumably fine). Both run dirs ended up
with 0 lines copied and both "rc" values printed 0 — meaningless, not a real result. **This is the
single highest-value next step**: fix the sed quoting (or just run the extracted
`worker-step3-verbatim.py` directly with Python instead of shelling through sed for the ROOT-path
rewrite) and actually execute it against fixture A. Everything else in the meeting-chain fix
depends on knowing this answer.

**Artifacts on disk** (real, inspectable):
- `state/skill-tests/meeting-writeback-worker/fixture/ff-writeback-A-faithful.json` (full fixture, shown above)
- `state/skill-tests/meeting-writeback-worker/fixture/ff-writeback-B-ffextractor-simulated.json` (post-drop simulation)
- `state/skill-tests/meeting-writeback-worker/worker-step3-verbatim.py` (427 lines, extracted from `SKILL.md:67-493`)
- `state/skill-tests/deal-debrief-analyst/outputs/deal-debrief-analyst/2026-08-04-northwind-logistics.md` (real fixture output, deal-debrief-analyst executed against the same Northwind fixture)

---

## 2. CRM batch — a real, dated, corroborating finding on the known event-leak bug

The crm-batch agent, testing `records-administrator`, went looking for the "66+ crm events, 4
types, live" evidence cited elsewhere (memory: fleet claimed this as proof of live CRM event
emission) and instead found strong evidence it is **test-fixture leakage**, not live emission —
independently corroborating the PR#305 test-event-leak bug (`incident_pr305_untracked_scripts_incomplete_wireup_2026-08-04` in memory) with fresh, dated data:

```
=== TEST-FIXTURE leakage (Acme/clearpath_id 42 or 7) ===
grep -l "EVENT crm\." *.json in ~/.cortextos/cortextos1/processed/crm:
  32 × EVENT crm.deal.stage_changed
  21 × EVENT crm.contact.created
   7 × EVENT crm.deal.created
   5 × EVENT crm.email.captured
```
Sample real dated hits:
```
2026-08-04T07:03:37.000Z EVENT crm.contact.created — {"contact_id": "zz-smoketest", "name": "ZZ Smoketest", ...}
2026-08-04T07:03:55.000Z EVENT crm.deal.created — {"clearpath_id": 8, "name": "OCG Expansion", "company": "OCG Properties"}
2026-08-04T07:03:55.000Z EVENT crm.deal.stage_changed — {"clearpath_id": null, "name": "Automation Sprint", "archived": true}
```
Cross-referenced against `orgs/clearworksai/agents/crm/crm/*.py` test files — the exact names
`zz-smoketest`, `OCG Expansion`, `Automation Sprint` are fixture data in
`test_reconcile_intake.py:93,101` and `test_sync_board.py:58,72`, not real client names. All three
hit at the same second (`07:03:37`/`07:03:55`) on 2026-08-04, consistent with a single test-suite
run leaking its fixtures into the live `processed/crm` inbox rather than 66 independent real
business events. **This means the earlier claim "CRM event emission system fully implemented and
tested" (memory entry `31596`, 2026-08-04 4:00 PM) needs re-examination — "tested" may be literally
true and "live business events" false for the same evidence.**

Secondary finding, same batch: `records-admin-sweep` is declared in
`orgs/clearworksai/agents/crm/config.json:58` (weekly, `0 20 * * 0`) but:
```
grep -c "records-admin-sweep" ~/.cortextos/cortextos1/.cortextOS/state/agents/crm/cron-execution.log → 0
```
It has never fired. `crm/config.json` itself is **UNTRACKED** in git (`git ls-files --error-unmatch` → not found) — same class of blind spot as PR#305 (config changes with no diff to review).

---

## 3. Bypass inventory (confirmed + carried forward)

| Skill (repo copy) | Runtime copy loaded | Divergence |
|---|---|---|
| meeting-intelligence-engineer | `~/.claude/skills/` — missing `NEEDS-OWNER` rule (added to repo copy Aug 2, never propagated) | contract-lint grades `orgs/clearworksai/skills/` (has the rule); fleet loads the copy without it |
| knowledge-base | `~/.claude/skills/` | same repo-vs-runtime split, not independently re-verified this run (see below — its scratch dir exists, execution didn't reach an assertion before cutoff) |
| followup-coordinator | `~/.claude/skills/` | same, not independently re-verified this run |
| records-administrator | crm `test_*.py` fixtures write to the same JSON-line event log crm live scripts read from | **new this run** — see §2. This is a *bypass in the test infrastructure itself* (no test-safety seam separating fixture writes from the live inbox), distinct from the "spec vs runtime copy" bypass pattern above. |
| meeting chain (ff-extractor.py vs meeting-writeback-worker) | both exist, only one wired | see §1 — not strictly a repo-vs-runtime split, but the same shape: two implementations of one contract, the wrong one is what's live |

No other new bypasses surfaced in the partial transcripts — the other 3 batches (sales,
meeting-adjacent, delivery) never got far enough into execution to find one.

---

## 4. Recommended next actions (from partial data only — no re-run of Verify/Crons/Report implied)

These are actionable from what's already on disk, no live cron/daemon operations required:

1. **Finish the meeting-writeback-worker comparison** (§1). Fix the sed quoting bug or bypass it
   (run the extracted 427-line `worker-step3-verbatim.py` with a Python-side path rewrite instead
   of sed), execute it against `ff-writeback-A-faithful.json`, and check whether `fx-1` survives.
   This is a single self-contained script fix + one execution — no live system touched, answers
   the highest-value open question in the whole meeting-chain investigation.
2. **Re-examine the "CRM event emission fully implemented and tested" claim** (memory `31596`)
   against §2's leakage evidence before repeating it. If real live volume is much lower than 66,
   say so; don't launder test-fixture noise as production signal a second time.
3. **Sync the 3 divergent skill copies** (meeting-intelligence-engineer, knowledge-base,
   followup-coordinator: `orgs/clearworksai/skills/<name>/SKILL.md` → `~/.claude/skills/<name>/SKILL.md`)
   and fix `contract-lint.sh:36-46` to resolve runtime-first (or lint both copies and fail on
   divergence) so P2's "18 PASS/0 FAIL" stops grading a file the fleet doesn't load.
4. **`git add -f` `orgs/clearworksai/agents/crm/config.json`** — it is untracked, which is why
   `records-admin-sweep` could be declared there with zero live fires and no diff ever flagged it.

Everything else (the other 15 skills, the P5 cron reconciliation, the full Verify adversarial
recheck) is simply **not yet attempted** — not failed, not passed, not started far enough to say
either way. Re-running the workflow (or a narrower version of it) is a decision for Josh, not
assumed here.
