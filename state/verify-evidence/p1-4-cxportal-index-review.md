# P1.4 cxportal-index Adversarial Review — parent-cache bug fix (0940f68)

**VERDICT**: PASS

## Deviations Summary
None found. Commit message claims match verified behavior exactly: guard change is correct, scope is exactly the 2 claimed files, all 20 tests pass, and an independently-written smoke test (not part of the repo) confirms interviews/surveys pull non-zero records for 2 fake orgs post-fix.

## Step-by-Step Verification

### Step 0 - Branch / HEAD
**Command**: `cd /Users/joshweiss/code/cortextos && git log --oneline -3 feature/p1-4-cxportal-index`
**Output**:
```
0940f68 P1.4 cxportal-index: fix parent-cache bug causing interviews/surveys to always return 0 records
37d687f P1.4 cxportal-index: pull_cxportal.py + tests + SKILL.md + cron entry
35d21b3 Merge branch 'feature/p1-3-org-brain-foldin' into feature/p1-4-cxportal-import
```

**Command**: `git rev-parse HEAD && git branch --show-current`
**Output**:
```
0940f680865dced9d9d3b345ae24cba7a3fdc2d2
feature/p1-4-cxportal-index
```

**Verdict**: PASS - HEAD matches the commit under review, correct branch.

---

### Step 1 - pull_cxportal.py diff + ENTITIES blast-radius check
**Command**: `git show 0940f68 -- orgs/clearworksai/skills/cxportal-import/pull_cxportal.py`
**Output** (diff body):
```diff
                 if entity_config.get("parent"):
                     # Handle parent-dependent entities
                     parent_entity = entity_config["parent"]
-                    if parent_entity not in org_status:
+                    cache_key = f"{org_id}:{parent_entity}"
+                    if cache_key not in parent_cache:
                         # Need to pull parent first
                         parent_config = ENTITIES[parent_entity]
                         parent_records = call_mcp_tool(
@@ -345,11 +346,9 @@ def run_pull(
                         }
 
                         # Store parent records for child processing
-                        cache_key = f"{org_id}:{parent_entity}"
                         parent_cache[cache_key] = parent_records
 
                     # Process child entity from parent data
-                    cache_key = f"{org_id}:{parent_entity}"
                     parent_data = parent_cache.get(cache_key, {})
```

**Command**: `grep -n '"parent"' pull_cxportal.py` and manual read of ENTITIES dict (lines 28-53):
**Output**: Only two entities carry a `"parent"` key: `interviews` (line 39-43, `"parent": "engagements"`) and `surveys` (line 44-48, `"parent": "engagements"`). All other 7 enabled/disabled entities (`pain-points`, `goals`, `recommendations`, `business-reviews`, `assessments`, `engagements` itself, `systems-inventory`, plus disabled `desires`/`budget-signals`/`wins`) go through the unrelated "Standard entity pull" branch (line 438-442) and are untouched by this diff.

Read of run_pull() (lines 290-506) also confirms: the standalone `engagements` entity (no `"parent"` key) runs through the "Standard entity pull" branch and writes `org_status["engagements"]` but never touches `parent_cache`. Under the OLD guard (`if parent_entity not in org_status`), once standalone `engagements` ran (it appears earlier in ENTITIES dict order, line 38 vs 39/44), the guard for `interviews`/`surveys` was already false (org_status already had "engagements" key) — skipping the fetch-and-cache block entirely and falling through to `parent_cache.get(cache_key, {})` which returns `{}` since parent_cache was never populated. This exactly matches the described bug mechanism. The NEW guard checks `parent_cache` directly, which is independent of `org_status` and only gets populated by the parent-fetch block itself — closing the gap.

**Verdict**: PASS - Guard change is real, matches the described bug/fix exactly, and blast radius is correctly scoped to only `interviews`/`surveys` (the only two entities with a `"parent"` key).

---

### Step 2 - test_pull_cxportal.py diff (new regression test)
**Command**: `git show 0940f68 -- orgs/clearworksai/skills/cxportal-import/tests/test_pull_cxportal.py`
**Output**: Adds `test_parent_child_entity_chain_pulls_records` inside `TestIntegration`. It patches `pull_cxportal.get_token`, `pull_cxportal.list_organizations`, `pull_cxportal.call_mcp_tool`, then calls `run_pull()` directly (not a mock of run_pull itself — genuine end-to-end call through the real function body), and asserts:
- `result["green"]` is True
- `result["files_created"] == 9`
- `alloi_status["interviews"]["records"] > 0`
- `alloi_status["surveys"]["records"] > 0`
- interviews.md / surveys.md files actually exist on disk and contain the mocked record titles

This is a real end-to-end exercise of `run_pull()`, not a shallow/mocked-out unit test.

**Independent proof the test would have failed under the old guard**: I temporarily reverted the guard in the working tree (`cp pull_cxportal.py /tmp/pull_cxportal_fixed_backup.py`, patched `if cache_key not in parent_cache:` back to `if parent_entity not in org_status:`, ran just the new test, then restored the original file from the backup):
```
FAILED tests/test_pull_cxportal.py::TestIntegration::test_parent_child_entity_chain_pulls_records
AssertionError: 0 not greater than 0 : Interviews should have records
```
Confirmed via `git diff --stat -- orgs/clearworksai/skills/cxportal-import/pull_cxportal.py` (empty output) that the working tree was cleanly restored to the committed fixed version after this experiment, and the full suite re-passed 20/20 afterward.

**Verdict**: PASS - Test is a genuine end-to-end regression test, proven to fail under the pre-fix guard and pass under the post-fix guard.

---

