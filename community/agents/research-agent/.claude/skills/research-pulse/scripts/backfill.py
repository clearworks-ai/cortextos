from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    from . import pulse_registry
    from . import seed_notebook
except ImportError:
    import pulse_registry  # type: ignore[no-redef]
    import seed_notebook  # type: ignore[no-redef]


_YOUTUBE_CHANNEL_RE = re.compile(r"https?://(?:www\.)?youtube\.com/channel/([^/?#]+)", re.IGNORECASE)
_PODCAST_HOST_MARKERS = (
    "anchor.fm",
    "libsyn",
    "buzzsprout",
    "transistor.fm",
    "simplecast",
    "megaphone",
)
_TITLE_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _normalize_title(title: str) -> str:
    return " ".join(_TITLE_TOKEN_RE.findall(str(title).lower()))


def infer_source_type(url: str, title: str) -> str:
    del title
    lower_url = str(url or "").lower()
    if "youtube.com" in lower_url or "youtu.be" in lower_url:
        return "youtube"
    if any(domain in lower_url for domain in ("fred.stlouisfed.org", "bls.gov", "census.gov")):
        return "data_feed"
    if lower_url.split("?", 1)[0].endswith(".pdf"):
        return "report"
    if (
        "/feed" in lower_url
        or ".rss" in lower_url
        or ".xml" in lower_url
        or "podcast" in lower_url
        or any(host in lower_url for host in _PODCAST_HOST_MARKERS)
    ):
        return "podcast"
    return "article"


def infer_feed_url(url: str, source_type: str) -> str | None:
    lower_url = str(url or "").lower()
    if source_type == "youtube":
        match = _YOUTUBE_CHANNEL_RE.match(str(url or ""))
        if match:
            return f"https://www.youtube.com/feeds/videos.xml?channel_id={match.group(1)}"
        return None
    if source_type == "podcast":
        if "/feed" in lower_url or ".rss" in lower_url or ".xml" in lower_url:
            return url
        return None
    return None


def stub_tags(source_type: str) -> dict:
    del source_type
    return {
        "topic": ["indicators"],
        "signal": ["sentiment"],
        "authority": "practitioner",
        "cadence": "ad_hoc",
        "quality": "emerging",
    }


def backfill(
    vertical: str,
    display_name: str,
    framing: str,
    notebook_id: str,
    framework_doc: str | None,
    merge: bool,
) -> dict:
    path = pulse_registry.registry_path(vertical)
    if path.exists():
        if not merge:
            raise FileExistsError(f"registry already exists: {path}; rerun with --merge to append only new sources")
        registry = pulse_registry.load_registry(vertical)
    else:
        registry = pulse_registry.new_registry(vertical, display_name, framing, notebook_id=notebook_id)

    registry["display_name"] = display_name
    registry["framing"] = framing
    registry["notebook_id"] = notebook_id
    if framework_doc is not None:
        registry["framework_doc"] = framework_doc

    payload = seed_notebook.nlm("source", "list", "--notebook", notebook_id)
    sources = payload.get("sources") or []
    existing_ids = {
        source.get("notebooklm_source_id")
        for source in registry.get("sources", [])
        if source.get("notebooklm_source_id")
    }
    existing_titles = {
        _normalize_title(source.get("source_name", ""))
        for source in registry.get("sources", [])
        if source.get("source_name")
    }

    added = 0
    skipped = 0
    placeholder_urls = 0

    for item in sources:
        if not isinstance(item, dict):
            continue
        source_id = item.get("source_id") or item.get("id")
        if not isinstance(source_id, str) or not source_id:
            continue
        title = item.get("title") or item.get("source_name") or source_id
        normalized_title = _normalize_title(title)
        if source_id in existing_ids or (normalized_title and normalized_title in existing_titles):
            skipped += 1
            continue

        raw_url = item.get("url") or item.get("source_url") or item.get("link")
        if isinstance(raw_url, str) and raw_url.strip():
            url = raw_url.strip()
            is_placeholder = False
        else:
            url = f"notebooklm://{source_id}"
            is_placeholder = True
            placeholder_urls += 1

        source_type = infer_source_type(url, title)
        feed_url = infer_feed_url(url, source_type)
        try:
            pulse_registry.add_source(
                registry,
                source_name=title,
                url=url,
                source_type=source_type,
                feed_url=feed_url,
                tags=stub_tags(source_type),
                notebooklm_source_id=source_id,
            )
        except ValueError as exc:
            if "duplicate url" in str(exc):
                skipped += 1
                continue
            raise

        if is_placeholder:
            registry["sources"][-1]["tags"]["quality"] = "emerging"
        added += 1
        existing_ids.add(source_id)
        existing_titles.add(normalized_title)

    pulse_registry.save_registry(registry)
    pulse_registry.write_pulse_snapshot(registry)
    return {
        "vertical": vertical,
        "added": added,
        "skipped": skipped,
        "placeholder_urls": placeholder_urls,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vertical", required=True)
    parser.add_argument("--display-name", required=True)
    parser.add_argument("--framing", required=True)
    parser.add_argument("--notebook-id", required=True)
    parser.add_argument("--framework-doc")
    parser.add_argument("--merge", action="store_true")
    args = parser.parse_args(argv)

    try:
        summary = backfill(
            vertical=args.vertical,
            display_name=args.display_name,
            framing=args.framing,
            notebook_id=args.notebook_id,
            framework_doc=args.framework_doc,
            merge=args.merge,
        )
    except FileExistsError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

