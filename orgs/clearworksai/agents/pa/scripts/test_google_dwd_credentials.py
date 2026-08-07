import importlib.util
import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("google_dwd_credentials.py")
SPEC = importlib.util.spec_from_file_location("google_dwd_credentials", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class CredentialHelperTest(unittest.TestCase):
    def test_uses_valid_cache_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache.json"
            cache.write_text(json.dumps({"token": "cached-secret", "expiry": 5000}))
            cache.chmod(0o600)
            with patch.object(MODULE, "_refresh_token") as refresh:
                self.assertEqual(MODULE.get_token(cache_file=cache, now=1000), "cached-secret")
                refresh.assert_not_called()

    def test_fresh_token_cache_is_0600(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache.json"
            with patch.object(MODULE, "_refresh_token", return_value=("fresh-secret", 5000)):
                self.assertEqual(MODULE.get_token(cache_file=cache, now=1000), "fresh-secret")
            self.assertEqual(stat.S_IMODE(cache.stat().st_mode), 0o600)

    def test_frozen_subject_and_calendar_scope(self):
        self.assertEqual(MODULE.SUBJECT, "josh@clearworks.ai")
        self.assertIn("https://www.googleapis.com/auth/calendar.readonly", MODULE.SCOPES)

    def test_refuses_a_symlinked_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            victim = root / "victim.json"
            victim.write_text(json.dumps({"token": "injected", "expiry": 5000}))
            victim.chmod(0o600)
            cache = root / "cache.json"
            cache.symlink_to(victim)
            with patch.object(MODULE, "_refresh_token", return_value=("fresh-secret", 5000)):
                self.assertEqual(MODULE.get_token(cache_file=cache, now=1000), "fresh-secret")
            self.assertEqual(victim.read_text(), json.dumps({"token": "injected", "expiry": 5000}))
            self.assertFalse(cache.is_symlink())


if __name__ == "__main__":
    unittest.main()
