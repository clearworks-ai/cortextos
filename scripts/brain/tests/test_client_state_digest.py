"""FR-009 invariants + baseline (Part A) and the Gmail digest section (Part B)."""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

import client_state_digest as cs_digest  # noqa: E402
from helpers_client_state import FakeRunner  # noqa: E402
from observation_ledger import Ledger, ObservationRow, Resolution  # noqa: E402


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _page(
    vault: Path,
    folder: str,
    slug: str,
    *,
    domains: str = "",
    org_names: tuple[str, ...] = (),
    history: tuple[str, ...] = (),
) -> Path:
    body = ["# Client: " + slug, "", "## Node", f"id: {slug}", "kind: engagement", f"client: {slug}"]
    if domains:
        body.append(f"domains: {domains}")
    for name in org_names:
        body.append(f"- CRM org name: {name}")
    body.append("")
    body.append("## History")
    body.append("")
    body.extend(history)
    body.append("")
    return _write(vault / "raw/areas/clearworks/org-brain" / folder / f"{slug}.md", "\n".join(body))


def _empty_ledger(tmp_path: Path) -> Ledger:
    state = tmp_path / "state"
    state.mkdir(parents=True, exist_ok=True)
    return Ledger(state / "observations.jsonl")


def test_compute_invariants_flags_duplicate_org_name_across_pages(tmp_path):
    vault = tmp_path / "vault"
    _page(vault, "clients", "acme-a", org_names=("Acme Corp",))
    _page(vault, "clients", "acme-b", org_names=("acme corp",))
    inv = cs_digest.compute_invariants(vault, _empty_ledger(tmp_path), "2026-01-01")
    assert len(inv["org_name_multi"]) == 1
    assert set(inv["org_name_multi"][0]["pages"]) == {"acme-a", "acme-b"}


def test_compute_invariants_flags_duplicate_domain_across_pages(tmp_path):
    vault = tmp_path / "vault"
    _page(vault, "clients", "dup-a", domains="shared.com")
    _page(vault, "orgs", "dup-b", domains="shared.com")
    inv = cs_digest.compute_invariants(vault, _empty_ledger(tmp_path), "2026-01-01")
    assert any(
        row["domain"] == "shared.com" and set(row["pages"]) == {"dup-a", "dup-b"}
        for row in inv["domain_multi"]
    )


def test_compute_invariants_does_not_confuse_different_tlds(tmp_path):
    """G-INV-1. Asserting only 'example.com not in flagged' cannot detect a
    bare-label collapse -- under the collapse the key becomes 'example', which
    also satisfies that assertion. So the WHOLE section is asserted, against a
    vault that ALSO contains one genuine duplicate: a collapse changes both the
    key and the row count, so the mutation is guaranteed to bite (G0A2-6)."""
    vault = tmp_path / "vault"
    _page(vault, "clients", "tld-a", domains="example.com")
    _page(vault, "clients", "tld-b", domains="example.org")
    _page(vault, "clients", "dup-a", domains="shared.com")
    _page(vault, "clients", "dup-b", domains="shared.com")
    inv = cs_digest.compute_invariants(vault, _empty_ledger(tmp_path), "2026-01-01")
    rows = sorted(inv["domain_multi"], key=lambda r: r["domain"])
    assert rows == [{"domain": "shared.com", "pages": ["dup-a", "dup-b"]}], rows


def test_compute_invariants_missing_gmail_ref_post_epoch_only(tmp_path):
    vault = tmp_path / "vault"
    _page(
        vault,
        "clients",
        "ref-page",
        history=(
            "- 2026-09-01 — pre-epoch email (email) [source: gmail:pre123]",
            "- 2026-09-10 — post-epoch email (email) [source: gmail:post456]",
            "- 2026-09-11 — a meeting (meeting: raw/media/transcripts/fireflies/xyz) [source: fireflies:xyz789]",
        ),
    )
    inv = cs_digest.compute_invariants(vault, _empty_ledger(tmp_path), "2026-09-05")
    refs = {row["ref"] for row in inv["missing_gmail_refs"]}
    assert refs == {"gmail:post456"}


