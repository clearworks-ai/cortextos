"""FR-002/FR-003 Gmail source: exclusion query, day-window queries, gws transport,
message parsing, and the 50-cap day-sweep. Every external effect goes through an
injectable Runner; this module imports Runner ONLY under typing.TYPE_CHECKING because
S-02 is not blocked by S-01 and must import cleanly whether or not
scripts/brain/runner.py exists yet."""
from __future__ import annotations

import base64
import email.utils
import json
import os
import re
from pathlib import Path
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
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

# G2r3-11: this is an INBOUND records lane. Gmail's messages.list searches Sent
# and Drafts too, so without this the pipeline read (and could FILE) our own
# outgoing mail as an observation about the counterparty -- an internal sender
# that resolves to a known page would have written a History entry about us.
# Kept OUT of EXCLUSION_QUERY, which is pinned verbatim to the comms-check
# skill (G-SWEEP-7); this is this lane's own constraint.
INBOUND_ONLY = "-in:sent -in:drafts"

OURS_DOMAINS: frozenset[str] = frozenset({"clearworks.ai"})
GWS_BIN = Path.home() / ".local" / "bin" / "gws"
EMPTY_PROOF_PADDING_S = 7 * 24 * 3600

_QUOTE_TAIL_RE = re.compile(r"^On .* wrote:$")


class GmailSourceError(RuntimeError):
    """Raised when a `gws gmail` subprocess exits non-zero or returns unparseable JSON."""


def _gws_argv(runner: "Runner", *args: str) -> list[str]:
    """Use canonical gws unless a test runner explicitly requests logical names."""
    current = runner
    while current is not None:
        if getattr(current, "use_logical_command_names", False):
            return ["gws", *args]
        current = getattr(current, "inner", None)
    if not GWS_BIN.is_file() or not os.access(GWS_BIN, os.X_OK):
        raise GmailSourceError(f"canonical gws is missing or not executable: {GWS_BIN}")
    return [str(GWS_BIN), *args]


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
    parts = [p for p in (extra_query, date_ops, INBOUND_ONLY, EXCLUSION_QUERY) if p]  # G-SWEEP-13
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


_EPOCH_RE = re.compile(r"-?\d{9,}")


def normalise_date_iso(value: Any) -> str:
    """Every Date form a Gmail payload can carry, reduced to ONE shape:
    `YYYY-MM-DDTHH:MM:SSZ` in UTC.

    The Gmail-API-native payload's `Date` header is RFC 2822
    ("Sun, 14 Sep 2026 03:00:00 -0700"); the recorded gws +read shape is
    ISO-8601; `internalDate` is an epoch stamp in milliseconds (seconds are
    accepted too). Normalising HERE, at the source, is what makes a downstream
    `date_iso[:10]` a real calendar date -- the RFC 2822 form sliced to
    "Sun, 14 Se" and landed in History entries. A value none of the three
    parsers accepts yields "" rather than a malformed date that reads as real.
    """
    raw = str(value or "").strip()
    if not raw:
        return ""
    dt: datetime | None = None
    if _EPOCH_RE.fullmatch(raw):
        epoch = int(raw)
        if abs(epoch) >= 100_000_000_000:  # milliseconds, not seconds
            epoch //= 1000
        try:
            dt = datetime.fromtimestamp(epoch, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return ""
    if dt is None:
        try:
            dt = datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
        except ValueError:
            dt = None
    if dt is None:
        try:
            dt = email.utils.parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            dt = None
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
        date_iso=normalise_date_iso(headers.get("date", "")),  # G-SWEEP-10
        body_text=_strip_quoted_tail(body_raw),
    )


def _flat_recipients(payload: dict, field: str) -> list[str]:
    """`to`/`cc` from EVERY shape the deployed adapter has been seen to emit.

    G2r3-6: gws-dwd's read_email() omits the Cc header from its flat response,
    so `payload.get("cc")` was always None in real runs and a known counterparty
    who appeared only in Cc got no resolution, no CRM interaction and no page
    fan-out -- FR-003 requires From/To/Cc. A top-level key (any capitalisation)
    wins; otherwise the nested `headers`, as either a Gmail-style list of
    {name, value} or a plain mapping, is consulted.
    """
    for key in (field, field.capitalize(), field.upper()):
        if key in payload:
            return _parse_address_list(payload[key])
    headers = payload.get("headers")
    if isinstance(headers, list):
        mapped = _headers_map(headers)
        if field in mapped:
            return _parse_address_list(mapped[field])  # G-SWEEP-12
    elif isinstance(headers, dict):
        for key, value in headers.items():
            if str(key).strip().lower() == field:
                return _parse_address_list(value)
    return []


