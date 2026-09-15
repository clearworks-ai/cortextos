"""FR-009 invariants + daily Gmail digest section for meeting_loop_watch.py.

Part A: invariant computation over org-brain pages plus a COMMITTED, EXPLICITLY
WRITTEN baseline (G0B-14 — no auto-baseline; `write-baseline` is a one-time CLI
step) so only NEW violations ever reach Josh. Part B: gmail_section(), the
renderer meeting_loop_watch.py calls, independent of the Fireflies section
(FR-009 INDEPENDENCE).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from atomic import atomic_write  # noqa: E402
from brain_rollup import _section_text  # noqa: E402
from client_state_projections import plan_digest_line  # noqa: E402
from client_state_writes import list_open_tasks  # noqa: E402
from observation_ledger import Ledger, ObservationRow, gap_line, read_receipt  # noqa: E402
from resolve_meeting import _domains_from_text, _norm_title, _org_names_from_text  # noqa: E402
from runner import Runner  # noqa: E402
from writeback_render import org_brain_root  # noqa: E402

BASELINE_FILE = "invariants-baseline.json"
_PAGE_FOLDERS = ("clients", "orgs", "projects")
# "since forever" sentinel for a FULL ledger history read (G0B-15 — the row a
# revision supersedes can be arbitrarily older than the digest's 24h window).
_EPOCH_SENTINEL = "1970-01-01T00:00:00+00:00"
# G-INV-2: only a "gmail:" source ref counts toward the missing-ref invariant —
# the live meeting pipeline appends "fireflies:" refs daily; an all-source
# check would violate forever and train Josh to skim past the one channel
# FR-009 exists to protect (round-2 fix).
_GMAIL_REF_LINE_RE = re.compile(r"^- (\d{4}-\d{2}-\d{2}) — .*\[source: (gmail:[^\]]+)\]")


def compute_invariants(vault: Path, ledger: Ledger, epoch_iso: str) -> dict[str, list[dict[str, Any]]]:
    """{"org_name_multi": [...], "domain_multi": [...], "missing_gmail_refs": [...]}.

    Reuses resolve_meeting's page-declaration readers (_domains_from_text,
    _org_names_from_text) PER PAGE rather than via load_closed_sets, whose
    domain_to_slug/org_name_to_slug maps collapse duplicates into a single
    last-writer-wins key and so cannot detect the duplicate itself
    (resolve_meeting.py:295-352) — exactly the gap these invariants cover.
    """
    brain = org_brain_root(Path(vault))
    org_pages: dict[str, dict[str, Any]] = {}
    domain_pages: dict[str, list[str]] = {}
    missing_refs: list[dict[str, str]] = []
    epoch_date = str(epoch_iso)[:10]
    known_refs = ledger.distinct_refs()

    for folder in _PAGE_FOLDERS:
        d = brain / folder
        if not d.is_dir():
            continue
        for path in sorted(d.glob("*.md")):
            if path.stem.startswith("_"):
                continue
            text = path.read_text(encoding="utf-8")
            # G-INV-3: pages are identified by their VAULT-RELATIVE PATH, never
            # by `path.stem`. Two folders may legitimately hold the same slug
            # (clients/acme.md and orgs/acme.md), and keying on the stem
            # collapsed them into ONE entry -- so a domain or CRM org name
            # declared on BOTH looked like a single page and the >=2-pages
            # invariant, whose entire job is catching exactly that split, never
            # fired.
            page_id = str(path.relative_to(brain))

            for oname in _org_names_from_text(text):
                key = _norm_title(oname)
                if not key:
                    continue
                entry = org_pages.setdefault(key, {"name": oname, "pages": []})
                if page_id not in entry["pages"]:
                    entry["pages"].append(page_id)

            for dom in _domains_from_text(text):
                # G-INV-1: FULL domain only, never registrable_label — a
                # bare-label collapse (example.com/example.org -> "example")
                # is exactly the false positive this invariant must not raise.
                pages = domain_pages.setdefault(dom, [])
                if page_id not in pages:
                    pages.append(page_id)

            history = _section_text(path, "History")
            for line in history.splitlines():
                m = _GMAIL_REF_LINE_RE.match(line.strip())
                if not m:
                    continue
                entry_date, ref = m.group(1), m.group(2)
                if entry_date < epoch_date:
                    continue  # pre-epoch refs are grandfathered by construction
                if ref not in known_refs:
                    missing_refs.append({"ref": ref, "page": page_id, "date": entry_date})

    org_name_multi = [
        {"name": v["name"], "pages": sorted(v["pages"])}
        for v in org_pages.values()
        if len(v["pages"]) > 1
    ]
    domain_multi = [
        {"domain": dom, "pages": sorted(pages)}
        for dom, pages in domain_pages.items()
        if len(pages) > 1
    ]
    return {
        "org_name_multi": sorted(org_name_multi, key=lambda r: r["name"]),
        "domain_multi": sorted(domain_multi, key=lambda r: r["domain"]),
        "missing_gmail_refs": sorted(missing_refs, key=lambda r: (r["ref"], r["page"])),
    }


def load_baseline(state_dir: Path) -> dict[str, Any] | None:
    path = Path(state_dir) / BASELINE_FILE
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or "epoch" not in data or "invariants" not in data:
        return None
    return data


def write_baseline(state_dir: Path, inv: dict[str, Any], epoch_iso: str) -> Path:
    path = Path(state_dir) / BASELINE_FILE
    payload = {
        "epoch": epoch_iso,
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "invariants": inv,
    }
    atomic_write(path, json.dumps(payload, indent=2, sort_keys=True).encode("utf-8"))
    return path


def new_violations(current: dict[str, Any], baseline: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Items in `current` not present in `baseline`, matched by CANONICAL record:
    (name/domain, sorted page-set tuple) for the two duplicate-declaration
    sections, (ref, page) for missing refs (G-BASE-2 / G0B-14 fix — comparing by
    name/domain KEY ALONE would grandfather a page added to an already-known
    duplicate group, and comparing a missing ref by REF ALONE would grandfather
    the SAME ref later going missing from a DIFFERENT page; the page must be
    part of the identity on both sides)."""
    out: dict[str, list[dict[str, Any]]] = {}
    for section, key_name in (("org_name_multi", "name"), ("domain_multi", "domain")):
        # Grandfathered PAGES per key, not the exact page-set tuple. Requiring
        # set equality made a REPAIR look like a new violation: a baseline group
        # of A/B/C, with the declaration removed from C, no longer matched and
        # was reported -- an alert for reducing a known problem, which is how a
        # reader learns to skim the section (G2r3-12). A page the baseline never
        # knew about still fires, which is what G0B-14 asked for.
        base_pages: dict[str, set[str]] = {}
        for item in baseline.get(section, []):
            base_pages.setdefault(item[key_name], set()).update(item.get("pages", []))
        flagged: list[dict[str, Any]] = []
        for item in current.get(section, []):
            known = base_pages.get(item[key_name])
            if known is None or any(page not in known for page in item.get("pages", [])):
                flagged.append(item)
        out[section] = flagged
    base_refs = {(item["ref"], item.get("page")) for item in baseline.get("missing_gmail_refs", [])}
    out["missing_gmail_refs"] = [
        item
        for item in current.get("missing_gmail_refs", [])
        if (item["ref"], item.get("page")) not in base_refs  # G-BASE-2
    ]
    return out


