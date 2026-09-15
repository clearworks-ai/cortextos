# G0 round 3 — integration log (single author)

Reviewer/integrator: **claude-opus-5 (requested: opus)**.
Plan: `docs/pipeline/plans/2026-09-14-client-state-gmail-v1-build.md`
sha256 before `06cbb519b477d296c9b8c056e355798685099b9792743b3c0565dc459838873b`
→ after `8ac1ca58847cf0991c0ba3a114592921b2d7cede91257adcff0a02701f3c1bad`.
Branch tip `248d61de`. Machine artifact: `G0-r3-integration.json` (51 dispositions,
all `fixed-and-reverified`, `remaining_open: []`).

This round's point is that the PLAN must be true, not the tree. Everything below
that says "verified" was run against `scratchpad/g0-r3-fresh` — a **fresh detached
worktree materialised only from the written-back plan**, never hand-edited.

Method:
1. `git worktree add --detach scratchpad/g0-r3-tree feat/client-state-gmail-v1-build` (248d61de), `npm ci --no-audit --no-fund` (rc 0).
2. Labelled every unlabelled Step-1 test/fixture block (`# file:` / `// file:`; `(append)` marks a delta), then materialised the plan in order with `scratchpad/g0-materialise.py` + `scratchpad/ts-apply.py`.
3. Fixed every open finding IN THE TREE.
4. Wrote the tree back with `scratchpad/plan-sync.py`, re-derived every Step-2/Step-4 count with `scratchpad/verify-steps.py` (materialise `--through N`, then run that task's own command), reassembled, and re-materialised into a SECOND fresh worktree to prove the written-back plan reproduces the green tree.

---

## 0. Starting point reproduced

The materialised plan reproduced the round-2 reviewer's tree exactly:

```
$ python3 -m pytest scripts/brain/tests -q -p no:cacheprovider
FAILED scripts/brain/tests/test_client_state_digest.py::test_gmail_section_renders_each_change_line_type
FAILED scripts/brain/tests/test_client_state_gmail.py::test_two_known_contacts_same_page_one_history_two_crm_rows
FAILED scripts/brain/tests/test_client_state_gmail_task8.py::test_dry_run_persists_ledger_and_receipt
FAILED scripts/brain/tests/test_client_state_gmail_task8.py::test_second_identical_dry_run_appends_nothing
FAILED scripts/brain/tests/test_client_state_gmail_task8.py::test_backfill_query_composes_exclusion_and_day_sweep
FAILED scripts/brain/tests/test_client_state_parity.py::test_history_entry_parity_byte_identical_via_real_consumer
FAILED scripts/brain/tests/test_client_state_parity.py::test_digest_line_parity_pure_and_deterministic
FAILED scripts/brain/tests/test_no_network.py::test_no_shim_traps_during_focused_suite
8 failed, 670 passed, 1 skipped in 44.58s
```

That is byte-for-byte the round-2 artifact's `670 passed / 8 failed / 1 skipped`, so
every fix below is measured against the same starting state the reviewers saw.

A ninth failure showed up only on the FIRST run of a clean checkout
(`test_extract_email.py::test_hostile_body_survives_gate_and_validates`, then green
on every re-run). Cause: the recorded-fixture generators lived in
`test_gmail_source.py`, and pytest imports test modules alphabetically —
`test_extract_email` first. The generators moved into
`helpers_client_state.ensure_gmail_fixtures()`; the suite is now green on a
fixture-less tree, first run.

---

## 1. The one fix that unblocked 4 of the 8 failures — C1 FakeRunner

`del self.responses[i]` made every recorded prefix single-use. The contract is now
written into the docstring and implemented as: first match in insertion order,
CONSUMED only when another entry with an identical prefix follows later.

```
$ python3 -m pytest scripts/brain/tests -q -p no:cacheprovider   # after the FakeRunner fix only
6 failed, 672 passed, 1 skipped in 39.80s
```

Both directions are pinned by tests that existed before and after:
`test_acquire_retries_once_on_stale_cleared_stderr_and_wins` needs consumption;
`test_backfill_query_composes_exclusion_and_day_sweep` needs stickiness (1 + days
triage queries off one recorded prefix).

---
## 2. Final suite — fresh worktree, materialised only from the written-back plan

```
$ python3 -m pytest scripts/brain/tests -q -p no:cacheprovider -rs
.........s....................................                           [100%]
=========================== short test summary info ============================
SKIPPED [1] scripts/brain/tests/test_single_flight.py:135: requires cortextos on PATH and CLIENT_STATE_LIVE_BUS=1 for a live bus claim/release round-trip
693 passed, 1 skipped in 78.40s (0:01:18)
```

The single skip is the gated live-bus round-trip, not a client-state test.

```
$ npx tsc --noEmit -p tsconfig.json; echo "rc=$?"
rc=0
```

```
$ npx vitest run tests/unit/bus/task-human-type.test.ts
 Test Files  1 passed (1)
$ npx vitest run tests/unit/cli/bus-create-task-type.test.ts
 Test Files  1 passed (1)
```

---

## 3. Ops selftests — every one green, on the fresh tree

### `test-ops-shims.sh` (18 PASS rows, rc 0)

```
$ bash docs/pipeline/run-artifacts/client-state-gmail-v1/test-ops-shims.sh; echo "rc=$?"
PASS: shims/cortextos traps 'bus create-task'
PASS: shims/cortextos logged the trapped call
PASS: shims/cortextos passes through 'bus meeting-brief-claim'
PASS: shims/cortextos logged the pass-through call
PASS: shims/cortextos passes through 'bus meeting-brief-release'
PASS: shims/cortextos passes through 'bus list-tasks'
PASS: shims/cortextos logged the 'bus list-tasks' pass-through call
PASS: shims/cortextos still traps 'bus send-telegram'
PASS: shims/cortextos still traps 'bus add-cron'
PASS: shims/cortextos still traps 'bus comms-filter'
PASS: shims/gws-trap always traps
PASS: shims/claude-trap always traps
g1-count-delta selftest: OK - extracted 18 failing files from the real log, exact match with BASELINE.json
g1-count-delta: FATAL - could not extract vitest 'Test Files'/'Tests' summary from /var/folders/9h/_28txm2j60g3n1tv2_hy98400000gn/T//g1-count-delta-selftest.uxLvbJ/bad-vitest.log (fail-closed, non-vacuous)
g1-count-delta selftest: OK - doctored log correctly rejected (non-vacuous)
g1-count-delta selftest: OK - passing files are never counted as failing (G0B-22 fixed)
g1-count-delta selftest: OK - check fails closed on a missing and on an unresolvable base_sha (G0B2-15)
g1-count-delta selftest: OK - a runner rc disagreeing with its parsed log is a violation (G0B2-15)
PASS: g1-count-delta.sh --selftest passed (extraction is non-vacuous)
PASS: g4-check.sh fails closed with no evidence artifacts
PASS: g4-check.sh --selftest passed (real-producer fixture + per-item and per-field negatives)
PASS: g4-check.sh --selftest proved all 8 items pass on real producer output
PASS: g4-check.sh --selftest isolated all 8 per-item negative fixtures
PASS: g4-check.sh --selftest rejected every individually-required field removal
ALL OPS-SHIM TESTS PASSED
rc=0
```

The four new rows are the G0A2-15/G0B2-6 fix: the shim now passes `bus list-tasks`
through (still logged) per the amended goal, and three rows prove `send-telegram`,
`add-cron` and `comms-filter` still trap.

### `g1-count-delta.sh` — REPO_ROOT is required, and the gate fails closed

```
$ ( unset CLIENT_STATE_REPO_ROOT; bash docs/pipeline/run-artifacts/client-state-gmail-v1/g1-count-delta.sh capture /tmp/x.json ); echo "rc=$?"
g1-count-delta: FATAL - CLIENT_STATE_REPO_ROOT is required (the tree to measure); refusing to guess
rc=2
```

Before: it silently fell back to the hardcoded real worktree, so a G1 run from any
other tree measured a tree that was not the one under test (G0A2-5).

```
$ CLIENT_STATE_REPO_ROOT=$PWD bash docs/pipeline/run-artifacts/client-state-gmail-v1/g1-count-delta.sh --selftest; echo "rc=$?"
g1-count-delta selftest: OK - extracted 18 failing files from the real log, exact match with BASELINE.json
g1-count-delta: FATAL - could not extract vitest 'Test Files'/'Tests' summary from /var/folders/9h/_28txm2j60g3n1tv2_hy98400000gn/T//g1-count-delta-selftest.VdcDX1/bad-vitest.log (fail-closed, non-vacuous)
g1-count-delta selftest: OK - doctored log correctly rejected (non-vacuous)
g1-count-delta selftest: OK - passing files are never counted as failing (G0B-22 fixed)
g1-count-delta selftest: OK - check fails closed on a missing and on an unresolvable base_sha (G0B2-15)
g1-count-delta selftest: OK - a runner rc disagreeing with its parsed log is a violation (G0B2-15)
rc=0
```

### `g4-check.sh --selftest` — positive fixtures from the REAL producers

```
$ bash docs/pipeline/run-artifacts/client-state-gmail-v1/g4-check.sh --selftest; echo "rc=$?"
g4-check selftest: OK - fully-satisfying fixture passes all 8 items
g4-check selftest: OK - negative fixture for item 1 (1-suite.json) flips ONLY that item to FAIL
g4-check selftest: OK - negative fixture for item 2 (2-shim-tests.log) flips ONLY that item to FAIL
g4-check selftest: OK - negative fixture for item 3 (3-dry-run) flips ONLY that item to FAIL
g4-check selftest: OK - negative fixture for item 4 (4-no-prod-writes.json) flips ONLY that item to FAIL
g4-check selftest: OK - negative fixture for item 5 (5-idempotency.json) flips ONLY that item to FAIL
g4-check selftest: OK - negative fixture for item 6 (6-digest-dry-run.txt) flips ONLY that item to FAIL
g4-check selftest: OK - negative fixture for item 7 (7-bus-guards.json) flips ONLY that item to FAIL
g4-check selftest: OK - negative fixture for item 8 (8-floor.txt) flips ONLY that item to FAIL
g4-check selftest: OK - all 28 individually-required field/artifact removals are rejected by their own item
rc=0
```

### `cron-precheck.sh --selftest`

```
$ bash docs/pipeline/run-artifacts/client-state-gmail-v1/cron-precheck.sh --selftest; echo "rc=$?"
/private/tmp/claude-501/-Users-joshweiss-code-cortextos/cae12226-d674-4173-af86-d7fe5cbba2d7/scratchpad/g0-r3-fresh/docs/pipeline/run-artifacts/client-state-gmail-v1/fixtures/crons-bad.json:0: cron 'range-with-step-regression' uses range-with-step form: 1-5/2 * * * *
cron-precheck selftest: OK (clean fixture -> 0, bad fixture -> 1)
rc=0
```

### no-network boundary proof

```
$ python3 -m pytest scripts/brain/tests/test_no_network.py -q -p no:cacheprovider
..                                                                       [100%]
2 passed in 1.79s
```

The zero-TRAP assertion now runs BEFORE the rc assertion (G0A2-13), so the
external-write evidence is never masked by an unrelated failure in the slice.

---

## 4. Mutation harness — 60 rows, 60 green, exit 0

Registry rebuilt from the FINAL modules: 58 python rows + the 2 TS bus rows.
Ten new guards this round (G-LEDGER-6/7, G-LOCKREF-1, G-LOCK-6, G-SIM-1, G-ESC-2,
G-EXT-4, G-WRITER-2, G-BASE-2, G-OWNER-1); four unproven ones (G-RES-1, G-INV-1,
G-DIG-1, G-IDEMP-2) strengthened or repointed until their mutation bites; one stale
node id (G-LEDGER-4) repointed.

```
$ CLIENT_STATE_REPO_ROOT=$PWD bash docs/pipeline/run-artifacts/client-state-gmail-v1/mutation-check.sh; echo "rc=$?"
mutation-check.sh: loaded 60 guard row(s) from GUARD_REGISTRY
...
rc=0   (every row: control_green AND mutation_applied AND diff_applied AND mutated_red)
```

- `g4/py-guards.json`: 58 rows, 58 green
- `g4/bus-guards.json`: 2 rows, 2 green

Two harness defects fixed along the way:

- **G0B2-8** — `backup="$(backup_target ...)"` ran the array appends in a SUBSHELL, so
  the `EXIT` trap had zero registered targets: an interrupted run left the tree mutated
  and then deleted the only backups. `backup_target` is now called in the parent shell
  and publishes `LAST_BACKUP`; a restore that fails KEEPS the backup dir.
- **G0A2-7** — CPython validates a `.pyc` against (source mtime in SECONDS, source size),
  and a byte-length-preserving `sed` inside one wall-clock second is invisible to that.
  `G-EXT-2` was recording `mutated_red: false` for a guard that DOES bite. The script now
  exports `PYTHONDONTWRITEBYTECODE=1` and purges `__pycache__` after each sed and restore.

A worked example of a guard that was NOT pinned before this round (G0A2-6):

```
# G-RES-1, BEFORE: the test asserted only one direction
#   assert r.slug == "example-org"
# load_closed_sets stores BOTH the full domain AND registrable_label(dom)
# (resolve_meeting.py:312-313), so domain_to_slug["example"] EXISTS and happened
# to point at example-org -- the bare-label collapse AGREED with the assertion.
$ sed -i "" "s/.get(dom)  # G-RES-1/.get(dom.split(\".\")[0])  # G-RES-1/" scripts/brain/resolve_email.py
$ python3 -m pytest .../test_full_domain_never_bare_label_collision -q
1 passed in 0.06s          <-- mutation invisible

# AFTER: both directions asserted, so a bare-label read must get one of them wrong
$ python3 -m pytest .../test_full_domain_never_bare_label_collision -q
FAILED scripts/brain/tests/test_resolve_email.py::test_full_domain_never_bare_label_collision
1 failed in 0.10s          <-- mutation bites
```

---

## 5. The three behavioural decisions that changed the code, and their proof

### (b) A dry-run row must not cancel the release (G0A2-2 / G0B2-4)

`ObservationRow` gains `simulated` + `planned_writes`. `is_terminal` and
`escalated_for` both refuse simulated rows; a LIVE run never carries forward `filed`
outcomes from one (`G-SIM-1`) while still reusing its already-PAID extraction cache.
`plan_digest_line` renders `effective_writes(row)` and tags simulated lines, so a
dry-run digest still reports what it previewed.

```
$ python3 -m pytest scripts/brain/tests/test_client_state_gmail.py -q -p no:cacheprovider -k "dry_run_then_live or escalation_row"
..                                                                       [100%]
2 passed, 22 deselected in 0.10s
```

Real dry-run ledger row from the G4 fixture generator (`g4-gen-fixture.py`):

```json
{
  "source_ref": "gmail:19a1b2c3d4e5f",
  "simulated": true,
  "writes": [],
  "planned_writes": [
    "crm:lori-bodenhamer",
    "raw/areas/clearworks/org-brain/clients/acme.md",
    "task:<new>|send the revised SOW"
  ],
  "partial": false
}
```

### (d) A lock-held halt must not falsify the success receipt (G0A2-16 / G0B2-7)

The amended goal: `run-receipt.json` byte-identical, cause in `last-lock-refusal.json`.
`record_lock_refusal` replaces `record_failure` on that ONE path.

```json
{
  "second_run_claude_calls": 0,
  "second_run_cost_delta_usd": 0.0,
  "second_run_exit_code": 0,
  "second_run_previews_count": 0,
  "second_run_rows_added": 0,
  "stale_lock_reclaimed_and_ran": true,
  "stale_then_next_acquire_wins": true,
  "third_run_exit_code": 2,
  "third_run_lock_held_processed": false,
  "third_run_lock_refusal": {
    "detail": "/private/tmp/g4fix2/_scratch/run1/state/claims",
    "error": "lock-held",
    "pid": 18326,
    "refused_at": "2026-09-15T01:57:52.801493+00:00"
  },
  "third_run_receipt_byte_identical": true
}
```

Note the deliberate ABSENCE of `second_run_receipt_unchanged`: an ordinary repeated
SUCCESSFUL run legitimately rewrites `last_success_at`/`cost_usd`, so the old checker
demanded something the system does not and should not do (G0B2-7).

### (m) A lost lease is a stop condition (G0B2-13)

`Lease.touch` records `lost` instead of swallowing the race; `run()` raises `LeaseLost`
before the next message; `release()` is a no-op once lost, so this invocation can never
release the replacement holder's lease.

```
$ python3 -m pytest scripts/brain/tests/test_client_state_gmail.py::test_lost_lease_mid_run_stops_and_never_releases_the_replacement -q
.                                                                        [100%]
1 passed in 0.03s
```

---

## 6. Write-back — making the plan mechanically true

**Labels first.** Fourteen Step-1 test/fixture blocks had no `# file:` label, so
`g0-compile.py` was silently skipping them (47 of 49 blocks before; 49 now, +2 TS test
files). `(append)` marks a delta block. Four trailing `(append)` blocks were converted
to whole-file restatements so that "last block per path" really is the final file.

**`scratchpad/plan-sync.py`** replaces each FINAL labelled block body with the tree's
current file content. It refuses two cases so it cannot corrupt the plan:

- an INTERMEDIATE whole-file block (a later block for that path is final), and
- a whole-file block whose path has a later `(append)` — writing the final file there
  would duplicate the appended text on materialisation. (This one bit: the first run
  wrote the final TS test files into Task 16's blocks, and Task 16's own Step 4 went
  red with Task 17's describes present. The rule was added, the two blocks
  reconstructed, and both tasks re-verified.)

```
$ python3 scratchpad/plan-sync.py <tree> scratchpad/plan-parts/*.md
synced 30 final block(s)
left as-is 20 block(s):
  ... 6 intermediate versions, 5 (append) deltas, 2 whose final is a later append,
  ... 1 retired path (test_client_state_gmail_task8.py)
# second run: synced 0 — idempotent
```

**Counts.** `scratchpad/verify-steps.py` materialises the plan `--through N` into a
scratch worktree and runs that task's own Step-2 and Step-4 commands. Every Step 4
returned rc 0. Restated where the plan was wrong (all three of G0A2-12's cases plus two
more that moved because tests were added this round):

| Task | Step 4 command | stated before | measured now |
|---|---|---|---|
| 8  | `pytest test_client_state_gmail_task8.py` | 6 passed (actually 1F/5P at round 2) | **6 passed** (true now the FakeRunner is fixed) |
| 11 | `pytest test_extract_email.py` | 23 passed | **24 passed** (+G-EXT-4 rebinding test) |
| 14 | `pytest test_client_state_writes.py` | 18 passed | **24 passed** (+G-OWNER-1 ×2, +G-WRITER-2 ×4) |
| 15 | `pytest test_client_state_projections.py test_client_state_gmail.py` | 21 passed | **32 passed** (8 + 24) |
| 19 | `pytest test_client_state_digest.py` | 14 passed (sandbox w/ stub + patch) | **16 passed** |
| 21 | `test-ops-shims.sh` | "ALL OPS-SHIM TESTS PASSED" | **18 PASS rows**, rc 0 |
| 22 | `pytest test_coverage_diff.py` + cron selftest | "all tests pass" | **4 passed**, rc 0 |
| 23 | guards + parity + no-network + mutation-check | 2 node ids only | **13 passed** + **60/60** rows |

Task 23's gate was widened from two node ids to the whole slice. It is the LAST task,
so every module the parity and no-network tests exercise has landed — the old narrowing
is exactly what let `test_client_state_parity.py` ship red (G0A2-4).

The S-06 header's combined figure was re-derived too:

```
$ python3 -m pytest test_client_state_writes.py test_writeback_email.py \
    test_client_state_projections.py test_client_state_gmail.py -q -p no:cacheprovider
66 passed in 0.20s
```

**Skeleton.** File map rebuilt from a real `git status --untracked-files=all` over a
full materialisation — 42 tracked paths (both previously-omitted test files added, the
retired file marked as retired) plus the 9 ops scripts under the gitignored
run-artifacts dir. Interfaces updated for every signature that changed this round; the
Global Constraints line now names the shim's three pass-through verbs.

---

## 7. The point of the round: the written-back plan reproduces the green tree

A SECOND fresh worktree was created at the same tip and materialised ONLY from the
written-back plan — nothing hand-edited, nothing copied from the worked tree.

```
$ python3 g0-compile.py <plan> <scratch>
blocks: 49 counts={py: 33, sh: 8, json: 3, ts: 2, other: 3} failures=0      rc=0

$ python3 g0-compile.py <plan> <scratch> --inject-error
injected 3 deliberate errors
FAIL json  .../fixtures/crons-2026-08-11.json: Extra data: line 13 column 1
FAIL bash -n .../test-ops-shims.sh: syntax error: unexpected end of file
FAIL py_compile scripts/brain/tests/test_observation_ledger.py: SyntaxError: invalid syntax
blocks: 49 ... failures=3                                                    # the check bites

$ git worktree add --detach scratchpad/g0-r3-fresh feat/client-state-gmail-v1-build   # 248d61de
$ python3 g0-materialise.py <plan> scratchpad/g0-r3-fresh
applied 68 blocks       (incl. T15 RETIRE scripts/brain/tests/test_client_state_gmail_task8.py)
$ python3 ts-apply.py <plan> scratchpad/g0-r3-fresh 16   # 3 PATCH
$ python3 ts-apply.py <plan> scratchpad/g0-r3-fresh 17   # 5 PATCH
```

Every file in the fresh tree is byte-identical to the worked tree:

```
$ for f in scripts/brain/client_state_gmail.py scripts/brain/tests/helpers_client_state.py \
           tests/unit/bus/task-human-type.test.ts docs/.../g4-check.sh ... ; do
    cmp -s "$f" "../g0-r3-tree/$f" || echo "DIFFERS: $f"; done
(no output)
$ ls scripts/brain/tests/test_client_state_gmail_task8.py
ls: ...: No such file or directory          # retired, as Task 15 says
```

And it is green:

| check | result |
|---|---|
| `pytest scripts/brain/tests` | **693 passed, 0 failed, 1 skipped** (the gated live-bus test) |
| `tsc --noEmit -p tsconfig.json` | **rc 0** |
| `vitest tests/unit/bus/task-human-type.test.ts` | **7 passed** |
| `vitest tests/unit/cli/bus-create-task-type.test.ts` | **6 passed** |
| `test-ops-shims.sh` | **18 PASS, rc 0** |
| `g1-count-delta.sh --selftest` | **5 OK lines, rc 0** |
| `g4-check.sh --selftest` | **8 items + 8 item-negatives + 28 field-negatives, rc 0** |
| `cron-precheck.sh --selftest` | **rc 0** |
| `mutation-check.sh` | **60/60 rows green, rc 0** |

---

## 8. Teardown

```
$ git worktree remove --force /private/tmp/claude-501/-Users-joshweiss-code-cortextos/cae12226-d674-4173-af86-d7fe5cbba2d7/scratchpad/g0-r3-tree
$ git worktree remove --force /private/tmp/claude-501/-Users-joshweiss-code-cortextos/cae12226-d674-4173-af86-d7fe5cbba2d7/scratchpad/g0-r3-verify
$ git worktree remove --force /private/tmp/claude-501/-Users-joshweiss-code-cortextos/cae12226-d674-4173-af86-d7fe5cbba2d7/scratchpad/g0-r3-fresh

$ git worktree list | grep -c g0-r3
0
0

$ git -C /Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1 status --short   # docs/ is gitignored
 M .cortextOS/state/agents/alice/crons.json
 M .cortextOS/state/agents/alice/crons.json.bak
 M .cortextOS/state/agents/bob/crons.json
 M .cortextOS/state/agents/bob/crons.json.bak
$ git -C ... status --short --untracked-files=all -- scripts src tests docs
(empty)
```

The four `.cortextOS/state/agents/*/crons.json{,.bak}` entries are PRE-EXISTING dirt
in that worktree (mtime 15:40, before this round's first write) and are untouched by
this work — the same four appear in the session-start snapshot. **None of the plan's
own paths under `scripts/`, `src/`, `tests/` or `docs/` is modified**: every code
change this round lived in the throwaway worktrees, which are now removed. The only
files this round wrote in the real worktree are the plan itself and the two G0-r3
artifacts (`docs/` is gitignored).

---

## 9. Remaining open

None. All 51 ids (20 carried from round 1 + 16 `G0A2-*` + 15 `G0B2-*`) are
`fixed-and-reverified` in `G0-r3-integration.json`, each with the change and the test
node id that pins it.
