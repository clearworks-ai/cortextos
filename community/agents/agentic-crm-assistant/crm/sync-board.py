#!/usr/bin/env python3
"""Push pipeline.json state TO the live CRM board (WS9 direction flip).

pipeline.json is the SOURCE OF TRUTH. This is the canonical replacement for
the legacy reverse-sync script that wrote board stages INTO pipeline.json
(the stealth writer that reverted CRM reclassifications every 15 minutes).

Direction here is strictly one-way:

    pipeline.json  --(read only)-->  PUT {base}/api/crm/deals

There is deliberately NO function in this file capable of writing
pipeline.json — no pipeline-writer helper, no atomic-replace helper. The
pipeline file is opened read-only via ``load_pipeline`` and never touched
again under any code path. Board-only deals and conflicting stages are
REPORTED in the JSON stdout summary ({pushed, conflicts, board_only})
instead of being merged back.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
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
    """Read-only load. This module never writes this file back."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("pipeline.json did not contain an object")
    engagements = payload.get("engagements")
    if not isinstance(engagements, list):
        raise ValueError("pipeline.json missing engagements list")
    return payload


def fetch_board_deals(
    base_url: str, token: str, *, urlopen: Urlopen = urllib.request.urlopen
) -> list[JsonObject] | None:
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


def engagement_to_deal(engagement: JsonObject) -> JsonObject:
    """Board payload derived from an engagement, keyed by engagement_board_id."""
    return {
        "id": engagement_board_id(engagement),
        "name": engagement.get("name"),
        "client_org": engagement.get("client_org"),
        "stage": engagement.get("stage"),
        "archived": engagement.get("archived") is True,
    }


def diff_board(
    engagements: list[JsonObject], board_deals: list[JsonObject]
) -> tuple[list[JsonObject], list[JsonObject], list[str]]:
    """Compute what to push. pipeline.json wins every disagreement.

    Returns (to_push, conflicts, board_only):
      - to_push: deal payloads whose board state is missing or differs
      - conflicts: board rows that disagreed with pipeline (reported, never merged)
      - board_only: deal ids on the board with no pipeline engagement (reported only)
    """
    board_by_id: dict[str, JsonObject] = {}
    for deal in board_deals:
        deal_id = deal.get("id")
        if isinstance(deal_id, str) and deal_id:
            board_by_id[deal_id] = deal

    to_push: list[JsonObject] = []
    conflicts: list[JsonObject] = []
    pipeline_ids: set[str] = set()

    for engagement in engagements:
        if not isinstance(engagement, dict):
            continue
        desired = engagement_to_deal(engagement)
        pipeline_ids.add(desired["id"])
        board = board_by_id.get(desired["id"])
        if board is None:
            to_push.append(desired)
            continue
        board_state = {
            "id": desired["id"],
            "name": board.get("name"),
            "client_org": board.get("client_org"),
            "stage": board.get("stage"),
            "archived": board.get("archived") is True,
        }
        if board_state != desired:
            to_push.append(desired)
            if board_state["stage"] != desired["stage"]:
                conflicts.append(
                    {
                        "id": desired["id"],
                        "board_stage": board_state["stage"],
                        "pipeline_stage": desired["stage"],
                        "resolution": "pipeline_wins",
                    }
                )

    board_only = sorted(set(board_by_id) - pipeline_ids)
    return to_push, conflicts, board_only


def push_deal(
    base_url: str,
    token: str,
    deal: JsonObject,
    *,
    urlopen: Urlopen = urllib.request.urlopen,
) -> bool:
    endpoint = f"{base_url.rstrip('/')}/api/crm/deals?token={token}"
    body = json.dumps(deal).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    try:
        response = urlopen(request, timeout=10)
        try:
            status = getattr(response, "status", 200)
            if status >= 400:
                raise ValueError(f"unexpected status {status}")
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()
    except Exception as exc:
        LOGGER.warning("sync-board: push failed for %s: %s", deal.get("id"), exc)
        return False
    return True


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
        print(json.dumps({"pushed": 0, "conflicts": [], "board_only": [], "noop": True}))
        return 0

    payload = load_pipeline(pipeline_path)
    engagements = payload.get("engagements", [])

    board_deals = fetch_board_deals(base_url, token, urlopen=urlopen)
    if board_deals is None:
        print(json.dumps({"pushed": 0, "conflicts": [], "board_only": [], "noop": True}))
        return 0

    to_push, conflicts, board_only = diff_board(list(engagements), board_deals)

    pushed = 0
    for deal in to_push:
        if push_deal(base_url, token, deal, urlopen=urlopen):
            pushed += 1

    print(
        json.dumps(
            {
                "pushed": pushed,
                "conflicts": conflicts,
                "board_only": board_only,
                "noop": pushed == 0 and not conflicts and not board_only,
                "at": timestamp or now_iso(),
            }
        )
    )
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Push pipeline.json (source of truth) to the live CRM board"
    )
    parser.add_argument("--pipeline-path", default=str(PIPELINE_PATH))
    parser.add_argument(
        "--base-url", default=os.environ.get("BRIEFS_BASE_URL", DEFAULT_BRIEFS_BASE_URL)
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("TASKS_TOKEN") or os.environ.get("BRIEFS_API_KEY") or "",
    )
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
