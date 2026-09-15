"""FR-001 observation ledger: one append-only JSONL row per handled Gmail
message, keyed by source_ref = 'gmail:<messageId>'. Outcome lives per
resolution (filed / escalated / ignored); a row is 'terminal' only when
every resolution on the LATEST row for its source_ref is filed against the
SAME content digest."""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
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

    def latest(self, source_ref: str) -> ObservationRow | None:
        result: ObservationRow | None = None
        for row in self._read_rows():
            if row.source_ref == source_ref:
                result = row
        return result

    def is_terminal(self, source_ref: str, digest: str) -> bool:
        row = self.latest(source_ref)
        if row is None or row.content_digest != digest:
            return False
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

    def escalated_for(self, source_ref: str, digest: str) -> bool:
        row = self.latest(source_ref)
        if row is None or row.content_digest != digest:
            return False
        return any(r.outcome == "escalated" for r in row.resolutions)  # G-LEDGER-5
