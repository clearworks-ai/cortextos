"""FR-004: standalone email/domain -> entity resolution (contact-email + full-domain,
guarded against bare-label collisions and duplicate-suppressed company names)."""
from __future__ import annotations

import json
from pathlib import Path

from resolve_meeting import _norm_title, load_closed_sets
import resolve_email
from resolve_email import EmailResolver, load_contacts
import gmail_source


def _client_page(domains: str = "", crm_org_names: list[str] | None = None) -> str:
    lines = ["# Client: Fixture", "", "## Node", "id: fixture", ""]
    if domains:
        lines.append(f"domains: {domains}")
        lines.append("")
    for name in crm_org_names or []:
        lines.append(f"- CRM org name: {name}")
    lines.append("")
    lines.append("## Open Items")
    lines.append("")
    return "\n".join(lines)


def _make_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    clients = vault / "raw" / "areas" / "clearworks" / "org-brain" / "clients"
    clients.mkdir(parents=True)
    (clients / "alloi.md").write_text(
        _client_page(domains="alloi.us", crm_org_names=["Alloy"]), encoding="utf-8"
    )
    (clients / "acme.md").write_text(_client_page(domains="acme.org"), encoding="utf-8")
    (clients / "example-com.md").write_text(_client_page(domains="example.com"), encoding="utf-8")
    (clients / "example-org.md").write_text(_client_page(domains="example.org"), encoding="utf-8")
    (clients / "dupe1.md").write_text(
        _client_page(domains="dupeone.example", crm_org_names=["Dupeco"]), encoding="utf-8"
    )
    (clients / "dupe2.md").write_text(
        _client_page(domains="duptwo.example", crm_org_names=["Dupeco"]), encoding="utf-8"
    )
    return vault


def _closed(tmp_path: Path) -> dict:
    return load_closed_sets(_make_vault(tmp_path))


def _msg(from_email: str, to: list[str] | None = None, cc: list[str] | None = None) -> gmail_source.Message:
    return gmail_source.Message(
        id="m1",
        thread_id="t1",
        from_name="Sender",
        from_email=from_email,
        to=to or ["josh@clearworks.ai"],
        cc=cc or [],
        subject="hi",
        date_iso="2026-09-14T00:00:00Z",
        body_text="body",
    )


class _DupCounterpartyMsg:
    """Duck-typed stand-in used ONLY to prove resolve_message's own exact-address
    dedup fires even if a future Message.counterparties() implementation ever
    stopped deduping upstream -- gmail_source.Message already dedupes, so this
    can't be exercised through the real class."""

    from_email = "one@alloi.us"

    def counterparties(self) -> list[str]:
        return ["one@alloi.us", "One@Alloi.US", "one@alloi.us"]


def test_contact_email_path(tmp_path):
    closed = _closed(tmp_path)
    contacts = [
        {"id": "c-ally", "name": "Ally Person", "emails": ["ally@notalloi.example"], "company": "Alloy"},
    ]
    r = EmailResolver(closed, contacts).resolve_address("ally@notalloi.example")
    assert r.outcome == "pending"
    assert r.slug == "alloi"
    assert r.kind == "client"
    assert r.method == "contact-email"
    assert r.contact_id == "c-ally"


def test_page_domain_path(tmp_path):
    closed = _closed(tmp_path)
    r = EmailResolver(closed, []).resolve_address("person@acme.org")
    assert r.outcome == "pending"
    assert r.slug == "acme"
    assert r.kind == "client"
    assert r.method == "page-domain"
    assert r.contact_id is None


def test_full_domain_never_bare_label_collision(tmp_path):
    """G-RES-1. `load_closed_sets` stores BOTH the full domain AND
    `registrable_label(dom)` as keys (resolve_meeting.py:312-313), so
    domain_to_slug["example"] EXISTS and points at whichever page happened to
    be read last. Asserting only ONE direction therefore cannot detect a
    bare-label collapse -- it would silently agree with the last-writer page.
    BOTH directions are asserted here, so a resolver reading the bare label is
    guaranteed to get at least one of them wrong (G0A2-6)."""
    resolver = EmailResolver(_closed(tmp_path), [])
    com = resolver.resolve_address("person@example.com")
    org = resolver.resolve_address("person@example.org")
    assert com.slug == "example-com", com
    assert org.slug == "example-org", org
    assert com.slug != org.slug