def test_baseline_round_trip(tmp_path):
    state = tmp_path / "state"
    inv = {"org_name_multi": [], "domain_multi": [], "missing_gmail_refs": []}
    path = cs_digest.write_baseline(state, inv, "2026-09-14T00:00:00+00:00")
    assert path.is_file()
    loaded = cs_digest.load_baseline(state)
    assert loaded["epoch"] == "2026-09-14T00:00:00+00:00"
    assert loaded["invariants"] == inv
    assert "computed_at" in loaded


def test_load_baseline_missing_returns_none(tmp_path):
    assert cs_digest.load_baseline(tmp_path / "state") is None


def test_new_violations_excludes_grandfathered(tmp_path):
    baseline = {
        "org_name_multi": [{"name": "Old Co", "pages": ["a", "b"]}],
        "domain_multi": [],
        "missing_gmail_refs": [{"ref": "gmail:already-known", "page": "a", "date": "2026-08-01"}],
    }
    current = {
        "org_name_multi": [
            {"name": "Old Co", "pages": ["a", "b"]},
            {"name": "New Co", "pages": ["c", "d"]},
        ],
        "domain_multi": [{"domain": "fresh.com", "pages": ["e", "f"]}],
        "missing_gmail_refs": [
            {"ref": "gmail:already-known", "page": "a", "date": "2026-08-01"},
            {"ref": "gmail:brand-new", "page": "g", "date": "2026-09-12"},
        ],
    }
    nv = cs_digest.new_violations(current, baseline)
    assert [r["name"] for r in nv["org_name_multi"]] == ["New Co"]
    assert [r["domain"] for r in nv["domain_multi"]] == ["fresh.com"]
    assert [r["ref"] for r in nv["missing_gmail_refs"]] == ["gmail:brand-new"]


def test_new_violations_flags_page_added_to_existing_duplicate_set():
    # G0B-14: comparing by name/domain KEY ALONE would grandfather page "c"
    # forever once "Acme Corp" was first seen duplicated on [a, b].
    baseline = {
        "org_name_multi": [{"name": "Acme Corp", "pages": ["a", "b"]}],
        "domain_multi": [{"domain": "shared.com", "pages": ["x", "y"]}],
        "missing_gmail_refs": [],
    }
    current = {
        "org_name_multi": [{"name": "Acme Corp", "pages": ["a", "b", "c"]}],
        "domain_multi": [{"domain": "shared.com", "pages": ["x", "y", "z"]}],
        "missing_gmail_refs": [],
    }
    nv = cs_digest.new_violations(current, baseline)
    assert nv["org_name_multi"] == [{"name": "Acme Corp", "pages": ["a", "b", "c"]}]
    assert nv["domain_multi"] == [{"domain": "shared.com", "pages": ["x", "y", "z"]}]


def test_new_violations_flags_the_same_ref_missing_from_a_different_page():
    """G0B-14 / C10: the canonical record for a missing ref is (ref, page).
    Comparing by REF ALONE would grandfather the same ref later going missing
    from a DIFFERENT page -- a genuinely new violation."""
    baseline = {
        "org_name_multi": [], "domain_multi": [],
        "missing_gmail_refs": [{"ref": "gmail:known", "page": "clients/acme.md", "date": "2026-08-01"}],
    }
    current = {
        "org_name_multi": [], "domain_multi": [],
        "missing_gmail_refs": [
            {"ref": "gmail:known", "page": "clients/acme.md", "date": "2026-08-01"},
            {"ref": "gmail:known", "page": "clients/alloi.md", "date": "2026-09-12"},
        ],
    }
    nv = cs_digest.new_violations(current, baseline)
    assert nv["missing_gmail_refs"] == [
        {"ref": "gmail:known", "page": "clients/alloi.md", "date": "2026-09-12"}
    ]


