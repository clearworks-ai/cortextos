# CortextOS / Codex Terminal Handoff

Date: 2026-08-05
Repository: `/Users/joshweiss/code/cortextos`
Shared branch: `docs/p2-p5-execution-runbook`
Shared HEAD at latest inspection: `a43be541` (the prior handoff snapshot was `e1003787be3a4ab000ddbf04f872bc52781bbb62`; a daily snapshot commit landed afterward).
Work status: **paused at user request for transfer to Codex Terminal**. Active fanouts were interrupted without commits or merges.

## Mission

Finish the remaining meeting-chain, CRM, dashboard, and Altari follow-through from the P2–P5 punch list. Keep implementation in separate worktrees, require an independent max-reasoning verification for every lane, and run real probes where the environment permits. Do not call a lane complete from code inspection alone.

The user also requested a capabilities manual/PDF covering the incorporated Altari jobs and skills, human-vs-automatic triggers, whole meeting workflow, graphics, examples, and sample outputs. That deliverable is already built and validated; do not rebuild it from scratch unless the evidence changes.

## Safety and ownership

- The shared checkout was already dirty before this handoff. Preserve unrelated user changes; do not run `git reset --hard`, broad checkout, or destructive cleanup.
- Do not merge or commit isolated branches without an explicit decision. The branches below are the working artifacts.
- Tests can mutate `.cortextOS/state/agents/*/crons.json`; restore only generated fixture mutations in the isolated worktree before reporting scope.
- The current daemon/bridge runtime has an ownership conflict; do not “fix” it by killing an unknown process without first identifying the owner and recording the probe.

## Current plan/status

1. Inventory punch list and meeting-chain gaps — **complete**.
2. Build unified capabilities manual in a dedicated worktree — **complete**.
3. Isolated meeting-chain repair (cron preservation, PA routing/writeback prerequisites) — **active**.
4. Prove Fireflies event → PA → durable meeting/client artifacts; retain polling until equivalent event output is proven — **pending**.
5. Repair and independently verify FR-001 through FR-005 — **active fanout; no lane is fully accepted yet**.
6. Complete deterministic CRM persistence/event handoff — **pending**.
7. Validate Multica/dashboard freshness plus P1–P6, Loops, Waves, and Altari follow-through — **pending**.
8. Run final independent review and publish the evidence-backed status — **pending**.

## Isolated worktrees

### Meeting-chain recovery

Path: `/private/tmp/ctx-meeting-chain-recovery`
Branch: `codex/meeting-chain-recovery`

Changed files:

- `src/daemon/cron-migration.ts`
- `tests/integration/crons-migration.test.ts`

The implementation now reads the existing registry before every destructive early return, fails closed if both live and backup registries are corrupt, preserves existing definitions on name collisions, and appends only missing config crons. Focused Vitest is **21/21 passing**. `npm run build` passes when this worktree temporarily uses the shared dependency tree; the worktree itself intentionally has no dependency install. `git diff --check` passes.

An independent verifier originally found a HIGH bug where missing/malformed/empty config paths bypassed the safety read. That was patched and regression-tested. The verifier was paused before issuing a post-fix GO/NO-GO, so resume independent verification before accepting Step 0. Check the collision-count reporting as a low-severity follow-up.

### FR-001 meeting filter / owner routing

Path: `/private/tmp/ctx-fr001-owner-filter`
Branch: `codex/fr001-owner-filter`

Changed files:

- `orgs/clearworksai/agents/pa/scripts/ff-extractor.py`
- `orgs/clearworksai/agents/pa/scripts/test_ff_extractor.py`

The initial implementation added casual-learning filtering, first-person speaker inference, and vague-date handling. It reached 24/24 focused tests. The independent verifier returned **NO-GO** and the implementation agent started a follow-up repair, then was paused for handoff. The unresolved cases are:

1. Equal Josh/Sarah first-person evidence must remain ambiguous/`NEEDS-OWNER`, not guess Josh.
2. Missing-speaker commitments must not become outbound downstream; ingest/recap must preserve the ambiguity.
3. A casual source such as “I’ll be learning more about coding…” can be extracted as “Build coding skills”; the filter must catch this context wording without dropping a real dated work commitment.
4. Model-supplied `a day or so` must not be trusted without transcript support, and an unrelated vague clause must not erase a genuine Friday deadline.

