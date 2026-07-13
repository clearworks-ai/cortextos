from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote_plus

try:
    import requests
except ModuleNotFoundError:
    requests = None

try:
    from . import pulse_registry
except ImportError:
    import pulse_registry  # type: ignore[no-redef]


CURATED_SITES = [
    {
        "source_name": "FRED",
        "url": "https://fred.stlouisfed.org",
        "feed_url": None,
        "source_type": "data_feed",
        "verticals": ["any"],
        "meta": {"focus": "macro indicators and time-series releases"},
    },
    {
        "source_name": "BLS",
        "url": "https://www.bls.gov",
        "feed_url": None,
        "source_type": "data_feed",
        "verticals": ["any"],
        "meta": {"focus": "labor, wages, and inflation indicators"},
    },
    {
        "source_name": "U.S. Census Construction Spending",
        "url": "https://www.census.gov/construction/c30/current/index.html",
        "feed_url": None,
        "source_type": "data_feed",
        "verticals": ["aec"],
        "meta": {"focus": "construction spending releases"},
    },
    {
        "source_name": "Engineering News-Record",
        "url": "https://www.enr.com",
        "feed_url": "https://www.enr.com/rss",
        "source_type": "article",
        "verticals": ["aec"],
        "meta": {"focus": "construction projects, rankings, and market news"},
    },
    {
        "source_name": "Construction Dive",
        "url": "https://www.constructiondive.com",
        "feed_url": "https://www.constructiondive.com/feeds/news/",
        "source_type": "article",
        "verticals": ["aec"],
        "meta": {"focus": "industry news and regulation"},
    },
    {
        "source_name": "Dodge / Architecture Billings Index",
        "url": "https://www.construction.com/products/dodge-construction-network",
        "feed_url": None,
        "source_type": "report",
        "verticals": ["aec"],
        "meta": {"focus": "AEC pipeline and billings indicators"},
    },
    {
        "source_name": "GuideStar / Candid",
        "url": "https://www.guidestar.org",
        "feed_url": None,
        "source_type": "data_feed",
        "verticals": ["nonprofit"],
        "meta": {"focus": "nonprofit filings and organization profiles"},
    },
    {
        "source_name": "ProPublica Nonprofit Explorer",
        "url": "https://projects.propublica.org/nonprofits/",
        "feed_url": None,
        "source_type": "data_feed",
        "verticals": ["nonprofit"],
        "meta": {"focus": "IRS filings and nonprofit financial indicators"},
    },
]


def _require_requests():
    if requests is None:
        raise RuntimeError("pip install requests feedparser")
    return requests


def _normalize_url(url: str) -> str:
    return str(url).strip().rstrip("/").lower()


def podcastindex_auth_headers(
    api_key: str,
    api_secret: str,
    now: int | None = None,
) -> dict[str, str]:
    auth_date = str(int(time.time() if now is None else now))
    digest = hashlib.sha1(f"{api_key}{api_secret}{auth_date}".encode("utf-8")).hexdigest()
    return {
        "X-Auth-Date": auth_date,
        "X-Auth-Key": api_key,
        "Authorization": digest,
        "User-Agent": "clearworks-research-pulse/1.0",
    }


