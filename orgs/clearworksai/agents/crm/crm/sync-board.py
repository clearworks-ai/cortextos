#!/usr/bin/env python3
"""Reverse-sync live CRM board changes back into pipeline.json."""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


LOGGER = logging.getLogger(__name__)
CRM_DIR = Path(__file__).resolve().parent
PIPELINE_PATH = CRM_DIR / "pipeline.json"
DEFAULT_BRIEFS_BASE_URL = "https://briefs-production-b399.up.railway.app"
SLUGIFY_RE = re.compile(r"[^a-z0-9]+")
JsonObject = dict[str, Any]
Urlopen = Callable[..., Any]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(text: str) -> str:
    return SLUGIFY_RE.sub("-", text.lower()).strip("-")[:48]


def engagement_board_id(engagement: JsonObject) -> str:
    org = str(engagement.get("client_org") or "")
    name = str(engagement.get("name") or "")
    return slugify(f"{org}-{name}")


def load_pipeline(path: Path) -> JsonObject:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("pipeline.json did not contain an object")
    engagements = payload.get("engagements")
    if not isinstance(engagements, list):
        raise ValueError("pipeline.json missing engagements list")
    return payload


def write_pipeline(path: Path, payload: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f"{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def fetch_board_deals(base_url: str, token: str, *, urlopen: Urlopen = urllib.request.urlopen) -> list[JsonObject] | None:
    endpoint = f"{base_url.rstrip('/')}/api/crm/deals?token={token}"
    try:
        response = urlopen(endpoint, timeout=10)
        try:
            status = getattr(response, "status", 200)
            if status != 200:
                raise ValueError(f"unexpected status {status}")
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()
    except Exception as exc:
        LOGGER.warning("sync-board: board fetch failed for %s: %s", endpoint, exc)
        return None

    if not isinstance(payload, dict):
        LOGGER.warning("sync-board: board payload was not an object")
        return None
    deals = payload.get("deals")
    if not isinstance(deals, list):
        LOGGER.warning("sync-board: board payload missing deals list")
        return None
    return [deal for deal in deals if isinstance(deal, dict)]


def reconcile_engagements(
    engagements: list[JsonObject],
    board_deals: list[JsonObject],
    *,
    changed_at: str,
) -> tuple[list[JsonObject], int, list[JsonObject]]:
    board_by_id: dict[str, JsonObject] = {}
    for deal in board_deals:
        deal_id = deal.get("id")
        if isinstance(deal_id, str) and deal_id:
            board_by_id[deal_id] = deal

    updated: list[JsonObject] = []
    changed = 0
    events: list[JsonObject] = []
    for engagement in engagements:
        if not isinstance(engagement, dict):
            updated.append(engagement)
            continue
        next_engagement = dict(engagement)
        board = board_by_id.get(engagement_board_id(next_engagement))
        if board is not None:
            # CRM-authoritative engagements keep their CRM stage; the board cannot override it.
            if not next_engagement.get("crm_authoritative"):
                board_stage = board.get("stage")
                current_stage = next_engagement.get("stage")
                if isinstance(board_stage, str) and board_stage and board_stage != current_stage:
                    next_engagement["stage"] = board_stage
                    next_engagement["stage_changed_at"] = changed_at
                    changed += 1
                    events.append(
                        {
                            "clearpath_id": next_engagement.get("clearpath_id"),
                            "name": next_engagement.get("name"),
                            "from_stage": current_stage,
                            "to_stage": board_stage,
                        }
                    )
            # archived still syncs regardless of authority
            if board.get("archived") is True and next_engagement.get("archived") is not True:
                next_engagement["archived"] = True
                changed += 1
                events.append(
                    {"clearpath_id": next_engagement.get("clearpath_id"), "name": next_engagement.get("name"), "archived": True}
                )
        updated.append(next_engagement)
    return updated, changed, events


def sync_board(
    *,
    pipeline_path: Path,
    base_url: str,
    token: str,
    urlopen: Urlopen = urllib.request.urlopen,
    timestamp: str | None = None,
) -> int:
    if not token:
        LOGGER.warning("sync-board: missing token, skipping")
        return 0

    board_deals = fetch_board_deals(base_url, token, urlopen=urlopen)
    if board_deals is None:
        return 0

    payload = load_pipeline(pipeline_path)
    engagements = payload.get("engagements", [])
    if not isinstance(engagements, list):
        raise ValueError("pipeline.json missing engagements list")

    changed_at = timestamp or now_iso()
    updated_engagements, changed, events = reconcile_engagements(
        list(engagements),
        board_deals,
        changed_at=changed_at,
    )

    if changed == 0:
        print(json.dumps({"updated": 0, "noop": True}))
        return 0

    payload["engagements"] = updated_engagements
    payload["updated_at"] = changed_at
    write_pipeline(pipeline_path, payload)
    for event in events:
        emit_stage_changed_event(event)
    print(json.dumps({"updated": changed, "noop": False}))
    return 0


def emit_stage_changed_event(event: JsonObject) -> None:
    """DESIGN-B-crm.md E2: self inbox per stage/archive change. Best-effort, never blocks the sync."""
    _emit_crm_event("crm.deal.stage_changed", json.dumps(event))


def _emit_crm_event(event_type: str, payload: str) -> None:
    """Self-inbox ``EVENT <type> — <json>`` (fast-checker wakes the crm session). Best-effort.
    Test seam: when CRM_EVENT_EMIT_LOG is set, append the line to that file instead of the bus."""
    line = f"EVENT {event_type} — {payload}"
    log_path = os.environ.get("CRM_EVENT_EMIT_LOG")
    if log_path:
        try:
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass
        return
    try:
        subprocess.run(
            ["cortextos", "bus", "send-message", "crm", "normal", line],
            check=False,
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync live board stage/archive changes into pipeline.json")
    parser.add_argument("--pipeline-path", default=str(PIPELINE_PATH))
    parser.add_argument("--base-url", default=os.environ.get("BRIEFS_BASE_URL", DEFAULT_BRIEFS_BASE_URL))
    parser.add_argument("--token", default=os.environ.get("TASKS_TOKEN") or os.environ.get("BRIEFS_API_KEY") or "")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = parse_args(argv)
    try:
        return sync_board(
            pipeline_path=Path(args.pipeline_path),
            base_url=args.base_url,
            token=args.token,
        )
    except Exception as exc:
        LOGGER.error("sync-board failed: %s", exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
