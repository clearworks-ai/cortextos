# G0a EMPIRICAL plan review — ROUND 2 (claude-opus-5)

- Plan: `docs/pipeline/plans/2026-09-14-client-state-gmail-v1-build.md`
- sha256 `06cbb519b477d296c9b8c056e355798685099b9792743b3c0565dc459838873b` — **verified** by `shasum -a 256` before any read.
- Branch tip `eb72ca79` (`feat/client-state-gmail-v1-build`).
- Round-1 inputs: `G0-review-opus-r1.json` (20 findings) + `G0b-codex-r1.json` (26 findings) = 46, all accepted; fix wave governed by `scratchpad/wave2-contract.md` (C1–C12), read in full before reviewing.
- Reviewer receipt: model requested `opus`; the reviewer cannot verify its own model id — recorded `unverified-by-reviewer`.

## Method (identical to round 1)

```
git -C /Users/joshweiss/code/cortextos worktree add --detach \
  <scratchpad>/g0a-r2-throwaway feat/client-state-gmail-v1-build      # rc 0, HEAD eb72ca79
npm ci --no-audit --no-fund                                            # rc 0, 143 packages
```

Tasks 1 → 23 applied **verbatim, in order**. Labelled `# file:` / `// file:` blocks were
materialised with the task-aware applier (`scratchpad/g0a-apply.py`, which honours
`(append)` labels); the unlabelled Step-1 test blocks were placed by hand at the path each
task's own prose names:

| Task | unlabelled block (plan line) | placed at | mode |
|---|---|---|---|
| 4 | 1632 | `scripts/brain/tests/test_gmail_source.py` | write |
| 5 | 2214 | same | append |
| 8 | 3519 | `scripts/brain/tests/test_client_state_gmail_task8.py` | write |
| 9 | 4006 | `scripts/brain/tests/test_extract_email.py` | write |
| 10 | 4535 | same | append |
| 11 | 5114 | same | append |
| 12 | 5710 | `scripts/brain/tests/test_client_state_writes.py` | write |
| 13 | 6051 | `scripts/brain/tests/test_writeback_email.py` | write |
| 14 | 6452 | `test_client_state_writes.py` | append |
| 15 | 6960 | `scripts/brain/tests/test_client_state_projections.py` | write |
| 15 | 7095 | `scripts/brain/tests/test_client_state_gmail.py` | write |

Tasks 16/17's TS blocks are exact `// OLD:` / `// NEW:` pairs; each OLD text matched the
real repo **exactly once** (`scratchpad/ts-apply.py`) — the plan's quoted OLD hunks are
accurate against `src/bus/task.ts` and `src/cli/bus.ts` at this tip.

Every Step 2 and Step 4 command was run and its real output recorded. The real worktree
was only ever READ (plan + spec + goal). Nothing reached live `gws` / `claude` — verified
under the PATH-trap shims (see "External-write boundary" below). Throwaway torn down and
`git worktree list` re-checked.

## Headline

| | |
|---|---|
| Round-1 findings re-verified fixed | 37 / 46 |
| Round-1 findings still open | 9 / 46 (G0A-1, G0A-10, G0A-16, G0B-3, G0B-9, G0B-15, G0B-17, G0B-18, G0B-24) |
| New findings (round-2) | 8 Critical, 8 Important (G0A2-1 … G0A2-16) |
| `python3 -m pytest scripts/brain/tests -q` | **8 failed, 670 passed, 1 skipped** (BASELINE 507 passed / 0 failed) |
| `npx tsc --noEmit -p tsconfig.json` | **rc 0** |
| `mutation-check.sh` (50 rows) | **rc 1** — 11 rows not fully green |
| `test-ops-shims.sh`, `g4-check.sh --selftest`, `cron-precheck.sh --selftest` | all green |

The G1 rule ("failing set ⊆ BASELINE failing set", BASELINE pytest = 507/0) therefore does
**not** hold on the plan as written.

## The one root cause behind most of the red: FakeRunner consumes its responses

C1 specifies "first matching prefix wins, **in insertion order**". Task 1 implements a
FIFO queue that **deletes** the matched entry (`del self.responses[i]`), so one
`record(prefix, …)` serves exactly one call. Three tasks then queue a single response for
a command their code calls two or three times:

* Task 8 `test_backfill_query_composes_exclusion_and_day_sweep` — one `+triage` response, `sweep` issues 1 full-window + `days` day queries → `GmailSourceError` on the 2nd day query.
* Task 15 `test_two_known_contacts_same_page_one_history_two_crm_rows` — one `add-interaction.py` response, two contacts → `WriterError` → `exit_code 3`.
* Task 19 `test_gmail_section_renders_each_change_line_type` — one `list-tasks` response, `list_open_tasks` enumerates `human` **and** `build` → `TaskEnumerationError`.

But the opposite semantics is equally required: Task 2's
`test_acquire_retries_once_on_stale_cleared_stderr_and_wins` (the C11/G0A-20 fix) needs the
first `meeting-brief-claim` response consumed so the retry gets the second. Proved both
directions empirically by deleting the `del` line:

