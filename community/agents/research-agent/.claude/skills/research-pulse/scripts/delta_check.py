from __future__ import annotations

import argparse
import calendar
import json
import os
import sys
from datetime import datetime, timezone

try:
    import feedparser
except ModuleNotFoundError:
    feedparser = None

try:
    import requests
except ModuleNotFoundError:
    requests = None

try:
    from . import pulse_registry
except ImportError:
    import pulse_registry  # type: ignore[no-redef]


DEPENDENCY_MESSAGE = "missing dependency: run pip install feedparser requests"


def fetch_feed(
    url: str,
    etag: str | None,
    last_modified: str | None,
    timeout: int = 30,
) -> tuple[int, bytes, str | None, str | None]:
    headers: dict[str, str] = {}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified

    response = requests.get(url, headers=headers, timeout=timeout)
    if response.status_code == 304:
        return 304, b"", etag, last_modified
    if response.status_code != 200:
        response.raise_for_status()
        raise RuntimeError(f"unexpected status code {response.status_code}")
    return (
        200,
        response.content,
        response.headers.get("ETag"),
        response.headers.get("Last-Modified"),
    )


def _entry_value(entry: object, key: str) -> object:
    if hasattr(entry, key):
        value = getattr(entry, key)
        if value is not None:
            return value
    if hasattr(entry, "get"):
        return entry.get(key)
    return None


def _entry_guid(entry: object) -> str | None:
    for key in ("id", "guid", "yt_videoid"):
        value = _entry_value(entry, key)
        if isinstance(value, str) and value:
            return value
    return None


def _time_struct_to_epoch(value: object) -> int | None:
    if value is None:
        return None
    try:
        return calendar.timegm(value)
    except (TypeError, ValueError):
        return None


def _epoch_to_iso(epoch: int | None) -> str:
    if epoch is None:
        return ""
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso8601(value: str | None) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_entries(body: bytes) -> list[dict]:
    parsed = feedparser.parse(body)
    ordered: list[tuple[int, int | None, dict]] = []
    undated: list[tuple[int, dict]] = []

    for index, entry in enumerate(getattr(parsed, "entries", [])):
        guid = _entry_guid(entry)
        if not guid:
            continue
        published = _entry_value(entry, "published_parsed") or _entry_value(entry, "updated_parsed")
        epoch = _time_struct_to_epoch(published)
        item = {
            "guid": guid,
            "title": _entry_value(entry, "title") or "",
            "url": _entry_value(entry, "link") or "",
            "pubdate": _epoch_to_iso(epoch),
        }
        if epoch is None:
            undated.append((index, item))
        else:
            ordered.append((index, epoch, item))

    newest_first = [item for _, _, item in sorted(ordered, key=lambda row: row[1], reverse=True)]
    newest_first.extend(item for _, item in undated)
    return newest_first


def detect_new(
    entries: list[dict],
    last_seen_guid: str | None,
    last_seen_pubdate: str | None,
) -> list[dict]:
    if not last_seen_guid and not last_seen_pubdate:
        return []

    if last_seen_guid:
        newer: list[dict] = []
        for entry in entries:
            if entry.get("guid") == last_seen_guid:
                return newer
            newer.append(entry)

    cutoff = _parse_iso8601(last_seen_pubdate)
    if cutoff is None:
        return []

    newer = []
    for entry in entries:
        entry_pubdate = _parse_iso8601(entry.get("pubdate"))
        if entry_pubdate is not None and entry_pubdate > cutoff:
            newer.append(entry)
    return newer


