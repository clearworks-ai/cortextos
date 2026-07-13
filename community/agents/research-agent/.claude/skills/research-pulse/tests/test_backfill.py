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

from scripts import backfill as MODULE
from scripts import pulse_registry


class BackfillTests(unittest.TestCase):
    def load_fixture(self) -> dict:
        with (FIXTURES / "nlm_source_list.json").open(encoding="utf-8") as handle:
            return json.load(handle)

    def test_infer_source_type_table(self) -> None:
        cases = [
            ("https://www.youtube.com/channel/UC123", "Channel", "youtube"),
            ("https://youtu.be/abc123", "Video", "youtube"),
            ("https://example.com/show.rss", "Feed", "podcast"),
            ("https://example.com/feed", "Feed", "podcast"),
            ("https://show.libsyn.com/site", "Show", "podcast"),
            ("https://fred.stlouisfed.org/series/CPIAUCSL", "FRED", "data_feed"),
            ("https://www.bls.gov/news.release/empsit.nr0.htm", "BLS", "data_feed"),
            ("https://www.census.gov/construction/c30/current/index.html", "Census", "data_feed"),
            ("https://example.com/report.pdf", "PDF Report", "report"),
            ("https://example.com/analysis", "Article", "article"),
        ]
        for url, title, expected in cases:
            with self.subTest(url=url):
                self.assertEqual(MODULE.infer_source_type(url, title), expected)

    def test_infer_feed_url_table(self) -> None:
        cases = [
            ("https://www.youtube.com/channel/UC123", "youtube", "https://www.youtube.com/feeds/videos.xml?channel_id=UC123"),
            ("https://www.youtube.com/channel/UC999/", "youtube", "https://www.youtube.com/feeds/videos.xml?channel_id=UC999"),
            ("https://www.youtube.com/watch?v=abc", "youtube", None),
            ("https://www.youtube.com/@clearworksai", "youtube", None),
            ("https://youtu.be/abc", "youtube", None),
            ("https://example.com/show.rss", "podcast", "https://example.com/show.rss"),
            ("https://example.com/show.xml", "podcast", "https://example.com/show.xml"),
            ("https://example.com/feed", "podcast", "https://example.com/feed"),
            ("https://example.com/post", "article", None),
        ]
        for url, source_type, expected in cases:
            with self.subTest(url=url):
                self.assertEqual(MODULE.infer_feed_url(url, source_type), expected)

    def test_backfill_builds_valid_registry_from_fixture(self) -> None:
        fixture = self.load_fixture()
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE.seed_notebook, "nlm", return_value=fixture):
                    summary = MODULE.backfill(
                        vertical="aec",
                        display_name="AEC",
                        framing="Tracks architecture and construction signals.",
                        notebook_id="nb-aec",
                        framework_doc="/tmp/aec-framework.md",
                        merge=False,
                    )
                registry = pulse_registry.load_registry("aec")
                snapshot = json.loads(pulse_registry.pulse_path("aec").read_text(encoding="utf-8"))

        self.assertEqual(summary, {"vertical": "aec", "added": 2, "skipped": 0, "placeholder_urls": 0})
        self.assertEqual(len(registry["sources"]), 2)
        self.assertEqual(pulse_registry.validate_registry(registry), [])
        self.assertEqual(registry["sources"][0]["notebooklm_source_id"], "seeded-1")
        self.assertEqual(registry["framework_doc"], "/tmp/aec-framework.md")
        self.assertEqual(snapshot["source_count"], 2)
        self.assertEqual(snapshot["active_source_count"], 2)

    def test_backfill_refuses_existing_without_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                registry = pulse_registry.new_registry("aec", "AEC", "Framing", notebook_id="nb-aec")
                pulse_registry.save_registry(registry)
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    rc = MODULE.main(
                        [
                            "--vertical",
                            "aec",
                            "--display-name",
                            "AEC",
                            "--framing",
                            "Framing",
                            "--notebook-id",
                            "nb-aec",
                        ]
                    )
        self.assertEqual(rc, 2)
        self.assertIn("registry already exists", stderr.getvalue())

    def test_merge_dedupes_by_nlm_id_and_title(self) -> None:
        payload = {
            "sources": [
                {"source_id": "seeded-1", "title": "Existing Source by ID"},
                {"source_id": "seeded-2", "title": "Existing Source by Title"},
                {"source_id": "seeded-3", "title": "Brand New Source", "url": "https://example.com/brand-new.rss"},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                registry = pulse_registry.new_registry("nonprofit", "Nonprofit", "Framing", notebook_id="nb-np")
                pulse_registry.add_source(
                    registry,
                    source_name="Existing Source by ID",
                    url="notebooklm://seeded-1",
                    source_type="article",
                    feed_url=None,
                    tags=MODULE.stub_tags("article"),
                    notebooklm_source_id="seeded-1",
                )
                pulse_registry.add_source(
                    registry,
                    source_name="Existing Source by Title",
                    url="https://example.com/existing-title",
                    source_type="article",
                    feed_url=None,
                    tags=MODULE.stub_tags("article"),
                )
                pulse_registry.save_registry(registry)
                with unittest.mock.patch.object(MODULE.seed_notebook, "nlm", return_value=payload):
                    summary = MODULE.backfill(
                        vertical="nonprofit",
                        display_name="Nonprofit",
                        framing="Framing",
                        notebook_id="nb-np",
                        framework_doc=None,
                        merge=True,
                    )
                saved = pulse_registry.load_registry("nonprofit")

        self.assertEqual(summary["added"], 1)
        self.assertEqual(summary["skipped"], 2)
        self.assertEqual(len(saved["sources"]), 3)
        self.assertEqual(saved["sources"][-1]["notebooklm_source_id"], "seeded-3")
        self.assertEqual(saved["sources"][-1]["feed_url"], "https://example.com/brand-new.rss")

    def test_placeholder_url_marked_emerging_and_unpollable(self) -> None:
        payload = {"sources": [{"source_id": "seeded-1", "title": "Mystery Source"}]}
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE.seed_notebook, "nlm", return_value=payload):
                    MODULE.backfill(
                        vertical="loan-syndication",
                        display_name="Loan Syndication",
                        framing="Tracks debt and capital-market signals.",
                        notebook_id="nb-loan",
                        framework_doc=None,
                        merge=False,
                    )
                registry = pulse_registry.load_registry("loan-syndication")

        source = registry["sources"][0]
        self.assertTrue(source["url"].startswith("notebooklm://"))
        self.assertEqual(source["tags"]["quality"], "emerging")
        self.assertIsNone(source["feed_url"])
        self.assertEqual(source["source_type"], "article")


if __name__ == "__main__":
    unittest.main()
