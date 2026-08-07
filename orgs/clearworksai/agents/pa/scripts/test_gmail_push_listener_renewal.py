import importlib.util
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("gmail_push_listener.py")
SPEC = importlib.util.spec_from_file_location("gmail_push_listener", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class ProviderRenewalTest(unittest.TestCase):
    def test_is_inert_without_an_explicit_approval_reference(self):
        state = {}
        with patch.dict(os.environ, {}, clear=True), patch.object(MODULE.subprocess, "run") as run:
            MODULE.renew_provider_leases(state, 1000)
        run.assert_not_called()
        self.assertEqual(state, {})

    def test_runs_both_due_renewals_without_logging_provider_output(self):
        state = {}
        approval = "approval-google-shadow-42"
        completed = SimpleNamespace(returncode=0, stdout="secret-output", stderr="secret-error")
        with patch.dict(os.environ, {"GOOGLE_PROVIDER_RENEWAL_APPROVAL": approval}, clear=True), \
             patch.object(MODULE.subprocess, "run", return_value=completed) as run:
            MODULE.renew_provider_leases(state, 1000)
        self.assertEqual(run.call_count, 2)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands[0][-5:], ["gmail", "renew", "--apply", "--approval", approval])
        self.assertEqual(commands[1][-5:], ["calendar", "renew", "--apply", "--approval", approval])
        self.assertEqual(state["provider_renewal_last_attempt"], 1000)
        self.assertEqual(state["provider_renewal_last_success"], 1000)

    def test_retries_a_failed_check_after_bounded_backoff(self):
        state = {}
        approval = "approval-google-shadow-42"
        failed = SimpleNamespace(returncode=1, stdout="secret-output", stderr="secret-error")
        with patch.dict(os.environ, {"GOOGLE_PROVIDER_RENEWAL_APPROVAL": approval}, clear=True), \
             patch.object(MODULE.subprocess, "run", return_value=failed) as run:
            MODULE.renew_provider_leases(state, 1000)
            MODULE.renew_provider_leases(state, 1000 + MODULE.WATCH_RETRY_SECS - 1)
            MODULE.renew_provider_leases(state, 1000 + MODULE.WATCH_RETRY_SECS)
        self.assertEqual(run.call_count, 2)
        self.assertNotIn("provider_renewal_last_success", state)


if __name__ == "__main__":
    unittest.main()