def _resolution(**over) -> Resolution:
    base = dict(
        slug="acme", kind="client", method="contact-email", outcome="filed",
        reason="", contact_id="c1", email="marcos@alloi.us",
    )
    base.update(over)
    return Resolution(**base)


def _row(source_ref, digest, observed_at, *, resolutions=None, writes=None, revision_of=None,
          suppressed=None, extraction=None, simulated=False, planned_writes=None) -> ObservationRow:
    return ObservationRow(
        source_ref=source_ref,
        thread_id=f"thread-{source_ref}",
        content_digest=digest,
        observed_at=observed_at,
        resolutions=resolutions if resolutions is not None else [_resolution()],
        writes=writes or [],
        revision_of=revision_of,
        suppressed=suppressed or [],
        extraction=extraction,
        simulated=simulated,
        planned_writes=planned_writes or [],
    )


def _seed_baseline_ok(state: Path, now: datetime) -> None:
    cs_digest.write_baseline(
        state, {"org_name_multi": [], "domain_multi": [], "missing_gmail_refs": []}, now.isoformat()
    )


def test_gmail_section_renders_each_change_line_type(tmp_path):
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    state.mkdir(parents=True)
    ledger = Ledger(state / "observations.jsonl")
    now = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)

    ledger.append(_row(
        "gmail:msg-a", "digesta", "2026-09-14T08:00:00+00:00",
        resolutions=[_resolution(slug="acme", outcome="filed")],
        writes=["clients/acme.md", "crm:c-marcos"],
        extraction={"summary": "Marcos asked for the renewal quote"},
    ))
    # G0B-15: this task was filed DAYS before the 24h window and is later
    # superseded by a revision INSIDE the window -- proves the superseded
    # lookup reads FULL ledger history, not just rows_since(last 24h).
    ledger.append(_row(
        "gmail:msg-b", "digestb1", "2026-09-01T08:05:00+00:00",
        resolutions=[_resolution(slug="acme", outcome="filed")],
        writes=["task:T-1|Send tacticals doc"],
    ))
    ledger.append(_row(
        "gmail:msg-b", "digestb2", "2026-09-14T09:00:00+00:00",
        resolutions=[_resolution(slug="acme", outcome="filed")],
        writes=["clients/acme.md"],
        revision_of="digestb1",
    ))
    ledger.append(_row(
        "gmail:msg-c", "digestc", "2026-09-14T09:10:00+00:00",
        resolutions=[_resolution(slug="acme", outcome="filed")],
        writes=[],
        suppressed=[{"title": "Send Alloi the tacticals doc", "tier": 1, "match": "Ship tacticals doc"}],
    ))
    ledger.append(_row(
        "gmail:msg-d", "digestd", "2026-09-14T09:20:00+00:00",
        resolutions=[_resolution(
            slug="", kind="", method="none", outcome="escalated",
            reason="ambiguous:acme|widget-co", email="",
        )],
        writes=[],
    ))
    ledger.append(_row(
        "gmail:msg-e", "digeste", "2026-09-14T09:30:00+00:00",
        resolutions=[_resolution(
            slug="", kind="", method="none", outcome="ignored",
            reason="no-known-entity", email="rando@unknown-co.com",
        )],
        writes=[],
    ))

    _write(state / "run-receipt.json", json.dumps({
        "last_success_at": "2026-09-14T11:50:00+00:00",
        "window_days": 3,
        "message_count": 6,
        "truncation": [{"day": "2026-09-12", "count": 50}],
        "cost_usd": 0.42,
    }))
    _seed_baseline_ok(state, now)

    runner = FakeRunner({
        ("cortextos", "bus", "list-tasks"): subprocess.CompletedProcess(
            ["cortextos", "bus", "list-tasks"], 0,
            json.dumps([{"id": "T-1", "title": "Send tacticals doc", "status": "open", "assigned_to": "josh"}]),
            "",
        ),
    })

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=runner)
    text = "\n".join(lines)

    assert "Client state (Gmail) — last 24h" in text
    # G0B-17: the change lines come from the SHARED projection
    # (client_state_projections.plan_digest_line) and carry the extraction
    # summary -- the same rendering the dry-run preview uses.
    assert "- Page: clients/acme.md (gmail:msg-a) — Marcos asked for the renewal quote" in text
    assert "- CRM: crm:c-marcos (gmail:msg-a) — Marcos asked for the renewal quote" in text
    assert "- Revision: gmail:msg-b supersedes digestb1" in text
    assert "- evidence superseded — review: task:T-1 Send tacticals doc" in text
    assert "- Task suppressed (tier 1): Send Alloi the tacticals doc matches 'Ship tacticals doc' (gmail:msg-c)" in text
    assert "- Escalated: gmail:msg-d — ambiguous:acme|widget-co" in text
    assert "1 messages from 1 senders" in text
    assert "unknown-co.com" in text
    assert "- truncated: 2026-09-12 (50 msgs, cap reached)" in text
    assert "- invariants: OK" in text


