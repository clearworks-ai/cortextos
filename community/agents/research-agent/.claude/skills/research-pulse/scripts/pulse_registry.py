from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCHEMA_VERSION = 1

DEFAULT_STATE_DIR = (
    "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/state/research-pulse"
)

SOURCE_TYPES = ("podcast", "youtube", "article", "data_feed", "report")
TOPIC_VOCAB = ("indicators", "strategy", "operations", "regulation", "innovation")
SIGNAL_VOCAB = ("leading", "coincident", "lagging", "sentiment", "macro", "micro")
AUTHORITY_VOCAB = ("academic", "industry_expert", "practitioner", "news", "vendor")
CADENCE_VOCAB = ("daily", "weekly", "monthly", "quarterly", "ad_hoc")
QUALITY_VOCAB = ("high", "medium", "emerging", "archival")

DELTA_RING_MAX = 200
PULSE_LATEST_ITEMS = 5
TRENDING_WINDOW_DAYS = 7

_SLUG_RE = re.compile(r"[a-z0-9]+")


def state_dir() -> Path:
    return Path(os.environ.get("PULSE_STATE_DIR", DEFAULT_STATE_DIR)).expanduser()


def slugify(name: str) -> str:
    slug = "-".join(_SLUG_RE.findall((name or "").lower())).strip("-")
    if not slug:
        raise ValueError("slugify() produced an empty slug")
    return slug


def registry_path(vertical: str) -> Path:
    return state_dir() / "registry" / f"{vertical}.json"


def pulse_path(vertical: str) -> Path:
    return state_dir() / "pulse" / f"{vertical}.json"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_registry(
    vertical: str,
    display_name: str,
    framing: str,
    notebook_id: str | None = None,
) -> dict:
    if vertical != slugify(vertical):
        raise ValueError("vertical must already be a slug")
    now = utc_now_iso()
    return {
        "schema_version": SCHEMA_VERSION,
        "vertical": vertical,
        "display_name": display_name,
        "framing": framing,
        "notebook_id": notebook_id,
        "framework_doc": None,
        "topic_vocab_extra": [],
        "created_at": now,
        "updated_at": now,
        "sources": [],
        "deltas": [],
    }


def _normalize_url(url: str) -> str:
    return str(url).strip().rstrip("/").lower()