```
as written   : 8 failed, 670 passed, 1 skipped
non-consuming: 3 failed, 642 passed, 1 skipped   (test_acquire_retries_once… now red)
```

No single semantics satisfies the current consumer set. The contract has to name one and
the tests on the other side have to be rewritten to it (queue N responses, or add an
explicit `record_once`).

## Dry-run poisons the live run

The C7 / G0A-3 / G0B-1 fix ("dry-run persists the ledger row") was applied, but
`_file_message` sets `resolution.outcome = "filed"` on the dry-run path too and appends
the row with `writes=[]`. `Ledger.is_terminal` = latest row, same digest, all outcomes
`filed` — so the row a dry-run writes marks the message permanently done.

```
DRY-RUN : exit 0 filed 1   ledger row outcomes ['filed'] writes []
LIVE-RUN: exit 0 filed 0 skipped_terminal 1
          live add-interaction calls: 0
          page written? False
```

Same mechanism silences FR-003's escalation: the dry-run row makes
`ledger.escalated_for(ref, digest)` true, so the live run never sends the Telegram.

## The G1 gate measures the wrong checkout

`g1-count-delta.sh`'s `repo_root()` falls back to a **hardcoded**
`/Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1` when
`CLIENT_STATE_REPO_ROOT` is unset. Running `capture` from the throwaway produced
`vitest 303 files / 4033 tests, pytest 507 passed / 0 failed` — byte-identical to BASELINE,
because it had silently run the suites in the *real* worktree, not the tree under test.
This is G0A-14's exact symptom relocated: C11 made `REPO_ROOT` required for
`mutation-check.sh` and left the same default in the G1 gate itself.

## Mutation matrix

`mutation-check.sh` loads 50 rows and exits 1. Four guards' named tests stay **green with
the guard mutated away** (re-confirmed by hand with `__pycache__` cleared):

| guard | mutation | named test |
|---|---|---|
| `G-RES-1` | `domain_to_slug.get(dom)` → `.get(dom.split(".")[0])` | `test_full_domain_never_bare_label_collision` → 1 passed |
| `G-INV-1` | `domain_pages.setdefault(dom, …)` → `.setdefault(dom.split(".")[0], …)` | `test_compute_invariants_does_not_confuse_different_tlds` → 1 passed |
| `G-DIG-1` | collapse condition → `if True:` | `test_gmail_section_collapses_to_one_line_when_nothing_happened` → 1 passed |
| `G-IDEMP-2` | signature check → `if False:` | `test_second_identical_dry_run_zero_new_claude_calls` → 1 passed |

`G-LEDGER-4` names `test_open_email_task_titles_parses_task_writes_entries`, which no
longer exists after C4's `open_email_tasks()` rename — `ERROR: not found … no tests ran`.

`G-EXT-2` is reported `mutated_red: false` by the harness but **does** bite when run by
hand: the mutation `"1," → "2,"` is byte-length-preserving and the whole control→mutate→run
cycle finishes inside one wall-clock second, so CPython reuses the stale `.pyc`
(validation is `(mtime_seconds, size)`). The harness needs to clear `__pycache__` (or set
`PYTHONDONTWRITEBYTECODE=1`) between arms.

Restore discipline itself is sound: after the full run `git status` showed exactly the four
allowlisted modified files and nothing else — `git checkout --` is never called (G0B-25 fixed).

## Task 8's test file is committed and goes red when Task 15 lands

