"""FR-002/FR-003 Gmail source: exclusion query, day-window queries, gws transport,
message parsing, and the 50-cap day-sweep. Every external effect goes through an
injectable Runner; this module imports Runner ONLY under typing.TYPE_CHECKING because
S-02 is not blocked by S-01 and must import cleanly whether or not
scripts/brain/runner.py exists yet."""
from __future__ import annotations

import base64
import email.utils
import json
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from runner import Runner

# G-SWEEP-7: verbatim from orgs/clearworksai/skills/comms-check-worker/SKILL.md:26,
# the clause from -category:promotions through -subject:"auto-reply". The
# is:unread newer_than:5h half is dropped — that is the attention lane's freshness
# filter, not this lane's day-window filter (FR-002 supplies after:/before: instead).
EXCLUSION_QUERY = (  # G-SWEEP-7
    '-category:promotions -category:social -from:notify.railway.app '
    '-from:notifications@github.com -from:noreply -from:no-reply '
    '-from:donotreply -from:do-not-reply -from:mailer-daemon '
    '-subject:"Accepted:" -subject:"Declined:" -subject:"Tentative:" '
    '-subject:"out of office" -subject:"auto-reply"'
)

OURS_DOMAINS: frozenset[str] = frozenset({"clearworks.ai"})

_QUOTE_TAIL_RE = re.compile(r"^On .* wrote:$")


class GmailSourceError(RuntimeError):
    """Raised when a `gws gmail` subprocess exits non-zero or returns unparseable JSON."""


@dataclass
class Message:
    id: str
    thread_id: str
    from_name: str
    from_email: str
    to: list[str]
    cc: list[str]
    subject: str
    date_iso: str
    body_text: str

    def counterparties(self) -> list[str]:
        """from + to + cc minus OURS_DOMAINS addresses, deduped, lowercased, order-preserving."""
        seen: list[str] = []
        for addr in (self.from_email, *self.to, *self.cc):
            a = (addr or "").strip().lower()
            if not a or "@" not in a:
                continue
            domain = a.rsplit("@", 1)[-1]
            if domain in OURS_DOMAINS:
                continue  # G-SWEEP-4
            if a not in seen:
                seen.append(a)
        return seen


def _date_ops(after: date, before: date) -> str:
    return f"after:{after:%Y/%m/%d} before:{before:%Y/%m/%d}"


def _compose_query(date_ops: str, extra_query: str | None) -> str:
    """<extra_query> <date operators> <EXCLUSION_QUERY> — C5: the manual backfill's
    --query clause composes into EVERY query sweep issues, never bypassing the
    exclusion filter or the date bounds."""
    parts = [p for p in (extra_query, date_ops, EXCLUSION_QUERY) if p]
    return " ".join(parts)  # G-SWEEP-9


def window_queries(days: int, today: date) -> list[tuple[str, str]]:
    """One (label, query) per calendar day covering EXACTLY the last `days` days ending
    today (today included). Gmail after: is inclusive, before: is exclusive, so each
    single day is after:<day> before:<day+1>."""
    out: list[tuple[str, str]] = []
    for offset in range(days - 1, -1, -1):  # G-SWEEP-1
        day = today - timedelta(days=offset)
        label = day.strftime("%Y-%m-%d")
        query = _compose_query(_date_ops(day, day + timedelta(days=1)), None)
        out.append((label, query))
    return out


def full_window_query(days: int, today: date) -> str:
    """The whole window in one query: after:<today - (days-1)> before:<today + 1>."""
    start = today - timedelta(days=days - 1)
    end = today + timedelta(days=1)
    return _compose_query(_date_ops(start, end), None)


def _address_from_value(value: Any) -> tuple[str, str]:
    """(name, email) for ONE address item: a "Name <addr>" string, a bare address
    string, or a dict {"name", "email"} (also accepts key "address" in place of
    "email") — the S-03/S-04 writer's +read fixtures use the dict shape for "from"."""
    if isinstance(value, dict):
        name = str(value.get("name") or "").strip()
        addr = str(value.get("email") or value.get("address") or "").strip().lower()
        return name, addr
    name, addr = email.utils.parseaddr(str(value or ""))
    return name.strip(), addr.strip().lower()


def _parse_address_list(value: Any) -> list[str]:
    """Accepts a bare/"Name <addr>" string (optionally comma-joined), a single dict
    {"name","email"|"address"}, or a list mixing address strings and/or such dicts —
    the observed +triage/+read shapes vary between a comma-joined string and a list of
    per-address dicts. Returns lowercased email addresses in order, skipping empties."""
    if value is None:
        return []
    if isinstance(value, dict):
        _, addr = _address_from_value(value)
        return [addr] if addr else []
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            if isinstance(item, dict):
                _, addr = _address_from_value(item)
                if addr:
                    out.append(addr)
            else:
                raw = str(item or "")
                if raw.strip():
                    out.extend(a.lower() for _, a in email.utils.getaddresses([raw]) if a)
        return out
    raw = str(value)
    if not raw.strip():
        return []
    return [a.lower() for _, a in email.utils.getaddresses([raw]) if a]


