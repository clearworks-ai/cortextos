"""FR-001 observation ledger: one append-only JSONL row per handled Gmail
message, keyed by source_ref = 'gmail:<messageId>'. Outcome lives per
resolution (filed / escalated / ignored); a row is 'terminal' only when
every resolution on the LATEST row for its source_ref is filed against the
SAME content digest.

FR-002: run-receipt persistence (last_success_at/window_days/message_count/
truncation/cost_usd) on the success path (write_receipt) and the failure path
(record_failure, which preserves the previous last_success_at), plus the gap
sentence the daily digest names when the receipt is stale (gap_line)."""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from atomic import atomic_write


@dataclass
class Resolution:
    slug: str
    kind: str
    method: str
    outcome: str
    reason: str = ""
    contact_id: str | None = None
    email: str = ""
    effects: list[str] = field(default_factory=list)
    # G0B3-1: the effect KEYS that have actually LANDED for this resolution --
    # "crm:<contact_id>", "page:<vault-relative path>", "task:<title>". `outcome`
    # becomes "filed" only once every REQUIRED key is present, so a run that dies
    # after the CRM row but before History or task creation leaves a resolution
    # that the next run finishes instead of treating as complete.


@dataclass
class ObservationRow:
    source_ref: str
    thread_id: str
    content_digest: str
    observed_at: str
    resolutions: list[Resolution]
    reason: str = ""
    extraction: dict | None = None
    writes: list[str] = field(default_factory=list)
    revision_of: str | None = None
    suppressed: list[dict] = field(default_factory=list)
    simulated: bool = False
    planned_writes: list[str] = field(default_factory=list)
    partial: bool = False
    # G2r3-7: the extraction ATTEMPT record for this row's identity --
    # {"identity", "attempt", "last_error", "frozen"?}. Set on the row that
    # reports a frozen identity, so the audit trail says why no further LLM
    # call will be made.
    extraction_attempt: dict | None = None


def content_digest(subject: str, body_text: str, from_email: str) -> str:
    """sha256 hex of subject/body/from_email, NUL-separated so concatenation
    boundaries can never collide two distinct triples."""
    h = hashlib.sha256()
    h.update(subject.encode("utf-8"))
    h.update(b"\x00")
    h.update(body_text.encode("utf-8"))
    h.update(b"\x00")
    h.update(from_email.encode("utf-8"))
    return h.hexdigest()


def _row_to_dict(row: ObservationRow) -> dict:
    return asdict(row)


def _row_from_dict(d: dict) -> ObservationRow:
    resolutions = [Resolution(**r) for r in d.get("resolutions", [])]
    return ObservationRow(
        source_ref=d["source_ref"],
        thread_id=d["thread_id"],
        content_digest=d["content_digest"],
        observed_at=d["observed_at"],
        resolutions=resolutions,
        reason=d.get("reason", ""),
        extraction=d.get("extraction"),
        writes=list(d.get("writes", [])),
        revision_of=d.get("revision_of"),
        suppressed=list(d.get("suppressed", [])),
        simulated=bool(d.get("simulated", False)),
        planned_writes=list(d.get("planned_writes", [])),
        partial=bool(d.get("partial", False)),
        extraction_attempt=d.get("extraction_attempt"),
    )


