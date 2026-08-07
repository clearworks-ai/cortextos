# Independent Review — PR #318 (crm-emit-event-test-guard)

Reviewer: larry (independent, adversarial pass). Method: `gh pr diff 318 --repo clearworks-ai/cortextos`
read in full, plus a scratch `git worktree add /tmp/pr318-worktree crm-emit-event-test-guard` to run tests
directly (not trusting the PR description).

## 1. Guard present in all 4 functions, correct position?
Yes. Verified in the raw diff for all four files:
- `comms-backfill.py` → `emit_crm_event`
- `crm_connect_common.py` → `emit_crm_event`
- `sync-board.py` → `_emit_crm_event`
- `upsert-contact.py` → `_emit_crm_event`

In every case the new `if _in_test_mode(): return` sits immediately after the existing
`CRM_EVENT_EMIT_LOG` branch's `return` and immediately before the `try: subprocess.run(...)` block.
Order is exactly: (1) log-seam check/return → (2) test-mode check/return → (3) real subprocess call.

## 2. Guard logic identical across all 4?
Yes, byte-for-byte identical `_in_test_mode()` bodies and docstrings in all four files:
`PYTEST_CURRENT_TEST` env var set, or `"pytest"`/`"unittest"` in `sys.modules`. `import sys` was
added to `comms-backfill.py` and `crm_connect_common.py`; confirmed `sync-board.py` and
`upsert-contact.py` already had `import sys` (lines 12 and 11 respectively) before this PR, so
adding it in only 2 files is correct, not an omission.

## 3. `CRM_EVENT_EMIT_LOG` behavior unchanged?
Yes. The log branch is untouched code, still evaluated and still returns before the new guard is
ever reached — confirmed both by diff inspection and by running the PR's own
`test_log_seam_still_wins_over_guard` test, which passed.

## 4. New test file (`test_emit_test_guard.py`) run myself — proves no real subprocess call?
Ran in a fresh worktree with both `pytest` and plain `python3 -m unittest`:
- `pytest test_emit_test_guard.py -v` → 5 passed.
- `python3 -m unittest test_emit_test_guard -v` → 5 passed (proves the plain-unittest signal path
  also works, not just the pytest one).

Yes, there is a real safety net: each guarded test monkeypatches `module.subprocess.run` to a lambda
that records the call args and then redirects execution to `["true"]` instead of the real command,
and asserts the recorded-calls list is empty. So even if the guard regressed, the test itself cannot
reach the live bus — this isn't just "assert no exception," it's a genuine call-interception check.

## 5. Full existing crm suite — regressions?
Ran the entire `crm/crm` test directory in the worktree: **28 passed, 2 skipped, 0 failed** (30
collected: 9 in `test_crm_events.py` incl. 2 pre-existing skips, 9 in `test_enrich_contact.py`, 7 in
`test_interactions_to_notes.py`, 5 new in `test_emit_test_guard.py`). No failures, no regressions.

**Minor discrepancy (not a defect):** the PR description states "22 passed + 2 pre-existing skips
(24 collected) — 19 existing unaffected + 5 new." The actual pre-existing suite (excluding the new
file) is 25 tests (23 pass + 2 skip), not 24/22 — the PR undercounts the existing suite by one test.
Confirmed by counting `def test_` in each pre-existing test file independently. Functionally
irrelevant (0 failures either way) but the PR's own numbers don't match a clean re-run; worth a
one-line correction if anyone cites those figures later.

Also spot-checked `test_crm_events.py`'s own emit-behavior tests (`test_e1`/`e2`/`e7`,
`ContactCreatedEndToEndTests`) to make sure they don't accidentally depend on the new guard: they
all explicitly set `CRM_EVENT_EMIT_LOG` (including in the subprocess `env=os.environ.copy()` case
for the end-to-end child-process test), so they're protected by the pre-existing log seam
regardless of the new guard — no coupling/fragility introduced.

## 6. Scope — anything outside the claimed 4 functions + 2 imports + 1 new test file?
No. `gh pr view --json files` confirms exactly 5 files touched: the 4 emit-function files (14-15
line additions each, matching the guard function + call site) and the new
`test_emit_test_guard.py` (77 lines added). No unrelated files, no changes to
`CRM_EVENT_EMIT_LOG` semantics, no dedup/refactor beyond what was scoped.

## Residual note (not a blocker, matches approved design)
`_in_test_mode()` trusts `"unittest" in sys.modules`, which is stdlib and could theoretically be
imported transitively by some unrelated production dependency, silently suppressing a real emit in
prod. This is the exact behavior Josh's spec asked for (not a deviation introduced by the
implementer), so it's not being scored down — flagging only as a known, accepted tradeoff for
future readers.

## Score: 5/5

Diff matches the spec exactly in placement, logic, and consistency across all 4 call sites; the
`CRM_EVENT_EMIT_LOG` seam is provably unchanged; the new test file was independently run (both
pytest and plain unittest) and genuinely intercepts `subprocess.run` rather than merely hoping the
guard fires; the full existing suite passes with zero regressions; scope is exactly as claimed. The
only issue found is a cosmetic test-count discrepancy in the PR body (24 vs. actual 25 pre-existing
tests) with no effect on correctness.