def test_gmail_section_renders_simulated_rows_from_planned_writes(tmp_path):
    """G0B2-4 / G4 item 6: the dry-run digest is built from the dry-run ledger.
    A simulated row's PLANNED writes are reported (tagged [simulated]) instead
    of an empty `writes` list producing a digest that claims zero changes."""
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    state.mkdir(parents=True)
    ledger = Ledger(state / "observations.jsonl")
    now = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)
    ledger.append(_row(
        "gmail:msg-s", "digests", "2026-09-14T08:00:00+00:00",
        resolutions=[_resolution(slug="acme", outcome="filed")],
        writes=[], planned_writes=["crm:<new:marcos@acme.org>", "clients/acme.md", "task:<new>|Send MSA"],
        simulated=True, extraction={"summary": "Marcos asked for the MSA"},
    ))
    _write(state / "run-receipt.json", json.dumps({
        "last_success_at": "2026-09-14T11:50:00+00:00",
        "window_days": 3, "message_count": 1, "truncation": [], "cost_usd": 0.01,
    }))
    _seed_baseline_ok(state, now)

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    text = "\n".join(lines)
    assert "Client state (Gmail) OK — 0 changes" not in text   # NOT a zero-change digest
    assert "- CRM: crm:<new:marcos@acme.org> (gmail:msg-s) — Marcos asked for the MSA [simulated]" in text
    assert "- Page: clients/acme.md (gmail:msg-s) — Marcos asked for the MSA [simulated]" in text
    assert "- Task created: Send MSA (gmail:msg-s) [simulated]" in text


def test_gmail_section_collapses_to_one_line_when_nothing_happened(tmp_path):
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    state.mkdir(parents=True)
    ledger = Ledger(state / "observations.jsonl")
    now = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)
    _write(state / "run-receipt.json", json.dumps({
        "last_success_at": "2026-09-14T11:55:00+00:00",
        "window_days": 3, "message_count": 0, "truncation": [], "cost_usd": 0.0,
    }))
    _seed_baseline_ok(state, now)

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    assert len(lines) == 1
    assert lines[0].startswith("Client state (Gmail) OK — 0 changes in 24h, invariants OK, poller last success ")
    assert "2026-09-14T11:55:00+00:00" in lines[0]


def test_gmail_section_shows_gap_line_when_receipt_stale(tmp_path):
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    state.mkdir(parents=True)
    ledger = Ledger(state / "observations.jsonl")
    now = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)
    _write(state / "run-receipt.json", json.dumps({
        "last_success_at": "2026-09-01T00:00:00+00:00",  # far older than a 3-day window
        "window_days": 3, "message_count": 0, "truncation": [], "cost_usd": 0.0,
    }))
    _seed_baseline_ok(state, now)

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    assert lines[0] == "Client state (Gmail) — last 24h"
    assert not lines[0].startswith("Client state (Gmail) OK")
    assert any("2026-09-01" in ln for ln in lines)