def poll_source(source: dict, fetch=fetch_feed) -> dict:
    source_id = str(source.get("id") or "")
    result = {
        "source_id": source_id,
        "status": "skipped",
        "new_items": [],
        "deactivated": False,
    }

    if not source.get("active", True):
        return result

    feed_url = source.get("feed_url")
    if not isinstance(feed_url, str) or not feed_url.strip():
        return result

    try:
        status_code, body, new_etag, new_last_modified = fetch(
            feed_url,
            source.get("etag"),
            source.get("last_modified"),
        )
        checked_at = pulse_registry.utc_now_iso()

        if status_code == 304:
            source["last_checked"] = checked_at
            source["consecutive_errors"] = 0
            result["status"] = "not_modified"
            return result

        entries = parse_entries(body)
        new_items = detect_new(
            entries,
            source.get("last_seen_guid"),
            source.get("last_seen_pubdate"),
        )
        source["etag"] = new_etag
        source["last_modified"] = new_last_modified
        if entries:
            source["last_seen_guid"] = entries[0]["guid"]
            source["last_seen_pubdate"] = entries[0]["pubdate"]
        source["last_checked"] = checked_at
        source["consecutive_errors"] = 0
        if new_items:
            source["last_delta"] = checked_at
        result["status"] = "changed" if new_items else "unchanged"
        result["new_items"] = new_items
        return result
    except Exception:
        source["consecutive_errors"] = int(source.get("consecutive_errors", 0) or 0) + 1
        if source["consecutive_errors"] >= 10:
            source["active"] = False
            result["deactivated"] = True
        source["last_checked"] = pulse_registry.utc_now_iso()
        result["status"] = "error"
        return result


def poll_vertical(vertical: str, dry_run: bool = False, fetch=fetch_feed) -> dict:
    registry = pulse_registry.load_registry(vertical)
    summary = {
        "vertical": vertical,
        "sources_polled": 0,
        "sources_304": 0,
        "sources_changed": 0,
        "sources_errored": 0,
        "new_deltas": 0,
        "deactivated": [],
        "error_sources": [],
        "new_items": [],
    }

    for source in registry.get("sources", []):
        result = poll_source(source, fetch=fetch)
        status = result["status"]
        if status == "skipped":
            continue

        summary["sources_polled"] += 1
        if status == "not_modified":
            summary["sources_304"] += 1
        elif status == "changed":
            summary["sources_changed"] += 1
        elif status == "error":
            summary["sources_errored"] += 1
            summary["error_sources"].append(result["source_id"])

        if result["deactivated"]:
            summary["deactivated"].append(result["source_id"])

        if result["new_items"]:
            pulse_registry.record_delta(registry, result["source_id"], result["new_items"])
            summary["new_deltas"] += len(result["new_items"])
            summary["new_items"].extend(
                {"source_id": result["source_id"], **item} for item in result["new_items"]
            )

    if not dry_run:
        pulse_registry.write_pulse_snapshot(registry)
        pulse_registry.save_registry(registry)

    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vertical")
    parser.add_argument("--state-dir")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.state_dir:
        os.environ["PULSE_STATE_DIR"] = args.state_dir

    if feedparser is None or requests is None:
        print(DEPENDENCY_MESSAGE, file=sys.stderr)
        return 1

    try:
        verticals = [args.vertical] if args.vertical else pulse_registry.list_verticals()
    except (FileNotFoundError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if not verticals:
        print("no registries found", file=sys.stderr)
        return 1

    summary = {
        "verticals_polled": 0,
        "sources_polled": 0,
        "sources_304": 0,
        "sources_changed": 0,
        "sources_errored": 0,
        "new_deltas": 0,
        "deactivated": [],
        "error_sources": [],
        "vertical_errors": [],
        "new_items": [],
    }

    for vertical in verticals:
        try:
            vertical_summary = poll_vertical(vertical, dry_run=args.dry_run)
        except Exception as exc:
            summary["vertical_errors"].append({"vertical": vertical, "error": str(exc)})
            continue

        summary["verticals_polled"] += 1
        summary["sources_polled"] += vertical_summary["sources_polled"]
        summary["sources_304"] += vertical_summary["sources_304"]
        summary["sources_changed"] += vertical_summary["sources_changed"]
        summary["sources_errored"] += vertical_summary["sources_errored"]
        summary["new_deltas"] += vertical_summary["new_deltas"]
        summary["deactivated"].extend(vertical_summary["deactivated"])
        summary["error_sources"].extend(vertical_summary["error_sources"])
        summary["new_items"].extend(
            {"vertical": vertical, **item} for item in vertical_summary["new_items"]
        )

    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