class Ledger:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def _read_rows(self) -> list[ObservationRow]:
        if not self.path.exists():
            return []
        text = self.path.read_text(encoding="utf-8")
        rows: list[ObservationRow] = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            rows.append(_row_from_dict(json.loads(line)))
        return rows

    def append(self, row: ObservationRow) -> None:
        rows = self._read_rows()
        rows.append(row)
        lines = [json.dumps(_row_to_dict(r), sort_keys=True) for r in rows]
        data = ("\n".join(lines) + "\n").encode("utf-8") if lines else b""
        atomic_write(self.path, data)  # G-LEDGER-1: read-whole + rewrite-whole, never a bare open("a")

    def all_rows(self) -> list[ObservationRow]:
        """Every row, oldest first -- the full history, for consumers that must
        not settle for the LATEST row per ref (the FR-006 coverage diff)."""
        return self._read_rows()

    def latest(self, source_ref: str) -> ObservationRow | None:
        result: ObservationRow | None = None
        for row in self._read_rows():
            if row.source_ref == source_ref:
                result = row
        return result

    def latest_real(self, source_ref: str, digest: str) -> ObservationRow | None:
        """The newest NON-simulated row for this exact (source_ref, digest).

        A dry run appended between two live runs leaves a simulated row on top,
        and a simulated row must never hand `filed` outcomes to a live run
        (nothing was written). But it must not ERASE the real partial work
        underneath it either -- the effects that genuinely landed live below it
        (G2r3-3)."""
        result: ObservationRow | None = None
        for row in self._read_rows():
            if row.source_ref == source_ref and row.content_digest == digest and not row.simulated:
                result = row  # G-LEDGER-9
        return result

    def is_terminal(self, source_ref: str, digest: str) -> bool:
        """A row is terminal only when every resolution on the LATEST row for
        this source_ref/digest is filed AND the row is a REAL one. A dry-run
        row is `simulated` -- it records what WOULD have been written
        (`planned_writes`), never what was, so it must never make the
        subsequent LIVE run a no-op (G0A2-2)."""
        row = self.latest(source_ref)
        if row is None or row.content_digest != digest:
            return False
        if row.simulated:  # G-LEDGER-6: a simulated (dry-run) row is never terminal
            return False
        # `partial` is a DERIVED summary of the resolutions (G-LEDGER-7, in
        # client_state_gmail._persist_partial), never an independent veto: a
        # recovery row whose every resolution is `filed` means every required
        # effect landed, and vetoing it made every later run re-process the
        # message and append another row forever (G2B-1).
        if not row.resolutions:
            return False
        return all(r.outcome == "filed" for r in row.resolutions)  # G-LEDGER-2

    def rows_since(self, since_iso: str) -> list[ObservationRow]:
        return [r for r in self._read_rows() if r.observed_at >= since_iso]

    def distinct_refs(self) -> set[str]:
        return {r.source_ref for r in self._read_rows()}  # G-LEDGER-3: DISTINCT refs, not row count

    def open_email_tasks(self) -> list[dict]:
        # G-LEDGER-4: parse ledger "writes" entries shaped "task:<id>|<title>"
        # into {"id","title","source_ref"} -- source_ref comes from the
        # OWNING row so a caller (client_state_writes.list_open_tasks join)
        # can match back to the observation that created the task, and can
        # itself re-check CURRENT task status before treating a title as
        # still-open dedup context (this module has no bus access to do that
        # join itself -- G0B-8).
        tasks: list[dict] = []
        for row in self._read_rows():
            for entry in row.writes:
                if not entry.startswith("task:") or "|" not in entry:
                    continue
                _, _, rest = entry.partition(":")
                task_id, _, title = rest.partition("|")
                tasks.append({"id": task_id, "title": title, "source_ref": row.source_ref})
        return tasks

    def cached_extraction(self, identity: str) -> dict | None:
        """The NEWEST stamped extraction anywhere in history whose `identity`
        matches.

        FR-001's at-most-one-LLM-call per (source_ref, content_digest, bound
        slugs) is a property of the LEDGER, not of the latest row (G2B-2). A
        later extraction-LESS row for the same message -- an ignored or
        escalated re-evaluation, which is constructed without one -- used to
        hide the call already paid for, so a binding set that cycled
        (bound -> unknown -> bound) paid twice for identical input. Simulated
        rows count here, and only here: a dry-run's extraction was really
        bought and stamped, even though nothing it describes was written."""
        for row in reversed(self._read_rows()):
            cached = row.extraction
            if cached and cached.get("identity") == identity:  # G-LEDGER-8
                return cached
        return None

    def escalated_for(self, source_ref: str, digest: str) -> bool:
        """True once a REAL (non-simulated) run has already DELIVERED the FR-003
        escalation for this exact (source_ref, digest).

        MONOTONIC (G2B-5): the search covers EVERY row for that pair, not just
        the latest. A resolution set that cycles -- ambiguous, then ignored when
        the contact momentarily stops matching, then ambiguous again -- used to
        forget the delivered alert as soon as any later row landed, and Josh got
        a second Telegram for the same message. An 'escalated' outcome is only
        ever persisted AFTER a successful send (G-ESC-3), so it is proof of
        delivery. A dry-run row is not (G0A2-2)."""
        for row in self._read_rows():
            if row.source_ref != source_ref or row.content_digest != digest:
                continue
            if row.simulated:  # G-LEDGER-6
                continue
            if any(r.outcome == "escalated" for r in row.resolutions):  # G-LEDGER-5
                return True
        return False