def _write_token(write: str) -> str:
    """"task:<id>|<title>" -> "task:<id>" (Ledger writes convention)."""
    return write.split("|", 1)[0]


def _task_id(write: str) -> str:
    token = _write_token(write)
    return token.split(":", 1)[1] if ":" in token else token


def _sender_domain(email: str) -> str:
    return email.split("@", 1)[1].lower() if "@" in email else ""


def _parse_receipt_ts(value: Any) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _poller_health_lines(receipt: dict | None) -> list[str]:
    """FR-009: the warning lines a receipt that CANNOT prove a healthy poller
    owes the digest. A missing, unreadable or never-stamped receipt says "no
    successful run on record"; an `error` stamped AFTER `last_success_at`
    (record_failure deliberately preserves the older last_success_at, so
    gap_line alone still reads "fresh") says the last run FAILED. An error that
    predates the last success is a repaired poller and yields nothing, so the
    gate can never become a permanent warning. An unparseable `failed_at` is
    treated as current -- fail-closed."""
    last_success = (receipt or {}).get("last_success_at")
    if not last_success:
        return ["- poller: no successful run on record — run-receipt.json missing, unreadable or never stamped"]
    error = str((receipt or {}).get("error") or "").strip()
    if not error:
        return []
    failed_at = (receipt or {}).get("failed_at")
    failed_dt = _parse_receipt_ts(failed_at)
    success_dt = _parse_receipt_ts(last_success)
    if failed_dt is not None and success_dt is not None and failed_dt <= success_dt:
        return []
    return [f"- poller: last run FAILED at {failed_at or 'unknown'}: {error}"]


