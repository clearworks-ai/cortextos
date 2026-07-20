from __future__ import annotations

import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import delta_check as MODULE
from scripts import pulse_registry


def yt_item(
    guid: str = "yt:video:v1",
    title: str = "Site walk in 60s",
    summary: str = "",
    url: str = "https://www.youtube.com/watch?v=v1",
) -> dict:
    return {
        "guid": guid,
        "title": title,
        "url": url,
        "pubdate": "2026-07-14T00:00:00Z",
        "summary": summary,
    }


class CaptionEnrichmentTests(unittest.TestCase):
    def load_fixture_bytes(self, name: str) -> bytes:
        return (FIXTURES / name).read_bytes()

    def make_youtube_registry(self) -> dict:
        registry = pulse_registry.new_registry(
            "nonprofit",
            "Nonprofit",
            "Tracks nonprofit operating, funding, and regulatory signals.",
        )
        pulse_registry.add_source(
            registry,
            source_name="YouTube Shorts Feed",
            url="https://www.youtube.com/@test",
            feed_url="https://www.youtube.com/feeds/videos.xml?channel_id=UC-test",
            source_type="youtube",
            tags={
                "topic": ["operations"],
                "signal": ["leading"],
                "authority": "industry_expert",
                "cadence": "daily",
                "quality": "high",
            },
        )
        return registry

    def save_registry(self, registry: dict, tmp: str) -> None:
        with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
            pulse_registry.save_registry(registry)

    def test_predicate_true_on_empty_summary(self) -> None:
        self.assertTrue(MODULE.is_descriptionless_youtube(yt_item(summary="")))

    def test_predicate_true_when_summary_equals_cleaned_title(self) -> None:
        title = "Margins &amp; backlog"
        item = yt_item(title=title, summary=MODULE.clean_summary(title))
        self.assertTrue(MODULE.is_descriptionless_youtube(item))

    def test_predicate_false_on_real_summary(self) -> None:
        self.assertFalse(
            MODULE.is_descriptionless_youtube(
                yt_item(summary="A real 2-sentence description of the video.")
            )
        )

    def test_predicate_false_on_non_youtube_guid(self) -> None:
        self.assertFalse(MODULE.is_descriptionless_youtube(yt_item(guid="episode-4", summary="")))

    def test_video_id_extraction(self) -> None:
        self.assertEqual(MODULE._youtube_video_id("yt:video:abc123"), "abc123")
        self.assertIsNone(MODULE._youtube_video_id("episode-4"))
        self.assertIsNone(MODULE._youtube_video_id("yt:video:"))

    def test_cap_six_attempts_per_shared_budget(self) -> None:
        budget = MODULE.new_caption_budget()
        list_a = [yt_item(guid=f"yt:video:a{i}") for i in range(4)]
        list_b = [yt_item(guid=f"yt:video:b{i}") for i in range(4)]
        fetch = unittest.mock.Mock(return_value="captions text")

        MODULE.enrich_youtube_items(list_a, budget, fetch_caption=fetch)
        MODULE.enrich_youtube_items(list_b, budget, fetch_caption=fetch)

        self.assertEqual(fetch.call_count, 6)
        self.assertTrue(all(item.get("caption_excerpt") == "captions text" for item in list_a))
        self.assertEqual(sum("caption_excerpt" in item for item in list_b), 2)
        self.assertEqual(budget["remaining"], 0)

    def test_fetch_none_leaves_item_untouched_and_source_healthy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_youtube_registry()
            source = registry["sources"][0]
            baseline = MODULE.parse_entries(self.load_fixture_bytes("youtube_shorts_feed.xml"))
            self.assertTrue(MODULE.is_descriptionless_youtube(baseline[0]))
            self.assertFalse(MODULE.is_descriptionless_youtube(baseline[1]))
            source["last_seen_guid"] = baseline[1]["guid"]
            source["last_seen_pubdate"] = baseline[1]["pubdate"]
            self.save_registry(registry, tmp)

            def fake_fetch(*_: object, **__: object):
                return 200, self.load_fixture_bytes("youtube_shorts_feed.xml"), None, None

            original_enrich = MODULE.enrich_youtube_items

            def patched_enrich(
                new_items: list[dict],
                caption_budget: dict | None,
                fetch_caption=MODULE.fetch_caption_excerpt,
            ) -> None:
                return original_enrich(
                    new_items,
                    caption_budget,
                    fetch_caption=lambda _video_id: None,
                )

            with unittest.mock.patch.object(MODULE, "enrich_youtube_items", side_effect=patched_enrich):
                result = MODULE.poll_source(
                    source,
                    fetch=fake_fetch,
                    caption_budget=MODULE.new_caption_budget(),
                )

        self.assertEqual(result["status"], "changed")
        self.assertNotIn("caption_excerpt", result["new_items"][0])
        self.assertEqual(source["consecutive_errors"], 0)
        self.assertTrue(source["active"])

    def test_raising_fetch_is_swallowed(self) -> None:
        items = [yt_item(guid=f"yt:video:v{i}") for i in range(2)]
        budget = MODULE.new_caption_budget()
        fetch = unittest.mock.Mock(side_effect=RuntimeError("boom"))

        MODULE.enrich_youtube_items(items, budget, fetch_caption=fetch)

        self.assertEqual(fetch.call_count, 2)
        self.assertTrue(all("caption_excerpt" not in item for item in items))
        self.assertEqual(budget["remaining"], MODULE.CAPTION_FETCH_CAP - 2)

    def test_dep_missing_returns_none(self) -> None:
        with unittest.mock.patch.object(MODULE, "YouTubeTranscriptApi", None):
            self.assertIsNone(MODULE.fetch_caption_excerpt("abc123"))

    def test_real_rss_summary_never_summarized(self) -> None:
        fetch = unittest.mock.Mock()
        youtube_item = yt_item(summary="Real description here.")
        podcast_item = yt_item(guid="episode-4", summary="")

        MODULE.enrich_youtube_items([youtube_item], MODULE.new_caption_budget(), fetch_caption=fetch)
        MODULE.enrich_youtube_items([podcast_item], MODULE.new_caption_budget(), fetch_caption=fetch)

        fetch.assert_not_called()
        self.assertEqual(youtube_item["summary"], "Real description here.")
        self.assertNotIn("caption_excerpt", youtube_item)
        self.assertNotIn("caption_excerpt", podcast_item)

    def test_excerpt_bounded_at_max_chars(self) -> None:
        class StubTranscriptApi:
            def fetch(self, video_id: str) -> list[SimpleNamespace]:
                self.video_id = video_id
                return [SimpleNamespace(text="x" * 2001)]

        with unittest.mock.patch.object(MODULE, "YouTubeTranscriptApi", StubTranscriptApi):
            excerpt = MODULE.fetch_caption_excerpt("abc123")

        self.assertIsNotNone(excerpt)
        self.assertEqual(len(excerpt), MODULE.CAPTION_EXCERPT_MAX_CHARS)
        self.assertTrue(excerpt.endswith("\u2026"))

    def test_no_budget_means_no_enrichment(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_youtube_registry()
            source = registry["sources"][0]
            baseline = MODULE.parse_entries(self.load_fixture_bytes("youtube_shorts_feed.xml"))
            source["last_seen_guid"] = baseline[1]["guid"]
            source["last_seen_pubdate"] = baseline[1]["pubdate"]
            self.save_registry(registry, tmp)

            def fake_fetch(*_: object, **__: object):
                return 200, self.load_fixture_bytes("youtube_shorts_feed.xml"), None, None

            with unittest.mock.patch.object(MODULE, "enrich_youtube_items") as mocked_enrich:
                result = MODULE.poll_source(source, fetch=fake_fetch)

        mocked_enrich.assert_not_called()
        self.assertEqual(result["status"], "changed")
        self.assertEqual(result["new_items"][0]["guid"], "yt:video:short-1")
        self.assertNotIn("caption_excerpt", result["new_items"][0])

    def test_run_summary_carries_caption_excerpt_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_youtube_registry()
            source = registry["sources"][0]
            baseline = MODULE.parse_entries(self.load_fixture_bytes("youtube_shorts_feed.xml"))
            source["last_seen_guid"] = baseline[1]["guid"]
            source["last_seen_pubdate"] = baseline[1]["pubdate"]
            self.save_registry(registry, tmp)

            def fake_fetch(*_: object, **__: object):
                return 200, self.load_fixture_bytes("youtube_shorts_feed.xml"), None, None

            original_enrich = MODULE.enrich_youtube_items

            def patched_enrich(
                new_items: list[dict],
                caption_budget: dict | None,
                fetch_caption=MODULE.fetch_caption_excerpt,
            ) -> None:
                return original_enrich(
                    new_items,
                    caption_budget,
                    fetch_caption=lambda _video_id: "He walks the site and calls out three margin leaks.",
                )

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE, "enrich_youtube_items", side_effect=patched_enrich):
                    summary = MODULE.poll_vertical(
                        "nonprofit",
                        fetch=fake_fetch,
                        caption_budget=MODULE.new_caption_budget(),
                    )
                    saved = pulse_registry.load_registry("nonprofit")

        self.assertEqual(
            summary["new_items"][0]["caption_excerpt"],
            "He walks the site and calls out three margin leaks.",
        )
        self.assertEqual(summary["new_items"][0]["guid"], "yt:video:short-1")
        self.assertNotIn("caption_excerpt", saved["deltas"][0])


if __name__ == "__main__":
    unittest.main()
