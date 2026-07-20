from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import delta_check as MODULE
from scripts import pulse_registry


class DeltaCheckTests(unittest.TestCase):
    def load_fixture_bytes(self, name: str) -> bytes:
        return (FIXTURES / name).read_bytes()

    def make_registry(self) -> dict:
        registry = pulse_registry.new_registry(
            "nonprofit",
            "Nonprofit",
            "Tracks nonprofit operating, funding, and regulatory signals.",
        )
        pulse_registry.add_source(
            registry,
            source_name="Ops Feed",
            url="https://example.com/podcast",
            feed_url="https://example.com/podcast/feed.xml",
            source_type="podcast",
            tags={
                "topic": ["operations"],
                "signal": ["leading"],
                "authority": "industry_expert",
                "cadence": "weekly",
                "quality": "high",
            },
        )
        return registry

    def save_registry(self, registry: dict, tmp: str) -> None:
        with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
            pulse_registry.save_registry(registry)

    def test_poll_source_304_path_bumps_last_checked_and_skips_parse(self) -> None:
        source = self.make_registry()["sources"][0]
        source["etag"] = "etag-1"
        source["last_modified"] = "Mon, 13 Jul 2026 00:00:00 GMT"
        source["consecutive_errors"] = 4

        def fake_fetch(url: str, etag: str | None, last_modified: str | None, timeout: int = 30):
            self.assertEqual(url, "https://example.com/podcast/feed.xml")
            self.assertEqual(etag, "etag-1")
            self.assertEqual(last_modified, "Mon, 13 Jul 2026 00:00:00 GMT")
            return 304, b"", etag, last_modified

        with unittest.mock.patch.object(MODULE, "parse_entries") as mocked_parse:
            result = MODULE.poll_source(source, fetch=fake_fetch)

        mocked_parse.assert_not_called()
        self.assertEqual(result["status"], "not_modified")
        self.assertEqual(result["new_items"], [])
        self.assertEqual(source["consecutive_errors"], 0)
        self.assertTrue(source["last_checked"])

    def test_poll_vertical_records_new_guid_delta_from_plus_one_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            baseline = MODULE.parse_entries(self.load_fixture_bytes("podcast_feed.xml"))
            source = registry["sources"][0]
            source["last_seen_guid"] = baseline[0]["guid"]
            source["last_seen_pubdate"] = baseline[0]["pubdate"]
            self.save_registry(registry, tmp)

            def fake_fetch(*_: object, **__: object):
                return 200, self.load_fixture_bytes("podcast_feed_plus_one.xml"), "etag-2", "Tue, 14 Jul 2026 00:00:00 GMT"

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                summary = MODULE.poll_vertical("nonprofit", fetch=fake_fetch)
                saved = pulse_registry.load_registry("nonprofit")

            self.assertEqual(summary["sources_changed"], 1)
            self.assertEqual(summary["new_deltas"], 1)
            self.assertEqual(saved["deltas"][0]["guid"], "episode-4")
            self.assertEqual(saved["deltas"][0]["title"], "Episode 4: Grants Acceleration")
            self.assertEqual(saved["deltas"][0]["url"], "https://example.com/podcast/ep-4")
            self.assertEqual(saved["deltas"][0]["pubdate"], "2026-07-14T00:00:00Z")

    def test_run_summary_new_items_carries_item_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            baseline = MODULE.parse_entries(self.load_fixture_bytes("podcast_feed.xml"))
            source = registry["sources"][0]
            source["last_seen_guid"] = baseline[0]["guid"]
            source["last_seen_pubdate"] = baseline[0]["pubdate"]
            self.save_registry(registry, tmp)

            def fake_fetch(*_: object, **__: object):
                return 200, self.load_fixture_bytes("podcast_feed_plus_one.xml"), None, None

            original_poll_vertical = MODULE.poll_vertical

            def patched_poll_vertical(vertical: str, dry_run: bool = False):
                return original_poll_vertical(vertical, dry_run=dry_run, fetch=fake_fetch)

            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE, "requests", object()):
                    with unittest.mock.patch.object(MODULE, "poll_vertical", side_effect=patched_poll_vertical):
                        with contextlib.redirect_stdout(stdout):
                            rc = MODULE.main(["--vertical", "nonprofit", "--state-dir", tmp])

            self.assertEqual(rc, 0)
            summary = json.loads(stdout.getvalue())
            self.assertEqual(summary["new_deltas"], 1)
            self.assertEqual(len(summary["new_items"]), summary["new_deltas"])
            self.assertEqual(len(summary["new_items"]), 1)
            self.assertEqual(
                set(summary["new_items"][0].keys()),
                {"vertical", "source_id", "guid", "title", "url", "pubdate", "summary"},
            )
            self.assertEqual(summary["new_items"][0]["vertical"], "nonprofit")
            self.assertEqual(summary["new_items"][0]["source_id"], source["id"])
            self.assertEqual(summary["new_items"][0]["guid"], "episode-4")
            self.assertEqual(summary["new_items"][0]["title"], "Episode 4: Grants Acceleration")
            self.assertEqual(summary["new_items"][0]["url"], "https://example.com/podcast/ep-4")
            self.assertEqual(summary["new_items"][0]["pubdate"], "2026-07-14T00:00:00Z")
            self.assertEqual(summary["new_items"][0]["summary"], "")

    def test_clean_summary_strips_html_and_collapses_whitespace(self) -> None:
        raw = "<p>Margins &amp; backlog</p>\n  <b>held firm</b> in Q2"
        self.assertEqual(MODULE.clean_summary(raw), "Margins & backlog held firm in Q2")

    def test_clean_summary_truncates_with_ellipsis(self) -> None:
        raw = "x" * 400
        cleaned = MODULE.clean_summary(raw)
        self.assertEqual(len(cleaned), MODULE.SUMMARY_MAX_CHARS)
        self.assertTrue(cleaned.endswith("\u2026"))

    def test_clean_summary_non_string_returns_empty(self) -> None:
        self.assertEqual(MODULE.clean_summary(None), "")
        self.assertEqual(MODULE.clean_summary(""), "")
        self.assertEqual(MODULE.clean_summary(123), "")

    def test_parse_entries_captures_summary_and_defaults_empty(self) -> None:
        feed = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Summary Feed</title>
    <item>
      <title>With description</title>
      <link>https://example.com/a</link>
      <guid>guid-a</guid>
      <pubDate>Tue, 14 Jul 2026 00:00:00 GMT</pubDate>
      <description>&lt;p&gt;Firm margins &amp;amp; backlog held&lt;/p&gt;</description>
    </item>
    <item>
      <title>Without description</title>
      <link>https://example.com/b</link>
      <guid>guid-b</guid>
      <pubDate>Mon, 13 Jul 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
