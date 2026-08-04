"""Regression test for the crm event-emit test-mode guard (crm-emit-event-test-guard).

Proves each of the 4 emit implementations does NOT shell out to the real
`cortextos bus send-message crm ...` subprocess when run under a test runner with
CRM_EVENT_EMIT_LOG unset — so no test suite can flood crm's live bus inbox. The
CRM_EVENT_EMIT_LOG log seam still takes precedence (last test).
"""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

CRM_DIR = Path(__file__).resolve().parent


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, CRM_DIR / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class EmitGuardTests(unittest.TestCase):
    def setUp(self):
        # Force the non-log path so the guard (not the log seam) is what suppresses the emit.
        self._saved = os.environ.pop("CRM_EVENT_EMIT_LOG", None)

    def tearDown(self):
        if self._saved is not None:
            os.environ["CRM_EVENT_EMIT_LOG"] = self._saved

    def _assert_no_real_bus(self, module, call):
        calls = []
        orig = module.subprocess.run
        # If the guard regressed and subprocess.run were reached, redirect to a harmless
        # ["true"] so even a failure can't hit the real bus during this test.
        module.subprocess.run = lambda *a, **k: calls.append(a) or orig(["true"])
        try:
            call(module)
        finally:
            module.subprocess.run = orig
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
        # With the seam set, emit still records to the log (the guard must not swallow it).
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "events.log"
            os.environ["CRM_EVENT_EMIT_LOG"] = str(log)
            try:
                m = _load("crm_connect_common_seam", "crm_connect_common.py")
                m.emit_crm_event("crm.deal.created", json.dumps({"x": 1}))
                self.assertTrue(log.exists())
                self.assertIn("crm.deal.created", log.read_text(encoding="utf-8"))
            finally:
                os.environ.pop("CRM_EVENT_EMIT_LOG", None)


if __name__ == "__main__":
    unittest.main()