def _superseded_task_ids(ledger: Ledger, row: ObservationRow) -> set[str]:
    # G-SUPER-1 (G0B-15): the digest a revision supersedes can be arbitrarily
    # older than the 24h window this digest covers, so the search reads FULL
    # ledger history (rows_since(_EPOCH_SENTINEL)), never just `rows_since(now
    # - 1 day)` — filtered to the exact row this revision's revision_of names.
    ids: set[str] = set()
    for hist in ledger.rows_since(_EPOCH_SENTINEL):
        if hist.source_ref != row.source_ref or hist.content_digest != row.revision_of:
            continue
        for w in hist.writes:
            if w.startswith("task:"):
                ids.add(_task_id(w))
    return ids


def gmail_section(
    state_dir: Path,
    vault: Path,
    ledger: Ledger,
    now: datetime,
    window_days: int,
    runner: Runner,
) -> list[str]:
    state_dir = Path(state_dir)
    since = (now - timedelta(days=1)).isoformat()
    rows = ledger.rows_since(since)

    change_lines: list[str] = []

    # G-SUPER-1: one list_open_tasks() enumeration covers every revision row
    # in this window's current-status join -- only called when there is
    # something to join against.
    open_tasks_by_id: dict[str, dict[str, Any]] = {}
    if any(row.revision_of for row in rows):
        open_tasks_by_id = {t["id"]: t for t in list_open_tasks(runner)}

    for row in rows:
        # G0B-17: EVERY per-row line -- writes (with the extraction summary),
        # suppressions, escalations and the revision marker -- comes from the
        # SHARED projection (client_state_projections.plan_digest_line), the
        # same rendering the dry-run preview uses. This loop adds ONLY what that
        # projection cannot know: the join against currently-open tasks below.
        # It used to re-emit the revision/suppression/escalation events in its
        # own wording on top of the projection's, so a row with writes AND any
        # of those reported each one twice. G0B2-4: a SIMULATED (dry-run) row's
        # effective writes are its `planned_writes`, so the G4 item-6 dry-run
        # digest reports what the run previewed instead of "0 changes".
        change_lines.extend(plan_digest_line(row))
        if row.revision_of:
            for tid in sorted(_superseded_task_ids(ledger, row)):
                task = open_tasks_by_id.get(tid)
                if task is not None:
                    # FR-001 D-02: any OPEN task derived from the superseded
                    # digest is flagged for review, never auto-closed.
                    change_lines.append(f"- evidence superseded — review: task:{tid} {task['title']}")

    ignored_refs: set[str] = set()
    ignored_senders: set[str] = set()
    domain_counts: Counter[str] = Counter()
    for row in rows:
        for res in row.resolutions:
            if res.outcome != "ignored":
                continue
            ignored_refs.add(row.source_ref)
            ignored_senders.add(res.email or row.source_ref)
            dom = _sender_domain(res.email)
            if dom:
                domain_counts[dom] += 1
    if ignored_refs:
        line = f"- ignored (no-known-entity): {len(ignored_refs)} messages from {len(ignored_senders)} senders"
        top = ", ".join(f"{d} ({n})" for d, n in domain_counts.most_common(5))
        if top:
            line += f" — top: {top}"
        change_lines.append(line)

    receipt = read_receipt(state_dir)
    for trunc in (receipt or {}).get("truncation", []):
        change_lines.append(f"- truncated: {trunc.get('day')} ({trunc.get('count')} msgs, cap reached)")

    # G-DIG-3 (FR-009): the collapsed OK sentence below CLAIMS a healthy poller
    # ("poller last success <X>"), so a receipt that cannot prove one must
    # speak. Appending to change_lines is what makes the claim unreachable --
    # the G-DIG-1 collapse already refuses to fire while any change line
    # exists, so there is exactly ONE place the OK sentence is gated.
    change_lines.extend(_poller_health_lines(receipt))  # G-DIG-3

    gap = gap_line(receipt, window_days, now)

    # G-BASE-1 (G0B-14): NO auto-baseline. A missing or corrupt baseline is an
    # ERROR the digest reports -- it is never written here; `write-baseline`
    # is a deliberate, one-time CLI step the activate goal commits.
    baseline = load_baseline(state_dir)
    if baseline is None:
        invariant_lines = ["- invariants: baseline missing — run write-baseline"]
    else:
        nv = new_violations(compute_invariants(vault, ledger, baseline["epoch"]), baseline["invariants"])
        invariant_lines = []
        for row in nv["org_name_multi"]:
            invariant_lines.append(
                f"- invariant: CRM org name {row['name']!r} declared on {len(row['pages'])} pages: "
                f"{', '.join(row['pages'])}"
            )
        for row in nv["domain_multi"]:
            invariant_lines.append(
                f"- invariant: domain {row['domain']!r} declared on {len(row['pages'])} pages: "
                f"{', '.join(row['pages'])}"
            )
        for row in nv["missing_gmail_refs"]:
            invariant_lines.append(
                f"- invariant: missing ledger ref {row['ref']} (page {row['page']}, dated {row['date']})"
            )
        if not invariant_lines:
            invariant_lines = ["- invariants: OK"]

    # G-DIG-1: a silent watcher is indistinguishable from a dead one, so the
    # single-line OK collapses ONLY when there is truly nothing to report
    # (which also means a missing baseline NEVER collapses -- its error line
    # is not "- invariants: OK").
    if not change_lines and gap is None and invariant_lines == ["- invariants: OK"]:
        last_success = (receipt or {}).get("last_success_at", "unknown")
        return [f"Client state (Gmail) OK — 0 changes in 24h, invariants OK, poller last success {last_success}"]

    lines = ["Client state (Gmail) — last 24h", *change_lines]
    if gap:
        lines.append(gap)
    lines.extend(invariant_lines)
    return lines


def _cmd_write_baseline(args: argparse.Namespace) -> int:
    state_dir = Path(args.state_dir)
    vault = Path(args.vault)
    ledger_path = Path(args.ledger) if args.ledger else state_dir / "observations.jsonl"
    ledger = Ledger(ledger_path)
    now_iso = datetime.now(timezone.utc).isoformat()
    inv = compute_invariants(vault, ledger, now_iso)
    path = write_baseline(state_dir, inv, now_iso)
    print(f"baseline written: {path} (epoch {now_iso})")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="client_state_digest.py")
    sub = parser.add_subparsers(dest="command", required=True)

    wb = sub.add_parser(
        "write-baseline",
        help="commit a one-time invariants baseline (explicit, never automatic — G0B-14)",
    )
    wb.add_argument("--state-dir", required=True)
    wb.add_argument("--vault", required=True)
    wb.add_argument("--ledger", default=None, help="defaults to <state-dir>/observations.jsonl")
    wb.set_defaults(func=_cmd_write_baseline)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
