# Ledger — goal-client-state-gmail-v1-build

run_id: 2026-09-14-client-state-gmail-v1
goal: docs/pipeline/goals/2026-09-14-client-state-gmail-v1-build-goal.md

## Events


## 2026-09-14T17:31:25Z — kickoff (EACH ITERATION step 1, first run)
- worktree: /Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1 on feat/client-state-gmail-v1-build @ 600e05f3 (cut from feature/client-state-gmail-v1 @ 600e05f3, pushed to origin)
- kickoff SHA origin/main = 6ef523d8; kickoff SHA feature/client-state-gmail-v1 = 600e05f3
- chain node marked running (claim=stage) at handoff; goal condition + chain-goal committed in 600e05f3
- BASELINE: pending (npm ci + npm test + pytest + npm run build running on the unmodified tip)

## 2026-09-14T17:39:59Z — BASELINE captured (unmodified tip 600e05f3, after npm ci)
- vitest: Test Files 18 failed | 276 passed | 9 skipped (303); Tests 10 failed | 3917 passed | 101 skipped | 5 todo (4033); rc=1 — 18 pre-existing red files (all dashboard/**, tests/integration/phase*, daemon fast-checker/rebaseline, pty-leak) listed in run-artifacts/client-state-gmail-v1/BASELINE.json
- pytest scripts/brain/tests: 507 passed, 0 failed (140.6s) rc=0
- npm run build: rc=0
- BASELINE.json + logs committed in worktree eb72ca79; env probes: codex logged in (ChatGPT), python cryptography 43.0.3, gws/gws-dwd/claude/codex on PATH, Grok skipped-by-Josh
- step 2 (planify) in progress: skeleton + 8 parallel sonnet slice writers

## 2026-09-14T20:01:08Z — plan drafted (planify) + G0-compile clean
- plan: docs/pipeline/plans/2026-09-14-client-state-gmail-v1-build.md (worktree, uncommitted until G0 closes; copy at scratchpad/plan-assembled.md) — 23 tasks / 9 slices,   458690 bytes; skeleton by main thread, task bodies by 8 parallel sonnet writers, 2 reconciliation rounds (parse_message from-shape; guard registry 22→39 rows; parity test rebound to real plan_* fns, escalation text + digest line recorded as G-PARITY-1 gaps)
- G0-compile: run-artifacts/client-state-gmail-v1/g0-compile.py — clean rc=0 over 46 blocks (31 py, 8 sh, 4 json); --inject-error rc=1 with 3/3 planted errors caught (py, sh, json). TS blocks are diff-style edits → verified empirically at G0a, tsc after implement.
- next: G0a opus empirical + G0b codex exec (parallel); G0c grok skipped-by-Josh

## 2026-09-14T20:02:59Z — G0 dispatched
- G0a: Agent(model: opus) empirical — throwaway detached worktree at scratchpad/g0a-throwaway, applies tasks 1–23, runs each Step 2/4 command, tears down; artifact → run-artifacts/client-state-gmail-v1/G0-review-opus.json (+ .md run log)
- G0b: `codex exec -s read-only -C <worktree> -o run-artifacts/client-state-gmail-v1/G0b-codex-last.json "<prompt in G0b-codex-prompt.txt>" < /dev/null` detached (pid 28165); codex login status = Logged in (ChatGPT); working-tree scope: plan is the only uncommitted file
- G0c: grok skipped-by-Josh (not run)

## 2026-09-14T20:15:18Z — G0b round 1 (codex exec, read-only, working-tree scope) — 26 findings: 18 Critical / 8 Important
- artifact: run-artifacts/client-state-gmail-v1/G0b-codex-last.json (full stdout G0b-codex-stdout.log); 36 line cites verified, 2 WRONG (src/types/index.ts:53→54; meeting-brief.ts age calc at 336-353) — cosmetic, fixed in plan anchors
- adjudication (main thread, against §Decisions + §Accepted assumptions): ALL 26 accepted as real; none reverses a locked row. Codex rejected 4 would-be findings as locked (pagination beyond 50-cap sweep = accepted assumption; unknown-human escalation = D-11 attention lane; 0.75 threshold = accepted assumption; hostile grounded quote survival + ungated summary = FR-005 by design) — rejections upheld.
- Critical clusters: Task 15 orchestrator (dry-run must persist ledger/cache/receipt on scratch + LoggingRunner; per-message evidence fields; partial-resolution merge; escalation send path + escalated_for; --query composes with exclusions + day-sweep; failure receipts keep last_success_at + persist BudgetExceeded cost; per-contact CRM rows vs per-page History; sender-only auto-create; non-zero writer rc never filed; History write under the existing sibling .md.lock flock), owner_name mismatch (Tasks 9–15), open-task enumeration (--open + classes + id→status join), schema-typed validator (Task 9), digest (explicit baseline write cmd; superseded tasks across full history + status; per-section try/except; extraction summary line), Task 8 del cfg bug. Important: Task 15 test block imports/fixtures, FakeRunner contract dict vs pairs, stale-lock test must age stored ts, g1-count-delta parses passed files as failures + swallows rc, g4-check too lenient, parity skips, mutation restore discards uncommitted guard, Task 11 imports Task 14 symbol.
- disposition plan: one merged fix wave per slice writer after G0a lands (same authors, single pass), then G0-compile → codex round 2 → opus re-run on corrections. findings-per-round: R1=26.

## 2026-09-14T20:32:38Z — G0a round 1 (opus empirical) — 7 Critical / 13 Important; fix wave dispatched
- artifact: run-artifacts/client-state-gmail-v1/G0-review-opus.json (+ .md per-task run log); throwaway worktree applied all 23 tasks: pytest 637 passed / 17 failed / 3 skipped (BASELINE 507/0) — four test files never collected verbatim; tsc rc=0; S-07 TS guards clean (7+6 tests, 977 bus/cli tests no regression); S-09 selftests pass incl. non-vacuous COUNT DELTA proof; torn down, build worktree untouched. 7 claims taken on trust listed; 10 locked-decision rejections upheld.
- Criticals overlap codex 1:1 (orchestrator never integrated; owner vs owner_name; dry-run persists nothing; uncaught gws/extraction failures; --query bypasses exclusions/sweep; del cfg bug; escalate-once unbuilt). Importants: conftest/sys.path, helper imports, FakeRunner contract split, difflib import, Task 15 append block, Lease.touch unguarded, mutation-check fail-open + hardcoded root, 20 registry rows without markers, wrong counts + File map, duplicate hostile fixture, parity fixture vs ensure_contact, --limit 500 vs clamp 200, stale-cleared vs G4 item 5.
- adjudication: all 20 accepted; none reverses a locked row. Merged with G0b: 46 findings round 1 (25 Critical / 21 Important).
- fix wave: shared contract scratchpad/wave2-contract.md (C1–C12: single FakeRunner, conftest, transient pending outcome, open_email_tasks + record_failure, sweep extra_query, projections module client_state_projections.py as the single preview/live source, orchestrator ownership Task 8+15 → S-06 writer (new part 04-s04.md), owner_name, list-tasks --open --class human|build --format json --limit 200, WriterError/TaskEnumerationError, typed schema validator, explicit write-baseline CLI, per-section try/except, strict g1/g4/mutation harness, parity over all projections, registry rebuilt from final markers). Skeleton Interfaces + File map updated to match. 8 writers resumed in parallel.
- next: reassemble → G0-compile → G0b codex round 2 + G0a opus re-run on corrections (verifies the corrections themselves). findings-per-round: R1=46.

## 2026-09-14T21:58:04Z — fix wave 1 landed (8/8 writers); reassembly + G0-compile clean
- parts: 01,02,03(Tasks 6–7),04(Task 8, new),05,06(12–15 + client_state_projections.py),07,08,09; 23 tasks; 544,756 bytes; G0-compile rc=0 over 47 blocks (33 py / 8 sh / 3 json)
- per-writer real-run counts: S-01 23 passed/1 skipped; S-02 16+22; S-03 13+2; S-05 12/19/23; S-06 6/7/10/18/21 (49/49 combined, against locally patched siblings); S-07 unchanged (7+6, tsc 0); S-08 8/14/3; S-09 registry 30 rows re-verified
- residual before round 2: S-06 modules carry no `# G-` markers (finding ids cited instead) → S-06 adding 16 markers on operative lines; S-09 then rebuilds registry rows (currently 30 rows; markers present 33; 4 S-01 markers lack rows). One false alarm: "duplicate Task 8" was a grep artefact (Task 15 title cites Task 8).

## 2026-09-14T22:27:44Z — G0 round 2 dispatched on revised plan
- plan v2 sha256 06cbb519b477d296c9b8c056e355798685099b9792743b3c0565dc459838873b (553,834 bytes; 23 tasks; 47 blocks G0-compile rc=0 — g0-compile-r2.log); guard registry 50 rows == markers (test_no_unregistered_guard verified live by S-09)
- round-1 artifacts archived as G0-review-opus-r1.{json,md}, G0b-codex-r1.json; round 2 writes G0-review-opus.json (opus empirical re-run: dispositions for all 46 + new findings) and G0b-codex-r2.json (codex, working-tree scope, detached)
- findings-per-round so far: R1=46

## 2026-09-14T22:38:55Z — G0b round 2 (codex) — 14 still-open / 12 fixed-and-reverified of 26; 15 NEW Critical (G0B2-1..15)
- artifact: run-artifacts/client-state-gmail-v1/G0b-codex-r2.json; 9 locked rejections upheld; 2 cite corrections (org-name keys suppress to "" at resolve_meeting.py:324 while domain keys overwrite at :312-313 — Tasks 18/19 prose must say so)
- findings-per-round (codex): R1=26 → R2=29 (14 carried + 15 new) — NOT decreasing once; a second non-decrease trips review-loop bound §2. Round cap 3.
- root cause (class): eight parallel authors verifying against locally patched siblings; every seam between sections re-diverges each wave (FakeRunner consumes responses so multi-call tests under-queue; parity test written to a superseded signature; dry-run rows persist writes=[] so plan_digest_line has nothing; shim traps the list-tasks READ the orchestrator needs; registry rows name renamed tests; bash arrays updated in a subshell). Adjudication: all 15 new + 14 carried accepted as real.
- two CONDITION AMENDMENTS (environment/mechanism, not decisions; recorded per the mid-run amendment rule): (1) external-write boundary — shim passes through read-only `bus list-tasks` in addition to meeting-brief-claim/release (G0B2-6); (2) G4 item 5 — lock-held run leaves run-receipt.json byte-identical and writes the cause to last-lock-refusal.json (G0B2-7 resolved the contract-vs-goal contradiction in the goal's favour). Goal file edited in the shared checkout; committed with the plan.
- ROUND 3 SHAPE CHANGE: one integrator (opus, empirical) owns the whole plan — materialise every task into a throwaway, fix until pytest scripts/brain/tests is 100% green (BASELINE 507/0 ⇒ zero failures allowed), vitest single files + tsc green, every selftest (g1/g4/mutation/parity/no-network/registry) green, then write the verified code back into the plan parts and re-derive every count. No more parallel section rewrites.

## 2026-09-14T22:39:26Z — branch housekeeping
- goal amendments committed cc58caf4 on feature/client-state-gmail-v1 (pushed); build branch rebased onto it: BASELINE commit eb72ca79 → 248d61de (delta underneath is docs-only: goal + ledger; BASELINE counts remain valid for tip 248d61de — no src/scripts/tests changed)
- awaiting G0a round 2 (opus empirical) artifact; then round-3 single-integrator dispatch

## 2026-09-14T22:56:24Z — G0a round 2 (opus empirical) — 37 fixed / 9 still-open of 46; 8 Critical + 8 Important NEW (G0A2-1..16); ROUND 3 dispatched (single integrator)
- artifact: run-artifacts/client-state-gmail-v1/G0-review-opus.json (+.md); pytest against applied plan 670 passed / 8 failed / 1 skipped (BASELINE 507/0 ⇒ G1 rule cannot hold yet); tsc 0; vitest +2 files/+13 tests, failing set == BASELINE 18; FR-010 allowlist clean; throwaway torn down.
- headline new: FakeRunner consume-on-match contradicts C1 and breaks Tasks 8/15/19 + 5 mutation control arms; dry-run terminal rows silence the subsequent LIVE run (filed 0, skipped_terminal 1) — fix = simulated rows with planned_writes, non-terminal; task8 test file left red after Task 15; parity called stale signature; g1-count-delta measured the REAL worktree (hardcoded root) and reported BASELINE verbatim; four guards (G-RES-1, G-INV-1, G-DIG-1, G-IDEMP-2) green when mutated away; shim/receipt items now covered by the goal amendments.
- findings-per-round: R1=46 (all reviewers); R2 = codex 29 + opus 25 (overlapping) — flat-to-up; review-loop bound §1 cap = 3 rounds ⇒ round 3 is the last dispatched round; open items after it are adjudicated here (fix / park-with-ruling / HALT) with reasoning.
- round 3 = ONE integrator (opus, empirical): fixes every open id in a materialised tree until pytest 100% green + vitest/tsc + every selftest + all mutation rows green, labels every block, writes plan-sync.py, syncs the verified tree back into the plan, re-derives counts, re-materialises from the written-back plan to prove the PLAN reproduces the green tree. Artifact: G0-r3-integration.json.

## 2026-09-15T02:10:42Z — round 3 integration DONE (single integrator, opus) → round-3 re-reviews dispatched
- G0-r3-integration.json: 51/51 ids fixed-and-reverified (20 carried + 16 G0A2 + 15 G0B2), each with a pinning test node; FRESH materialisation from the written-back plan: pytest 693 passed / 0 failed / 1 skipped (gated live-bus), tsc 0, vitest 7+6, test-ops-shims 18 PASS, g1/g4/cron selftests rc 0 (g4: 8 items + 8 item-negatives + 28 field-negatives, positives generated by real producers), mutation-check 60/60 rows green; plan sha256 06cbb519… → 8ac1ca58847cf0991c0ba3a114592921b2d7cede91257adcff0a02701f3c1bad (690,194 bytes, 49 labelled blocks, G0-compile rc=0, zero unlabeled); plan-sync.py makes tree→plan write-back mechanical
- integrator decisions (recorded): FakeRunner consumes an entry only if another entry with the same prefix follows; dry-run rows persist with simulated:true + planned_writes and are NON-terminal (a later live run files for real); cached extraction persists its context mapping and cached matches re-resolve against it + current open status; lost lease ⇒ stop, record_failure, never release a lease not owned; shim pass-through = {meeting-brief-claim, meeting-brief-release, list-tasks}; g1 requires REPO_ROOT + base_sha; g4 positives from real producers; mutation arrays in parent shell; coverage-diff keys (source_ref, contact_id); task8 intermediate test retired at Task 15.
- worktree hygiene: vitest runs dirty .cortextOS/state/agents/{alice,bob}/crons.json(.bak) — restored with git checkout; note for G1.
- round 3 REVIEWS (last under the 3-round cap): G0a opus empirical re-verify → writes FINAL G0-review-opus.json (all ids across rounds with final dispositions); G0b codex → G0b-codex-r3.json (pid 76835, detached). Anything still open after this round is adjudicated in this thread (fix / park-with-ruling / HALT).

## 2026-09-15T02:21:39Z — G0b round 3 (codex) — 35 fixed / 6 still-open of 41; 11 NEW (8 Critical / 3 Important); CAP REACHED
- artifact: G0b-codex-r3.json (one unescaped quote at line 221 broke strict JSON — parsed leniently; content intact). findings-per-round (codex): 26 → 29 → 17 — decreasing on the final round. Round cap (3) reached ⇒ per review-loop bounds §1 every open item is adjudicated in this thread: fix / park-with-ruling / HALT, each with reasoning, no round 4 dispatch.

## ADJUDICATION AT THE CAP (main thread) — codex round-3 open items, ruling per cluster
Rule applied: review-loop bounds §1 — cap reached; each open finding is fixed / parked-with-ruling / HALTed here with reasoning. None contradicts a §Decisions row or an §Accepted assumption (checked D-11, D-01..D-10 as amended, FR-001..010, the four owned assumptions). Disposition for every item below = **fixed-final-adjudication**: the integrator applies the fix; closure evidence = the pinning test named per item + a deterministic re-materialisation run BY THE ORCHESTRATOR (not the integrator's claim) with pytest 0 failures, mutation rows all green, G0-compile rc 0. No round-4 review is dispatched.
| cluster | ids | severity | ruling | why |
|---|---|---|---|---|
| A completion-per-effect | G0B3-1, G0B-11, G0B-3 | Critical | FIX | outcome `filed` must be set only after CRM+History+task effects for that resolution all landed; persist landed effect tokens per resolution; retry completes missing effects idempotently; merge identity = (slug, normalized email) with contact_id assigned back before persist; prior filed rows absent from fresh are carried. Data-integrity — cannot park. |
| B budget cache | G0B3-2, G0B-6 | Critical | FIX | catch BudgetExceeded inside `_file_message`; append a non-terminal partial row carrying `exc.extraction` (+identity, context mapping) before exit 12; retry test asserts 0 further claude calls. FR-001 at-most-one-call is BINDING. |
| C simulated revision | G0B3-3 | Critical | FIX | carry `revision_of` forward from a simulated/partial same-digest prior; dry-run-revision → live-revision test asserts page marker + live row. D-02 append/revision is BINDING. |
| D preview contract | G0B3-4, G0B-2 | Critical | FIX | preview blocks carry explicit absent-section markers (`extraction: n/a`, `CRM: none`, `page: none`, `task: none`, `quote: none`); g4 item-3 checker conditions its field requirements on the block's outcome; positive fixtures generated by the real producer for filed-with-items, filed-empty-items, ignored, escalated. |
| E G4 items 1 & 8 | G0B3-5, G0B-23, G0B2-14 | Critical | FIX | item 1 binds g1-record.json to the measured tree SHA and to the G3 merge SHA argument; item 8 requires the exact artifact paths (G0-review-opus.json + verify exit 0 record, G2 codex review/challenge stdout artifacts, FINAL fable artifact + verify record, gate_invocation records) each existing and non-empty, one negative fixture per required artifact. |
| F heartbeat | G0B3-6 | Critical | FIX | heartbeat = injectable callback with a monotonic clock; touch at every runner call boundary (sweep queries, read, claude, writers) when ≥ 5 min since last touch; loss ⇒ stop; test simulates a long sweep + long extraction with a fake clock. A2 (≤10 min) is settled. |
| G coverage-diff inputs | G0B3-7 | Critical | FIX | missing/unreadable/malformed `--old-interactions`, ledger, or CRM inputs ⇒ exit 2 with the cause; negative test. FR-006 gate must fail closed. |
| H source_ref proof | G0B3-8 | Critical | FIX | `parsed["source_ref"] == f"gmail:{msg.id}"` required; regression + mutation row G-WRITER-2. |
| I restore failure | G0B3-9 | Important | FIX | EXIT handler captures rc, restores, exits non-zero if any restore failed; intentional restore-failure selftest. |
| J Task 1 fake | G0B3-10 | Important | FIX | Task 1's FakeRunner block = the final consume-only-if-followed version (plan-sync already has the file; sync Task 1's block too); Task 7 restates identically. |
| K release rc | G0B3-11 | Important | FIX | release rc≠0 ⇒ `last-lease-release-failure.json` diagnostic + exit 3 without touching last_success_at; tests for non-zero + timeout. |
Cite corrections: none new. Rejections upheld: codex's `rejected_as_locked` list (re-read; all map to D-11 / accepted assumptions / FR-005 design).

## 2026-09-15T02:29:18Z — G0a round 3 (opus, FINAL artifact G0-review-opus.json) — 75 fixed / 2 still-open (Important) / 2 new (Important); Critical not closed: 0
- empirical: own materialiser + task walker; every task rebuilt from a reset tree through that task, all 23 stated Step-4 counts matched; 4/5 RED claims reproduced exactly; all 8 TS OLD anchors matched exactly once against tip 248d61de; FR-010 exact (4 allowlisted existing files); pytest 693/0/1 reproduced twice; tsc 0; mutation 60/60 with byte-identical restore (md5). Receipt: unverified-by-reviewer (recorded as requested-but-unverified per the model-identity rule).
- open Importants: G0A3-1 File map incomplete (test_client_state_projections.py, vault_min fixtures, 5 ops scripts), G0A3-2 wrong test-node citation in the integration record, G0A-16/G0A2-11 close with the File map. Adjudicated: FIX (folded into the post-cap pass).
- findings-per-round (opus): R1=20 → R2=25 (9 carried + 16 new) → R3=4 — converged. Combined R3 open at cap: codex 17 + opus 4 = 21, all ruled FIX; post-cap pass dispatched to the single integrator; closure by orchestrator-run materialisation (Layer 1), not by a round 4.

## 2026-09-15T02:38:23Z — orchestrator-run materialised verification (Layer 1, no agent claim) on plan 8ac1ca58…
- harness run-artifacts/client-state-gmail-v1/verify-materialised.sh (fresh detached worktree @248d61de, npm ci, g0-compile materialise, plan `git rm` retirements applied, pytest, g1/g4/cron/shims selftests, mutation-check): g0-compile rc=0 (49 blocks); pytest rc=0 — 693 passed / 0 failed / 1 skipped (gated live-bus); g1 rc=0; g4 rc=0; cron rc=0; shims rc=0; mutation rows 60: 58 green, 2 not applied = G-BUS-1/G-BUS-2 (TS OLD/NEW edits are not applied by this harness — TS coverage = opus round-3 empirical run: anchors matched once, vitest 7+6, tsc 0, both TS mutation rows green there). Record: orch-verify-precap.json.
- two harness iterations were needed (chmod order, `git rm` retirements, CLIENT_STATE_REPO_ROOT, npm ci for the FR-011 tsx subprocess) — all harness defects, zero plan defects found by them; recorded so the closure run is on a proven command.
- awaiting post-cap integrator pass; closure = this harness on the written-back plan + verify-review-artifact exit 0 on G0-review-opus.json + adjudication artifact for codex items.

## 2026-09-15T03:48:34Z — post-cap integrator STALLED (no tree edits since 20:48Z, no write-back, no completion) — resumed via message
- pc-tree: 37 dirty files (partial rulings applied); plan sha unchanged 8ac1ca58…; agent transcript file 142 bytes @19:29Z. Recovery: resume-by-message with status-then-finish instruction; fallback if no write-back = fresh integrator seeded from pc-tree diff.

## 2026-09-15T03:51:37Z — stalled integrator: state recovered from its tree (pc-tree)
- resume-by-message queued but never delivered (agent never took another tool round; no hung subprocess found). pc-tree pytest (orchestrator-run): 706 passed / 2 failed / 1 skipped — the two failures share one root: 8 new guard markers from rulings A/B/C/F/K (G-BUDGET-2, G-EFFECT-1, G-LOCK-7, G-LOCK-8, G-MERGE-2, G-MERGE-3, G-PARITY-2, G-REV-1) lack registry rows (test_no_unregistered_guard), and the focused no-network suite exits non-zero because it contains that test (zero TRAP lines — boundary intact). Diff vs plan: client_state_gmail.py +182/-38, single_flight.py +101/-11, observation_ledger.py +35, projections +37, writes +8, g4-check.sh +127/-26, mutation-check.sh +46, coverage-diff.py +49/-9, g4-gen-fixture.py +58, tests +557.
- decision: stop the stalled agent and its watcher; dispatch a FRESH integrator seeded from pc-tree to finish (registry rows + mutation rows for the 8, all rows green, selftests, plan-sync write-back, File map, counts, fresh re-materialisation). Closure remains orchestrator-run harness + verify-review-artifact.

## 2026-09-15T04:23:12Z — post-cap work recovered and completed in-thread
- replacement integrator stopped after 20 min with no edits (Josh: "this seems wrong" — agreed; residual was small enough to finish here). Measured state: the first integrator HAD finished the tree AND synced parts 01/06/09 + skeleton at 21:13–21:16Z before going silent; the registry already carried all 68 rows (8 post-cap guards included).
- orchestrator-run in pc-tree: pytest 710 passed / 0 failed / 1 skipped; mutation-check 68/68 rows green rc=0; registry + no-network tests pass. Candidate plan reassembled from the parts materialises to EXACTLY pc-tree (only diff = the retired Task 8 test the plan `git rm`s; fixture JSONs are test-generated; TS files are edit snippets) — g0-compile rc=0, 49 blocks.
- installed as the plan in the worktree; orchestrator harness proof (fresh throwaway + npm ci + retirements) running; post-cap dispositions + codex adjudication artifact next; then G0 record-gate.

## 2026-09-15T04:24:14Z — G0 closure artifacts
- G0-adjudication.json: 21 items (17 codex + 4 opus residuals) `fixed-final-adjudication`, each with pinning test nodes present in the green tree; reviewed.plan_sha256 = final plan 62ec29c51775a43d…; verify-review-artifact --sha <final> rc=0
- G0-review-opus.json (round 3, FINAL): 79 findings, 0 Critical open; verify-review-artifact --sha 8ac1ca58… (the sha it reviewed) rc=0. The post-cap delta (rulings A–K) was not re-reviewed by opus (cap) — covered by the adjudication artifact + orchestrator harness.
- G0-r3-integration.json gains `post_cap` (dispositions, final runs 710/0/1, mutation 68/68, registry 68)
- pc-tree + proof-tree worktrees removed; harness proof on the installed plan running (orch-verify-final.json)

## 2026-09-15T04:25:51Z — G0 CLOSED (kind=deterministic) → plan stamped
- orchestrator harness on the INSTALLED plan (sha 62ec29c51775a43d7530ee1cf413e84cf09bfefb8e27fd254e28a548627c381a, 759,669 bytes, 23 tasks): g0-compile rc=0 (49 blocks), npm ci, retirements applied, pytest 710 passed / 0 failed / 1 skipped, g1/g4/cron/shims selftests rc=0, mutation 66/68 (G-BUS-1/2 not applied by the harness; both green in the applied-tree runs: opus r3 + pc-tree 68/68). Record: orch-verify-final.json.
- record-gate G0-review: `verify-review-artifact --file G0-review-opus.json --sha 8ac1ca58… && … --file G0-adjudication.json --sha 62ec29c5…` exit 0 → gate-G0-review.json (gate_invocation for mark-done).
- plan committed 60d5fb94 on feat/client-state-gmail-v1-build (pushed by name); chain node meta.plan_artifact stamped from the shared checkout (a first stamp ran from the worktree cwd and was reverted); validate PASS.
- G0 tally: rounds 1–3 raised 79 (opus) + 52 (codex) findings incl. carried; all closed (fixed-and-reverified or fixed-final-adjudication); 0 Critical open. Verification floor so far: Layer 1 (harness, compile, gates) + Layer 3 (opus x3, codex x3).
- NEXT: EACH ITERATION step 4 — Skill(implementify) applying the plan task-by-task on feat/client-state-gmail-v1-build with focused tests; then G1 COUNT DELTA.
