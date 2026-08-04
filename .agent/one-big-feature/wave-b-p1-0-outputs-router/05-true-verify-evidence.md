# WAVE B P1.0 outputs-router — true-verify evidence

Run directly by the orchestrating agent (no subagent transcript required for this stage), citing
a distinct artifact from `04-review-final.md` per the ledger's dedupe-by-artifact-sha rule.

## What I re-ran myself, independently, before signing this

### 1. Full pytest suite (own run, not just trusting the review subagent)

```
$ cd orgs/clearworksai/skills/outputs-router && python3 -m pytest tests/ -v
...
tests/test_file_output.py::test_sop_md_write_success PASSED
tests/test_file_output.py::test_binary_write_creates_provenance_sidecar PASSED
tests/test_file_output.py::test_missing_client_refused PASSED
tests/test_file_output.py::test_duplicate_destination_refused PASSED
tests/test_file_output.py::test_client_traversal_payload_rejected[absolute-path] PASSED
tests/test_file_output.py::test_client_traversal_payload_rejected[dotdot-component] PASSED
tests/test_file_output.py::test_client_traversal_payload_rejected[embedded-separator] PASSED
tests/test_file_output.py::test_legit_client_slug_success PASSED
tests/test_mirror_deliverables.py::test_t1_md_with_existing_frontmatter PASSED
tests/test_mirror_deliverables.py::test_t2_md_without_frontmatter PASSED
tests/test_mirror_deliverables.py::test_t3_binary_with_provenance_sidecar PASSED
tests/test_mirror_deliverables.py::test_t4_target_exists_different_content PASSED
tests/test_mirror_deliverables.py::test_t5_idempotent_mirror PASSED
tests/test_mirror_deliverables.py::test_t6_excluded_files PASSED
tests/test_mirror_deliverables.py::test_t7_plan_fixture_tree PASSED
tests/test_mirror_deliverables.py::test_t8_tamper_detection PASSED
tests/test_mirror_deliverables.py::test_t9_unmapped_path_detection PASSED
tests/test_mirror_deliverables.py::test_t10_basename_collision PASSED
tests/test_mirror_deliverables.py::test_t11_plan_excludes_name_glob_files PASSED
============================== 19 passed in 0.05s ==============================
```

**Result: 19/19 passed, 0 failed, 0 errors, 0 skipped.** (8 new cases in `test_file_output.py`
closing the coverage gap identified by `04-review.md`; 11 pre-existing cases in
`test_mirror_deliverables.py`, unchanged, still passing.) Note: must be run with cwd =
`orgs/clearworksai/skills/outputs-router` (matches this repo's existing test-running convention
for this tool) — running from the repo root with a `tests/` path argument breaks the
`sys.path.insert(0, os.path.dirname(__file__))` import convention both test files use; this is a
pre-existing property of the test layout, not something introduced this pass.

### 2. Independent live CLI smoke test (fresh /tmp fixture, real routing, real cleanup)

Run directly against the unmodified, committed `file_output.py`, not the pytest suite, as an
extra independent confirmation beyond automated tests:

```
$ python3 file_output.py --content-type sop --source /tmp/.../smoke.md --agent larry \
    --job true-verify-smoke --source-task task_wave_b_p1_0_true_verify --date 2026-08-03
/Users/joshweiss/code/knowledge-sync/raw/resources/reference/clearworks/smoke.md
EXIT:0

$ python3 file_output.py --content-type client --source /tmp/.../smoke.md ...   # no --client
Error: --client missing when --content-type=client
EXIT:1

$ python3 file_output.py --content-type sop --source /tmp/.../smoke.md ...      # re-run, same dest
Error: Destination file '.../smoke.md' already exists
EXIT:1

$ python3 file_output.py --content-type client --source /tmp/.../smoke.md \
    --client "../../../../../../etc" ...
Error: --client cannot contain '..' path components
EXIT:1
```

All four exercises match documented behavior exactly. Cleaned up the one real file written
(`smoke.md` under `raw/resources/reference/clearworks/`) immediately after; confirmed via
`git -C ~/code/knowledge-sync status --porcelain -- raw/resources/reference/clearworks/smoke.md`
returning empty (clean) after removal.

### 3. `file_output.py` diff check

```
$ git diff --stat orgs/clearworksai/skills/outputs-router/file_output.py
(empty)
```

Zero diff — confirmed a third time (research doc, review-stage subagent, and now here). This
receipt certifies already-shipped, unmodified production code plus one new, additive test file.

## What this receipt is actually certifying

1. **Functional behavior of `file_output.py` (merged PR #187, unmodified on this branch except for
   the new test file) is real and working** — routing table, frontmatter injection, provenance
   sidecar, duplicate-destination refusal, missing-`--client` refusal, and `--client`
   path-traversal sanitization (absolute path / `..` components / embedded separator) were all
   exercised live, twice independently across this session (once in `04-review.md`'s adversarial
   pass, once again here), with identical results both times.
2. **The specific gap this pass was built to close — "unit test suite passes" was previously
   unsubstantiated for `file_output.py` — is now closed for real.** `tests/test_file_output.py`
   exists, is committed as part of this PR, covers all 6 branches from
   `03-specs/spec-01-reverify.md`, and passes 8/8 on its own, 19/19 combined with the pre-existing
   suite. This is not a rubber stamp: the review-stage subagent independently confirmed zero bugs
   were found in `file_output.py` while writing tests against it, and I independently re-ran the
   full suite myself rather than trusting that report alone.

## Known, explicitly out-of-scope follow-up (not blocking this receipt)

`get_destination_path()`'s containment backstop uses `os.path.abspath()`, not
`os.path.realpath()`, so it does not resolve symlinks before the containment check — a
`os.path.realpath()` hardening already exists, uncommitted, on a separate unmerged branch
(`p1-0-outputs-router-hardening` @ `1bf8d42`). Not exploitable today (nothing in this codebase
creates attacker-controlled symlinks inside the knowledge-sync tree) and explicitly out of scope
for this VERIFY-only pass — tracked as a distinct, separate follow-up, not silently folded in
here.

## Verdict: PASS

Real, reproduced, independently-confirmed. `file_output.py`'s functional behavior works as
claimed (live-exercised twice this session with identical results), and the one substantiated gap
from `04-review.md` (missing automated test coverage) has been closed with a genuine, hermetic,
19/19-passing test suite — not by asserting a pass without evidence.