Task 8 Step 5 `git add`s `scripts/brain/tests/test_client_state_gmail_task8.py`. Task 15
replaces `client_state_gmail.py` wholesale, and the plan says so ("re-running these same 6
tests against Task 15's final module is expected to diverge … NOT part of this task's
gate"). But the file stays in the tree, so the final suite carries three permanent
failures from it. This is the G0A-12 fix (split the append into its own file) trading one
defect for another.

## FR-010 allowlist

`git diff --name-only HEAD` after all 23 tasks:

```
.gitignore                          (1 added line: state/client-state/)
scripts/brain/meeting_loop_watch.py (allowlisted; 0 defs/constants removed, only added)
src/bus/task.ts                     (allowlisted)
src/cli/bus.ts                      (allowlisted)
```

Clean. 39 new files created; two of them — `test_client_state_gmail_task8.py` and
`test_client_state_projections.py` — are still missing from the plan's File map (C12).

## External-write boundary

`test_no_network.py::test_shim_positive_control` passes (traps are non-vacuous). Running
the **whole** brain suite under the three PATH-trap shims produced exactly 2 TRAP lines,
both from the pre-existing `test_run_meeting_apply.py` (`cortextos list-workers`,
`cortextos bus list-tasks --status pending`) — outside this diff. Zero traps from any
client-state test. Note that `test_no_shim_traps_during_focused_suite` asserts
`returncode == 0` *before* it reads the shim log, so the boundary proof is masked by any
unrelated failure in the focused slice (it is, today).

## Claims executed (not taken on trust)

* `EXCLUSION_QUERY` is a verbatim substring of `orgs/clearworksai/skills/comms-check-worker/SKILL.md` line 26 → True.
* `LIST_TASKS_MAX_LIMIT = 200` at `src/bus/task.ts:89` → confirmed.
* `CLAUDE_ARGV` matches `extract_meeting.py:356-371` (`--setting-sources "" --disallowedTools "*" --model sonnet --output-format json --max-turns 1`) → confirmed.
* `meeting-brief.ts:396-418` unlinks a stale lock and returns `stale-cleared` without claiming → confirmed.
* `writeback_render.render_page:133-137` refuses a duplicate `[source:]` marker → confirmed (justifies the new sibling renderer).
* `client_file_lock` exists at `orgs/clearworksai/agents/pa/scripts/meeting_writeback.py:52` → confirmed; loaded by path, read-only.
* `Task.type: 'agent' | 'human'` at `src/types/index.ts:54` → confirmed.
* Task 20's "Fireflies logic body 0 lines differ" → the statement sequence is unchanged; the only differences are the added `try/except` and the `return lines, None` shape, exactly as claimed.

## Vitest count delta (with CLIENT_STATE_REPO_ROOT set correctly)

```
vitest_files 305   (BASELINE 303, +2 = Tasks 16+17)
vitest_tests 4046  (BASELINE 4033, +13)
vitest_failing == BASELINE's 18 files, exactly
pytest 670 passed / 8 failed   (BASELINE 507 / 0)
node_rc 0
```

The vitest half of G1 is clean. The pytest half is not.

## Round-2 findings

| id | sev | one line |
|---|---|---|
| G0A2-1 | Critical | FakeRunner consumes its responses; no single semantics satisfies Tasks 2, 8, 15 and 19. |
| G0A2-2 | Critical | Dry-run rows are written with `outcome: "filed"`, so `is_terminal` makes the live run a no-op. |
| G0A2-3 | Critical | `test_client_state_gmail_task8.py` is committed and goes red when Task 15 replaces the module. |
| G0A2-4 | Critical | The parity test calls `plan_history_entry` with args in the wrong order; the digest-line fixture has no `writes`. |
| G0A2-5 | Critical | `g1-count-delta.sh` defaults to a hardcoded checkout — G1 can measure the wrong tree. |
| G0A2-6 | Critical | `G-RES-1`, `G-INV-1`, `G-DIG-1`, `G-IDEMP-2` stay green when mutated — four unproven guards. |
| G0A2-7 | Important | `mutation-check.sh` false negatives on same-size mutations (stale `__pycache__`). |
| G0A2-8 | Important | `G-LEDGER-4` names a test C4's rename deleted. |
| G0A2-9 | Important | Dry-run omits the CRM interaction argv when the sender's contact would be auto-created. |
| G0A2-10 | Important | `plan_digest_line` has no orchestrator consumer — C6's "dry-run digest preview" was not built. |
| G0A2-11 | Important | File map still omits two created test files. |
| G0A2-12 | Important | Tasks 8/15/19 still state counts a real run contradicts; Task 19's was measured against a patched FakeRunner. |
| G0A2-13 | Important | `test_no_network` asserts rc before the trap log, masking the boundary proof. |
| G0A2-14 | Important | Task 22's "no conftest" docstring — the one C2 correction not applied. |
| G0A2-15 | Critical | The shim traps `bus list-tasks`, which the amended goal requires it to pass through — every live dry-run would exit 3. |
| G0A2-16 | Critical | Lock-held writes into `run-receipt.json`; the amended G4 item 5 requires it byte-identical with the cause in `last-lock-refusal.json`. |

## Round-1 findings still open

`G0A-1`, `G0A-10`, `G0A-16`, `G0B-3`, `G0B-9`, `G0B-15`, `G0B-17`, `G0B-18`, `G0B-24` — each with
its concrete evidence in `G0-review-opus.json`. Six of the nine are downstream of `G0A2-1`:
the code the round-1 fix prescribed is present and correct, but the test that was supposed
to prove it is red, so the behaviour is unverified rather than unbuilt.

## Note: the branch was rewritten during this review

The review ran against `eb72ca79`. While it was running the branch was rebuilt to
`248d61de` — the same BASELINE commit reparented onto an amended goal commit `cc58caf4`
("amend shim read pass-through (list-tasks) + lock-held receipt semantics after G0 round
2"). `eb72ca79` is no longer an ancestor of HEAD.

The **plan file's sha256 is unchanged** (`06cbb519…`), so every empirical result above
stands. What changed is the GOAL, in two places the plan does not satisfy — filed as
`G0A2-15` (the shim must pass `bus list-tasks` through) and `G0A2-16` (a lock-held refusal
must leave `run-receipt.json` byte-identical and write `last-lock-refusal.json` instead).
`G0A2-16` in particular partially reverses round-1's `G0A-4` / `G0B-6`, which asked for the
lock-held cause to go onto the receipt; the goal amendment supersedes that, and the plan
still implements the old reading.