def _strip_quoted_tail(text: str) -> str:
    kept: list[str] = []
    for line in text.splitlines():
        if _QUOTE_TAIL_RE.match(line.strip()):
            break  # G-SWEEP-5
        if line.lstrip().startswith(">"):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def _headers_map(headers: list[dict[str, str]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for h in headers or []:
        name = str(h.get("name", "")).strip().lower()
        if name:
            out[name] = h.get("value", "")
    return out


def _find_plain_body(part: dict) -> str:
    mime = part.get("mimeType", "")
    body = part.get("body") or {}
    data = body.get("data")
    if mime == "text/plain" and data:
        padded = data + "=" * (-len(data) % 4)
        try:
            return base64.urlsafe_b64decode(padded).decode("utf-8", "replace")
        except Exception:
            return ""
    for sub in part.get("parts", []) or []:
        found = _find_plain_body(sub)
        if found:
            return found
    return ""


def _parse_message_gmail_api_shape(payload: dict) -> Message:
    inner = payload["payload"]
    headers = _headers_map(inner.get("headers", []))
    from_name, from_email = _address_from_value(headers.get("from", ""))
    body_raw = _find_plain_body(inner)
    return Message(
        id=str(payload.get("id", "")),
        thread_id=str(payload.get("threadId", "")),
        from_name=from_name.strip(),
        from_email=from_email.strip().lower(),
        to=_parse_address_list(headers.get("to")),
        cc=_parse_address_list(headers.get("cc")),
        subject=headers.get("subject", ""),
        date_iso=headers.get("date", ""),
        body_text=_strip_quoted_tail(body_raw),
    )


def _parse_message_flat_shape(payload: dict) -> Message:
    from_name, from_email = _address_from_value(payload.get("from", ""))
    return Message(
        id=str(payload.get("id", "")),
        thread_id=str(payload.get("threadId", "")),
        from_name=from_name.strip(),
        from_email=from_email.strip().lower(),
        to=_parse_address_list(payload.get("to")),
        cc=_parse_address_list(payload.get("cc")),
        subject=str(payload.get("subject", "")),
        date_iso=str(payload.get("date", "")),
        body_text=_strip_quoted_tail(str(payload.get("body", ""))),
    )


def parse_message(payload: dict) -> Message:
    """Accepts the recorded flat gws-dwd +read shape (id/threadId/from/to/cc/subject/
    date/body — "from" a string or {"name","email"} dict, "to"/"cc" a string, a dict,
    or a list mixing strings and dicts) and a Gmail-API-native nested shape (top-level
    id/threadId, payload.headers as a list of {name, value}, payload.body/parts for
    text/plain)."""
    if isinstance(payload.get("payload"), dict):
        return _parse_message_gmail_api_shape(payload)
    return _parse_message_flat_shape(payload)


def list_messages(runner: "Runner", query: str, max_results: int = 50) -> list[dict]:
    argv = ["gws", "gmail", "+triage", "--query", query, "--format", "json", "--max", str(max_results)]
    proc = runner.run(argv)
    if proc.returncode != 0:
        raise GmailSourceError(f"gws gmail +triage failed rc={proc.returncode}: {proc.stderr.strip()}")  # G-SWEEP-6
    try:
        obj = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise GmailSourceError(f"gws gmail +triage returned invalid JSON: {exc}") from exc  # G-SWEEP-6
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        return list(obj.get("messages") or obj.get("emails") or [])  # G-SWEEP-8
    return []


def read_message(runner: "Runner", message_id: str) -> Message:
    argv = ["gws", "gmail", "+read", "--id", message_id, "--format", "json"]
    proc = runner.run(argv)
    if proc.returncode != 0:
        raise GmailSourceError(f"gws gmail +read failed rc={proc.returncode}: {proc.stderr.strip()}")  # G-SWEEP-6
    try:
        obj = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise GmailSourceError(f"gws gmail +read returned invalid JSON: {exc}") from exc  # G-SWEEP-6
    return parse_message(obj)


def sweep(
    runner: "Runner", days: int, today: date, extra_query: str | None = None
) -> tuple[list[dict], list[dict]]:
    """Runs the full-window query first (composed as <extra_query> <date ops>
    <EXCLUSION_QUERY> per C5 — the manual backfill's --query clause never bypasses the
    exclusion filter or date bounds). WHEN it returns fewer than 50 rows THE window is
    complete and no sweep is needed. WHEN it returns exactly 50 (G-SWEEP-2) THE SYSTEM
    day-sweeps the FULL window (one query per calendar day, each composed the same way,
    not a narrowed tail), unions rows by id, and reports every day that itself returned
    50 ({"day": label, "count": 50}) while still including that day's 50 rows
    (G-SWEEP-3) — bounded, reported loss on a freak day, never an uncovered remainder."""
    start = today - timedelta(days=days - 1)
    end = today + timedelta(days=1)
    full_query = _compose_query(_date_ops(start, end), extra_query)
    full = list_messages(runner, full_query, max_results=50)
    if len(full) < 50:
        return full, []

    seen: dict[str, dict] = {}
    truncation: list[dict] = []
    for offset in range(days - 1, -1, -1):  # G-SWEEP-2
        day = today - timedelta(days=offset)
        label = day.strftime("%Y-%m-%d")
        query = _compose_query(_date_ops(day, day + timedelta(days=1)), extra_query)
        rows = list_messages(runner, query, max_results=50)
        if len(rows) == 50:
            truncation.append({"day": label, "count": 50})  # G-SWEEP-3
        for row in rows:
            mid = str(row.get("id", ""))
            if mid and mid not in seen:
                seen[mid] = row
    return list(seen.values()), truncation