The broad test file baseline is known: 64 collected, 52 passing, 2 pre-existing prompt failures, and 10 pre-existing `meeting_id` signature errors. Targeted tests and `py_compile` pass for the current edits, but the verifier’s four probes are binding.

### FR-002 client history / stale rows

Path: `/private/tmp/ctx-fr002-history-merge`
Branch: `codex/fr002-history-merge`

Staged but uncommitted files:

- `orgs/clearworksai/agents/frank2/scripts/sync_client_context.py`
- `orgs/clearworksai/agents/frank2/scripts/tests/test_sync_client_context.py`

The implementation preserves complete meeting history blocks as atomic units, keeps meeting-sourced open items, regenerates CRM/pipeline-derived rows from current sources, and uses atomic writes before removing obsolete client files. Focused synthetic tests are **2/2 passing**; broader relevant tests were **32 passing with one baseline import error** because `scripts/ff-extractor.py` is absent in that worktree. The independent verifier returned **NO-GO**: `history_rows()` case-folds all CRM source keys, so distinct sources such as `CRM:Event-A` and `crm:event-a` collapse to one row. Add a regression and restrict case-fold deduplication to the intended meeting-source namespace (or preserve CRM source identity). The verifier also found a low-risk temporary-file hygiene gap when an atomic replace is forced to fail. Generated Alice cron fixture mutations were restored before handoff; current scope is limited to the two intended staged files.

### FR-003 call-prep output-path conformance

Path: `/private/tmp/ctx-fr003-path-conformance`
Branch: `codex/fr003-path-conformance`

Changed/untracked files:

- `orgs/clearworksai/agents/frank2/.claude/skills/pre-meeting-brief-page-worker/SKILL.md`
- `state/CRON-ACCOUNTABILITY-2026-08-04.md`
- `state/P2-P5-EXECUTION-RUNBOOK.md`
- `state/P2-P5-SKILL-LEDGER-2026-08-04.md`
- `state/SKILL-OUTPUT-PATH-REGISTRY.json`
- `tests/unit/skills/call-prep-output-conformance.test.ts`

The worker contract now states that `/tmp/pmb-brief.md` is published through `briefs/publisher/publish_brief.py` and verified via URL; it does not claim a durable local write. The registry and three status docs distinguish that live path from the separate CalAsia P1 router spot-run. Focused Vitest is **19/19 passing** across two files; `git diff --check` passes. Build was not run because the isolated worktree lacks dependencies. This still needs an independent verifier.

### FR-004 and FR-005

Prepared worktrees:

- `/private/tmp/ctx-fr004-runtime-policy` — branch `codex/fr004-runtime-policy` (not yet implemented).
- `/private/tmp/ctx-meeting-chain-fr005` — branch `ctx-meeting-chain-fr005` (existing/older worktree; audit before editing).

FR-004 must reconcile the global “never auto-apply” policy with CRM config/AGENTS text that still permits automatic STALE/MISSING writes and with the live registry lacking `records-admin-sweep`.

FR-005 must be re-run from a clean, dependency-capable checkout; the audit found a missing `add-interaction.py` in clean scope, duplicate-contact risk when ID+email both match, public PII fixtures, non-wired deterministic `--apply`, and a prose-only cron path.

### Follow-up repair worktrees paused during transfer

Two fresh worktrees contain **unverified, uncommitted** follow-up edits made after the original handoff snapshot. They are not accepted and must not be treated as terminal-agent output:

- `/private/tmp/ctx-fr001-filter-repair2` — branch `codex/fr001-filter-repair2`; edits to `ff-extractor.py` and `meeting_recap_draft.py`.
- `/private/tmp/ctx-fr002-source-key-fix` — branch `codex/fr002-source-key-fix`; edit to `sync_client_context.py`.

Run their tests and independent verifiers only if you deliberately resume those lanes; otherwise leave them untouched.

Follow-up verification update: the fresh FR-001 worktree `/private/tmp/ctx-fr001-filter-repair2` is now independently **GO** (tracked four-edge-case regressions, extractor 62/62, recap 6/6, compile and diff checks). The fresh FR-002 worktree `/private/tmp/ctx-fr002-source-key-fix` is independently **GO** (tracked four boundary tests, 36/36 collectable Frank2 tests, compile/diff checks, CRM identity, meeting-only dedup, stale-row removal, and atomic cleanup). These GO results apply only to those isolated worktrees; the original terminal-handoff branches remain unmerged.