def test_gmail_section_reports_missing_baseline_and_never_writes_one(tmp_path):
    # G0B-14: no auto-baseline -- a missing baseline is an ERROR line, and
    # gmail_section must never write one itself.
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    state.mkdir(parents=True)
    ledger = Ledger(state / "observations.jsonl")
    now = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)
    _write(state / "run-receipt.json", json.dumps({
        "last_success_at": "2026-09-14T11:55:00+00:00",
        "window_days": 3, "message_count": 0, "truncation": [], "cost_usd": 0.0,
    }))
    assert cs_digest.load_baseline(state) is None

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    text = "\n".join(lines)
    assert "- invariants: baseline missing — run write-baseline" in text
    assert cs_digest.load_baseline(state) is None


def test_gmail_section_reports_corrupt_baseline(tmp_path):
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    state.mkdir(parents=True)
    ledger = Ledger(state / "observations.jsonl")
    now = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)
    _write(state / "run-receipt.json", json.dumps({
        "last_success_at": "2026-09-14T11:55:00+00:00",
        "window_days": 3, "message_count": 0, "truncation": [], "cost_usd": 0.0,
    }))
    (state / cs_digest.BASELINE_FILE).write_text("{not json", encoding="utf-8")

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    text = "\n".join(lines)
    assert "- invariants: baseline missing — run write-baseline" in text


def test_write_baseline_cli_writes_committed_baseline(tmp_path):
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    _page(vault, "clients", "solo", org_names=("Solo Co",))

    rc = cs_digest.main(["write-baseline", "--state-dir", str(state), "--vault", str(vault)])
    assert rc == 0
    baseline = cs_digest.load_baseline(state)
    assert baseline is not None
    assert baseline["invariants"]["org_name_multi"] == []


# --- G2a-1 / FR-009: poller-health gate on the one-line OK sentence ----------
# A silent watcher must be distinguishable from a dead one. The collapsed
# "Client state (Gmail) OK — ... poller last success <X>" sentence asserts a
# healthy poller, so it may only be emitted when the receipt PROVES a success
# that no later failure has invalidated.

def _no_rows_state(tmp_path) -> tuple[Path, Path, Ledger, datetime]:
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    state.mkdir(parents=True)
    ledger = Ledger(state / "observations.jsonl")
    now = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)
    _seed_baseline_ok(state, now)
    return vault, state, ledger, now


def test_gmail_section_warns_when_receipt_missing(tmp_path):
    vault, state, ledger, now = _no_rows_state(tmp_path)
    assert not (state / "run-receipt.json").exists()

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    text = "\n".join(lines)

    assert not text.startswith("Client state (Gmail) OK"), text
    assert "poller last success unknown" not in text
    assert any(ln.startswith("- poller: no successful run on record") for ln in lines), text


def test_gmail_section_warns_when_receipt_corrupt(tmp_path):
    vault, state, ledger, now = _no_rows_state(tmp_path)
    (state / "run-receipt.json").write_text("{not json", encoding="utf-8")

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    text = "\n".join(lines)

    assert not text.startswith("Client state (Gmail) OK"), text
    assert any(ln.startswith("- poller: no successful run on record") for ln in lines), text


def test_gmail_section_warns_when_receipt_has_no_last_success(tmp_path):
    vault, state, ledger, now = _no_rows_state(tmp_path)
    _write(state / "run-receipt.json", json.dumps({
        "window_days": 3, "message_count": 0, "truncation": [], "cost_usd": 0.0,
    }))

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    text = "\n".join(lines)

    assert not text.startswith("Client state (Gmail) OK"), text
    assert any(ln.startswith("- poller: no successful run on record") for ln in lines), text


