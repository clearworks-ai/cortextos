#!/usr/bin/env python3
"""Unit tests for zoom_meeting.create_zoom_meeting (Lane A).

No live Zoom creds required for the default suite — the Zoom OAuth + meeting-create
HTTP calls are mocked. One extra live success test is gated behind ZOOM_LIVE_TEST=1 so
the committed suite never creates real (billable, hard-to-delete) meetings on every run.
Run the live one manually with real S2S creds sourced from secrets.env.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

# Load the sibling module by path (pa/scripts isn't a package).
_MOD_PATH = Path(__file__).resolve().parent / "zoom_meeting.py"
_spec = importlib.util.spec_from_file_location("zoom_meeting", _MOD_PATH)
zoom_meeting = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(zoom_meeting)

create_zoom_meeting = zoom_meeting.create_zoom_meeting
ZoomMeetingCreateError = zoom_meeting.ZoomMeetingCreateError

_FAKE_ENV = {
    "ZOOM_ACCOUNT_ID": "acct-123",
    "ZOOM_CLIENT_ID": "cid-123",
    "ZOOM_CLIENT_SECRET": "sec-123",
}


class _FakeResp:
    """Minimal context-manager stand-in for urlopen's return (json.load reads .read())."""

    def __init__(self, payload: dict):
        self._buf = io.BytesIO(json.dumps(payload).encode("utf-8"))

    def read(self, *a):
        return self._buf.read(*a)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _http_error(status: int, body: dict) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url="https://api.zoom.us/v2/users/x/meetings",
        code=status,
        msg="scope denied",
        hdrs=None,
        fp=io.BytesIO(json.dumps(body).encode("utf-8")),
    )


class TestCreateZoomMeeting(unittest.TestCase):
    def setUp(self):
        self._env = patch.dict(os.environ, _FAKE_ENV, clear=False)
        self._env.start()

    def tearDown(self):
        self._env.stop()

    def test_success_parses_join_url_meeting_id_password(self):
        token_resp = _FakeResp({"access_token": "tok-abc"})
        meeting_resp = _FakeResp(
            {
                "id": 86797832271,
                "join_url": "https://us06web.zoom.us/j/86797832271?pwd=abc",
                "password": "s3cret",
                "topic": "Intro call",
            }
        )
        # First urlopen = token, second = meeting create.
        with patch.object(zoom_meeting.urllib.request, "urlopen", side_effect=[token_resp, meeting_resp]):
            out = create_zoom_meeting("Intro call", "2026-08-10T15:00:00Z", 30, "josh@clearworks.ai")
        self.assertEqual(out["join_url"], "https://us06web.zoom.us/j/86797832271?pwd=abc")
        self.assertEqual(out["meeting_id"], "86797832271")  # stringified
        self.assertEqual(out["password"], "s3cret")

    def test_missing_password_returns_empty_string_not_none(self):
        token_resp = _FakeResp({"access_token": "tok-abc"})
        meeting_resp = _FakeResp(
            {"id": 5, "join_url": "https://us06web.zoom.us/j/5"}  # no password field
        )
        with patch.object(zoom_meeting.urllib.request, "urlopen", side_effect=[token_resp, meeting_resp]):
            out = create_zoom_meeting("t", "2026-08-10T15:00:00Z", 15, "h@x.com")
        self.assertEqual(out["password"], "")
        self.assertEqual(out["join_url"], "https://us06web.zoom.us/j/5")

    def test_401_scope_denied_raises_loud_error_not_none(self):
        token_resp = _FakeResp({"access_token": "tok-abc"})
        err = _http_error(401, {"code": 124, "message": "Invalid access token"})
        with patch.object(zoom_meeting.urllib.request, "urlopen", side_effect=[token_resp, err]):
            with self.assertRaises(ZoomMeetingCreateError) as ctx:
                create_zoom_meeting("t", "2026-08-10T15:00:00Z", 30, "h@x.com")
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(ctx.exception.code, 124)
        self.assertIn("Invalid access token", str(ctx.exception))

    def test_403_scope_denied_preserves_zoom_code_message(self):
        token_resp = _FakeResp({"access_token": "tok-abc"})
        err = _http_error(
            403,
            {"code": 4711, "message": "does not contain scopes:[meeting:write:meeting:admin]"},
        )
        with patch.object(zoom_meeting.urllib.request, "urlopen", side_effect=[token_resp, err]):
            with self.assertRaises(ZoomMeetingCreateError) as ctx:
                create_zoom_meeting("t", "2026-08-10T15:00:00Z", 30, "h@x.com")
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, 4711)
        self.assertIn("meeting:write", str(ctx.exception))

    def test_2xx_without_join_url_is_a_loud_failure(self):
        token_resp = _FakeResp({"access_token": "tok-abc"})
        meeting_resp = _FakeResp({"id": 9, "password": "x"})  # no join_url
        with patch.object(zoom_meeting.urllib.request, "urlopen", side_effect=[token_resp, meeting_resp]):
            with self.assertRaises(ZoomMeetingCreateError) as ctx:
                create_zoom_meeting("t", "2026-08-10T15:00:00Z", 30, "h@x.com")
        self.assertEqual(ctx.exception.code, "no_join_url")

    def test_missing_credentials_raises_config_error(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ZoomMeetingCreateError) as ctx:
                create_zoom_meeting("t", "2026-08-10T15:00:00Z", 30, "h@x.com")
        self.assertEqual(ctx.exception.code, "config")


@unittest.skipUnless(
    os.environ.get("ZOOM_LIVE_TEST") == "1",
    "live Zoom test disabled (set ZOOM_LIVE_TEST=1 with real S2S creds to run)",
)
class TestCreateZoomMeetingLive(unittest.TestCase):
    """Real end-to-end call against the Zoom account. Opt-in only — creates a real
    meeting. Best-effort teardown (delete needs meeting:delete scope; logs the id if
    it can't delete so it can be cleaned up manually)."""

    def test_live_create_returns_real_join_url(self):
        out = create_zoom_meeting(
            "codexer lane-a live test — DELETE ME",
            "2026-08-10T15:00:00Z",
            30,
            os.environ.get("ZOOM_TEST_HOST", "josh@clearworks.ai"),
        )
        try:
            self.assertTrue(out["join_url"].startswith("https://"))
            self.assertTrue(out["meeting_id"])
        finally:
            try:
                zoom_meeting.delete_zoom_meeting(out["meeting_id"])
            except ZoomMeetingCreateError as e:
                print(f"\n[live-test] could not delete meeting {out['meeting_id']} "
                      f"(scope: {e.code}); clean up manually")


if __name__ == "__main__":
    unittest.main()