## Authoritative runtime findings

- A real Fireflies HMAC event reached PA and extracted two decisions. The fast path did not create durable meeting/client/CRM artifacts. This corrected the earlier “webhook login/registration” conclusion: the login gate is done; downstream persistence/writeback is the gap.
- `cortextos status --instance cortextos1` showed the daemon and 11 agents running.
- The local webhook bridge has repeated `EADDRINUSE` failures on `127.0.0.1:20242`; endpoint ownership is unstable. Treat this as a runtime ownership defect, not a Fireflies-registration gate. Re-probe before claiming live event-driven mode.
- Keep the polling path until an equivalent event-driven run produces durable transcript, meeting, client-history, CRM, and Mission Control artifacts.
- PR #318 (`crm-emit-event-test-guard`) was still open/non-draft with green checks; PR #319 (`crm-decision-persistence`) was merged. Do not infer runtime completion from PR state.
- Multica had historically been exercised; re-probe after runtime ownership is stable before clearing its dashboard gate.
- LOOP2 remains unresolved: bypass exists, but `hook-retrieval-enforcer.ts` still exists unless a deliberate delete/downgrade decision is made.

## Existing deliverables

- Manual PDF: `/Users/joshweiss/code/cortextos/state/cortextos-capabilities-manual.pdf`
- Dashboard/capability map: `/Users/joshweiss/code/cortextos/state/cortextos-capability-map.html`
- Corrected status report: `/Users/joshweiss/code/cortextos/state/P2-P5-BATCH4-REPORT-2026-08-04.md`

The PDF is 12 pages and was validated with pypdf plus visual checks of the cover, Altari scope/job cards, workflows, meeting-chain diagram, sample outputs, trigger/manual gates, and the casual-self-disclosure filter rule. It incorporates the Altari Phase-1 wiring plan/design docs and the selected job playbooks/skill definitions. The PDF workflow followed the local PDF skill instructions and bundled reportlab runtime.

## Recommended terminal-agent sequence

1. Read this file, inspect `git status` in the shared checkout and every worktree, and preserve the dirty shared state.
2. Resume FR-001 repair; add the four verifier probes above, then run targeted tests, the broad file, `py_compile` with a temp cache, and `git diff --check`.
3. Run a fresh independent FR-001 verifier in a separate context. Accept only if ambiguity, downstream owner/direction, casual wording, and due-date grounding all pass.
4. Run the FR-002 verifier. Confirm only the two intended files are staged and no generated cron state remains modified.
5. Run an independent FR-003 verifier; use a temporary symlink to the shared `node_modules` only for build/testing if needed, then remove it.
6. Implement FR-004 and FR-005 in their own worktrees, with a separate verifier for each.
7. Resume Step 0 verifier and resolve any remaining low findings (especially collision counts).
8. Trace the actual Fireflies event through PA and prove durable artifacts end-to-end. Keep polling active until proven equivalent.
9. Re-probe Mission Control v2 freshness, Multica, P1–P6, Loops, Waves, and Altari statuses against live evidence.
10. Update the status report/manual only with verified facts. Do not mark a row complete because a PR or focused unit test exists; require a reproducible test/probe and an isolated verifier verdict.

## Useful checks

```bash
git -C /private/tmp/ctx-meeting-chain-recovery status --short
git -C /private/tmp/ctx-fr001-owner-filter status --short
git -C /private/tmp/ctx-fr002-history-merge status --short
git -C /private/tmp/ctx-fr003-path-conformance status --short

# Step 0 focused suite with shared dependencies
PATH=/Users/joshweiss/code/cortextos/node_modules/.bin:$PATH \
NODE_PATH=/Users/joshweiss/code/cortextos/node_modules \
npx vitest run tests/integration/crons-migration.test.ts

# FR-001 focused/broad Python tests
PYTHONPYCACHEPREFIX=/private/tmp/cortextos-pycache \
python3 -m unittest orgs.clearworksai.agents.pa.scripts.test_ff_extractor

# FR-002 focused tests
PYTHONPYCACHEPREFIX=/private/tmp/cortextos-pycache \
python3 -m unittest discover -s orgs/clearworksai/agents/frank2/scripts/tests -p 'test_sync_client_context.py'
```

Handoff rule: if a clean terminal run disagrees with this file, trust the new reproducible probe, record the discrepancy, and update the status report before proceeding.
