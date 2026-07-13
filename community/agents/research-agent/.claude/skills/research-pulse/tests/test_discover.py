from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import discover as MODULE


class FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class DiscoverTests(unittest.TestCase):
    def load_fixture(self, name: str) -> dict:
        with (FIXTURES / name).open(encoding="utf-8") as handle:
            return json.load(handle)

    def test_auth_headers_known_vector(self) -> None:
        headers = MODULE.podcastindex_auth_headers("k", "s", now=1000)
        self.assertEqual(headers["X-Auth-Date"], "1000")
        self.assertEqual(headers["X-Auth-Key"], "k")
        self.assertEqual(headers["Authorization"], "80d100de6a5dda54a93eb6e584f01f4d77a7b948")

    def test_search_podcastindex_maps_fixture(self) -> None:
        fixture = self.load_fixture("podcastindex_search.json")
        fake_requests = unittest.mock.Mock()
        fake_requests.get.return_value = FakeResponse(fixture)
        with unittest.mock.patch.object(MODULE, "requests", fake_requests):
            results = MODULE.search_podcastindex("nonprofit operations", 3, "key", "secret")
        self.assertGreaterEqual(len(results), 3)
        self.assertEqual(results[0]["source_type"], "podcast")
        self.assertEqual(results[0]["provider"], "podcastindex")
        self.assertIn("episode_count", results[0]["meta"])

    def test_search_youtube_api_maps_fixture(self) -> None:
        fixture = self.load_fixture("youtube_channel_search.json")
        fake_requests = unittest.mock.Mock()
        fake_requests.get.return_value = FakeResponse(fixture)
        with unittest.mock.patch.object(MODULE, "requests", fake_requests):
            results = MODULE.search_youtube_channels("nonprofit operations", 3, api_key="yt-key")
        self.assertGreaterEqual(len(results), 3)
        self.assertEqual(results[0]["source_type"], "youtube")
        self.assertEqual(results[0]["provider"], "youtube_api")
        self.assertIn("feeds/videos.xml?channel_id=", results[0]["feed_url"])

    def test_youtube_fallback_uses_ytdlp(self) -> None:
        payloads = "\n".join(
            [
                json.dumps({"channel_id": "chan-1", "channel": "Alpha", "title": "Video A"}),
                json.dumps({"channel_id": "chan-1", "channel": "Alpha", "title": "Video B"}),
                json.dumps({"channel_id": "chan-2", "channel": "Bravo", "title": "Video C"}),
                json.dumps({"channel_id": "chan-3", "channel": "Charlie", "title": "Video D"}),
            ]
        )

        def fake_run(args: list[str], **_: object) -> subprocess.CompletedProcess:
            self.assertIn("yt-dlp", args[0])
            return subprocess.CompletedProcess(args, 0, stdout=payloads, stderr="")

        with unittest.mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/yt-dlp"):
            with unittest.mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                results = MODULE.search_youtube_channels("query", 2, api_key=None)
        self.assertEqual(len(results), 2)
        self.assertEqual([item["source_name"] for item in results], ["Alpha", "Bravo"])
        self.assertTrue(all("feeds/videos.xml?channel_id=" in item["feed_url"] for item in results))

    def test_curated_sites_filtered_by_vertical(self) -> None:
        aec = MODULE.curated_indicator_sites("aec", ["commercial construction"])
        nonprofit = MODULE.curated_indicator_sites("nonprofit", ["nonprofit operations"])
        aec_names = {item["source_name"] for item in aec}
        nonprofit_names = {item["source_name"] for item in nonprofit}
        self.assertIn("Engineering News-Record", aec_names)
        self.assertTrue(any("Dodge" in name for name in aec_names))
        self.assertIn("ProPublica Nonprofit Explorer", nonprofit_names)
        self.assertIn("FRED", aec_names)
        self.assertIn("FRED", nonprofit_names)

    def test_dedupe_candidates_url_normalization(self) -> None:
        deduped = MODULE.dedupe_candidates(
            [
                {"url": "https://example.com/source/", "source_name": "One"},
                {"url": "HTTPS://EXAMPLE.COM/source", "source_name": "Two"},
                {"url": "https://example.com/other", "source_name": "Three"},
            ]
        )
        self.assertEqual([item["source_name"] for item in deduped], ["One", "Three"])

    def test_main_with_mocked_fixtures_writes_candidates_file(self) -> None:
        podcast_fixture = self.load_fixture("podcastindex_search.json")
        youtube_fixture = self.load_fixture("youtube_channel_search.json")
        podcast_results = [
            {
                "source_name": feed["title"],
                "url": feed["link"],
                "feed_url": feed["url"],
                "source_type": "podcast",
                "provider": "podcastindex",
                "meta": {"episode_count": feed["episodeCount"]},
            }
            for feed in podcast_fixture["feeds"]
        ]
        youtube_results = [
            {
                "source_name": item["snippet"]["channelTitle"],
                "url": f"https://www.youtube.com/channel/{item['id']['channelId']}",
                "feed_url": f"https://www.youtube.com/feeds/videos.xml?channel_id={item['id']['channelId']}",
                "source_type": "youtube",
                "provider": "youtube_api",
                "meta": {"description": item["snippet"]["description"]},
            }
            for item in youtube_fixture["items"]
        ]
        with tempfile.TemporaryDirectory() as tmp:
            out_path = Path(tmp) / "candidates.json"
            with unittest.mock.patch.dict(
                os.environ,
                {
                    "PODCASTINDEX_API_KEY": "pod-key",
                    "PODCASTINDEX_API_SECRET": "pod-secret",
                    "YOUTUBE_API_KEY": "yt-key",
                },
                clear=True,
            ):
                with unittest.mock.patch.object(MODULE, "requests", object()):
                    with unittest.mock.patch.object(
                        MODULE,
                        "search_podcastindex",
                        return_value=podcast_results,
                    ):
                        with unittest.mock.patch.object(
                            MODULE,
                            "search_youtube_channels",
                            return_value=youtube_results,
                        ):
                            rc = MODULE.main(
                                [
                                    "--vertical",
                                    "nonprofit",
                                    "--query",
                                    "nonprofit operations",
                                    "--out",
                                    str(out_path),
                                ]
                            )
            self.assertEqual(rc, 0)
            payload = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["vertical"], "nonprofit")
            self.assertGreaterEqual(
                len([item for item in payload["candidates"] if item["source_type"] == "podcast"]),
                3,
            )
            self.assertGreaterEqual(
                len([item for item in payload["candidates"] if item["source_type"] == "youtube"]),
                3,
            )
            self.assertGreaterEqual(
                len([item for item in payload["candidates"] if item["provider"] == "curated"]),
                2,
            )

    def test_degraded_run_without_keys_exit_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_path = Path(tmp) / "candidates.json"
            with unittest.mock.patch.dict(os.environ, {}, clear=True):
                with unittest.mock.patch.object(MODULE, "requests", object()):
                    with unittest.mock.patch.object(MODULE.shutil, "which", return_value=None):
                        rc = MODULE.main(
                            [
                                "--vertical",
                                "nonprofit",
                                "--query",
                                "nonprofit operations",
                                "--out",
                                str(out_path),
                            ]
                        )
            self.assertEqual(rc, 0)
            payload = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertGreaterEqual(len(payload["candidates"]), 2)
            self.assertEqual(len(payload["degraded"]), 2)


if __name__ == "__main__":
    unittest.main()
