from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import daily_digest as MODULE
from scripts import delta_check as DELTA
from scripts import pulse_registry


class DailyDigestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = datetime(2026, 7, 20, 5, 0, 0, tzinfo=timezone.utc)

    def make_registry(self) -> dict:
        registry = pulse_registry.new_registry("aec", "AEC", "test")
        registry["topic_vocab_extra"] = [
            "construction_spending",
            "project_delivery",
            "infrastructure",
        ]
        pulse_registry.add_source(
            registry,
            source_name="News Blog",
            url="https://example.com/news",
            source_type="article",
            feed_url="https://example.com/news/feed.xml",
            tags={
                "topic": ["strategy"],
                "signal": ["sentiment"],
                "authority": "news",
                "cadence": "daily",
                "quality": "high",
            },
        )
        pulse_registry.add_source(
            registry,
            source_name="Macro Indicator",
            url="https://example.com/macro",
            source_type="article",
            feed_url="https://example.com/macro/feed.xml",
            tags={
                "topic": ["indicators"],
                "signal": ["macro", "leading"],
                "authority": "industry_expert",
                "cadence": "daily",
                "quality": "high",
            },
        )
        pulse_registry.add_source(
            registry,
            source_name="Spend Feed",
            url="https://example.com/spend",
            source_type="data_feed",
            feed_url="https://example.com/spend/feed.xml",
            tags={
                "topic": ["indicators", "construction_spending"],
                "signal": ["coincident"],
                "authority": "industry_expert",
                "cadence": "monthly",
                "quality": "high",
            },
        )
        pulse_registry.add_source(
            registry,
            source_name="Mega GC Wire",
            url="https://example.com/mega-gc",
            source_type="article",
            feed_url="https://example.com/mega-gc/feed.xml",
            tags={
                "topic": ["operations"],
                "signal": ["coincident"],
                "authority": "news",
                "cadence": "daily",
                "quality": "high",
            },
        )
        registry["sources"][-1]["active"] = False
        return registry

    def write_state(self, tmp: str, registry: dict, inbox_items: list[dict], quotes: list[dict]) -> None:
        with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
            pulse_registry.save_registry(registry)
            inbox_path = pulse_registry.state_dir() / "inbox.jsonl"
            inbox_path.parent.mkdir(parents=True, exist_ok=True)
            with inbox_path.open("w", encoding="utf-8") as handle:
                for item in inbox_items:
                    handle.write(json.dumps(item) + "\n")
            pulse_registry.atomic_write_json(
                pulse_registry.state_dir() / "owner_voice_pool.json",
                {"quotes": quotes, "surfaced": []},
            )

    def make_inbox_items(self, registry: dict) -> list[dict]:
        source_ids = {source["source_name"]: source["id"] for source in registry["sources"]}
        fresh = self.now.strftime("%Y-%m-%dT%H:%M:%SZ")
        return [
            {
                "ingested_at": fresh,
                "vertical": "aec",
                "source_id": source_ids["News Blog"],
                "guid": "news-guid",
                "title": "Firm operators share margin playbooks",
                "url": "https://example.com/news/item",
                "pubdate": "2026-07-20T04:30:00Z",
            },
            {
                "ingested_at": fresh,
                "vertical": "aec",
                "source_id": source_ids["Macro Indicator"],
                "guid": "macro-guid",
                "title": "ABI weakens as backlog softens",
                "url": "https://example.com/macro/item",
                "pubdate": "2026-07-20T04:00:00Z",
            },
            {
                "ingested_at": fresh,
                "vertical": "aec",
                "source_id": source_ids["Spend Feed"],
                "guid": "spend-guid",
                "title": "Construction Spending rises in June",
                "url": "https://example.com/spend/item",
                "pubdate": "2026-07-20T03:30:00Z",
            },
            {
                "ingested_at": fresh,
                "vertical": "aec",
                "source_id": source_ids["Mega GC Wire"],
                "guid": "mega-guid",
                "title": "Skanska reports record $7B order intake",
                "url": "https://example.com/mega/item",
                "pubdate": "2026-07-20T03:00:00Z",
            },
            {
                "ingested_at": fresh,
                "vertical": "nonprofit",
                "source_id": source_ids["News Blog"],
                "guid": "wrong-vertical-guid",
                "title": "Wrong vertical should skip",
                "url": "https://example.com/wrong",
                "pubdate": "2026-07-20T02:30:00Z",
            },
            {
                "ingested_at": fresh,
                "vertical": "aec",
                "source_id": "src_unknown",
                "guid": "unknown-guid",
                "title": "Unknown source should skip",
                "url": "https://example.com/unknown",
                "pubdate": "2026-07-20T02:00:00Z",
            },
        ]

    def make_quotes(self) -> list[dict]:
        return [
            {
                "quote": "CA is where we either preserve design profit or lose it.",
                "speaker": "Jack Sadler",
                "theme_tag": "ca_profitability_threat",
            },
            {
                "quote": "Hourly billing punishes efficiency the moment your systems improve.",
                "speaker": "Architecture principal",
                "theme_tag": "pricing_efficiency_penalty",
            },
        ]

    def test_build_digest_three_way_bucketing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            self.write_state(tmp, registry, self.make_inbox_items(registry), self.make_quotes())

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                digest = MODULE.build_digest(since_hours=48, now=self.now)

        self.assertEqual(
            set(digest["buckets"].keys()),
            {"industry_news", "spend_confidence", "owner_voice"},
        )
        self.assertEqual(
            [item["title"] for item in digest["buckets"]["industry_news"]],
            ["Firm operators share margin playbooks"],
        )
        self.assertEqual(
            [item["title"] for item in digest["buckets"]["spend_confidence"]],
            ["ABI weakens as backlog softens", "Construction Spending rises in June"],
        )
        self.assertTrue(digest["buckets"]["owner_voice"])

    def test_no_mega_gc_in_industry_news(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            self.write_state(tmp, registry, self.make_inbox_items(registry), self.make_quotes())

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                digest = MODULE.build_digest(since_hours=48, now=self.now, rotate=False)

        titles = [
            item["title"]
            for bucket_name in ("industry_news", "spend_confidence")
            for item in digest["buckets"][bucket_name]
        ]
        self.assertFalse(any("Skanska" in title or "Tutor Perini" in title for title in titles))
        self.assertFalse(any("Skanska" in item["title"] for item in digest["buckets"]["industry_news"]))

    def test_unknown_source_and_wrong_vertical_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            self.write_state(tmp, registry, self.make_inbox_items(registry), self.make_quotes())

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                digest = MODULE.build_digest(since_hours=48, now=self.now, rotate=False)

        all_titles = [
            item["title"]
            for bucket_name in ("industry_news", "spend_confidence")
            for item in digest["buckets"][bucket_name]
        ]
        self.assertNotIn("Wrong vertical should skip", all_titles)
        self.assertNotIn("Unknown source should skip", all_titles)

    def test_title_filter_census(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            census_source = json.loads(json.dumps(registry["sources"][2]))
            census_source["id"] = "src_u-s-census-construction-spending"
            census_source["source_name"] = "U.S. Census Construction Spending"
            census_source["url"] = "https://www.census.gov/construction"
            census_source["feed_url"] = "https://www.census.gov/economic-indicators/indicator.xml"
            census_source["source_type"] = "data_feed"
            registry["sources"].append(census_source)
            self.write_state(
                tmp,
                registry,
                [
                    {
                        "ingested_at": self.now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "vertical": "aec",
                        "source_id": "src_u-s-census-construction-spending",
                        "guid": "retail-sales-guid",
                        "title": "Advance Retail Sales",
                        "url": "https://example.com/retail",
                        "pubdate": "2026-07-20T04:30:00Z",
                    },
                    {
                        "ingested_at": self.now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "vertical": "aec",
                        "source_id": "src_u-s-census-construction-spending",
                        "guid": "construction-spending-guid",
                        "title": "Construction Spending May 2026",
                        "url": "https://example.com/construction-spending",
                        "pubdate": "2026-07-20T04:00:00Z",
                    },
                ],
                self.make_quotes(),
            )

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                digest = MODULE.build_digest(since_hours=48, now=self.now, rotate=False)

        self.assertEqual(
            [item["title"] for item in digest["buckets"]["spend_confidence"]],
            ["Construction Spending May 2026"],
        )

    def test_owner_voice_rotation_no_repeat_and_reset(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            self.write_state(tmp, registry, [], self.make_quotes())

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                first = MODULE.rotate_owner_voice(MODULE.load_pool(), count=1)
                second = MODULE.rotate_owner_voice(MODULE.load_pool(), count=1)
                third = MODULE.rotate_owner_voice(MODULE.load_pool(), count=1)
                saved = MODULE.load_pool()

        self.assertNotEqual(first[0]["quote"], second[0]["quote"])
        self.assertEqual(third[0]["quote"], first[0]["quote"])
        self.assertEqual(saved["surfaced"], [MODULE.quote_id(first[0]["quote"])])

    def test_render_telegram_sections(self) -> None:
        digest = {
            "digest_date": "2026-07-20",
            "buckets": {
                "industry_news": [],
                "spend_confidence": [
                    {
                        "title": "ABI weakens as backlog softens",
                        "source_name": "Macro Indicator",
                        "pubdate": "2026-07-20T04:00:00Z",
                    }
                ],
                "owner_voice": [
                    {
                        "quote": "CA is where we either preserve design profit or lose it.",
                        "speaker": "Jack Sadler",
                    }
                ],
            },
        }

        rendered = MODULE.render_telegram(digest)
        self.assertIn("INDUSTRY", rendered)
        self.assertIn("SPEND CONFIDENCE", rendered)
        self.assertIn("OWNER VOICE", rendered)
        self.assertIn("2026-07-20", rendered)
        self.assertIn("• (no new items in window)", rendered)

    def test_render_telegram_surfaces_url_and_summary(self) -> None:
        digest = {
            "digest_date": "2026-07-20",
            "buckets": {
                "industry_news": [
                    {
                        "title": "Firm operators share margin playbooks",
                        "source_name": "News Blog",
                        "pubdate": "2026-07-20T04:30:00Z",
                        "url": "https://example.com/news/item",
                        "summary": "Operators detail how CA-phase discipline preserves design margin.",
                    }
                ],
                "spend_confidence": [],
                "owner_voice": [],
            },
        }

        rendered = MODULE.render_telegram(digest)
        lines = rendered.splitlines()
        idx = lines.index("• Firm operators share margin playbooks (News Blog, 2026-07-20)")
        self.assertEqual(lines[idx + 1], "  https://example.com/news/item")
        self.assertEqual(
            lines[idx + 2],
            "  Operators detail how CA-phase discipline preserves design margin.",
        )

    def test_render_telegram_empty_summary_renders_link_only(self) -> None:
        digest = {
            "digest_date": "2026-07-20",
            "buckets": {
                "industry_news": [
                    {
                        "title": "Firm operators share margin playbooks",
                        "source_name": "News Blog",
                        "pubdate": "2026-07-20T04:30:00Z",
                        "url": "https://example.com/news/item",
                        "summary": "",
                    }
                ],
                "spend_confidence": [],
                "owner_voice": [],
            },
        }

        rendered = MODULE.render_telegram(digest)
        lines = rendered.splitlines()
        idx = lines.index("• Firm operators share margin playbooks (News Blog, 2026-07-20)")
        self.assertEqual(lines[idx + 1], "  https://example.com/news/item")
        self.assertEqual(lines[idx + 2], "")

    def test_render_telegram_no_url_no_summary_matches_legacy(self) -> None:
        digest = {
            "digest_date": "2026-07-20",
            "buckets": {
                "industry_news": [
                    {
                        "title": "Firm operators share margin playbooks",
                        "source_name": "News Blog",
                        "pubdate": "2026-07-20T04:30:00Z",
                    }
                ],
                "spend_confidence": [],
                "owner_voice": [],
            },
        }

        rendered = MODULE.render_telegram(digest)
        lines = rendered.splitlines()
        idx = lines.index("• Firm operators share margin playbooks (News Blog, 2026-07-20)")
        self.assertEqual(lines[idx + 1], "")
        self.assertNotIn("https://", rendered)

    def test_bucketize_carries_summary_and_defaults_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            items = self.make_inbox_items(registry)
            items[0]["summary"] = "Operators detail CA-phase discipline."
            self.write_state(tmp, registry, items, self.make_quotes())

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                digest = MODULE.build_digest(since_hours=48, now=self.now, rotate=False)

        news = digest["buckets"]["industry_news"]
        self.assertEqual(news[0]["summary"], "Operators detail CA-phase discipline.")
        spend = digest["buckets"]["spend_confidence"]
        self.assertTrue(all(item["summary"] == "" for item in spend))

    def test_write_pulse_file_dated_path(self) -> None:
        digest = {
            "digest_date": "2026-07-20",
            "generated_at": "2026-07-20T05:00:00Z",
            "vertical": "aec",
            "since_hours": 24,
            "buckets": {"industry_news": [], "spend_confidence": [], "owner_voice": []},
        }
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                path = MODULE.write_pulse_file(digest)
                loaded = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(path, Path(tmp) / "pulse" / "2026-07-20.json")
        self.assertEqual(loaded, digest)

    def test_since_hours_window(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            fresh = self.now.strftime("%Y-%m-%dT%H:%M:%SZ")
            old = (self.now - timedelta(hours=72)).strftime("%Y-%m-%dT%H:%M:%SZ")
            source_id = registry["sources"][0]["id"]
            self.write_state(
                tmp,
                registry,
                [
                    {
                        "ingested_at": old,
                        "vertical": "aec",
                        "source_id": source_id,
                        "guid": "old-guid",
                        "title": "Older strategy item",
                        "url": "https://example.com/old",
                        "pubdate": old,
                    },
                    {
                        "ingested_at": fresh,
                        "vertical": "aec",
                        "source_id": source_id,
                        "guid": "fresh-guid",
                        "title": "Fresh strategy item",
                        "url": "https://example.com/fresh",
                        "pubdate": fresh,
                    },
                ],
                self.make_quotes(),
            )

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                digest_24 = MODULE.build_digest(since_hours=24, now=self.now, rotate=False)
                digest_96 = MODULE.build_digest(since_hours=96, now=self.now, rotate=False)

        self.assertEqual(
            [item["title"] for item in digest_24["buckets"]["industry_news"]],
            ["Fresh strategy item"],
        )
        self.assertEqual(
            [item["title"] for item in digest_96["buckets"]["industry_news"]],
            ["Fresh strategy item", "Older strategy item"],
        )

    def test_fetch_feed_sends_user_agent(self) -> None:
        fake_response = unittest.mock.Mock()
        fake_response.status_code = 304
        fake_response.headers = {}
        fake_requests = unittest.mock.Mock()
        fake_requests.get.return_value = fake_response

        with unittest.mock.patch.object(DELTA, "requests", fake_requests):
            DELTA.fetch_feed("https://example.com/feed.xml", None, None)

        headers = fake_requests.get.call_args.kwargs["headers"]
        self.assertEqual(headers["User-Agent"], DELTA.USER_AGENT)
        self.assertTrue(headers["User-Agent"].startswith("Mozilla/5.0"))


if __name__ == "__main__":
    unittest.main()