### Step 3 - Full test suite
**Command**: `cd orgs/clearworksai/skills/cxportal-import && python3 -m pytest tests/ -v`
**Output**:
```
collected 20 items

tests/test_pull_cxportal.py::TestMCPParsing::test_double_encoded_content PASSED [  5%]
tests/test_pull_cxportal.py::TestMCPParsing::test_iserror_result PASSED  [ 10%]
tests/test_pull_cxportal.py::TestMCPParsing::test_jsonrpc_error PASSED   [ 15%]
tests/test_pull_cxportal.py::TestMCPParsing::test_plain_json_response PASSED [ 20%]
tests/test_pull_cxportal.py::TestMCPParsing::test_sse_framed_response PASSED [ 25%]
tests/test_pull_cxportal.py::TestRendering::test_deterministic_rendering PASSED [ 30%]
tests/test_pull_cxportal.py::TestRendering::test_render_entity_file_empty PASSED [ 35%]
tests/test_pull_cxportal.py::TestRendering::test_render_entity_file_with_records PASSED [ 40%]
tests/test_pull_cxportal.py::TestRendering::test_section_title_fallback PASSED [ 45%]
tests/test_pull_cxportal.py::TestRendering::test_write_if_changed_changed PASSED [ 50%]
tests/test_pull_cxportal.py::TestRendering::test_write_if_changed_date_masking PASSED [ 55%]
tests/test_pull_cxportal.py::TestRendering::test_write_if_changed_new_file PASSED [ 60%]
tests/test_pull_cxportal.py::TestRendering::test_write_if_changed_unchanged PASSED [ 65%]
tests/test_pull_cxportal.py::TestEntities::test_entities_config PASSED   [ 70%]
tests/test_pull_cxportal.py::TestEntities::test_entity_tool_names PASSED [ 75%]
tests/test_pull_cxportal.py::TestIntegration::test_disabled_entity_not_called PASSED [ 80%]
tests/test_pull_cxportal.py::TestIntegration::test_parent_child_entity_chain_pulls_records PASSED [ 85%]
tests/test_pull_cxportal.py::TestErrorHandling::test_empty_result_set PASSED [ 90%]
tests/test_pull_cxportal.py::TestErrorHandling::test_nested_json_field_rendering PASSED [ 95%]
tests/test_pull_cxportal.py::TestErrorHandling::test_org_exclusion_handling PASSED [100%]

============================== 20 passed in 0.05s ==============================
```

**Verdict**: PASS - 20/20 tests pass, matches commit message claim exactly.

---

### Step 4 - Independent smoke test (2 fake orgs, own script, not part of repo)
Wrote `/tmp/my_independent_smoke_test.py` (separate from the repo's test suite) that imports `pull_cxportal`, monkeypatches `get_token`/`list_organizations`/`call_mcp_tool` with 2 fake orgs (`org-fake-1`→`fakeorg1`, `org-fake-2`→`fakeorg2`), each with 2 fake engagements, and calls `run_pull()` directly.

**Command**: `python3 /tmp/my_independent_smoke_test.py`
**Output** (key lines from full JSON result + summary):
```
"fakeorg1": { ... "engagements": {"records": 2, "status": "updated"}, "interviews": {"records": 2, "status": "created"}, "surveys": {"records": 2, "status": "created"}, ... }
"fakeorg2": { ... "engagements": {"records": 2, "status": "updated"}, "interviews": {"records": 2, "status": "created"}, "surveys": {"records": 2, "status": "created"}, ... }
"green": true, "files_created": 18, "tool_errors": [], "unmapped_orgs": []

fakeorg1: interviews=2 surveys=2
fakeorg2: interviews=2 surveys=2
SMOKE TEST PASSED: interviews and surveys > 0 records for both fake orgs
```

**Verdict**: PASS - Independently-authored smoke test confirms non-zero interviews/surveys record counts for both fake orgs, matching the expected fix behavior (2 records each, one per fake engagement, correctly aggregated).

---

### Step 5 - Commit scope
**Command**: `git show --stat 0940f68`
**Output**:
```
 .../skills/cxportal-import/pull_cxportal.py        |  5 +-
 .../cxportal-import/tests/test_pull_cxportal.py    | 70 ++++++++++++++++++++++
 2 files changed, 72 insertions(+), 3 deletions(-)
```

**Verdict**: PASS - Exactly the 2 expected files, no scope bleed (5 line diff in pull_cxportal.py matches the guard/cache_key relocation, 70 lines added in the test file matches the new regression test).

---

## Final Assessment

All core requirements verified directly, not taken on faith:
- Guard change confirmed real and correctly scoped: only `interviews`/`surveys` carry `"parent": "engagements"` in ENTITIES; the fix decouples the parent-cache check from `org_status`, which is exactly the reported bug mechanism (standalone `engagements` entity setting `org_status["engagements"]` without touching `parent_cache`, since it runs first in dict order and takes the unrelated "Standard entity pull" branch).
- New regression test is a genuine end-to-end `run_pull()` call (not a shallow mock), and I independently proved it fails under the old guard (`AssertionError: 0 not greater than 0`) and passes under the new guard, then restored the file to its committed state.
- Full suite: 20/20 passed, matching the commit message.
- My own independent smoke test (2 fake orgs, 2 fake engagements each, own mock data distinct from the repo's fixtures) confirms interviews=2/surveys=2 records for both orgs post-fix — non-zero as required.
- Commit scope is exactly `pull_cxportal.py` + `tests/test_pull_cxportal.py`, no scope bleed.

**BUILD: PASS** - Fix is correct, tested, and scoped cleanly.
