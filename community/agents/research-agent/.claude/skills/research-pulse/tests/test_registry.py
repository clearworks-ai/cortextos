from __future__ import annotations

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

from scripts import pulse_registry as MODULE


class RegistryTests(unittest.TestCase):
    def make_registry(self) -> dict:
        return MODULE.new_registry(
            "nonprofit",
            "Nonprofit",
            "Tracks nonprofit operating, funding, and regulatory signals.",
        )

    def add_valid_source(self, registry: dict, name: str, url: str, **overrides: object) -> dict:
        tags = {
            "topic": ["operations"],
            "signal": ["leading"],
            "authority": "industry_expert",
            "cadence": "weekly",
            "quality": "high",
        }
        tags.update(overrides.pop("tags", {}))
        return MODULE.add_source(
            registry,
            source_name=name,
            url=url,
            source_type=overrides.pop("source_type", "podcast"),
            feed_url=overrides.pop("feed_url", f"{url}/feed"),
            tags=tags,
            industry=overrides.pop("industry", None),
            notebooklm_source_id=overrides.pop("notebooklm_source_id", None),
        )

    def test_slugify_basic(self) -> None:
        self.assertEqual(MODULE.slugify("AEC — Architecture & Engineering"), "aec-architecture-engineering")

    def test_slugify_rejects_empty(self) -> None:
        with self.assertRaises(ValueError):
            MODULE.slugify("!!!")

    def test_new_registry_schema_valid(self) -> None:
        registry = self.make_registry()
        self.assertEqual(MODULE.validate_registry(registry), [])
        self.assertEqual(registry["sources"], [])
        self.assertEqual(registry["deltas"], [])
        self.assertEqual(registry["topic_vocab_extra"], [])
        self.assertEqual(registry["created_at"], registry["updated_at"])

    def test_add_source_id_collision_suffix(self) -> None:
        registry = self.make_registry()
        one = self.add_valid_source(registry, "Nonprofit Ops", "https://example.com/ops")
        two = self.add_valid_source(registry, "Nonprofit Ops", "https://example.com/ops-2")
        self.assertEqual(one["id"], "src_nonprofit-ops")
        self.assertEqual(two["id"], "src_nonprofit-ops-2")

    def test_add_source_duplicate_url_raises(self) -> None:
        registry = self.make_registry()
        self.add_valid_source(registry, "One", "https://example.com/path/")
        with self.assertRaisesRegex(ValueError, "duplicate url"):
            self.add_valid_source(registry, "Two", "HTTPS://EXAMPLE.COM/path")

    def test_validate_rejects_bad_facets(self) -> None:
        cases = [
            ("topic", {"topic": ["wrong"]}, "invalid topic"),
            ("signal", {"signal": ["wrong"]}, "invalid signal"),
            ("authority", {"authority": "wrong"}, "authority"),
            ("cadence", {"cadence": "wrong"}, "cadence"),
            ("quality", {"quality": "wrong"}, "quality"),
        ]
        for label, override, needle in cases:
            with self.subTest(label=label):
                registry = self.make_registry()
                self.add_valid_source(registry, "Bad", "https://example.com/bad", tags=override)
                errors = MODULE.validate_registry(registry)
                self.assertTrue(any(needle in error for error in errors), errors)

    def test_validate_requires_feed_url_for_pollable_types(self) -> None:
        registry = self.make_registry()
        self.add_valid_source(
            registry,
            "No Feed",
            "https://example.com/no-feed",
            feed_url=None,
        )
        errors = MODULE.validate_registry(registry)
        self.assertTrue(any("feed_url required" in error for error in errors), errors)

    def test_validate_rejects_duplicate_id_duplicate_url_and_unknown_source_type(self) -> None:
        registry = self.make_registry()
        first = self.add_valid_source(registry, "One", "https://example.com/one")
        duplicate_id = json.loads(json.dumps(first))
        duplicate_id["url"] = "https://example.com/two"
        duplicate_url = json.loads(json.dumps(first))
        duplicate_url["id"] = "src_two"
        duplicate_url["source_name"] = "Two"
        unknown_type = json.loads(json.dumps(first))
        unknown_type["id"] = "src_three"
        unknown_type["url"] = "https://example.com/three"
        unknown_type["source_type"] = "newsletter"
        registry["sources"].extend([duplicate_id, duplicate_url, unknown_type])

        errors = MODULE.validate_registry(registry)
        self.assertTrue(any("duplicate id" in error for error in errors), errors)
        self.assertTrue(any("duplicate url" in error for error in errors), errors)
        self.assertTrue(any("invalid source_type" in error for error in errors), errors)

    def test_validate_accepts_notebooklm_scheme_url(self) -> None:
        registry = self.make_registry()
        self.add_valid_source(
            registry,
            "Recovered Source",
            "notebooklm://abc123",
            source_type="report",
            feed_url=None,
        )
        self.assertEqual(MODULE.validate_registry(registry), [])

    def test_topic_vocab_extra_allows_custom_topics(self) -> None:
        registry = self.make_registry()
        registry["topic_vocab_extra"] = ["fundraising"]
        self.add_valid_source(
            registry,
            "Fundraising Weekly",
            "https://example.com/fundraising",
            tags={"topic": ["fundraising"]},
        )
        self.assertEqual(MODULE.validate_registry(registry), [])

    def test_save_load_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                registry = self.make_registry()
                self.add_valid_source(registry, "One", "https://example.com/one")
                self.add_valid_source(registry, "Two", "https://example.com/two")
                self.add_valid_source(
                    registry,
                    "Report",
                    "https://example.com/report",
                    source_type="report",
                    feed_url=None,
                )
                path = MODULE.save_registry(registry)
                loaded = MODULE.load_registry("nonprofit")
                self.assertEqual(path, MODULE.registry_path("nonprofit"))
                self.assertEqual(loaded, registry)
                leftovers = [p.name for p in path.parent.iterdir() if p.name != "nonprofit.json"]
                self.assertEqual(leftovers, [])

    def test_record_delta_ring_buffer_truncates_at_200(self) -> None:
        registry = self.make_registry()
        for idx in range(205):
            MODULE.record_delta(
                registry,
                "src_any",
                [{"guid": f"g-{idx}", "title": f"Title {idx}", "url": f"https://x/{idx}", "pubdate": "2026-07-13T00:00:00Z"}],
            )
        self.assertEqual(len(registry["deltas"]), MODULE.DELTA_RING_MAX)
        self.assertEqual(registry["deltas"][0]["guid"], "g-204")

    def test_pulse_snapshot_latest_five_and_trending_window(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                registry = self.make_registry()
                self.add_valid_source(
                    registry,
                    "Ops Podcast",
                    "https://example.com/ops",
                    tags={"topic": ["operations", "innovation"]},
                )
                self.add_valid_source(
                    registry,
                    "Strategy Show",
                    "https://example.com/strategy",
                    tags={
                        "topic": ["strategy"],
                        "signal": ["lagging"],
                        "authority": "practitioner",
                        "cadence": "monthly",
                        "quality": "medium",
                    },
                )
                now = datetime.now(timezone.utc)
                recent = now.strftime("%Y-%m-%dT%H:%M:%SZ")
                old = (now - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
                registry["deltas"] = [
                    {"detected_at": recent, "source_id": "src_ops-podcast", "guid": "g1", "title": "A", "url": "https://a", "pubdate": recent},
                    {"detected_at": recent, "source_id": "src_ops-podcast", "guid": "g2", "title": "B", "url": "https://b", "pubdate": recent},
                    {"detected_at": recent, "source_id": "src_strategy-show", "guid": "g3", "title": "C", "url": "https://c", "pubdate": recent},
                    {"detected_at": recent, "source_id": "src_ops-podcast", "guid": "g4", "title": "D", "url": "https://d", "pubdate": recent},
                    {"detected_at": recent, "source_id": "src_strategy-show", "guid": "g5", "title": "E", "url": "https://e", "pubdate": recent},
                    {"detected_at": recent, "source_id": "src_ops-podcast", "guid": "g6", "title": "F", "url": "https://f", "pubdate": recent},
                    {"detected_at": old, "source_id": "src_strategy-show", "guid": "g7", "title": "G", "url": "https://g", "pubdate": old},
                ]
                path = MODULE.write_pulse_snapshot(registry)
                with path.open(encoding="utf-8") as handle:
                    snapshot = json.load(handle)
                self.assertEqual(len(snapshot["latest_items"]), 5)
                self.assertEqual(snapshot["latest_items"][0]["source_name"], "Ops Podcast")
                counts = {item["topic"]: item["count"] for item in snapshot["trending_topics"]}
                self.assertEqual(counts["operations"], 4)
                self.assertEqual(counts["innovation"], 4)
                self.assertEqual(counts["strategy"], 2)

    def test_list_verticals_empty_and_populated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                self.assertEqual(MODULE.list_verticals(), [])
                one = MODULE.new_registry("nonprofit", "Nonprofit", "A")
                two = MODULE.new_registry("aec", "AEC", "B")
                MODULE.save_registry(one)
                MODULE.save_registry(two)
                self.assertEqual(MODULE.list_verticals(), ["aec", "nonprofit"])


if __name__ == "__main__":
    unittest.main()