def test_gmail_section_warns_when_last_run_failed_after_last_success(tmp_path):
    """record_failure preserves last_success_at, so a receipt carrying a RECENT
    error still looks fresh to gap_line. The digest must say the last run
    failed instead of collapsing to OK."""
    vault, state, ledger, now = _no_rows_state(tmp_path)
    _write(state / "run-receipt.json", json.dumps({
        "last_success_at": "2026-09-14T09:00:00+00:00",
        "error": "gws gmail +triage failed rc=1: token expired",
        "failed_at": "2026-09-14T11:55:00+00:00",
        "window_days": 3, "message_count": 0, "truncation": [], "cost_usd": 0.0,
    }))

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    text = "\n".join(lines)

    assert not text.startswith("Client state (Gmail) OK"), text
    assert "- poller: last run FAILED at 2026-09-14T11:55:00+00:00: " \
           "gws gmail +triage failed rc=1: token expired" in text


def test_gmail_section_still_collapses_for_a_healthy_receipt(tmp_path):
    """A receipt whose error PREDATES the last success is a repaired poller --
    it still collapses, so the health gate cannot become a permanent warning."""
    vault, state, ledger, now = _no_rows_state(tmp_path)
    _write(state / "run-receipt.json", json.dumps({
        "last_success_at": "2026-09-14T11:55:00+00:00",
        "error": "gws gmail +triage failed rc=1: token expired",
        "failed_at": "2026-09-13T04:00:00+00:00",
        "window_days": 3, "message_count": 0, "truncation": [], "cost_usd": 0.0,
    }))

    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=FakeRunner({}))
    assert len(lines) == 1
    assert lines[0].startswith("Client state (Gmail) OK — 0 changes in 24h, invariants OK, poller last success ")


# --- G2a-5: ONE source for every digest event line ---------------------------

def test_gmail_section_emits_each_event_exactly_once(tmp_path):
    """plan_digest_line(row) already renders the revision, suppression and
    escalation lines for a row that has writes; the surrounding loop used to
    render them a SECOND time in its own wording."""
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    state.mkdir(parents=True)
    ledger = Ledger(state / "observations.jsonl")
    now = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)

    ledger.append(_row(
        "gmail:msg-x", "digestx", "2026-09-14T09:00:00+00:00",
        resolutions=[
            _resolution(slug="acme", outcome="filed"),
            _resolution(slug="", kind="", method="none", outcome="escalated",
                        reason="ambiguous:acme|alloi", email=""),
        ],
        writes=["clients/acme.md"],
        revision_of="digestw0",
        suppressed=[{"title": "Send the MSA", "tier": 1, "match": "Ship the MSA"}],
        extraction={"summary": "Marcos asked again"},
    ))
    _write(state / "run-receipt.json", json.dumps({
        "last_success_at": "2026-09-14T11:50:00+00:00",
        "window_days": 3, "message_count": 1, "truncation": [], "cost_usd": 0.01,
    }))
    _seed_baseline_ok(state, now)

    runner = FakeRunner({
        ("cortextos", "bus", "list-tasks"): subprocess.CompletedProcess(
            ["cortextos", "bus", "list-tasks"], 0, "[]", "",
        ),
    })
    lines = cs_digest.gmail_section(state, vault, ledger, now, window_days=3, runner=runner)

    revision_lines = [ln for ln in lines if "supersedes" in ln.lower() or "revision" in ln.lower()]
    suppression_lines = [ln for ln in lines if "Send the MSA" in ln]
    escalation_lines = [ln for ln in lines if "escalat" in ln.lower()]
    page_lines = [ln for ln in lines if "clients/acme.md" in ln]

    assert len(revision_lines) == 1, revision_lines
    assert len(suppression_lines) == 1, suppression_lines
    assert len(escalation_lines) == 1, escalation_lines
    assert len(page_lines) == 1, page_lines
    # the reason the loop's own line carried is not lost
    assert any("ambiguous:acme|alloi" in ln for ln in escalation_lines), escalation_lines
