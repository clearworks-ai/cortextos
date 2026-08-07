# Spec 01 — Guard crm event emit in test mode

## Objective
Add an automatic test-mode guard so that exercising any crm event-emit code path under a test runner
never shells out to the real `cortextos bus send-message crm …` subprocess — with zero required edits to
existing test files, and zero change to production emit behavior or the existing `CRM_EVENT_EMIT_LOG` seam.

## Chosen approach: INLINE guard in all 4 implementations (see 02-master-plan.md for the vs-shared-helper justification)

Add a module-local `_in_test_mode()` predicate and one early-return line to each of the 4 emit functions.
Precedence inside each function stays: (1) `CRM_EVENT_EMIT_LOG` set → append to file, return (UNCHANGED);
(2) else if `_in_test_mode()` → return (NEW no-op); (3) else → real `subprocess.run` (UNCHANGED).

### Guard predicate (identical text in each file)
```python
def _in_test_mode() -> bool:
    """True when running under pytest or a plain unittest run, so emits stay off the live bus.
    PYTEST_CURRENT_TEST is set by pytest and inherited by subprocess children via os.environ.copy();
    the sys.modules checks cover in-process plain-unittest runs. Belt-and-suspenders: the explicit
    CRM_EVENT_EMIT_LOG seam still takes precedence when a test wants to assert emit content."""
    import sys
    return (
        os.environ.get("PYTEST_CURRENT_TEST") is not None
        or "pytest" in sys.modules
        or "unittest" in sys.modules
    )
```
(Use `import sys` at the TOP of each file where missing rather than the inline `import sys` shown above —
see per-file steps. The inline import is a fallback only if a top-level add is undesirable; prefer top-level.)

### Guard insertion inside each emit function
Insert immediately AFTER the existing `CRM_EVENT_EMIT_LOG` block's `return`, BEFORE the `try:`/`subprocess.run`:
```python
    if _in_test_mode():
        return
```

## Owned files (exact targets — verify line numbers before editing; they were accurate this session)

1. **`orgs/clearworksai/agents/crm/crm/upsert-contact.py`**
   - `import sys` already present (line 11). No new import.
   - Add `_in_test_mode()` above `_emit_crm_event` (which starts at line 241).
   - Inside `_emit_crm_event`, after the `CRM_EVENT_EMIT_LOG` block returns (~line 252) and before `try:`
     (~line 253), insert `if _in_test_mode(): return`.

2. **`orgs/clearworksai/agents/crm/crm/sync-board.py`**
   - `import sys` already present (line 12). No new import.
   - Add `_in_test_mode()` above `_emit_crm_event` (starts line 191).
   - Insert the guard after the log-block return (~line 202) and before `try:` (~line 203).

3. **`orgs/clearworksai/agents/crm/crm/crm_connect_common.py`**
   - `sys` NOT imported. ADD `import sys` to the top import block (near line 6–8, alongside `import os`).
   - Add `_in_test_mode()` above `emit_crm_event` (starts line 494).
   - Insert the guard after the log-block return (~line 511) and before `try:` (~line 512).

4. **`orgs/clearworksai/agents/crm/crm/comms-backfill.py`**
   - `sys` NOT imported (line 7 is `import json, os, re, subprocess`). ADD `sys` → `import json, os, re, subprocess, sys`.
   - Add `_in_test_mode()` above `emit_crm_event` (starts line 72).
   - Insert the guard after the log-block return (~line 83) and before `try:` (~line 84).

> To avoid 4 divergent copies of the predicate drifting: keep the predicate body byte-identical across all
> 4 files (the regression test enforces behavioral equivalence). Do NOT introduce a new shared import path.

## Implementation steps (order)
1. `upsert-contact.py`: add `_in_test_mode()`, add guard line in `_emit_crm_event`.
2. `sync-board.py`: same.
3. `crm_connect_common.py`: add `import sys`, add `_in_test_mode()`, add guard line in `emit_crm_event`.
4. `comms-backfill.py`: add `sys` to the combined import, add `_in_test_mode()`, add guard line in `emit_crm_event`.
5. Add the regression test (below).
6. Run the full crm test suite under pytest; confirm 19 existing + new test pass.

## Test strategy
Existing tests MUST still pass unchanged (19/19). The `CRM_EVENT_EMIT_LOG` assertions are unaffected
because that branch returns before the new guard is reached.