def test_contact_company_blank_falls_to_domain(tmp_path):
    closed = _closed(tmp_path)
    contacts = [
        {"id": "c-blank", "name": "Blank Co", "emails": ["blank@acme.org"], "company": ""},
    ]
    r = EmailResolver(closed, contacts).resolve_address("blank@acme.org")
    assert r.outcome == "pending"
    assert r.method == "page-domain"
    assert r.slug == "acme"


def test_contact_company_duplicate_suppressed_no_match(tmp_path):
    closed = _closed(tmp_path)
    assert closed["org_name_to_slug"].get(_norm_title("Dupeco")) == ""
    contacts = [
        {"id": "c-dup", "name": "Dup Person", "emails": ["dup@nowhere.example"], "company": "Dupeco"},
    ]
    r = EmailResolver(closed, contacts).resolve_address("dup@nowhere.example")
    assert r.outcome == "ignored"
    assert r.reason == "no-known-entity"


def test_ambiguous_escalates_with_reason(tmp_path):
    closed = _closed(tmp_path)
    contacts = [
        {"id": "c-ambig", "name": "Ambig Person", "emails": ["ambig@acme.org"], "company": "Alloy"},
    ]
    r = EmailResolver(closed, contacts).resolve_address("ambig@acme.org")
    assert r.outcome == "escalated"
    assert r.reason == "ambiguous:alloi|acme"


def test_unknown_sender_single_ignored(tmp_path):
    closed = _closed(tmp_path)
    resolver = EmailResolver(closed, [])
    msg = _msg("stranger@unknown.example")
    results = resolver.resolve_message(msg)
    assert len(results) == 1
    assert results[0].outcome == "ignored"


def test_fanout_two_resolutions(tmp_path):
    closed = _closed(tmp_path)
    resolver = EmailResolver(closed, [])
    msg = _msg("person@alloi.us", cc=["person@acme.org"])
    results = resolver.resolve_message(msg)
    slugs = sorted(r.slug for r in results)
    assert len(results) == 2
    assert slugs == ["acme", "alloi"]


def test_two_distinct_addresses_same_slug_both_kept(tmp_path):
    # C3/G0B-9: contact-level rows -- two DIFFERENT known contacts on the same
    # client page must each get their own Resolution, never merged by slug.
    closed = _closed(tmp_path)
    contacts = [
        {"id": "c-one", "name": "One Person", "emails": ["one@alloi.us"], "company": "Alloy"},
        {"id": "c-two", "name": "Two Person", "emails": ["two@alloi.us"], "company": "Alloy"},
    ]
    resolver = EmailResolver(closed, contacts)
    msg = _msg("one@alloi.us", cc=["two@alloi.us"])
    results = resolver.resolve_message(msg)
    assert len(results) == 2
    assert [r.slug for r in results] == ["alloi", "alloi"]
    assert {r.contact_id for r in results} == {"c-one", "c-two"}


def test_exact_duplicate_address_deduped_once(tmp_path):
    closed = _closed(tmp_path)
    resolver = EmailResolver(closed, [])
    results = resolver.resolve_message(_DupCounterpartyMsg())
    assert len(results) == 1
    assert results[0].slug == "alloi"


def test_norm_title_never_called_on_none_or_blank_company(tmp_path, monkeypatch):
    closed = _closed(tmp_path)
    calls = {"n": 0}

    def _boom(_title):
        calls["n"] += 1
        raise AssertionError("_norm_title must not be called for a falsy company")

    monkeypatch.setattr(resolve_email, "_norm_title", _boom)
    contacts = [
        {"id": "c-blank2", "name": "Blank Two", "emails": ["blank2@nowhere.example"], "company": ""},
        {"id": "c-none", "name": "None Co", "emails": ["none@nowhere2.example"], "company": None},
    ]
    resolver = EmailResolver(closed, contacts)
    r1 = resolver.resolve_address("blank2@nowhere.example")
    r2 = resolver.resolve_address("none@nowhere2.example")
    assert r1.outcome == "ignored"
    assert r2.outcome == "ignored"
    assert calls["n"] == 0


def test_load_contacts_reads_file(tmp_path):
    crm_dir = tmp_path / "crm"
    crm_dir.mkdir()
    (crm_dir / "contacts.json").write_text(
        json.dumps({"contacts": [{"id": "c-1", "name": "X", "emails": ["x@y.example"], "company": None}]}),
        encoding="utf-8",
    )
    contacts = load_contacts(crm_dir)
    assert len(contacts) == 1
    assert contacts[0]["id"] == "c-1"


def test_load_contacts_missing_file_returns_empty(tmp_path):
    assert load_contacts(tmp_path / "no-such-crm") == []