def _parse_iso8601(value: str) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def validate_registry(registry: dict) -> list[str]:
    errors: list[str] = []
    if not isinstance(registry, dict):
        return ["registry must be an object"]

    if registry.get("schema_version") != SCHEMA_VERSION:
        errors.append("schema_version must equal 1")

    vertical = registry.get("vertical")
    if not isinstance(vertical, str) or not vertical:
        errors.append("vertical must be a non-empty slug")
    else:
        try:
            expected = slugify(vertical)
        except ValueError:
            errors.append("vertical must be a non-empty slug")
        else:
            if vertical != expected:
                errors.append("vertical must be a normalized slug")

    display_name = registry.get("display_name")
    if not isinstance(display_name, str) or not display_name.strip():
        errors.append("display_name must be non-empty")

    extra_topics = registry.get("topic_vocab_extra", [])
    if not isinstance(extra_topics, list) or any(
        not isinstance(topic, str) or not topic.strip() for topic in extra_topics
    ):
        errors.append("topic_vocab_extra must be a list of non-empty strings")
        extra_topics = []
    allowed_topics = set(TOPIC_VOCAB) | {topic.strip() for topic in extra_topics}

    sources = registry.get("sources", [])
    if not isinstance(sources, list):
        errors.append("sources must be a list")
        sources = []

    deltas = registry.get("deltas", [])
    if not isinstance(deltas, list):
        errors.append("deltas must be a list")
        deltas = []
    if len(deltas) > DELTA_RING_MAX:
        errors.append(f"deltas exceeds max length {DELTA_RING_MAX}")

    seen_ids: set[str] = set()
    seen_urls: dict[str, str] = {}

    for index, source in enumerate(sources):
        if not isinstance(source, dict):
            errors.append(f"source[{index}] must be an object")
            continue

        source_id = source.get("id")
        if not isinstance(source_id, str) or not source_id:
            errors.append(f"source[{index}] id must be non-empty")
        else:
            if not source_id.startswith("src_"):
                errors.append(f"source[{index}] id must start with src_")
            if source_id in seen_ids:
                errors.append(f"source[{index}] duplicate id: {source_id}")
            seen_ids.add(source_id)

        url = source.get("url")
        if not isinstance(url, str) or not url.strip():
            errors.append(f"source[{index}] url must be non-empty")
        else:
            normalized_url = _normalize_url(url)
            if normalized_url in seen_urls:
                errors.append(
                    f"source[{index}] duplicate url: {url} matches {seen_urls[normalized_url]}"
                )
            else:
                seen_urls[normalized_url] = url

        source_type = source.get("source_type")
        if source_type not in SOURCE_TYPES:
            errors.append(f"source[{index}] invalid source_type: {source_type}")

        if source_type in ("podcast", "youtube"):
            feed_url = source.get("feed_url")
            if not isinstance(feed_url, str) or not feed_url.strip():
                errors.append(f"source[{index}] feed_url required for pollable source types")

        tags = source.get("tags")
        if not isinstance(tags, dict):
            errors.append(f"source[{index}] tags must be an object")
            continue

        topic_tags = tags.get("topic")
        if not isinstance(topic_tags, list) or not topic_tags:
            errors.append(f"source[{index}] tags.topic must be a non-empty list")
        else:
            invalid_topics = [
                topic for topic in topic_tags if not isinstance(topic, str) or topic not in allowed_topics
            ]
            if invalid_topics:
                errors.append(f"source[{index}] invalid topic tags: {invalid_topics}")

        signal_tags = tags.get("signal")
        if not isinstance(signal_tags, list) or not signal_tags:
            errors.append(f"source[{index}] tags.signal must be a non-empty list")
        else:
            invalid_signals = [
                signal
                for signal in signal_tags
                if not isinstance(signal, str) or signal not in SIGNAL_VOCAB
            ]
            if invalid_signals:
                errors.append(f"source[{index}] invalid signal tags: {invalid_signals}")

        if tags.get("authority") not in AUTHORITY_VOCAB:
            errors.append(f"source[{index}] invalid authority tag: {tags.get('authority')}")
        if tags.get("cadence") not in CADENCE_VOCAB:
            errors.append(f"source[{index}] invalid cadence tag: {tags.get('cadence')}")
        if tags.get("quality") not in QUALITY_VOCAB:
            errors.append(f"source[{index}] invalid quality tag: {tags.get('quality')}")

    return errors


def atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            dir=path.parent,
            delete=False,
            encoding="utf-8",
        ) as handle:
            tmp_path = Path(handle.name)
            json.dump(data, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
        tmp_path = None
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink()


def load_registry(vertical: str) -> dict:
    path = registry_path(vertical)
    if not path.exists():
        raise FileNotFoundError(f"registry not found: {path}")
    with path.open(encoding="utf-8") as handle:
        registry = json.load(handle)
    errors = validate_registry(registry)
    if errors:
        raise ValueError(f"registry invalid: {'; '.join(errors)}")
    return registry


def save_registry(registry: dict) -> Path:
    errors = validate_registry(registry)
    if errors:
        raise ValueError(f"registry invalid: {'; '.join(errors)}")
    registry["updated_at"] = utc_now_iso()
    path = registry_path(registry["vertical"])
    atomic_write_json(path, registry)
    return path


def list_verticals() -> list[str]:
    directory = state_dir() / "registry"
    if not directory.exists():
        return []
    return sorted(path.stem for path in directory.glob("*.json"))


def add_source(
    registry: dict,
    *,
    source_name: str,
    url: str,
    source_type: str,
    tags: dict,
    feed_url: str | None = None,
    industry: list[str] | None = None,
    notebooklm_source_id: str | None = None,
) -> dict:
    normalized_url = _normalize_url(url)
    for source in registry.get("sources", []):
        if _normalize_url(source.get("url", "")) == normalized_url:
            raise ValueError(f"duplicate url: {url}")

    base_id = f"src_{slugify(source_name)}"
    source_id = base_id
    existing_ids = {source.get("id") for source in registry.get("sources", [])}
    suffix = 2
    while source_id in existing_ids:
        source_id = f"{base_id}-{suffix}"
        suffix += 1

    source = {
        "id": source_id,
        "source_name": source_name,
        "url": url,
        "feed_url": feed_url,
        "source_type": source_type,
        "industry": list(industry or [registry["vertical"]]),
        "tags": {
            "topic": list(tags.get("topic", [])),
            "signal": list(tags.get("signal", [])),
            "authority": tags.get("authority"),
            "cadence": tags.get("cadence"),
            "quality": tags.get("quality"),
        },
        "notebooklm_source_id": notebooklm_source_id,
        "etag": None,
        "last_modified": None,
        "last_seen_guid": None,
        "last_seen_pubdate": None,
        "last_checked": None,
        "last_delta": None,
        "consecutive_errors": 0,
        "active": True,
    }
    registry.setdefault("sources", []).append(source)
    return source


def record_delta(registry: dict, source_id: str, items: list[dict]) -> None:
    detected_at = utc_now_iso()
    entries = [
        {
            "detected_at": detected_at,
            "source_id": source_id,
            "guid": item["guid"],
            "title": item["title"],
            "url": item["url"],
            "pubdate": item["pubdate"],
        }
        for item in items
    ]
    registry["deltas"] = (entries + list(registry.get("deltas", [])))[:DELTA_RING_MAX]


def write_pulse_snapshot(registry: dict) -> Path:
    source_lookup = {
        source.get("id"): source for source in registry.get("sources", []) if isinstance(source, dict)
    }

    latest_items = []
    for item in registry.get("deltas", [])[:PULSE_LATEST_ITEMS]:
        source = source_lookup.get(item.get("source_id"), {})
        latest_items.append(
            {
                "title": item.get("title"),
                "url": item.get("url"),
                "source_name": source.get("source_name", "unknown"),
                "pubdate": item.get("pubdate"),
            }
        )

    cutoff = datetime.now(timezone.utc) - timedelta(days=TRENDING_WINDOW_DAYS)
    topic_counts: dict[str, int] = {}
    for item in registry.get("deltas", []):
        detected_at = _parse_iso8601(item.get("detected_at"))
        if detected_at is None or detected_at < cutoff:
            continue
        source = source_lookup.get(item.get("source_id"))
        if not source:
            continue
        for topic in source.get("tags", {}).get("topic", []):
            topic_counts[topic] = topic_counts.get(topic, 0) + 1

    trending_topics = [
        {"topic": topic, "count": count}
        for topic, count in sorted(topic_counts.items(), key=lambda item: (-item[1], item[0]))[:6]
    ]

    snapshot = {
        "schema_version": SCHEMA_VERSION,
        "vertical": registry.get("vertical"),
        "display_name": registry.get("display_name"),
        "generated_at": utc_now_iso(),
        "source_count": len(registry.get("sources", [])),
        "active_source_count": sum(1 for source in registry.get("sources", []) if source.get("active")),
        "notebook_id": registry.get("notebook_id"),
        "framework_doc": registry.get("framework_doc"),
        "latest_items": latest_items,
        "trending_topics": trending_topics,
        "errors": sum(
            1
            for source in registry.get("sources", [])
            if isinstance(source, dict) and int(source.get("consecutive_errors", 0)) >= 3
        ),
    }
    path = pulse_path(registry["vertical"])
    atomic_write_json(path, snapshot)
    return path