Add ONE new test file: `orgs/clearworksai/agents/crm/crm/test_emit_test_guard.py`. It must prove the guard
actually prevents a real subprocess from firing under pytest, for each of the 4 implementations, with
`CRM_EVENT_EMIT_LOG` unset. Approach — monkeypatch `subprocess.run` on the loaded module and assert it is
never called:

```python
import importlib.util, os, unittest
from pathlib import Path
CRM_DIR = Path(__file__).resolve().parent

def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, CRM_DIR / filename)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

class EmitGuardTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("CRM_EVENT_EMIT_LOG", None)  # force the non-log path

    def _assert_no_real_bus(self, module, call):
        calls = []
        orig = module.subprocess.run
        module.subprocess.run = lambda *a, **k: calls.append(a) or orig(["true"])  # never reach real bus
        try:
            call(module)
        finally:
            module.subprocess.run = orig
        # Under pytest PYTEST_CURRENT_TEST is set → guard returns before subprocess.run
        self.assertEqual(calls, [], "emit must not invoke subprocess.run under test mode")

    def test_upsert_contact_guarded(self):
        m = _load("upsert_contact_guard", "upsert-contact.py")
        self._assert_no_real_bus(m, lambda mm: mm._emit_crm_event("crm.contact.created", "{}"))

    def test_sync_board_guarded(self):
        m = _load("sync_board_guard", "sync-board.py")
        self._assert_no_real_bus(m, lambda mm: mm._emit_crm_event("crm.deal.stage_changed", "{}"))

    def test_crm_connect_common_guarded(self):
        m = _load("crm_connect_common_guard", "crm_connect_common.py")
        self._assert_no_real_bus(m, lambda mm: mm.emit_crm_event("crm.deal.created", "{}"))

    def test_comms_backfill_guarded(self):
        m = _load("comms_backfill_guard", "comms-backfill.py")
        self._assert_no_real_bus(m, lambda mm: mm.emit_crm_event("crm.email.captured", "{}"))

    def test_log_seam_still_wins_over_guard(self):
        # With the seam set, emit still records to the log (guard must not swallow it).
        import tempfile, json
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "events.log"
            os.environ["CRM_EVENT_EMIT_LOG"] = str(log)
            try:
                m = _load("crm_connect_common_seam", "crm_connect_common.py")
                m.emit_crm_event("crm.deal.created", json.dumps({"x": 1}))
                self.assertTrue(log.exists() and "crm.deal.created" in log.read_text())
            finally:
                os.environ.pop("CRM_EVENT_EMIT_LOG", None)

if __name__ == "__main__":
    unittest.main()
```

Notes for the implementer:
- The monkeypatch replaces `module.subprocess.run` and, if reached, redirects to a harmless `["true"]`
  BEFORE asserting `calls == []` — so even a guard regression cannot hit the real bus during THIS test.
- These assertions rely on the fact that pytest sets `PYTEST_CURRENT_TEST`, so the guard's first clause
  fires. That is the reproduced-flood runner, so it is the correct thing to lock down.
- Keep this test file `unittest`-based to match the existing suite's style and `unittest.main()` footer.

## Validation requirements
1. `cd orgs/clearworksai/agents/crm/crm && python3 -m pytest test_crm_events.py test_sync_board.py \
   test_reconcile_intake.py test_upsert_contact.py test_emit_test_guard.py -q` → all pass
   (19 existing + 5 new = 24).
2. Manually confirm (review) that with NEITHER `PYTEST_CURRENT_TEST` nor a framework module loaded NOR
   `CRM_EVENT_EMIT_LOG`, control reaches the real `subprocess.run` (production path unchanged) — this is
   by construction: the guard only adds an early return gated on test signals.
3. Diff review: exactly 4 emit functions changed + 2 import-line additions + 1 new test file. No other files.

## Rollout risk: VERY LOW
- No production behavior change (guard only short-circuits under test signals).
- No schema/migration/daemon/multi-repo impact.
- Fully additive; revert = drop the 4 guard lines + 2 imports + test file.

## Non-goals
- De-duplicating the 4 emit copies into one shared function (separate refactor if ever wanted).
- Changing `CRM_EVENT_EMIT_LOG` semantics.
- Changing what real production emits do.
- Editing existing test files to add env vars.
- Closing the theoretical plain-unittest-subprocess-of-upsert-contact edge with new infra (no such
  emitting test exists; documented in 01/02 as a known narrow gap).