def search_podcastindex(
    query: str,
    limit: int,
    api_key: str,
    api_secret: str,
    timeout: int = 20,
) -> list[dict]:
    requests_mod = _require_requests()
    response = requests_mod.get(
        "https://api.podcastindex.org/api/1.0/search/byterm",
        params={"q": query, "max": limit},
        headers=podcastindex_auth_headers(api_key, api_secret),
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    candidates = []
    for feed in payload.get("feeds", []):
        feed_url = feed.get("url")
        if not feed_url:
            continue
        categories = feed.get("categories") or {}
        if isinstance(categories, dict):
            categories = list(categories.values())
        elif not isinstance(categories, list):
            categories = []
        candidates.append(
            {
                "source_name": feed.get("title") or feed_url,
                "url": feed.get("link") or feed_url,
                "feed_url": feed_url,
                "source_type": "podcast",
                "provider": "podcastindex",
                "meta": {
                    "episode_count": feed.get("episodeCount"),
                    "categories": categories,
                },
            }
        )
    return candidates


def search_youtube_channels(
    query: str,
    limit: int,
    api_key: str | None,
    timeout: int = 30,
) -> list[dict]:
    if api_key:
        requests_mod = _require_requests()
        response = requests_mod.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet",
                "type": "channel",
                "maxResults": limit,
                "q": query,
                "key": api_key,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
        candidates = []
        for item in payload.get("items", []):
            channel_id = (item.get("id") or {}).get("channelId")
            snippet = item.get("snippet") or {}
            if not channel_id:
                continue
            candidates.append(
                {
                    "source_name": snippet.get("channelTitle") or snippet.get("title") or channel_id,
                    "url": f"https://www.youtube.com/channel/{channel_id}",
                    "feed_url": f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}",
                    "source_type": "youtube",
                    "provider": "youtube_api",
                    "meta": {"description": snippet.get("description", "")},
                }
            )
        return candidates

    if not shutil.which("yt-dlp"):
        raise RuntimeError("yt-dlp not found on PATH. Install with: pip install yt-dlp")

    result = subprocess.run(
        [
            "yt-dlp",
            f"ytsearch{limit * 2}:{query}",
            "--flat-playlist",
            "--dump-json",
            "--no-download",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    seen: dict[str, dict] = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        channel_id = item.get("channel_id") or item.get("uploader_id")
        if not channel_id or channel_id in seen:
            continue
        seen[channel_id] = {
            "source_name": item.get("channel") or item.get("uploader") or channel_id,
            "url": f"https://www.youtube.com/channel/{channel_id}",
            "feed_url": f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}",
            "source_type": "youtube",
            "provider": "yt_dlp",
            "meta": {"description": item.get("description", ""), "sample_video": item.get("title")},
        }
        if len(seen) >= limit:
            break
    return list(seen.values())


def curated_indicator_sites(vertical: str, queries: list[str]) -> list[dict]:
    candidates = []
    for entry in CURATED_SITES:
        if vertical not in entry["verticals"] and "any" not in entry["verticals"]:
            continue
        candidates.append(
            {
                "source_name": entry["source_name"],
                "url": entry["url"],
                "feed_url": entry["feed_url"],
                "source_type": entry["source_type"],
                "provider": "curated",
                "meta": dict(entry["meta"]),
            }
        )

    if queries:
        candidates.append(
            {
                "source_name": f"Feedspot directory for {vertical}",
                "url": f"https://podcast.feedspot.com/search/?q={quote_plus(queries[0])}",
                "feed_url": None,
                "source_type": "article",
                "provider": "curated",
                "meta": {"focus": "directory starting point for manual source expansion"},
            }
        )
    return candidates


def dedupe_candidates(candidates: list[dict]) -> list[dict]:
    deduped = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized_url = _normalize_url(candidate.get("url", ""))
        if not normalized_url or normalized_url in seen:
            continue
        seen.add(normalized_url)
        deduped.append(candidate)
    return deduped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vertical", required=True)
    parser.add_argument("--query", action="append", required=True)
    parser.add_argument("--podcasts", type=int, default=15)
    parser.add_argument("--channels", type=int, default=10)
    parser.add_argument("--out")
    args = parser.parse_args(argv)

    try:
        pulse_registry.slugify(args.vertical)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if requests is None:
        print("pip install requests feedparser", file=sys.stderr)
        return 1

    degraded: list[str] = []
    provider_errors: list[str] = []
    candidates: list[dict] = []

    api_key = os.environ.get("PODCASTINDEX_API_KEY", "").strip()
    api_secret = os.environ.get("PODCASTINDEX_API_SECRET", "").strip()
    if not api_key or not api_secret:
        degraded.append("podcastindex: PODCASTINDEX_API_KEY/PODCASTINDEX_API_SECRET not set")
    else:
        for query in args.query:
            try:
                candidates.extend(
                    search_podcastindex(query, args.podcasts, api_key=api_key, api_secret=api_secret)
                )
            except Exception as exc:
                message = f"podcastindex: {exc}"
                print(message, file=sys.stderr)
                degraded.append(message)
                provider_errors.append(message)

    youtube_api_key = os.environ.get("YOUTUBE_API_KEY", "").strip() or None
    if youtube_api_key or shutil.which("yt-dlp"):
        for query in args.query:
            try:
                candidates.extend(
                    search_youtube_channels(query, args.channels, api_key=youtube_api_key)
                )
            except Exception as exc:
                message = f"youtube: {exc}"
                print(message, file=sys.stderr)
                degraded.append(message)
                provider_errors.append(message)
    else:
        degraded.append("youtube: YOUTUBE_API_KEY not set and yt-dlp not available")

    candidates.extend(curated_indicator_sites(args.vertical, args.query))
    output = {
        "vertical": args.vertical,
        "generated_at": pulse_registry.utc_now_iso(),
        "queries": args.query,
        "degraded": degraded,
        "candidates": dedupe_candidates(candidates),
    }

    out_path = Path(args.out or f"/tmp/pulse-candidates-{args.vertical}.json")
    pulse_registry.atomic_write_json(out_path, output)

    if not output["candidates"] and provider_errors:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