def write_receipt(state_dir: Path, receipt: dict) -> None:
    """Atomic JSON write of the FR-002 SUCCESS-PATH run receipt. A failed run
    uses record_failure instead, which preserves last_success_at."""
    path = Path(state_dir) / "run-receipt.json"
    data = json.dumps(receipt, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    atomic_write(path, data)


def read_receipt(state_dir: Path) -> dict | None:
    path = Path(state_dir) / "run-receipt.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def record_failure(state_dir: Path, error: str, **partial: object) -> None:
    """FR-002 failure-path receipt: records `error` + `failed_at` (now, UTC
    ISO) plus any partial progress fields (message_count/cost_usd/truncation)
    the caller supplies, while PRESERVING the previous receipt's
    last_success_at/window_days -- a failed run must never look like the
    poller has never succeeded."""
    prev = read_receipt(state_dir) or {}
    out = dict(prev)  # G-RECEIPT-1: start from the previous receipt so last_success_at survives unless partial explicitly overrides it
    out.update(partial)
    out["error"] = error
    out["failed_at"] = datetime.now(timezone.utc).isoformat()
    write_receipt(state_dir, out)


EXTRACTION_ATTEMPTS_FILENAME = "extraction-attempts.json"
# FR-001 is "no duplicate spend on a USABLE result". An output the validator
# REJECTED produced nothing, so one automatic retry is legitimate -- but only
# one: a poisoned message must not be able to bill forever in silence (G2r3-7).
EXTRACTION_MAX_ATTEMPTS = 2


def read_extraction_attempts(state_dir: Path) -> dict:
    path = Path(state_dir) / EXTRACTION_ATTEMPTS_FILENAME
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_extraction_attempts(state_dir: Path, data: dict) -> None:
    path = Path(state_dir) / EXTRACTION_ATTEMPTS_FILENAME
    Path(state_dir).mkdir(parents=True, exist_ok=True)
    atomic_write(path, json.dumps(data, indent=2, sort_keys=True).encode("utf-8") + b"\n")


def extraction_attempt_state(state_dir: Path, identity: str) -> tuple[int, str]:
    """(attempts already made, last error) for this extraction identity."""
    row = read_extraction_attempts(state_dir).get(identity) or {}
    return int(row.get("attempt") or 0), str(row.get("last_error") or "")


def record_extraction_attempt(state_dir: Path, identity: str) -> int:
    """Stamp the NEXT attempt and return its number.

    Written BEFORE the call, never after: a crash inside claude (or a kill
    mid-call) must still count against the budget, or a message that reliably
    hangs the model would be retried on every sweep forever."""
    data = read_extraction_attempts(state_dir)
    row = dict(data.get(identity) or {})
    row["attempt"] = int(row.get("attempt") or 0) + 1  # G-EXT-5
    row["last_attempt_at"] = datetime.now(timezone.utc).isoformat()
    data[identity] = row
    _write_extraction_attempts(state_dir, data)
    return int(row["attempt"])


def record_extraction_failure(state_dir: Path, identity: str, error: str) -> None:
    data = read_extraction_attempts(state_dir)
    row = dict(data.get(identity) or {})
    row["last_error"] = error
    data[identity] = row
    _write_extraction_attempts(state_dir, data)


def clear_extraction_attempts(state_dir: Path, identity: str) -> None:
    """A usable result retires the identity's budget."""
    data = read_extraction_attempts(state_dir)
    if identity in data:
        del data[identity]
        _write_extraction_attempts(state_dir, data)


LOCK_REFUSAL_FILENAME = "last-lock-refusal.json"


def record_lock_refusal(
    state_dir: Path, holder_pid: int | None = None, detail: str = "",
    reason: str = "already-claimed",
) -> None:
    """FR-002 lock-held refusal diagnostic. Deliberately does NOT touch
    run-receipt.json: a fail-closed halt must persist its cause WITHOUT
    falsifying the success receipt (binding goal G4 item 5, amended
    2026-09-14). The receipt is byte-identical across a lock-held run; the
    cause lands here."""
    path = Path(state_dir) / LOCK_REFUSAL_FILENAME  # G-LOCKREF-1
    payload = {
        "error": "lock-held",
        # G2r3-1: WHICH verdict refused this run. `stale-cleared` means this
        # call cleared a dead holder's lock and deliberately did not reclaim
        # it -- the next sweep wins the empty slot.
        "reason": reason,
        "refused_at": datetime.now(timezone.utc).isoformat(),
        "pid": int(holder_pid) if holder_pid is not None else None,
        "detail": detail,
    }
    Path(state_dir).mkdir(parents=True, exist_ok=True)
    atomic_write(path, json.dumps(payload, indent=2, sort_keys=True).encode("utf-8") + b"\n")


LEASE_RELEASE_FAILURE_FILENAME = "last-lease-release-failure.json"


def record_lease_release_failure(state_dir: Path, error: str) -> None:
    """FR-002: `meeting-brief-release` failed, so the lock stays live until its
    TTL while this run would otherwise look successful. Like the lock-held
    refusal, the cause goes to its OWN file and run-receipt.json is left alone —
    the run really did do its work, so `last_success_at` must not be rewritten
    or erased (G0B3-11)."""
    path = Path(state_dir) / LEASE_RELEASE_FAILURE_FILENAME  # G-LOCK-7
    payload = {
        "error": "lease-release-failed",
        "detail": error,
        "failed_at": datetime.now(timezone.utc).isoformat(),
    }
    Path(state_dir).mkdir(parents=True, exist_ok=True)
    atomic_write(path, json.dumps(payload, indent=2, sort_keys=True).encode("utf-8") + b"\n")


def read_lease_release_failure(state_dir: Path) -> dict | None:
    path = Path(state_dir) / LEASE_RELEASE_FAILURE_FILENAME
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_lock_refusal(state_dir: Path) -> dict | None:
    path = Path(state_dir) / LOCK_REFUSAL_FILENAME
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def gap_line(receipt: dict | None, window_days: int, now: datetime) -> str | None:
    """FR-002: when the receipt's last_success_at is older than the lookback
    window, return the digest sentence naming the repair (`--days N`,
    N = ceil(days since last_success_at)); else None."""
    if not receipt:
        return None
    last = receipt.get("last_success_at")
    if not last:
        return None
    try:
        last_dt = datetime.fromisoformat(last)
    except ValueError:
        return None
    if last_dt.tzinfo is None:
        last_dt = last_dt.replace(tzinfo=timezone.utc)
    now_dt = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    delta_days = (now_dt - last_dt).total_seconds() / 86400.0
    if delta_days <= window_days:
        return None
    n = math.ceil(delta_days)  # G-RECEIPT-2: N = ceil(days since last_success_at)
    return (
        f"Gmail poller gap: last success {last} is {n} day(s) old "
        f"(window {window_days}d) -- repair with `--days {n}`."
    )