def _parse_message_flat_shape(payload: dict) -> Message:
    from_name, from_email = _address_from_value(payload.get("from", ""))
    return Message(
        id=str(payload.get("id", "")),
        thread_id=str(payload.get("threadId", "")),
        from_name=from_name.strip(),
        from_email=from_email.strip().lower(),
        to=_flat_recipients(payload, "to"),
        cc=_flat_recipients(payload, "cc"),
        subject=str(payload.get("subject", "")),
        date_iso=normalise_date_iso(payload.get("date", "")),  # G-SWEEP-10
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


def _error_detail(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("message") or json.dumps(value, sort_keys=True))
    return str(value or "").strip()


def _list_message_page(runner: "Runner", query: str, max_results: int) -> tuple[list[dict], int]:
    argv = _gws_argv(runner, "gmail", "+triage", "--query", query, "--format", "json", "--max", str(max_results))
    proc = runner.run(argv)
    if proc.returncode != 0:
        raise GmailSourceError(f"gws gmail +triage failed rc={proc.returncode}: {proc.stderr.strip()}")  # G-SWEEP-6
    try:
        obj = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise GmailSourceError(f"gws gmail +triage returned invalid JSON: {exc}") from exc  # G-SWEEP-6
    if isinstance(obj, list):
        rows, total, envelope = list(obj), len(obj), {}
    elif isinstance(obj, dict):
        detail = _error_detail(obj.get("error"))
        if detail:
            raise GmailSourceError(f"gws gmail +triage returned an error: {detail}")
        raw_rows = obj["messages"] if "messages" in obj else obj.get("emails")  # G-SWEEP-8
        if not isinstance(raw_rows, list):
            raise GmailSourceError("gws gmail +triage returned an invalid payload")
        rows, envelope = list(raw_rows), obj
        raw_total = obj.get("total", obj.get("resultSizeEstimate", len(rows)))
        if isinstance(raw_total, bool) or not isinstance(raw_total, int) or raw_total < 0:
            raise GmailSourceError("gws gmail +triage returned an invalid total")
        total = raw_total
    else:
        raise GmailSourceError("gws gmail +triage returned an invalid payload")
    # gws-dwd obtains at most max_results message IDs, then fetches metadata for
    # each ID. It silently skips a failed metadata fetch while retaining Gmail's
    # resultSizeEstimate in `total`. The estimate is not an exact per-window
    # count, but it does prove how many rows the capped ID page should have
    # supplied: min(total, max_results). Never compare a recursively acquired
    # union with `total`; use it only to detect loss inside this one wrapper call.
    if len(rows) < min(total, max_results):
        raise GmailSourceError(
            f"gws gmail +triage page coverage mismatch: emitted {len(rows)} "
            f"of at least {min(total, max_results)} listed rows"
        )
    if not rows:
        # G-SWEEP-11: an EMPTY result is only believable when nothing else says
        # otherwise. The deployed `gws` routes this call to gws-dwd, whose
        # triage() turns a Gmail HTTP error into {"emails": [], "total": 0} with
        # exit code 0 -- so an auth or quota outage arrived looking exactly like
        # a quiet inbox, run() wrote a fresh SUCCESS receipt, and the digest's
        # poller-health line stayed green through a dead poller. Fail closed on
        # an error envelope or on anything at all on stderr.
        detail = str(envelope.get("error") or "").strip() or (proc.stderr or "").strip()
        if detail:
            raise GmailSourceError(f"gws gmail +triage returned no rows and reported: {detail}")
    return rows, total


def list_messages(runner: "Runner", query: str, max_results: int = 50) -> list[dict]:
    rows, _ = _list_message_page(runner, query, max_results)
    return rows


def read_message(runner: "Runner", message_id: str) -> Message:
    argv = _gws_argv(runner, "gmail", "+read", "--id", message_id, "--format", "json")
    proc = runner.run(argv)
    if proc.returncode != 0:
        raise GmailSourceError(f"gws gmail +read failed rc={proc.returncode}: {proc.stderr.strip()}")  # G-SWEEP-6
    try:
        obj = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise GmailSourceError(f"gws gmail +read returned invalid JSON: {exc}") from exc  # G-SWEEP-6
    if not isinstance(obj, dict):
        raise GmailSourceError("gws gmail +read returned an empty or invalid payload")
    detail = _error_detail(obj.get("error"))
    if detail:
        raise GmailSourceError(f"gws gmail +read returned an error for {message_id}: {detail}")
    actual_id = str(obj.get("id") or "")
    if not actual_id:
        raise GmailSourceError(f"gws gmail +read returned missing message id for {message_id}")
    if actual_id != message_id:
        raise GmailSourceError(f"gws gmail +read returned mismatched message id {actual_id} for {message_id}")
    nested = obj.get("payload")
    nested_valid = isinstance(nested, dict) and (
        bool(nested.get("headers"))
        or (isinstance(nested.get("body"), dict) and bool(nested["body"].get("data")))
        or bool(nested.get("parts"))
    )
    flat_valid = "body" in obj and any(
        obj.get(key) for key in ("from", "to", "cc", "subject", "date", "headers", "labels", "snippet")
    )
    if not obj.get("threadId") or (nested is not None and not isinstance(nested, dict)) or not (
        nested_valid or flat_valid
    ):
        raise GmailSourceError(f"gws gmail +read returned an empty or invalid payload for {message_id}")
    message = parse_message(obj)
    if message.id != message_id or not message.thread_id:
        raise GmailSourceError(f"gws gmail +read returned an empty or invalid payload for {message_id}")
    return message


def adaptive_sweep(
    runner: "Runner", terms: str, start: int, end: int, floor_s: int = 300
) -> tuple[list[dict], list[dict]]:
    """Every row in the epoch-second window [start, end), with NO exclusion
    filter added (callers choose `terms`). A window that hits the 50-row cap is
    split in half and both halves re-queried, recursively, until each piece is
    under the cap or no wider than floor_s. A floor window still at the cap
    keeps its rows and is reported as {"after", "before", "count"} -- bounded,
    named loss, never an uncovered remainder. Halves overlap by one second so a
    message stamped exactly on the split is never missed; rows union by id."""
    truncated: list[dict] = []

    def proof_ids(rows: list[dict]) -> set[str]:
        ids: set[str] = set()
        for row in rows:
            message_id = str(row.get("id") or "") if isinstance(row, dict) else ""
            if not message_id:
                raise GmailSourceError("gws gmail +triage empty-window proof row has no valid id")
            ids.add(message_id)
        return ids

    def exhaustive_proof(after: int, before: int, *, left: bool) -> set[str]:
        outer = after - EMPTY_PROOF_PADDING_S if left else before + EMPTY_PROOF_PADDING_S

        def query(boundary: int) -> list[dict]:
            proof_after, proof_before = (boundary, before) if left else (after, boundary)
            terms_with_window = " ".join(p for p in (
                terms, f"after:{proof_after} before:{proof_before}",
            ) if p)
            rows, _ = _list_message_page(runner, terms_with_window, 50)
            return rows

        rows = query(outer)
        if rows and len(rows) < 50:
            return proof_ids(rows)
        if not rows:
            raise GmailSourceError("gws gmail +triage cannot prove an empty window")

        # The outer superset is capped. Tighten only its added edge while the
        # whole target remains included, looking for a non-empty exhaustive
        # page. An empty candidate means the canary was excluded; a capped one
        # still cannot prove coverage.
        low, high = (outer, after) if left else (before, outer)
        while low + 1 < high:
            candidate = (low + high) // 2
            rows = query(candidate)
            if not rows:
                if left:
                    high = candidate
                else:
                    low = candidate
            elif len(rows) < 50:
                return proof_ids(rows)
            elif left:
                low = candidate
            else:
                high = candidate
        raise GmailSourceError("gws gmail +triage cannot prove an empty window")

    def prove_empty(after: int, before: int) -> None:
        # Header Date is not Gmail's query-membership timestamp. Instead, use
        # set conservation: the intersection of exhaustive [older + target]
        # and [target + newer] queries is exactly the target query by Gmail's
        # own search semantics, regardless of a message's RFC822 Date header.
        left_ids = exhaustive_proof(after, before, left=True)
        right_ids = exhaustive_proof(after, before, left=False)
        if left_ids & right_ids:
            raise GmailSourceError("gws gmail +triage returned a false-empty window")

    def walk(after: int, before: int) -> tuple[dict[str, dict], bool]:
        query = " ".join(p for p in (terms, f"after:{after} before:{before}") if p)
        rows, _ = _list_message_page(runner, query, 50)
        if not rows:
            prove_empty(after, before)
            retry_rows, _ = _list_message_page(runner, query, 50)
            if retry_rows:
                raise GmailSourceError("gws gmail +triage returned a false-empty window on retry")
            return {}, True
        if len(rows) >= 50:
            if before - after > floor_s:
                mid = (after + before) // 2
                children, left_complete = walk(after, mid + 1)
                right, right_complete = walk(mid, before)
                children.update(right)
                missing = {str(row.get("id") or "") for row in rows} - set(children)
                if missing:
                    raise GmailSourceError(
                        f"gws gmail +triage bisected coverage mismatch: {len(missing)} parent rows disappeared"
                    )
                complete = left_complete and right_complete
                return children, complete
            truncated.append({"after": after, "before": before, "count": len(rows)})
        seen: dict[str, dict] = {}
        for row in rows:
            mid_ = str(row.get("id", ""))
            if mid_ and mid_ not in seen:
                seen[mid_] = row
        return seen, len(rows) < 50

    seen, _ = walk(start, end)
    return list(seen.values()), truncated


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