"""
        entries = MODULE.parse_entries(feed)
        self.assertEqual(entries[0]["guid"], "guid-a")
        self.assertEqual(entries[0]["summary"], "Firm margins & backlog held")
        self.assertEqual(entries[1]["guid"], "guid-b")
        self.assertEqual(entries[1]["summary"], "")

    def test_detect_new_falls_back_to_pubdate_without_reflood(self) -> None:
        baseline = MODULE.parse_entries(self.load_fixture_bytes("podcast_feed.xml"))
        entries = MODULE.parse_entries(self.load_fixture_bytes("podcast_feed_plus_one.xml"))
        new_items = MODULE.detect_new(entries, "missing-guid", baseline[0]["pubdate"])
        self.assertEqual([item["guid"] for item in new_items], ["episode-4"])

    def test_first_run_guard_records_baseline_without_deltas(self) -> None:
        source = self.make_registry()["sources"][0]

        def fake_fetch(*_: object, **__: object):
            return 200, self.load_fixture_bytes("podcast_feed.xml"), "etag-1", "Mon, 13 Jul 2026 00:00:00 GMT"

        result = MODULE.poll_source(source, fetch=fake_fetch)
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(result["new_items"], [])
        self.assertEqual(source["last_seen_guid"], "episode-3")
        self.assertEqual(source["last_seen_pubdate"], "2026-07-13T00:00:00Z")
        self.assertEqual(source["consecutive_errors"], 0)

    def test_error_count_escalation_deactivates_at_ten_and_surfaces_in_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            source = registry["sources"][0]
            source["consecutive_errors"] = 9
            self.save_registry(registry, tmp)

            def fake_fetch(*_: object, **__: object):
                raise RuntimeError("boom")

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                summary = MODULE.poll_vertical("nonprofit", fetch=fake_fetch)
                saved = pulse_registry.load_registry("nonprofit")

            self.assertEqual(summary["sources_errored"], 1)
            self.assertEqual(summary["deactivated"], [source["id"]])
            self.assertEqual(summary["error_sources"], [source["id"]])
            self.assertFalse(saved["sources"][0]["active"])
            self.assertEqual(saved["sources"][0]["consecutive_errors"], 10)

    def test_non_pollable_skip_excludes_source_from_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = pulse_registry.new_registry(
                "nonprofit",
                "Nonprofit",
                "Tracks nonprofit operating, funding, and regulatory signals.",
            )
            pulse_registry.add_source(
                registry,
                source_name="FRED",
                url="https://fred.stlouisfed.org",
                feed_url=None,
                source_type="data_feed",
                tags={
                    "topic": ["operations"],
                    "signal": ["macro"],
                    "authority": "industry_expert",
                    "cadence": "weekly",
                    "quality": "high",
                },
            )
            self.save_registry(registry, tmp)

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                summary = MODULE.poll_vertical("nonprofit")

            self.assertEqual(summary["sources_polled"], 0)
            self.assertEqual(summary["sources_304"], 0)
            self.assertEqual(summary["sources_changed"], 0)
            self.assertEqual(summary["sources_errored"], 0)

    def test_parse_entries_extracts_youtube_ids(self) -> None:
        entries = MODULE.parse_entries(self.load_fixture_bytes("youtube_videos.xml"))
        self.assertEqual(entries[0]["guid"], "yt:video:vid-3")
        self.assertEqual(entries[0]["url"], "https://www.youtube.com/watch?v=vid-3")
        self.assertEqual(entries[0]["pubdate"], "2026-07-14T00:00:00Z")

    def test_pulse_snapshot_refreshes_latest_items_after_delta_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            baseline = MODULE.parse_entries(self.load_fixture_bytes("podcast_feed.xml"))
            source = registry["sources"][0]
            source["last_seen_guid"] = baseline[0]["guid"]
            source["last_seen_pubdate"] = baseline[0]["pubdate"]
            self.save_registry(registry, tmp)

            def fake_fetch(*_: object, **__: object):
                return 200, self.load_fixture_bytes("podcast_feed_plus_one.xml"), "etag-2", "Tue, 14 Jul 2026 00:00:00 GMT"

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                MODULE.poll_vertical("nonprofit", fetch=fake_fetch)
                snapshot_path = pulse_registry.pulse_path("nonprofit")
                snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))

            self.assertTrue(snapshot_path.exists())
            self.assertEqual(snapshot["latest_items"][0]["title"], "Episode 4: Grants Acceleration")
            self.assertEqual(snapshot["latest_items"][0]["source_name"], "Ops Feed")

    def test_main_missing_dependencies_prints_actionable_message(self) -> None:
        stderr = io.StringIO()
        with unittest.mock.patch.object(MODULE, "feedparser", None):
            with unittest.mock.patch.object(MODULE, "requests", object()):
                with contextlib.redirect_stderr(stderr):
                    rc = MODULE.main([])
        self.assertEqual(rc, 1)
        self.assertIn("missing dependency: run pip install feedparser requests", stderr.getvalue())

    def test_corrupt_registry_isolated_partial_run_still_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = pulse_registry.new_registry(
                "nonprofit",
                "Nonprofit",
                "Tracks nonprofit operating, funding, and regulatory signals.",
            )
            pulse_registry.add_source(
                registry,
                source_name="FRED",
                url="https://fred.stlouisfed.org",
                feed_url=None,
                source_type="data_feed",
                tags={
                    "topic": ["operations"],
                    "signal": ["macro"],
                    "authority": "industry_expert",
                    "cadence": "weekly",
                    "quality": "high",
                },
            )

            registry_dir = Path(tmp) / "registry"
            registry_dir.mkdir(parents=True, exist_ok=True)
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                pulse_registry.save_registry(registry)
            (registry_dir / "broken.json").write_text("{not valid json\n", encoding="utf-8")

            stdout = io.StringIO()
            stderr = io.StringIO()
            with unittest.mock.patch.object(MODULE, "feedparser", object()):
                with unittest.mock.patch.object(MODULE, "requests", object()):
                    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                        rc = MODULE.main(["--state-dir", tmp])

            self.assertEqual(rc, 0)
            self.assertEqual(stderr.getvalue(), "")
            summary = json.loads(stdout.getvalue())
            self.assertEqual(summary["verticals_polled"], 1)
            self.assertEqual(summary["sources_polled"], 0)
            self.assertEqual(summary["vertical_errors"][0]["vertical"], "broken")
            self.assertIn("Expecting property name enclosed in double quotes", summary["vertical_errors"][0]["error"])


if __name__ == "__main__":
    unittest.main()
