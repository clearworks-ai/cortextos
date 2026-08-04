# Post-rebase note: concurrent-lane collision on the same gap

`05-true-verify-evidence.md` (signed into the pipeline ledger before this rebase) is left
unmodified as an accurate historical record of the verification I actually performed at the
time: I independently found the same real gap as `04-review.md` (zero committed test coverage
for `file_output.py`), wrote and ran my own `tests/test_file_output.py` (8 cases), and got
19/19 passing combined with the pre-existing suite.

Between finishing that work and opening this PR, a **different concurrent lane** merged
**PR #252** (`test(outputs-router): add test_file_output.py coverage for file_output.py`),
closing the identical gap with an equivalent-but-more-thorough suite (14 cases, subprocess-driven,
parametrized across all 7 `--content-type` choices, `HOME` pointed at a pytest temp dir).

On rebase onto the updated `origin/main`, this branch hit an add/add conflict on
`orgs/clearworksai/skills/outputs-router/tests/test_file_output.py` (both sides added the same
new file). Resolution: **adopted PR #252's already-merged version** rather than keeping my
duplicate, to avoid two competing test files for the same target and to defer to the version
already landed on `main`. My own 8-case version is not present in the final tree; PR #252's
14-case version is.

Post-rebase, re-ran the full suite against the final merged state:

```
$ python3 -m pytest tests/ -v
...
25 passed in 0.53s
```

25/25 (14 from PR #252's `test_file_output.py` + 11 pre-existing `test_mirror_deliverables.py`),
`file_output.py` still shows zero diff. The pipeline-ledger chain for
`wave-b-p1-0-outputs-router` still verifies cleanly post-rebase
(`bin/pipeline-stage-emit --verify --slug wave-b-p1-0-outputs-router --through true-verify
--max-age 86400` exits 0) — the ledger rows are a provenance record of the verification process
performed, not a live pointer to file content, so rebasing the underlying test file onto an
already-merged equivalent does not invalidate the receipt: the substantive claim it certifies
(file_output.py works as documented; the test-coverage gap is closed) remains true, now doubly
confirmed by two independent lanes reaching the same conclusion.
