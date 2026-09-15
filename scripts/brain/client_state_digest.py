"""FR-009 invariants + daily Gmail digest section for meeting_loop_watch.py.

Part A (Task 18): invariant computation over org-brain pages plus a COMMITTED,
EXPLICITLY WRITTEN baseline (G0B-14, wave2 C10 — no auto-baseline; the
`write-baseline` CLI entry is a one-time step) so only NEW violations ever
reach Josh. Part B (Task 19) adds gmail_section(), the renderer
meeting_loop_watch.py calls, and the `write-baseline` CLI.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from atomic import atomic_write  # noqa: E402
from brain_rollup import _section_text  # noqa: E402
from observation_ledger import Ledger  # noqa: E402
from resolve_meeting import _domains_from_text, _norm_title, _org_names_from_text  # noqa: E402
from writeback_render import org_brain_root  # noqa: E402

BASELINE_FILE = "invariants-baseline.json"
_PAGE_FOLDERS = ("clients", "orgs", "projects")
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

            for oname in _org_names_from_text(text):
                key = _norm_title(oname)
                if not key:
                    continue
                entry = org_pages.setdefault(key, {"name": oname, "pages": []})
                if path.stem not in entry["pages"]:
                    entry["pages"].append(path.stem)

            for dom in _domains_from_text(text):
                # G-INV-1: FULL domain only, never registrable_label — a
                # bare-label collapse (example.com/example.org -> "example")
                # is exactly the false positive this invariant must not raise.
                pages = domain_pages.setdefault(dom, [])
                if path.stem not in pages:
                    pages.append(path.stem)

            history = _section_text(path, "History")
            for line in history.splitlines():
                m = _GMAIL_REF_LINE_RE.match(line.strip())
                if not m:
                    continue
                entry_date, ref = m.group(1), m.group(2)
                if entry_date < epoch_date:
                    continue  # pre-epoch refs are grandfathered by construction
                if ref not in known_refs:
                    missing_refs.append({"ref": ref, "page": path.stem, "date": entry_date})

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
    sections, ref alone for missing refs (G-BASE-2 / G0B-14 fix — comparing by
    name/domain KEY ALONE would grandfather a page added to an already-known
    duplicate group; the page-set must be part of the identity)."""
    out: dict[str, list[dict[str, Any]]] = {}
    for section, key_name in (("org_name_multi", "name"), ("domain_multi", "domain")):
        base_canon = {
            (item[key_name], tuple(sorted(item.get("pages", []))))
            for item in baseline.get(section, [])
        }
        out[section] = [
            item
            for item in current.get(section, [])
            if (item[key_name], tuple(sorted(item.get("pages", [])))) not in base_canon
        ]
    base_refs = {item["ref"] for item in baseline.get("missing_gmail_refs", [])}
    out["missing_gmail_refs"] = [
        item for item in current.get("missing_gmail_refs", []) if item["ref"] not in base_refs
    ]
    return out
