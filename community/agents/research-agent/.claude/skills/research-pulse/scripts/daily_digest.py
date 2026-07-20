from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from . import pulse_registry
except ImportError:
    import pulse_registry  # type: ignore[no-redef]


VERTICAL_DEFAULT = "aec"
INBOX_PATH = pulse_registry.state_dir() / "inbox.jsonl"
POOL_PATH = pulse_registry.state_dir() / "owner_voice_pool.json"
PULSE_DIR = pulse_registry.state_dir() / "pulse"
SPEND_TOPIC = "construction_spending"
TITLE_FILTERS = {"src_u-s-census-construction-spending": ["construction"]}
ISO8601_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def _inbox_path() -> Path:
    return pulse_registry.state_dir() / INBOX_PATH.name


def _pool_path() -> Path:
    return pulse_registry.state_dir() / POOL_PATH.name


def _pulse_dir() -> Path:
    return pulse_registry.state_dir() / PULSE_DIR.name


def _parse_iso8601(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.strptime(value, ISO8601_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _path_or_default(path: Path, default_path: Path, current_path: Path) -> Path:
    if path == default_path:
        return current_path
    return path


def quote_id(quote: str) -> str:
    return hashlib.sha1(quote.encode("utf-8")).hexdigest()[:12]


def load_inbox(
    vertical: str = VERTICAL_DEFAULT,
    since_hours: int = 24,
    now: datetime | None = None,
) -> list[dict]:
    path = _inbox_path()
    if not path.exists():
        return []

    now_dt = now or datetime.now(timezone.utc)
    cutoff = now_dt - timedelta(hours=since_hours)
    kept: list[tuple[datetime, datetime, dict]] = []

    with path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if not isinstance(item, dict) or item.get("vertical") != vertical:
                continue
            ingested_at = _parse_iso8601(item.get("ingested_at"))
            if ingested_at is None or ingested_at < cutoff:
                continue
            pubdate = _parse_iso8601(item.get("pubdate")) or ingested_at
            kept.append((pubdate, ingested_at, item))

    kept.sort(key=lambda row: (row[0], row[1]), reverse=True)
    return [item for _, _, item in kept]


def bucketize(items: list[dict], registry: dict) -> dict[str, list[dict]]:
    source_lookup = {
        source.get("id"): source
        for source in registry.get("sources", [])
        if isinstance(source, dict) and isinstance(source.get("id"), str)
    }
    buckets = {"industry_news": [], "spend_confidence": []}
    seen_guids: set[str] = set()

    for item in items:
        source_id = str(item.get("source_id") or "")
        source = source_lookup.get(source_id)
        if source is None or not source.get("active", True):
            continue

        title = str(item.get("title") or "")
        filters = TITLE_FILTERS.get(source_id)
        if filters and not any(keyword.lower() in title.lower() for keyword in filters):
            continue

        guid = str(item.get("guid") or "")
        if guid:
            if guid in seen_guids:
                continue
            seen_guids.add(guid)

        tags = source.get("tags", {})
        topics = set(tags.get("topic", []))
        signals = set(tags.get("signal", []))
        bucket_name = (
            "spend_confidence"
            if SPEND_TOPIC in topics or ("indicators" in topics and "macro" in signals)
            else "industry_news"
        )
        if len(buckets[bucket_name]) >= 6:
            continue

        buckets[bucket_name].append(
            {
                "title": title,
                "url": str(item.get("url") or ""),
                "source_name": str(source.get("source_name") or source_id or "unknown"),
                "source_id": source_id,
                "pubdate": str(item.get("pubdate") or ""),
            }
        )

    return buckets


def load_pool(path: Path = POOL_PATH) -> dict:
    resolved = _path_or_default(path, POOL_PATH, _pool_path())
    if not resolved.exists():
        return {"quotes": [], "surfaced": []}
    with resolved.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        return {"quotes": [], "surfaced": []}
    payload.setdefault("quotes", [])
    payload.setdefault("surfaced", [])
    return payload


def rotate_owner_voice(pool: dict, count: int = 1, save: bool = True) -> list[dict]:
    quotes = [quote for quote in pool.get("quotes", []) if isinstance(quote, dict)]
    if not quotes or count <= 0:
        return []

    surfaced = [
        value for value in pool.get("surfaced", []) if isinstance(value, str) and value
    ]
    available = [
        quote for quote in quotes if quote_id(str(quote.get("quote") or "")) not in surfaced
    ]
    if len(available) < count:
        surfaced = []
        pool["surfaced"] = []
        available = list(quotes)

    chosen = available[:count]
    surfaced.extend(quote_id(str(quote.get("quote") or "")) for quote in chosen)
    pool["surfaced"] = surfaced

    if save:
        pulse_registry.atomic_write_json(_pool_path(), pool)

    return chosen


def build_digest(
    vertical: str = VERTICAL_DEFAULT,
    since_hours: int = 24,
    now: datetime | None = None,
    rotate: bool = True,
) -> dict:
    digest_now = now or datetime.now(timezone.utc)
    registry = pulse_registry.load_registry(vertical)
    buckets = bucketize(load_inbox(vertical, since_hours, digest_now), registry)
    buckets["owner_voice"] = rotate_owner_voice(load_pool(), count=1, save=rotate)
    return {
        "digest_date": digest_now.strftime("%Y-%m-%d"),
        "generated_at": pulse_registry.utc_now_iso(),
        "vertical": vertical,
        "since_hours": since_hours,
        "buckets": buckets,
    }


def render_telegram(digest: dict) -> str:
    lines = [f"🏗️ **AEC Daily Digest** | {digest['digest_date']}", ""]
    bucket_specs = [
        ("industry_news", "📰 **INDUSTRY** (firm-scale news)"),
        ("spend_confidence", "💰 **SPEND CONFIDENCE**"),
        ("owner_voice", "🎙️ **OWNER VOICE** (from AEC Pulse research corpus)"),
    ]

    for key, header in bucket_specs:
        lines.append(header)
        items = list(digest.get("buckets", {}).get(key, []))
        if not items:
            lines.append("• (no new items in window)")
            lines.append("")
            continue

        if key == "owner_voice":
            for item in items:
                quote = str(item.get("quote") or "").strip()
                speaker = str(item.get("speaker") or "unknown").strip()
                lines.append(f'> "{quote}" — {speaker}')
        else:
            for item in items:
                title = str(item.get("title") or "").strip()
                source_name = str(item.get("source_name") or "unknown").strip()
                pubdate = str(item.get("pubdate") or "").strip()
                published = pubdate[:10] if len(pubdate) >= 10 else "unknown date"
                lines.append(f"• {title} ({source_name}, {published})")
        lines.append("")

    return "\n".join(lines).rstrip()


def write_pulse_file(digest: dict) -> Path:
    path = _pulse_dir() / f"{digest['digest_date']}.json"
    pulse_registry.atomic_write_json(path, digest)
    return path


def _parse_digest_date(value: str) -> datetime:
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError(f"invalid --date {value!r}; expected YYYY-MM-DD") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vertical", default=VERTICAL_DEFAULT)
    parser.add_argument("--since-hours", type=int, default=24)
    parser.add_argument("--date")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--state-dir")
    args = parser.parse_args(argv)

    if args.state_dir:
        os.environ["PULSE_STATE_DIR"] = args.state_dir

    try:
        now = _parse_digest_date(args.date) if args.date else None
        digest = build_digest(
            vertical=args.vertical,
            since_hours=args.since_hours,
            now=now,
            rotate=not args.dry_run,
        )
        if not args.dry_run:
            write_pulse_file(digest)
        print(render_telegram(digest))
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
