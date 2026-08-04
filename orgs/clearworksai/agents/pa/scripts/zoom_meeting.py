#!/usr/bin/env python3
"""Create a real Zoom meeting for a pa booking invite and return its join link.

Lane A (EA GWS calendar + Zoom invite). The booking-coordinator worker calls
``create_zoom_meeting`` immediately before a REAL (approved, non-dry-run)
``gws calendar events insert`` so the calendar invite carries a working "Join Zoom
Meeting" link instead of a bare event. Never called during the ``--dry-run`` hold — a
Zoom meeting is a real, billable, calendar-cluttering artifact; don't create one for a
slot Josh might reject.

Auth is Server-to-Server OAuth (``grant_type=account_credentials``), the same pattern
and the same three secrets already used by ``crm/zoom-officehours-sync.py`` —
``ZOOM_ACCOUNT_ID`` / ``ZOOM_CLIENT_ID`` / ``ZOOM_CLIENT_SECRET`` from
``orgs/clearworksai/secrets.env``. Stdlib only (urllib), no new dependency.

Any non-2xx response raises ``ZoomMeetingCreateError`` carrying Zoom's own
``code``/``message`` — a 401/403 scope-denied failure is loud and distinguishable from
a transient network error, so the caller can escalate to Lane D instead of silently
inserting a bare event.
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

ZOOM_OAUTH_URL = "https://zoom.us/oauth/token"
ZOOM_API_BASE = "https://api.zoom.us/v2"


class ZoomMeetingCreateError(Exception):
    """Raised on any non-2xx Zoom response while creating a meeting.

    Preserves the HTTP status and Zoom's error body (``code``/``message``) so a
    401/403 scope-denied failure is distinguishable from a transient network error.
    Never carries the meeting password.
    """

    def __init__(self, message: str, *, status: int | None = None, code: object = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.zoom_message = message


def _require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise ZoomMeetingCreateError(
            f"missing required Zoom credential env var: {name}", status=None, code="config"
        )
    return val


def _zoom_token() -> str:
    """Fetch a Server-to-Server OAuth access token (account_credentials grant)."""
    acct = _require_env("ZOOM_ACCOUNT_ID")
    cid = _require_env("ZOOM_CLIENT_ID")
    sec = _require_env("ZOOM_CLIENT_SECRET")
    url = f"{ZOOM_OAUTH_URL}?grant_type=account_credentials&account_id={urllib.parse.quote(acct)}"
    basic = base64.b64encode(f"{cid}:{sec}".encode()).decode()
    req = urllib.request.Request(
        url, method="POST", headers={"Authorization": f"Basic {basic}"}
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)["access_token"]
    except urllib.error.HTTPError as e:
        body = _read_error_body(e)
        raise ZoomMeetingCreateError(
            f"Zoom OAuth token request failed: {body.get('message') or e.reason}",
            status=e.code,
            code=body.get("code") or "oauth",
        ) from e


def _read_error_body(e: urllib.error.HTTPError) -> dict:
    """Best-effort parse of a Zoom HTTPError body into {code, message}."""
    try:
        raw = e.read().decode("utf-8", "replace")
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
        return {"message": raw}
    except Exception:
        return {"message": getattr(e, "reason", "unknown error")}


def create_zoom_meeting(
    topic: str,
    start_time_iso: str,
    duration_minutes: int,
    host_email: str,
) -> dict:
    """Create a scheduled Zoom meeting owned by ``host_email``.

    Args:
        topic: Meeting subject shown in Zoom + used for the calendar event title context.
        start_time_iso: ISO8601 start, e.g. ``"2026-08-10T15:00:00Z"``. Sent verbatim as
            the meeting ``start_time`` with ``timezone: "UTC"`` (the booking flow resolves
            slots to UTC before calling this — keeps the Zoom time unambiguous).
        duration_minutes: Meeting length in minutes.
        host_email: The Zoom user the meeting is created for (Josh's workspace email or a
            shared Clearworks host). Becomes the ``{userId}`` path segment.

    Returns:
        ``{"join_url": str, "meeting_id": str, "password": str}``. ``password`` may be an
        empty string if the account/meeting has no passcode. ``meeting_id`` is stringified.

    Raises:
        ZoomMeetingCreateError: on any non-2xx response (including 401/403 scope-denied),
            with Zoom's ``code``/``message`` preserved.
    """
    token = _zoom_token()
    payload = json.dumps(
        {
            "topic": topic,
            "type": 2,  # scheduled meeting
            "start_time": start_time_iso,
            "duration": int(duration_minutes),
            "timezone": "UTC",
        }
    ).encode("utf-8")

    url = f"{ZOOM_API_BASE}/users/{urllib.parse.quote(host_email)}/meetings"
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        body = _read_error_body(e)
        # Do NOT include the response verbatim on success paths; on error the body is
        # Zoom's structured error (code/message), safe to surface — no password present.
        raise ZoomMeetingCreateError(
            f"Zoom meeting create failed ({e.code}): {body.get('message') or e.reason}",
            status=e.code,
            code=body.get("code"),
        ) from e
    except urllib.error.URLError as e:
        raise ZoomMeetingCreateError(
            f"Zoom meeting create network error: {e.reason}", status=None, code="network"
        ) from e

    join_url = data.get("join_url")
    if not join_url:
        # 2xx but no join_url is a contract violation — treat as loud failure, not a
        # silently-usable empty result.
        raise ZoomMeetingCreateError(
            "Zoom meeting create returned 2xx without a join_url",
            status=200,
            code="no_join_url",
        )
    return {
        "join_url": join_url,
        "meeting_id": str(data.get("id", "")),
        "password": data.get("password", "") or "",
    }


def delete_zoom_meeting(meeting_id: str) -> None:
    """Delete a Zoom meeting by id (needs ``meeting:delete`` scope).

    Used for test-meeting cleanup and, in the booking flow, if a downstream calendar
    insert fails after the Zoom meeting was already created (avoid orphan meetings).
    Raises ``ZoomMeetingCreateError`` on a non-2xx that isn't 404 (already gone).
    """
    token = _zoom_token()
    url = f"{ZOOM_API_BASE}/meetings/{urllib.parse.quote(str(meeting_id))}"
    req = urllib.request.Request(
        url, method="DELETE", headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(req):
            return
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return  # already deleted / never existed
        body = _read_error_body(e)
        raise ZoomMeetingCreateError(
            f"Zoom meeting delete failed ({e.code}): {body.get('message') or e.reason}",
            status=e.code,
            code=body.get("code"),
        ) from e


if __name__ == "__main__":  # pragma: no cover - manual smoke helper
    import argparse

    ap = argparse.ArgumentParser(description="Create (and optionally delete) a Zoom meeting")
    ap.add_argument("--topic", required=True)
    ap.add_argument("--start", required=True, help="ISO8601 start, e.g. 2026-08-10T15:00:00Z")
    ap.add_argument("--duration", type=int, default=30)
    ap.add_argument("--host", required=True, help="host email")
    ap.add_argument("--delete-after", action="store_true", help="delete the meeting immediately")
    args = ap.parse_args()
    result = create_zoom_meeting(args.topic, args.start, args.duration, args.host)
    # Do not print the password to stdout (no-PII-in-logs); show only join_url + id.
    print(json.dumps({"join_url": result["join_url"], "meeting_id": result["meeting_id"]}))
    if args.delete_after:
        delete_zoom_meeting(result["meeting_id"])
        print(json.dumps({"deleted": result["meeting_id"]}))
