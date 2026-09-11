"""FR-003: acceptance meeting title+aliases → alloi-03 rule 2."""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

FIXTURES_CRM = Path(__file__).resolve().parent / "fixtures" / "crm"


def _node_page(client: str, nid: str, aliases: str) -> str:
    return f"""# Client: {client} — {nid}

## Node
id: {nid}
kind: project
client: {client}
parent: alloi-01
title: Tactical Reports
aliases: {aliases}
domains: alloi.us
deal_id:
delivery_state: active
opened:
closed:

## History (dated, newest first)

## Open Items
"""


def _write_env(dir_path: Path, title: str) -> None:
    source = {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": "01M1MW2G"},
        "title": title,
        "occurred_at": "2026-09-04T17:00:00Z",
        "duration_s": 12,
        "participants": [
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Marcos",
                "email": "marcos@alloi.us",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        "text_units": [{"i": 0, "speaker": "Marcos", "text": "hello tacticals", "ts": 0}],
        "native_summary": {"overview": "hello tacticals"},
    }
    raw = json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (dir_path / "source.json").write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    (dir_path / "source.sha256").write_text(sha + "\n", encoding="utf-8")
    extraction = {
        "schema": "brain.extraction/1",
        "inputSha": sha,
        "promptSha": "p",
        "model": "sonnet",
        "cost_usd": 0,
        "extracted_at": "2026-09-05T00:00:00Z",
        "classification": {
            "org_name": "Alloi",
            "domain": "alloi.us",
            "relationship": "client",
            "confidence": 0.9,
            "evidence": "hello tacticals",
        },
        "summary": {"overview": "hello tacticals", "bullets": []},
        "decisions": [{"text": "Keep cadence", "quote": "hello"}],
        "commitments": [],
        "proposed_delivery_state": None,
        "deal_state": "won",
        "meeting_type": "delivery",
    }
    (dir_path / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")


def test_alloi_title_alias_rule_2(tmp_path, capsys) -> None:
    from resolve_meeting import main

    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    (brain / "clients" / "alloi.md").write_text(
        "# Client: Alloi\n\n## Contacts\n\ndomains: alloi.us\n",
        encoding="utf-8",
    )
    (brain / "projects" / "alloi-03.md").write_text(
        _node_page("alloi", "alloi-03", "tacticals, tactical report, arch tactical"),
        encoding="utf-8",
    )
    (brain / "projects" / "alloi-01.md").write_text(
        _node_page("alloi", "alloi-01", ""),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_env(src, "Weekly tacticals review")
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai/agents/crm-codex/crm").mkdir(parents=True)
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text("{}", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        '{"contacts":[]}', encoding="utf-8"
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "home=projects/alloi-03.md" in out
    assert "node=alloi-03" in out
    assert "rule=2" in out
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["node"] == "alloi-03"
    assert res["rule"] == 2
    val = json.loads((src / "validated.json").read_text(encoding="utf-8"))
    assert val["decisions"][0]["quote"] == "hello"


def test_empty_quote_is_dropped() -> None:
    from resolve_meeting import quote_gate

    extraction = {
        "decisions": [{"text": "Keep cadence", "quote": ""}],
        "commitments": [{"text": "Ship it", "quote": "   "}],
        "proposed_delivery_state": {"to": "delivered", "quote": ""},
    }
    source = {"text_units": [{"text": "hello tacticals"}]}
    validated = quote_gate(extraction, source)
    assert validated["decisions"] == []
    assert validated["commitments"] == []
    assert validated["proposed_delivery_state"] is None
    assert validated["dropped"]["decisions"] == 1
    assert validated["dropped"]["commitments"] == 1
    assert validated["dropped"]["promotion"] is True
    assert validated["dropped"]["promotion_reason"] == "ungrounded"


def test_ungrounded_promotion_is_dropped() -> None:
    from resolve_meeting import quote_gate

    extraction = {
        "decisions": [{"text": "Keep cadence", "quote": "hello"}],
        "commitments": [],
        "proposed_delivery_state": {"to": "delivered", "quote": "we never said this"},
    }
    source = {"text_units": [{"text": "hello tacticals"}]}
    validated = quote_gate(extraction, source)
    assert len(validated["decisions"]) == 1
    assert validated["proposed_delivery_state"] is None
    assert validated["dropped"]["promotion"] is True


def test_multi_client_picks_deterministically_and_keeps_also_present(tmp_path, capsys) -> None:
    from resolve_meeting import main

    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    (brain / "clients" / "alpha.md").write_text(
        "# Client: Alpha\n\n## Contacts\n\ndomains: alpha.com\n",
        encoding="utf-8",
    )
    (brain / "clients" / "beta.md").write_text(
        "# Client: Beta\n\n## Contacts\n\ndomains: beta.com\n",
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    source = {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": "01MULTI"},
        "title": "Weekly sync",
        "occurred_at": "2026-09-04T17:00:00Z",
        "duration_s": 12,
        "participants": [
            {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Ann", "email": "ann@alpha.com", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Abe", "email": "abe@alpha.com", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Bea", "email": "bea@beta.com", "side": "theirs", "spoke": True, "notetaker": False, "handle": None},
        ],
        "text_units": [{"i": 0, "speaker": "Ann", "text": "hello", "ts": 0}],
        "native_summary": {"overview": "hello"},
    }
    raw = json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (src / "source.json").write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    (src / "source.sha256").write_text(sha + "\n", encoding="utf-8")
    extraction = {
        "schema": "brain.extraction/1",
        "inputSha": sha,
        "promptSha": "p",
        "model": "sonnet",
        "cost_usd": 0,
        "extracted_at": "2026-09-05T00:00:00Z",
        "classification": {
            "org_name": "Alpha",
            "domain": "alpha.com",
            "relationship": "client",
            "confidence": 0.9,
            "evidence": "hello",
        },
        "summary": {"overview": "hello", "bullets": []},
        "decisions": [{"text": "Keep cadence", "quote": "hello"}],
        "commitments": [],
        "proposed_delivery_state": None,
        "deal_state": "won",
        "meeting_type": "delivery",
    }
    (src / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai/agents/crm-codex/crm").mkdir(parents=True)
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text("{}", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        '{"contacts":[]}', encoding="utf-8"
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["counterparty_slug"] == "alpha"
    assert res["home_path"] == "clients/alpha.md"
    assert res["also_present"] == ["beta"]
    assert res["rule"] == 3


def _seed_brain(tmp_path: Path) -> tuple[Path, Path]:
    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai/agents/crm-codex/crm").mkdir(parents=True)
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text("{}", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        '{"contacts":[]}', encoding="utf-8"
    )
    return vault, repo


def _write_source(
    dir_path: Path,
    *,
    title: str,
    participants: list[dict],
    text: str = "hello",
    org_name: str = "Internal",
    domain: str | None = "clearworks.ai",
    relationship: str = "internal",
    confidence: float = 0.9,
    meeting_type: str = "internal",
    deal_state: str | None = "none",
    fireflies_id: str = "01RULE8",
    occurred_at: str = "2026-09-04T17:00:00Z",
) -> None:
    source = {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": fireflies_id},
        "title": title,
        "occurred_at": occurred_at,
        "duration_s": 12,
        "participants": participants,
        "text_units": [{"i": 0, "speaker": "Josh", "text": text, "ts": 0}],
        "native_summary": {"overview": text},
    }
    raw = json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (dir_path / "source.json").write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    (dir_path / "source.sha256").write_text(sha + "\n", encoding="utf-8")
    extraction = {
        "schema": "brain.extraction/1",
        "inputSha": sha,
        "promptSha": "p",
        "model": "sonnet",
        "cost_usd": 0,
        "extracted_at": "2026-09-05T00:00:00Z",
        "classification": {
            "org_name": org_name,
            "domain": domain,
            "relationship": relationship,
            "confidence": confidence,
            "evidence": text,
        },
        "summary": {"overview": text, "bullets": []},
        "decisions": [{"text": "Keep cadence", "quote": text.split()[0]}],
        "commitments": [],
        "proposed_delivery_state": None,
        "deal_state": deal_state,
        "meeting_type": meeting_type,
    }
    (dir_path / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")


def test_rule_6_creates_org_from_unknown_nonfree_domain(tmp_path) -> None:
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Intro call",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Sam",
                "email": "sam@newco-fixture.test",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Wrong Name",
        domain="newco-fixture.test",
        relationship="prospect",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 6
    assert res["home_path"] == "orgs/newco-fixture.md"
    assert res["created"] == {
        "kind": "org",
        "slug": "newco-fixture",
        "relationship": "prospect",
    }
    assert res["node"] == "none"


def test_rule_7_freemail_external_creates_person_page(tmp_path) -> None:
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Weekly sync",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Sam Patel",
                "email": "sam@gmail.com",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Unknown Co",
        domain="gmail.com",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["home_path"] == "orgs/sam-patel.md"
    assert res["created"] == {
        "kind": "person",
        "slug": "sam-patel",
        "relationship": "personal",
    }


def test_rule_8_no_externals_homes_clearworks_internal(tmp_path) -> None:
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Weekly internal standup",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            }
        ],
        org_name="Alloi",
        domain="alloi.us",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 8
    assert res["home_path"] == "orgs/clearworks-internal.md"
    assert res["node"] == "none"
    assert res["created"] == {
        "kind": "org",
        "slug": "clearworks-internal",
        "relationship": "internal",
    }


def test_rule_3_also_present_includes_org_candidates(tmp_path) -> None:
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "alpha.md").write_text(
        "# Client: Alpha\n\n## Contacts\n\ndomains: alpha.com\n",
        encoding="utf-8",
    )
    (brain / "orgs" / "vendor.md").write_text(
        "# Vendor\n\ndomains: vendor.com\n",
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Weekly sync",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Ann",
                "email": "ann@alpha.com",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Vic",
                "email": "vic@vendor.com",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Alpha",
        domain="alpha.com",
        relationship="client",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 3
    assert res["home_path"] == "clients/alpha.md"
    assert res["also_present"] == ["vendor"]


def test_empty_participants_and_text_units_exit_5(tmp_path) -> None:
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    source = {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": "01EMPTY"},
        "title": "Ghost",
        "occurred_at": "2026-09-04T17:00:00Z",
        "duration_s": 0,
        "participants": [],
        "text_units": [],
        "native_summary": {"overview": ""},
    }
    raw = json.dumps(source, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (src / "source.json").write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    (src / "source.sha256").write_text(sha + "\n", encoding="utf-8")
    extraction = {
        "schema": "brain.extraction/1",
        "inputSha": sha,
        "promptSha": "p",
        "model": "sonnet",
        "cost_usd": 0,
        "extracted_at": "2026-09-05T00:00:00Z",
        "classification": {
            "org_name": "X",
            "domain": "x.test",
            "relationship": "prospect",
            "confidence": 0.1,
            "evidence": "n",
        },
        "summary": {"overview": "", "bullets": []},
        "decisions": [],
        "commitments": [],
        "proposed_delivery_state": None,
        "deal_state": "none",
        "meeting_type": "other",
    }
    (src / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 5


def test_sha_mismatch_exits_4(tmp_path) -> None:
    from resolve_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    (src / "source.json").write_text("{}", encoding="utf-8")
    (src / "source.sha256").write_text("deadbeef\n", encoding="utf-8")
    rc = main(["--source", str(src), "--vault", str(tmp_path), "--repo-root", str(tmp_path)])
    assert rc == 4


def test_non_string_quote_is_dropped() -> None:
    from resolve_meeting import quote_gate

    extraction = {
        "decisions": [{"text": "Keep cadence", "quote": 123}],
        "commitments": [],
        "proposed_delivery_state": {"state": "delivered", "quote": 123},
    }
    source = {"text_units": [{"text": "hello 123 tacticals"}]}
    validated = quote_gate(extraction, source)
    assert validated["decisions"] == []
    assert validated["proposed_delivery_state"] is None
    assert validated["dropped"]["decisions"] == 1
    assert validated["dropped"]["promotion"] is True


def test_null_company_contact_does_not_steal_client_domain(tmp_path) -> None:
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "alloi.md").write_text(
        "# Client: Alloi\n\n## Contacts\n\ndomains: alloi.us\n",
        encoding="utf-8",
    )
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps(
            {
                "contacts": [
                    {"id": "ivette", "company": None, "emails": ["ivette@alloi.us"]},
                ]
            }
        ),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Weekly sync",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Marcos",
                "email": "marcos@alloi.us",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Alloi",
        domain="alloi.us",
        relationship="client",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/alloi.md"
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "alloi"


def test_f2_live_com_is_free_mail_not_org(tmp_path) -> None:
    """D-13: live.com must never yield created org slug 'live' — follow rule 5/7 person path."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Intro call",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Lee Adams",
                "email": "lee@live.com",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Unknown",
        domain="live.com",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["kind"] == "person"
    assert res["created"] == {
        "kind": "person",
        "slug": "lee-adams",
        "relationship": "personal",
    }
    assert res["created"]["slug"] != "live"


def test_f5_also_present_excludes_home_client_rule_1(tmp_path) -> None:
    """also_present for rules 1/2 must exclude the resolved home client itself."""
    from resolve_meeting import main

    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    (brain / "clients" / "alloi.md").write_text(
        "# Client: Alloi\n\n## Contacts\n\ndomains: alloi.us\n",
        encoding="utf-8",
    )
    (brain / "clients" / "alpha.md").write_text(
        "# Client: Alpha\n\n## Contacts\n\ndomains: alpha.com\n",
        encoding="utf-8",
    )
    (brain / "projects" / "alloi-03.md").write_text(
        _node_page("alloi", "alloi-03", "tacticals"),
        encoding="utf-8",
    )
    (brain / "projects" / "alloi-01.md").write_text(
        _node_page("alloi", "alloi-01", ""),
        encoding="utf-8",
    )
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai/agents/crm-codex/crm").mkdir(parents=True)
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text("{}", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        '{"contacts":[]}', encoding="utf-8"
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Node alloi-03 sync",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Marcos",
                "email": "marcos@alloi.us",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Ann",
                "email": "ann@alpha.com",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Alloi",
        domain="alloi.us",
        relationship="client",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 1
    assert res["node"] == "alloi-03"
    assert res["also_present"] == ["alpha"]


def test_f6_existing_org_uses_page_relationship_over_classification(tmp_path) -> None:
    """rule 6 existing-org relationship reads orgs/<slug>.md frontmatter first (§4a enum)."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "orgs" / "vendor.md").write_text(
        "# Vendor\n\nrelationship: vendor\ndomains: vendor.com\n",
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Vendor check-in",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Vic",
                "email": "vic@vendor.com",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Vendor",
        domain="vendor.com",
        relationship="prospect",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 6
    assert res["counterparty_slug"] == "vendor"
    assert res["relationship"] == "vendor"
    assert res["created"] is None


def test_f6_existing_org_falls_back_to_classification_when_page_has_no_relationship(tmp_path) -> None:
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "orgs" / "vendor2.md").write_text(
        "# Vendor2\n\ndomains: vendor2.com\n",
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Vendor check-in",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Pat",
                "email": "pat@vendor2.com",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Vendor2",
        domain="vendor2.com",
        relationship="partner",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 6
    assert res["relationship"] == "partner"


def test_f6_ambiguous_relationship_exits_5(tmp_path) -> None:
    """No page relationship: and no valid classification.relationship => FR-003 ambiguity exit."""
    from resolve_meeting import load_closed_sets, resolve

    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    (brain / "orgs" / "vendor3.md").write_text(
        "# Vendor3\n\ndomains: vendor3.com\n",
        encoding="utf-8",
    )
    closed = load_closed_sets(vault)
    source = {
        "title": "Intro",
        "occurred_at": "2026-09-04T17:00:00Z",
        "participants": [
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
            },
            {
                "name": "Vic",
                "email": "vic@vendor3.com",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
            },
        ],
        "text_units": [{"i": 0, "speaker": "Vic", "text": "hi"}],
    }
    with pytest.raises(SystemExit) as exc:
        resolve(source, closed, tmp_path / "repo", classification=None)
    assert exc.value.code == 5


def test_f7_contact_company_alias_first_not_slugify(tmp_path) -> None:
    """G-32/G-55: contacts.json company->slug prebuild must check the alias table before slugify."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "alloi.md").write_text(
        "# Client: Alloi\n\n## Contacts\n\ndomains: alloi.us\n",
        encoding="utf-8",
    )
    (brain / "clients" / "alloi-inc.md").write_text(
        "# Client: Alloi Inc (decoy)\n\n## Contacts\n\n",
        encoding="utf-8",
    )
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text(
        json.dumps({"Alloi Inc": "alloi"}), encoding="utf-8"
    )
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps(
            {
                "contacts": [
                    {"id": "c1", "company": "Alloi Inc", "emails": ["known@alloi-other.test"]},
                ]
            }
        ),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Weekly sync",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Marcos",
                "email": "marcos@alloi-other.test",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Alloi",
        domain="alloi-other.test",
        relationship="client",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "alloi"
    assert res["home_path"] == "clients/alloi.md"


# --- R4 resolver-fix (2026-09-06 brain-backfill-r4 D-20 review): 5/15 wrong
# homes from batch fireflies-20260907T173226Z. These tests use SELF-CONTAINED
# CRM fixtures (scripts/brain/tests/fixtures/crm/{contacts,org-aliases}.json)
# holding only the real rows the R1-R5/control/F-cases below need — copied
# verbatim from the real contacts.json/org-aliases.json (messy real-world
# alias/company data that a hand-rolled stub can't reproduce) so the tests
# never depend on a path outside this repo (round-2 fable review F6) — see
# .pipeline/sdd/2026-09-06-brain-backfill-r4/resolver-fix-round2-brief.md.
# Fixtures below carry ONLY participants + classification copied from the real
# envelopes (never transcript text).


def _r4_repo_root(tmp_path: Path) -> Path:
    """F6 (round 2): copy the fixture CRM rows to the exact relative path
    resolve() reads (orgs/clearworksai/agents/crm-codex/crm/) under a fresh
    tmp repo root, so every R4 test is self-contained."""
    repo = tmp_path / "repo"
    crm_dir = repo / "orgs/clearworksai/agents/crm-codex/crm"
    crm_dir.mkdir(parents=True)
    shutil.copy(FIXTURES_CRM / "contacts.json", crm_dir / "contacts.json")
    shutil.copy(FIXTURES_CRM / "org-aliases.json", crm_dir / "org-aliases.json")
    return repo


def _seed_r4_vault(tmp_path: Path) -> tuple[Path, Path]:
    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    (brain / "clients" / "msia.md").write_text(
        "# Client: MSIA\n\n## Contacts\n\n## Current state\n\n"
        "- CRM org name: Movement of Spiritual Awareness\n",
        encoding="utf-8",
    )
    for slug, name in (
        ("pts", "PTS"),
        ("logictcg", "LogicTCG"),
        ("calasiaconstruction", "CalAsia Construction"),
        ("allsafeit", "AllSafe IT"),
        ("kadre", "Kadre"),
    ):
        (brain / "clients" / f"{slug}.md").write_text(f"# Client: {name}\n\n## Contacts\n", encoding="utf-8")
    (brain / "clients" / "alloi.md").write_text(
        "# Client: Alloi\n\n## Contacts\n\ndomains: alloi.us\n", encoding="utf-8"
    )
    repo = _r4_repo_root(tmp_path)
    return vault, repo


def _r1_participants() -> list[dict]:
    return [
        {"name": None, "email": "josh@clearworks.ai", "side": "ours", "spoke": False, "notetaker": False},
        {"name": "Josh Weiss", "email": None, "side": "ours", "spoke": True, "notetaker": False},
        {"name": "Douglas Teiger", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {
            "name": "Eddie Cortez | Kluger Architects",
            "email": None,
            "side": "unknown",
            "spoke": True,
            "notetaker": False,
        },
        {"name": "Steven Burns, FAIA", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Melvin Williams", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Thesla Collier", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]


def test_r1_aia_office_hours_creates_community_org_not_person(tmp_path) -> None:
    """D-20: internal AIA LA teaching session — home is the community org page,
    never a person page carved from an attendee (was rule 7 -> orgs/douglas-teiger.md,
    01KYGEE6TGNCNZ1YMYHQMZH9KC)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    participants = _r1_participants()
    _write_source(
        src,
        title="AI Office Hours (AIA LA TAP Committee)",
        participants=participants,
        org_name="AIA LA (Office Hours community)",
        domain=None,
        relationship="colleague",
        confidence=0.55,
        meeting_type="other",
        fireflies_id="01KYGEE6TGNCNZ1YMYHQMZH9KC",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "orgs/aia-la.md"
    assert res["rule"] == 10
    assert res["counterparty_slug"] == "aia-la"
    assert res["kind"] == "org"
    assert res["created"] == {"kind": "org", "relationship": "colleague", "slug": "aia-la"}


def test_r2_aia_office_hours_number_2_same_community_org(tmp_path) -> None:
    """D-20: second AIA LA session normalizes to the SAME org page as R1
    (01KZ4G1SY192WQRSQD5SGCR171, was rule 7 -> orgs/thesla-collier.md)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": "Thesla Collier", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Josh Weiss", "email": None, "side": "ours", "spoke": True, "notetaker": False},
        {
            "name": "Eddie Cortez | Kluger Architects",
            "email": None,
            "side": "unknown",
            "spoke": True,
            "notetaker": False,
        },
        {"name": "Melvin Williams", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Douglas Teiger", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Steven Burns, FAIA", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]
    _write_source(
        src,
        title="AIA AI Office Hours Number 2",
        participants=participants,
        org_name="AIA LA Office Hours",
        domain=None,
        relationship="colleague",
        confidence=0.55,
        meeting_type="other",
        fireflies_id="01KZ4G1SY192WQRSQD5SGCR171",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "orgs/aia-la.md"
    assert res["rule"] == 10
    assert res["counterparty_slug"] == "aia-la"
    # F10 (round 2): same created-org shape as R1 — same community page, not
    # a second created page and not None (this attendee set didn't create it
    # first; R1's identical fixture-per-test tmp vault means this test run
    # creates aia-la itself, exactly like R1).
    assert res["created"] == {"kind": "org", "relationship": "colleague", "slug": "aia-la"}


def test_f1_community_rule_wins_even_when_attendee_org_page_exists(tmp_path) -> None:
    """F1 (round 2, Critical): seeding one attendee's own org page (Thesla
    Collier -> HNTB Corporation) must NOT pre-empt the community predicate —
    rule 10 must still fire before rules 4/6 get a candidate to look at.

    N9 (round 3, Minor): this test alone does NOT isolate the rule-10 hoist —
    with the F7 email-match gate in place, a name-only HNTB match can no
    longer reach org_cands at all, so this test stays green even if only the
    hoist (not F7) is reverted. It is a paired control with
    test_f1_community_rule_wins_even_when_attendee_client_page_exists, which
    (via the B-override/rule-4 client path, unaffected by F7) is the one that
    actually proves the hoist."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "orgs" / "hntb-corporation.md").write_text(
        "# HNTB Corporation\n\nrelationship: colleague\n", encoding="utf-8"
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="AI Office Hours (AIA LA TAP Committee)",
        participants=_r1_participants(),
        org_name="AIA LA (Office Hours community)",
        domain=None,
        relationship="colleague",
        confidence=0.55,
        meeting_type="other",
        fireflies_id="01KYGEE6TGNCNZ1YMYHQMZH9KC",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "orgs/aia-la.md"
    assert res["rule"] == 10
    assert res["created"] == {"kind": "org", "relationship": "colleague", "slug": "aia-la"}


def test_f1_community_rule_wins_even_when_attendee_client_page_exists(tmp_path) -> None:
    """F1 (round 2, Critical): seeding one attendee's own CLIENT page (Melvin
    Williams -> HKS Inc.) must NOT pre-empt the community predicate either —
    rule 10 must still fire before the B override / rule 3-4 default."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "hks-inc.md").write_text("# Client: HKS Inc.\n\n## Contacts\n", encoding="utf-8")
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="AI Office Hours (AIA LA TAP Committee)",
        participants=_r1_participants(),
        org_name="AIA LA (Office Hours community)",
        domain=None,
        relationship="colleague",
        confidence=0.55,
        meeting_type="other",
        fireflies_id="01KYGEE6TGNCNZ1YMYHQMZH9KC",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "orgs/aia-la.md"
    assert res["rule"] == 10
    assert res["created"] == {"kind": "org", "relationship": "colleague", "slug": "aia-la"}


def test_n2_rule10_reuses_existing_client_page_named_by_org_name(tmp_path) -> None:
    """N2 (round 3, Important): the hoisted rule-10 predicate must not create
    a duplicate orgs/<slug>.md beside an existing clients/<slug>.md for the
    same normalized org name — reuse the client page instead (round-2 review
    N2 repro: a colleague/personal-labelled, email-less session whose
    org_name normalizes to an existing CLIENT slug used to create
    orgs/hks-inc.md beside clients/hks-inc.md)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "hks-inc.md").write_text("# Client: HKS Inc.\n\n## Contacts\n", encoding="utf-8")
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="AI Office Hours (AIA LA TAP Committee)",
        participants=_r1_participants(),
        org_name="HKS Inc.",
        domain=None,
        relationship="colleague",
        confidence=0.55,
        meeting_type="other",
        fireflies_id="01KYGEE6TGNCNZ1YMYHQMZH9KC",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/hks-inc.md"
    assert res["rule"] == 10
    assert res["created"] is None


def _r3_participants() -> list[dict]:
    return [
        {"name": None, "email": "yohanr@logictcg.com", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": None, "email": "markj@jensen-architects.com", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": None, "email": "jaime@russianriverkeeper.org", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False},
        {"name": None, "email": "ariel@russianriverkeeper.org", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": None, "email": "rob@russianriverkeeper.org", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": None, "email": "amelia@russianriverkeeper.org", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": "Rob Schwenker (he, him)", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Mark Jensen", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {
            "name": "Jaime Neary, Russian Riverkeeper",
            "email": None,
            "side": "unknown",
            "spoke": True,
            "notetaker": False,
        },
    ]


def test_r3_russian_riverkeeper_classification_over_minority_client(tmp_path) -> None:
    """D-20: 4 Russian Riverkeeper participants outnumber the 1 logictcg
    participant; no client/org page exists for Russian Riverkeeper yet, so
    the high-confidence classification creates one (was rule 3 ->
    clients/logictcg.md, 01KYGEE6SHKHM67BFY8B0DK1FP)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Tech Committee Meeting #4",
        participants=_r3_participants(),
        org_name="Russian Riverkeeper",
        domain="russianriverkeeper.org",
        relationship="client",
        confidence=0.85,
        meeting_type="delivery",
        deal_state="won",
        fireflies_id="01KYGEE6SHKHM67BFY8B0DK1FP",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "orgs/russian-riverkeeper.md"
    assert res["rule"] == 9
    assert res["counterparty_slug"] == "russian-riverkeeper"
    assert res["created"] == {"kind": "org", "relationship": "client", "slug": "russian-riverkeeper"}


def test_f3_rule9_reuses_existing_org_page_declaring_the_domain(tmp_path) -> None:
    """F3 (round 2, Important): when a page ALREADY declares the classified
    domain (orgs/rrk.md: domains: russianriverkeeper.org), rule 9 must home
    to that existing page (created None) instead of creating a duplicate
    orgs/russian-riverkeeper.md under a different slug."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "orgs" / "rrk.md").write_text(
        "# Russian Riverkeeper\n\nrelationship: client\ndomains: russianriverkeeper.org\n",
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Tech Committee Meeting #4",
        participants=_r3_participants(),
        org_name="Russian Riverkeeper",
        domain="russianriverkeeper.org",
        relationship="client",
        confidence=0.85,
        meeting_type="delivery",
        deal_state="won",
        fireflies_id="01KYGEE6SHKHM67BFY8B0DK1FP",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "orgs/rrk.md"
    assert res["rule"] == 9
    assert res["counterparty_slug"] == "rrk"
    assert res["created"] is None


def test_n3_reverse_alias_resolves_msia_without_crm_org_name_line(tmp_path) -> None:
    """N3 (round 3, Important): the reverse-alias lookup in
    _resolve_company_slug must resolve clients/msia.md via org-aliases.json
    ("msia.org" -> "Movement of Spiritual Awareness") WITHOUT depending on a
    "- CRM org name:" page line at all. Round-2 review N3: the round-2 test
    suite never proved this independently of the org_name_to_slug fallback —
    deleting the reverse-alias block left R5 green via that fallback because
    _seed_r4_vault's msia.md always carried the CRM-org-name line."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "msia.md").write_text("# Client: MSIA\n\n## Contacts\n", encoding="utf-8")
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False},
        {"name": None, "email": "julie@pts.org", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": "julie lurie", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]
    _write_source(
        src,
        title="Julie Lurie and Josh Weiss",
        participants=participants,
        org_name="PTS",
        domain="pts.org",
        relationship="client",
        confidence=0.85,
        meeting_type="delivery",
        deal_state="none",
        fireflies_id="01KZF06155XKMBF7Y0YXD5KB5F",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/msia.md"
    assert res["rule"] == 4
    assert res["counterparty_slug"] == "msia"
    assert res["created"] is None


def test_n4_reverse_alias_canonicalizes_alias_key_company(tmp_path) -> None:
    """N4 (round 3, Important): _resolve_company_slug must canonicalize the
    contact row's company through the alias table BEFORE the reverse-alias
    lookup, so a contact whose company is the alias KEY (the raw legal name
    "Movement of Spiritual Awareness Internationale (MSIA)") resolves exactly
    like one whose company is already the alias VALUE. Uses a per-test
    contacts.json override (mirrors test_f7_contact_company_alias_first_not_slugify)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "msia.md").write_text("# Client: MSIA\n\n## Contacts\n", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps(
            {
                "contacts": [
                    {
                        "id": "fixture-julie",
                        "name": "julie lurie",
                        "company": "Movement of Spiritual Awareness Internationale (MSIA)",
                        "emails": [],
                        "aliases": [],
                        "type": "person",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False},
        {"name": None, "email": "julie@pts.org", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": "julie lurie", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]
    _write_source(
        src,
        title="Julie Lurie and Josh Weiss",
        participants=participants,
        org_name="PTS",
        domain="pts.org",
        relationship="client",
        confidence=0.85,
        meeting_type="delivery",
        deal_state="none",
        fireflies_id="01KZF06155XKMBF7Y0YXD5KB5F",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/msia.md"
    assert res["rule"] == 4
    assert res["counterparty_slug"] == "msia"
    assert res["created"] is None


def test_n7_reverse_alias_uses_pristine_domain_map_over_contacts_overlay(tmp_path) -> None:
    """N7 (round 3, Minor): the reverse-alias lookup must try the pristine,
    page-frontmatter-only domain map (closed["domain_to_slug"]) BEFORE the
    local map that a later contact row's company-name slugification can
    clobber — mirrors F3's same fix for rule 9. "Clobber Contact"'s company
    slugifies to the same label as "Target Contact"'s declared domain and
    overwrites the local overlaid map for that label with a non-page value;
    only the pristine map still points at the real client page."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "foo-page.md").write_text(
        "# Client: Foo\n\n## Contacts\n\ndomains: somefoo.org\n", encoding="utf-8"
    )
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text(
        json.dumps({"somefoo.org": "Some Foo Org"}), encoding="utf-8"
    )
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps(
            {
                "contacts": [
                    {
                        "id": "clobber",
                        "name": "Clobber Contact",
                        "company": "SomeFoo",
                        "emails": ["x@somefoo.example"],
                        "aliases": [],
                        "type": "person",
                    },
                    {
                        "id": "target",
                        "name": "Target Contact",
                        "company": "Some Foo Org",
                        "emails": [],
                        "aliases": [],
                        "type": "person",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Foo catchup",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Target Contact",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Some Foo Org",
        domain=None,
        relationship="vendor",
        confidence=0.4,
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/foo-page.md"
    assert res["rule"] == 4


def test_r4_calasia_vs_allsafe_participant_count_weighting(tmp_path) -> None:
    """D-20: 3 CalAsia participants vs 1 AllSafe IT participant — pick by
    participant count (was rule 3 -> clients/allsafeit.md, alphabetical
    fallback, 01KZCM9K0PQJTS5S6BP1P2VKY9)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {
            "name": None,
            "email": "myrnamurawski@calasiaconstruction.com",
            "side": "theirs",
            "spoke": False,
            "notetaker": False,
        },
        {
            "name": None,
            "email": "johnmurawski@calasiaconstruction.com",
            "side": "theirs",
            "spoke": False,
            "notetaker": False,
        },
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": False, "notetaker": False},
        {"name": None, "email": "abbey@calasiaconstruction.com", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": "Nathan Phinney", "email": "nphinney@allsafeit.com", "side": "theirs", "spoke": True, "notetaker": False},
        {"name": "John Murawski", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Abbey Ocampo", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Chris", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]
    _write_source(
        src,
        title="AllSafe IT <> CalAsia Construction: Introductory Call",
        participants=participants,
        org_name="CalAsia Construction",
        domain="calasiaconstruction.com",
        relationship="prospect",
        confidence=0.8,
        meeting_type="sales",
        deal_state="proposal",
        fireflies_id="01KZCM9K0PQJTS5S6BP1P2VKY9",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/calasiaconstruction.md"
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "calasiaconstruction"
    assert res["created"] is None


def test_r5_contacts_beats_domain_julie_lurie_msia_not_pts(tmp_path) -> None:
    """D-20: julie@pts.org (domain) vs "julie lurie" contacts.json match
    (company Movement of Spiritual Awareness -> msia) — the identified
    contact wins (was rule 3 -> clients/pts.md, 01KZF06155XKMBF7Y0YXD5KB5F;
    the classification LLM also said PTS here and was wrong)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False},
        {"name": None, "email": "julie@pts.org", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": "julie lurie", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]
    _write_source(
        src,
        title="Julie Lurie and Josh Weiss",
        participants=participants,
        org_name="PTS",
        domain="pts.org",
        relationship="client",
        confidence=0.85,
        meeting_type="delivery",
        deal_state="none",
        fireflies_id="01KZF06155XKMBF7Y0YXD5KB5F",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/msia.md"
    assert res["rule"] == 4
    assert res["counterparty_slug"] == "msia"
    assert res["created"] is None


def test_f4_contact_name_collision_across_companies_is_no_match(tmp_path) -> None:
    """F4 (round 2, Important): real contacts.json has a true two-company
    name collision (Brian Skowvron -> Gruen Associates AND AC Martin). A
    name-only speaker with that name must not silently pick the first row on
    file order and override the real kadre.org domain pick — it must count
    as no contact match at all."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "gruen-associates.md").write_text(
        "# Client: Gruen Associates\n\n## Contacts\n", encoding="utf-8"
    )
    (brain / "clients" / "ac-martin.md").write_text("# Client: AC Martin\n\n## Contacts\n", encoding="utf-8")
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False},
        {"name": None, "email": "nerin@kadre.org", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": "Brian Skowvron", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]
    _write_source(
        src,
        title="Kadre intro",
        participants=participants,
        org_name="Kadre",
        domain="kadre.org",
        relationship="client",
        confidence=0.6,
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/kadre.md"
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "kadre"
    assert res["created"] is None


def test_n6_collision_guard_skips_unresolvable_row_first_in_file_order(tmp_path) -> None:
    """N6 (round 3, Minor): when duplicate-name rows all "agree" (0 or 1
    distinct resolved company slug), the collision guard must not just hand
    back matches[0] on file order — if that row's OWN company fails to
    resolve while a sibling row (same name) resolves fine, the identity must
    still be usable. "Pat Dual"'s first contacts.json row (an unresolvable
    company) sits before the row that resolves to the existing kadre client
    page."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps(
            {
                "contacts": [
                    {
                        "id": "dup1",
                        "name": "Pat Dual",
                        "company": "Some Unresolvable Co",
                        "emails": [],
                        "aliases": [],
                        "type": "person",
                    },
                    {
                        "id": "dup2",
                        "name": "Pat Dual",
                        "company": "Kadre",
                        "emails": [],
                        "aliases": [],
                        "type": "person",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Kadre catchup",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Pat Dual",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Kadre",
        domain=None,
        relationship="client",
        confidence=0.5,
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/kadre.md"
    assert res["rule"] == 4
    assert res["counterparty_slug"] == "kadre"


def test_control_kadre_low_confidence_classification_stays_rule3(tmp_path) -> None:
    """Control: 01KYZASJY2ZTWC9F4ET3QZ5RFZ. classification.confidence=0.6 is
    below the 0.8 rule-9 threshold, so the single-domain rule-3 pick is
    untouched (kadre)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False},
        {"name": None, "email": "nerin@kadre.org", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": "Zoom user", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]
    _write_source(
        src,
        title="Nerin Kadribegovic and Josh Weiss",
        participants=participants,
        org_name="Kadre",
        domain="kadre.org",
        relationship="client",
        confidence=0.6,
        meeting_type="sales",
        deal_state="proposal",
        fireflies_id="01KYZASJY2ZTWC9F4ET3QZ5RFZ",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/kadre.md"
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "kadre"
    assert res["created"] is None


def test_control_alloi_single_domain_candidate_stays_rule3(tmp_path) -> None:
    """Control: 01KZF3MM897VEM5FDQN5R7HASA. classification agrees with the
    only domain candidate — no rule-9 override, no contacts-name override
    (alloi)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": None, "email": "marcos@alloi.us", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": None, "email": "josh@clearworks.ai", "side": "ours", "spoke": False, "notetaker": False},
        {"name": "Josh Weiss", "email": None, "side": "ours", "spoke": True, "notetaker": False},
        {
            "name": "Marcos  Alloi  Architect, Builder, Mountaineer",
            "email": None,
            "side": "unknown",
            "spoke": True,
            "notetaker": False,
        },
    ]
    _write_source(
        src,
        title="Alloi — Marcos Santa Ana",
        participants=participants,
        org_name="Alloi",
        domain="alloi.us",
        relationship="client",
        confidence=0.9,
        meeting_type="delivery",
        deal_state="won",
        fireflies_id="01KZF3MM897VEM5FDQN5R7HASA",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/alloi.md"
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "alloi"
    assert res["created"] is None


def test_f5_tie_break_prefers_classification_named_party_over_alphabetical(tmp_path) -> None:
    """F5 (round 2, Important): a 1-vs-1 participant-count tie between two
    client candidates must resolve to the one the classifier named, not the
    alphabetically-first one."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "aaafirst.md").write_text(
        "# Client: AAA First\n\n## Contacts\n\ndomains: aaafirst.com\n", encoding="utf-8"
    )
    (brain / "clients" / "zzzlast.md").write_text(
        "# Client: ZZZ Last\n\n## Contacts\n\ndomains: zzzlast.com\n", encoding="utf-8"
    )
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False},
        {"name": None, "email": "pat@aaafirst.com", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": None, "email": "sam@zzzlast.com", "side": "theirs", "spoke": False, "notetaker": False},
    ]
    _write_source(
        src,
        title="Intro call",
        participants=participants,
        org_name="ZZZ Last",
        domain="zzzlast.com",
        relationship="prospect",
        confidence=0.55,
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/zzzlast.md"
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "zzzlast"
    assert res["created"] is None


def test_f7_name_only_contact_match_to_org_page_does_not_feed_rule6(tmp_path) -> None:
    """F7 (round 2, Important): restore the pre-47ff343b rule-6 candidate
    behavior — org_cands only comes from domain labels and EMAIL-matched
    contacts. A name-only speaker whose contacts.json company happens to be
    an existing orgs/ page must fall through to rule 7/8 as before, never
    rule 6."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "orgs" / "vendor-org.md").write_text("# Vendor Org\n\nrelationship: vendor\n", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps({"contacts": [{"id": "pat", "name": "Pat Vendor", "company": "Vendor Org", "emails": []}]}),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Random catchup",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Pat Vendor",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Unrelated",
        domain=None,
        relationship="prospect",
        confidence=0.3,
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["home_path"] == "orgs/pat-vendor.md"
    assert res["kind"] == "person"


def test_n5_org_cands_requires_email_match_not_just_has_email(tmp_path) -> None:
    """N5 (round 3, Minor): F7's gate was "participant has an email", not
    "matched BY email" (round-2 review N5, check-4 repro). A participant
    whose OWN email is unrelated to any contact row, but whose NAME matches a
    contact known at an existing org page, must not feed org_cands via that
    unrelated email — it must not route the meeting to that org via rule 6."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "orgs" / "hntb-corporation.md").write_text(
        "# HNTB Corporation\n\nrelationship: colleague\n", encoding="utf-8"
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Random catchup",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Thesla Collier",
                "email": "thesla@someunknownco.com",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Unrelated",
        domain=None,
        relationship="prospect",
        confidence=0.3,
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] != "orgs/hntb-corporation.md"
    assert res["counterparty_slug"] != "hntb-corporation"
    assert res["home_path"] == "orgs/someunknownco.md"
    assert res["rule"] == 6


def test_bare_first_name_contact_match_does_not_override_domain_pick(tmp_path) -> None:
    """R3-1 (round 4, Critical): _match_contact must not treat a bare first
    name as an identity — a name-only participant "Michelle" must not match
    a contacts.json row named exactly "Michelle" and drive the B override
    (rule 4) onto that row's company over the real email-domain pick
    (production repro: 01KZSBRA9776MXKWVEWNQ4M1GG, clients/oakrootsaccounting.md
    r3 -> WRONGLY re-homed to clients/alloi.md r4). Per-test contacts.json
    override with one bare-first-name row (mirrors test_n4/test_n7)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "oakrootsaccounting.md").write_text(
        "# Client: Oak Roots Accounting\n\n## Contacts\n", encoding="utf-8"
    )
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps(
            {
                "contacts": [
                    {
                        "id": "fixture-michelle",
                        "name": "Michelle",
                        "company": "Alloi",
                        "emails": ["contact99@alloi.us"],
                        "aliases": [],
                        "type": "person",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False},
        {
            "name": None,
            "email": "michelle@oakrootsaccounting.com",
            "side": "theirs",
            "spoke": False,
            "notetaker": False,
        },
        {"name": "Michelle", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]
    _write_source(
        src,
        title="Michelle Jaimes and Josh Weiss",
        participants=participants,
        org_name="Oak Roots Accounting",
        domain="oakrootsaccounting.com",
        relationship="vendor",
        confidence=0.9,
        meeting_type="delivery",
        deal_state="none",
        fireflies_id="01KZSBRA9776MXKWVEWNQ4M1GG",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/oakrootsaccounting.md"
    assert res["rule"] == 3
    assert res["also_present"] == []
    assert res["created"] is None


def test_rule10_requires_at_least_two_externals_single_external_falls_to_rule7(tmp_path) -> None:
    """R3-2 (round 4, Important, coordinator-decided option b): rule 10's
    community predicate must additionally require len(externals) >= 2, so a
    single-external email-less colleague/personal 1:1 (production repro:
    "Steven Burns", 01KZC5W0RCVEKEV0WBA7DCKKP1) falls through to rule 7's
    person page instead of creating a new org page named after whatever the
    classifier put in org_name (was WRONGLY creating orgs/core-boards.md
    r10; D-20 accepted orgs/steven-burns-faia.md r7). R1/R2 (5 externals)
    are unaffected controls."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    # R1 participants truncated to keep both "ours" rows plus exactly one
    # external ("Douglas Teiger", unknown+spoke) instead of R1's five.
    participants = _r1_participants()[:3]
    _write_source(
        src,
        title="Steven Burns",
        participants=participants,
        org_name="Core Boards (BQE)",
        domain=None,
        relationship="colleague",
        confidence=0.65,
        meeting_type="other",
        fireflies_id="01KZC5W0RCVEKEV0WBA7DCKKP1",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"].startswith("orgs/")
    assert res["rule"] == 7
    assert res["kind"] == "person"


def test_rule10_page_declared_name_reuses_client_page_by_org_name(tmp_path) -> None:
    """R3-3 (round 4, Minor): rule 10's page-declared-name branch must check
    closed["org_name_to_slug"] against CLIENT pages too, not only orgs/ pages
    (org_name_to_slug is built from both — load_closed_sets). Without this,
    an org_name that normalizes to an existing clients/<slug>.md's declared
    "CRM org name" (here msia.md's "Movement of Spiritual Awareness") falls
    through to create a duplicate orgs/movement-of-spiritual-awareness.md
    beside clients/msia.md — the N2 bug via the second door."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="MSIA catchup",
        participants=_r1_participants(),
        org_name="Movement of Spiritual Awareness",
        domain=None,
        relationship="colleague",
        confidence=0.6,
        meeting_type="other",
        fireflies_id="01R3-3MSIA",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/msia.md"
    assert res["rule"] == 10
    assert res["created"] is None


# --- R4b plan v3 (P1' placeholder guard + P3' description-shaped org_name
# guard). Test names/behaviors are the explicit list in
# docs/pipeline/plans/2026-09-07-r4b-resolver-personpage-fix.md §3, as
# approved (with 4 amendments) by docs/pipeline/run-artifacts/
# brain-backfill-r4b/G0a-v3-review.md. ---


def test_p1_speaker_placeholder_sole_external_homes_rule8(tmp_path) -> None:
    """P1' (G0a-v3 13-meeting class): a sole external whose only name is a
    transcription placeholder ("Speaker 1") must not fabricate a person
    page — every rule-7 candidate is filtered, so the meeting takes the
    existing rule-8 home (byte-identical payload — extracted as
    _rule8_home so the two paths cannot drift)."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="AI Exchange intro",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Speaker 1",
                "email": None,
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="AI Exchange",
        domain=None,
        relationship="vendor",
        confidence=0.70,
        meeting_type="other",
        fireflies_id="01P1SPEAKER1",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 8
    assert res["home_path"] == "orgs/clearworks-internal.md"
    assert res["kind"] == "org"
    assert res["relationship"] == "internal"
    assert res["counterparty_slug"] == "clearworks-internal"
    assert res["confidence"] == 1.0
    assert res["corroborated"] is False
    assert res["also_present"] == []
    assert res["created"] == {"kind": "org", "slug": "clearworks-internal", "relationship": "internal"}


def test_p1_iphone_placeholder_sole_external_homes_rule8(tmp_path) -> None:
    """P1': a device-recording label ("Dalton's iPhone (2)") is not a
    person; filtered from rule 7's candidate list, falls to the rule-8
    home."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Quick call",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Dalton's iPhone (2)",
                "email": None,
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Independent Dating Coaching Practice",
        domain=None,
        relationship="vendor",
        confidence=0.70,
        meeting_type="other",
        fireflies_id="01P1IPHONE",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 8
    assert res["home_path"] == "orgs/clearworks-internal.md"
    assert res["created"] == {"kind": "org", "slug": "clearworks-internal", "relationship": "internal"}


def test_p1_email_as_name_sole_external_homes_rule8(tmp_path) -> None:
    """P1' C-5: a participant whose NAME field is itself an email address
    (the anchored full-string shape, NOT merely "contains @") is a
    placeholder, filtered from rule 7's candidate list."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Design review",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "jose@jsrarchitects.com",
                "email": None,
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="JSR Architects",
        domain=None,
        relationship="prospect",
        confidence=0.6,
        meeting_type="other",
        fireflies_id="01P1EMAILNAME",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 8
    assert res["home_path"] == "orgs/clearworks-internal.md"
    assert res["created"] == {"kind": "org", "slug": "clearworks-internal", "relationship": "internal"}


def test_p1_kevin_collins_title_and_at_sign_not_suppressed_rule7(tmp_path) -> None:
    """P1' C-5 must not over-fire: a real person's name that merely
    CONTAINS "@" (a title/company suffix, not the anchored email-only
    shape) is not a placeholder — resolves normally to a rule-7 person
    page, as today."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Turazo intro",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Kevin Collins - CTO @ Turazo",
                "email": None,
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Turazo",
        domain=None,
        relationship="prospect",
        confidence=0.6,
        meeting_type="other",
        fireflies_id="01P1KEVIN",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["kind"] == "person"
    assert res["home_path"] == "orgs/kevin-collins-cto-turazo.md"


def test_p1_anjali_iyer_parenthetical_email_not_suppressed_rule7(tmp_path) -> None:
    """P1' C-5 must not over-fire: a real person's name with a parenthetical
    email is not the anchored email-only shape — resolves normally to a
    rule-7 person page, as today."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Feldman intro",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Anjali Iyer (AIyer@feldmanarch.com)",
                "email": None,
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Feldman Architecture",
        domain=None,
        relationship="prospect",
        confidence=0.6,
        meeting_type="other",
        fireflies_id="01P1ANJALI",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["kind"] == "person"
    assert res["home_path"] == "orgs/anjali-iyer-aiyer-feldmanarch-com.md"


def test_p1_mixed_placeholder_and_real_external_real_one_wins_rule7(tmp_path) -> None:
    """P1': when the rule-7 candidate list has both a placeholder and a
    real named person, rule 7 must pick the first REAL candidate — not
    externals[0] unfiltered ("Speaker 1" ahead of "Jesus Manzo")."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Design walkthrough",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Speaker 1",
                "email": None,
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Jesus Manzo",
                "email": None,
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Manzo Construction",
        domain=None,
        relationship="prospect",
        confidence=0.6,
        meeting_type="other",
        fireflies_id="01P1MIXED",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["kind"] == "person"
    assert res["home_path"] == "orgs/jesus-manzo.md"
    assert res["created"] == {"kind": "person", "slug": "jesus-manzo", "relationship": "personal"}


def test_p1_null_name_placeholder_sole_external_homes_rule8(tmp_path) -> None:
    """Judge review I-2 (r4b-v3-implement-review.md): a NULL/empty/
    whitespace-only participant name is the DOMINANT placeholder shape in
    the live batch — 191 external participants carry name: null, 4.5x more
    common than "Speaker N" (42) — and drives 4 of the 19 rows this build
    actually changes (plan v3 §4a), yet it had zero tests before this one.
    Pin all three shapes (None, empty string, whitespace-only): a sole such
    external must not fabricate a person page and must take the rule-8
    home, asserting the full payload exactly as the other P1' placeholder
    tests do."""
    from resolve_meeting import main

    for shape_id, raw_name in (("none", None), ("empty", ""), ("whitespace", "   ")):
        case_root = tmp_path / shape_id
        vault, repo = _seed_brain(case_root)
        src = case_root / "env"
        src.mkdir(parents=True)
        _write_source(
            src,
            title="Gmail intro",
            participants=[
                {
                    "name": "Josh Weiss",
                    "email": "josh@clearworks.ai",
                    "side": "ours",
                    "spoke": True,
                    "notetaker": False,
                    "handle": None,
                },
                {
                    "name": raw_name,
                    "email": None,
                    "side": "theirs",
                    "spoke": True,
                    "notetaker": False,
                    "handle": None,
                },
            ],
            org_name="AI Exchange",
            domain=None,
            relationship="vendor",
            confidence=0.70,
            meeting_type="other",
            fireflies_id=f"01P1NULLNAME{shape_id.upper()}",
        )
        rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
        assert rc == 0, shape_id
        res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
        assert res["rule"] == 8, shape_id
        assert res["home_path"] == "orgs/clearworks-internal.md", shape_id
        assert res["kind"] == "org", shape_id
        assert res["relationship"] == "internal", shape_id
        assert res["counterparty_slug"] == "clearworks-internal", shape_id
        assert res["confidence"] == 1.0, shape_id
        assert res["corroborated"] is False, shape_id
        assert res["also_present"] == [], shape_id
        assert res["created"] == {
            "kind": "org",
            "slug": "clearworks-internal",
            "relationship": "internal",
        }, shape_id


def test_p3_pick_tiebreak_still_reads_raw_org_name(tmp_path) -> None:
    """G0a-v3 amendment 1 / judge review I-3: P3' sanitizes cls_org_name
    ONLY at the rule-9 and rule-10 call sites (resolve_meeting.py:612,
    :712) — the module-level slug_for_cls (:373) that feeds _pick's
    tie-break for rules 3/4/5/6 must keep reading the RAW classification
    name. Today that boundary was proven only by a code comment. This
    constructs a 1-vs-1 client-candidate tie where a description-shaped
    org_name slugifies onto one candidate's exact slug: with cls_domain
    empty (so cls_label cannot supply a competing match), the RAW org_name
    must still decide the tie. If a future change hoisted P3' sanitization
    into slug_for_cls's own definition, cls_match would go empty and the
    tie would fall through to alphabetical order, picking "aaafirst"
    instead (proven red against a scratch copy with that regression
    applied — see r4b-v3-implement-report.md)."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "aaafirst.md").write_text(
        "# Client: AAA First\n\n## Contacts\n\ndomains: aaafirst.com\n", encoding="utf-8"
    )
    (brain / "clients" / "nerin-s-architecture-design-firm.md").write_text(
        "# Client: Nerin's Architecture/Design Firm\n\n## Contacts\n\n"
        "domains: nerin-s-architecture-design-firm.io\n",
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": True, "notetaker": False},
        {"name": None, "email": "pat@aaafirst.com", "side": "theirs", "spoke": False, "notetaker": False},
        {
            "name": None,
            "email": "sam@nerin-s-architecture-design-firm.io",
            "side": "theirs",
            "spoke": False,
            "notetaker": False,
        },
    ]
    _write_source(
        src,
        title="Intro call",
        participants=participants,
        org_name="Nerin's architecture/design firm",
        domain=None,
        relationship="prospect",
        confidence=0.55,
        meeting_type="other",
        fireflies_id="01P3PICKTIE",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "nerin-s-architecture-design-firm"
    assert res["home_path"] == "clients/nerin-s-architecture-design-firm.md"
    assert res["created"] is None
    assert res["also_present"] == ["aaafirst"]


def test_p3_description_shaped_org_name_with_valid_domain_still_resolves_rule9_by_domain(tmp_path) -> None:
    """P3' synthetic (G0a-v3 §3.4: 0/292 live rule-9/10 meetings pair a
    description-shaped org_name with a valid cls_domain — no live witness).
    A description-shaped org_name must be treated as ABSENT for rule 9's
    page-creation door and must NOT shadow a valid cls_domain: rule 9
    falls back to the domain-derived slug (cls_label = "russianriverkeeper",
    no hyphen), proven here because it differs from what slugify() would do
    to the raw garbage name (which would fabricate
    orgs/nonprofit-organization-name-not-stated.md)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Tech Committee Meeting #4",
        participants=_r3_participants(),
        org_name="Nonprofit organization (name not stated)",
        domain="russianriverkeeper.org",
        relationship="client",
        confidence=0.85,
        meeting_type="delivery",
        deal_state="won",
        fireflies_id="01P3RULE9SYN",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 9
    assert res["counterparty_slug"] == "russianriverkeeper"
    assert res["home_path"] == "orgs/russianriverkeeper.md"
    assert res["created"] == {"kind": "org", "slug": "russianriverkeeper", "relationship": "client"}


def test_p3_rule9_domain_slug_collides_with_existing_hyphenated_org_page(tmp_path) -> None:
    """G0a-v3 amendment 2 / judge review I-4: the test above seeds an EMPTY
    orgs/ dir, which hides the V2-2 duplicate-slug hazard G0a-v3 flagged and
    v3 does not retire — when a description-shaped org_name is sanitized
    away, rule 9 falls back to the DOMAIN-derived slug ("russianriverkeeper",
    no hyphen), which is a DIFFERENT slug from the real, already-existing
    page ("orgs/russian-riverkeeper.md", from the org-name-derived
    slugify()). Seed that real page here (no "domains:" line, matching the
    live vault page per G0a-v3 §1.2) so the collision is fixture-visible:
    per the review's exact fix option (a), assert the outcome that actually
    occurs — a SECOND, differently-hyphenated org page is created beside the
    existing one, not a reuse of it. F3's page-declared-domain reuse path
    (test_f3_rule9_reuses_existing_org_page_declaring_the_domain) only fires
    when the existing page itself declares a "domains:" line; this fixture
    deliberately omits it because the real vault page predates that
    convention. V2-2 (unretired by v3): R5/P2' owns fixing this hazard
    class, not this build."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "orgs" / "russian-riverkeeper.md").write_text(
        "# Org: Russian Riverkeeper\n\nrelationship: client\n", encoding="utf-8"
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Tech Committee Meeting #4",
        participants=_r3_participants(),
        org_name="Nonprofit organization (name not stated)",
        domain="russianriverkeeper.org",
        relationship="client",
        confidence=0.85,
        meeting_type="delivery",
        deal_state="won",
        fireflies_id="01P3RULE9DUP",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    # The pre-existing "orgs/russian-riverkeeper.md" is NOT reused — the
    # resolver creates a second page under the domain-derived slug instead.
    assert res["rule"] == 9
    assert res["counterparty_slug"] == "russianriverkeeper"
    assert res["home_path"] == "orgs/russianriverkeeper.md"
    assert res["created"] == {"kind": "org", "slug": "russianriverkeeper", "relationship": "client"}
    assert res["home_path"] != "orgs/russian-riverkeeper.md"


def test_p3_description_shaped_org_name_alone_rule10_falls_through_to_rule7(tmp_path) -> None:
    """P3' synthetic, required amendment (G0a-v3 V3-3): a description-shaped
    org_name must be treated as ABSENT for rule 10's community-org door.
    Asserts the POSITIVE outcome the meeting actually takes (rule 7, the
    exact person-page home for the first non-placeholder attendee) —
    never merely "no org page created", which a silent r10->r7 drop would
    also satisfy without proving anything happened (G0a-v3 A-2)."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    participants = _r1_participants()
    _write_source(
        src,
        # R4b plan v2 Phase 1: title changed from "AI Office Hours (AIA LA
        # TAP Committee)" to avoid an incidental collision with the new P-3
        # office-hours branch (inserted before rule 10) -- this test's
        # actual subject is the P3' description-shaped org_name guard on
        # rule 10, unrelated to office-hours titling; the synthetic id
        # (01P3RULE10SYN) was never one of the real production aia-la
        # meetings, so no production behavior is affected by this rename.
        title="AIA LA TAP Committee Meeting",
        participants=participants,
        org_name="Client (name not stated)",
        domain=None,
        relationship="colleague",
        confidence=0.55,
        meeting_type="other",
        fireflies_id="01P3RULE10SYN",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["kind"] == "person"
    assert res["home_path"] == "orgs/douglas-teiger.md"
    assert res["created"] == {"kind": "person", "slug": "douglas-teiger", "relationship": "personal"}


def test_p2_deferred_org_name_equals_participant_name_unchanged(tmp_path) -> None:
    """01KB0SNHC7Q7 class (org_name "Kimie Aryai" == the sole participant's
    own name): P2' re-homing onto existing pages is deferred to R5 (plan v3
    §4). Neither P1' nor P3' touches this meeting — "Kimie Aryai" is a real
    name, not a placeholder participant shape, and not a description-shaped
    org_name — so it resolves exactly as base does, unchanged, via rule 7."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Intro call",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Kimie Aryai",
                "email": None,
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Kimie Aryai",
        domain=None,
        relationship="prospect",
        confidence=0.6,
        meeting_type="other",
        fireflies_id="01KB0SNHC7Q7",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["kind"] == "person"
    assert res["home_path"] == "orgs/kimie-aryai.md"


# --- R4b plan v2 Phase 1 (docs/pipeline/plans/2026-09-08-r4b-identity-
# enrichment.md, P-1..P-4), corrected 2026-09-08 by the coordinator's
# post-review message: P-1 (roster), P-2 (qualifier stripping) and P-4
# (date-aware employer) transform inputs to the UNCHANGED rule ladder;
# only P-3 (office hours) is a new branch, inserted after rules 1-2 and
# before rule 10. Protection for the two already-applied aia-la meetings
# is an explicit id allow-list (PROTECTED_MEETING_IDS) enforced as a
# full-resolution invariant. ---


def _write_roster(repo: Path, names: list[str]) -> None:
    crm_dir = repo / "orgs/clearworksai/agents/crm-codex/crm"
    crm_dir.mkdir(parents=True, exist_ok=True)
    (crm_dir / "internal-roster.json").write_text(json.dumps({"names": names}), encoding="utf-8")


def _write_employer_history(repo: Path, data: dict) -> None:
    crm_dir = repo / "orgs/clearworksai/agents/crm-codex/crm"
    crm_dir.mkdir(parents=True, exist_ok=True)
    (crm_dir / "employer-history.json").write_text(json.dumps(data), encoding="utf-8")


# --- P-1: internal roster ---


def test_p1_roster_josh_and_mrin_sole_participants_resolves_internal(tmp_path) -> None:
    """P-1: a meeting whose only participants are roster members (Josh
    Weiss, Mrin Sawant) resolves internal -- Mrin is filtered out of the
    external-participant view by NAME regardless of her stored Fireflies
    side/spoke (G0a C-2: her fetch-time side is "unknown"/spoke:true
    today, since OURS_NAMES at fetch time doesn't know her). RED before
    P-1: rc==0, res["rule"]==7, res["home_path"]=="orgs/mrin-sawant.md"."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    _write_roster(repo, ["Josh Weiss", "Mrin Sawant"])
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Josh / Mrin",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Mrin Sawant",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        fireflies_id="01P1ROSTERSOLE",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 8
    assert res["home_path"] == "orgs/clearworks-internal.md"
    assert res["kind"] == "org"


def test_p1_roster_recognizes_short_form_name_variants(tmp_path) -> None:
    """G0a I-2: the roster must be a normalized alias list including
    short-form live variants ("Mrin", "Mrin S.") -- not just the full
    "Mrin Sawant"/"Mrinmayi Sawant" forms. RED before P-1 (or before the
    roster file lists these variants): each case resolves rule 7 to
    orgs/mrin-*.md instead of falling to rule 8."""
    from resolve_meeting import main

    for idx, variant in enumerate(["Mrin", "Mrinmayi Sawant", "Mrin S."]):
        case_root = tmp_path / f"case{idx}"
        vault, repo = _seed_brain(case_root)
        _write_roster(repo, ["Josh Weiss", "Mrin Sawant", "Mrinmayi Sawant", "Mrin", "Mrin S."])
        src = case_root / "env"
        src.mkdir(parents=True)
        _write_source(
            src,
            title="Josh / Mrin catchup",
            participants=[
                {
                    "name": "Josh Weiss",
                    "email": "josh@clearworks.ai",
                    "side": "ours",
                    "spoke": True,
                    "notetaker": False,
                    "handle": None,
                },
                {"name": variant, "email": None, "side": "unknown", "spoke": True, "notetaker": False, "handle": None},
            ],
            fireflies_id=f"01P1VARIANT{idx}",
        )
        rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
        assert rc == 0, variant
        res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
        assert res["rule"] == 8, variant
        assert res["home_path"] == "orgs/clearworks-internal.md", variant


def test_p1_roster_presence_never_decides_home_rule7_person_page(tmp_path) -> None:
    """Ground truth (Josh 2026-09-08): "her presence must NEVER decide a
    meeting's home -- she is on OUR side, like Josh. The meeting belongs
    to the CLIENT being interviewed." Ordered BEFORE a real named
    attendee in participants[], an unfiltered Mrin would win rule 7's
    `candidates[0]` and mint the wrong person page. RED before P-1:
    res["home_path"] == "orgs/mrin-sawant.md"."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    _write_roster(repo, ["Josh Weiss", "Mrin Sawant"])
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Assessment Interview (Casey Nguyen)",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Mrin Sawant",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Casey Nguyen",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Casey Nguyen",
        domain=None,
        relationship="prospect",
        fireflies_id="01P1ROSTERWINS",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["kind"] == "person"
    assert res["home_path"] == "orgs/casey-nguyen.md"


def test_p1_roster_name_matching_normalizes_case_and_whitespace(tmp_path) -> None:
    """Roster matching normalizes case/whitespace the same way the rest of
    the resolver does (_norm_title) -- a roster entry "josh weiss" matches
    a participant name "JOSH WEISS", and "MRIN   SAWANT" matches
    "Mrin  Sawant"."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    _write_roster(repo, ["josh weiss", "MRIN   SAWANT"])
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Josh / Mrin",
        participants=[
            {
                "name": "JOSH WEISS",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Mrin  Sawant",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        fireflies_id="01P1NORMCASE",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 8
    assert res["home_path"] == "orgs/clearworks-internal.md"


def test_p1_roster_preserves_calasia_control_with_short_form_variant_present(tmp_path) -> None:
    """G0a I-2 regression control: 01KZVZVSMRNR6N5A5NFXEW5P23
    (calasiaconstruction rule 3, one of R4's five corrected homes) carries
    a "Mrin S." participant in the live batch. Both before and after P-1
    this control is unaffected (she is email-less and was never counted
    toward client_cands either way) -- labeled honestly as a regression
    control, not a red-first test, per the assignment's method note."""
    from resolve_meeting import main

    vault, repo = _seed_r4_vault(tmp_path)
    _write_roster(repo, ["Josh Weiss", "Mrin Sawant", "Mrin S."])
    src = tmp_path / "env"
    src.mkdir()
    participants = [
        {
            "name": None,
            "email": "myrnamurawski@calasiaconstruction.com",
            "side": "theirs",
            "spoke": False,
            "notetaker": False,
        },
        {
            "name": None,
            "email": "johnmurawski@calasiaconstruction.com",
            "side": "theirs",
            "spoke": False,
            "notetaker": False,
        },
        {"name": "Josh Weiss", "email": "josh@clearworks.ai", "side": "ours", "spoke": False, "notetaker": False},
        {"name": None, "email": "abbey@calasiaconstruction.com", "side": "theirs", "spoke": False, "notetaker": False},
        {"name": "Nathan Phinney", "email": "nphinney@allsafeit.com", "side": "theirs", "spoke": True, "notetaker": False},
        {"name": "John Murawski", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Abbey Ocampo", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Chris", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
        {"name": "Mrin S.", "email": None, "side": "unknown", "spoke": True, "notetaker": False},
    ]
    _write_source(
        src,
        title="AllSafe IT <> CalAsia Construction: Introductory Call",
        participants=participants,
        org_name="CalAsia Construction",
        domain="calasiaconstruction.com",
        relationship="prospect",
        confidence=0.8,
        meeting_type="sales",
        deal_state="proposal",
        fireflies_id="01KZVZVSMRNR6N5A5NFXEW5P23",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/calasiaconstruction.md"
    assert res["rule"] == 3


def test_p1_roster_removal_leaves_phone_placeholder_falls_to_rule8(tmp_path) -> None:
    """G0a I-1 (required amendment before P-1 ships): removing a roster
    member from externals must not promote a redacted phone number to
    rule 7's candidates[0] and mint a junk orgs/1-310-00.md-shaped page --
    the placeholder regex now recognizes phone shapes, so this falls
    through to the existing "every candidate is a placeholder" rule-8
    fallback. RED before the phone-shape regex extension:
    res["rule"] == 7, res["home_path"].startswith("orgs/1")."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    _write_roster(repo, ["Josh Weiss", "Mrin Sawant"])
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Weekly check-in",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Mrin Sawant",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "+1 310-***-**00",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        fireflies_id="01P1PHONEJUNK",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 8
    assert res["home_path"] == "orgs/clearworks-internal.md"


# --- P-2: qualifier stripping ---


def test_p2_guard_preserves_email_shaped_parenthetical() -> None:
    """P-2 trap (must not mangle): a trailing parenthetical whose content
    is an email address is the only identity evidence in the slot and
    must never be stripped."""
    from resolve_meeting import _strip_name_qualifiers

    assert _strip_name_qualifiers("Erin Morris (erin@erinmorris.com)") == "Erin Morris (erin@erinmorris.com)"


def test_p2_guard_preserves_dash_at_qualifier_shape() -> None:
    """P-2 trap (must not mangle): no trailing parenthetical and no comma
    -- nothing strips."""
    from resolve_meeting import _strip_name_qualifiers

    assert _strip_name_qualifiers("Kevin Collins - CTO @ Turazo") == "Kevin Collins - CTO @ Turazo"


def test_p2_strips_trailing_paren_then_trailing_org_qualifier() -> None:
    """P-2: strip ONE trailing parenthetical, then a trailing ', <Org>'
    qualifier."""
    from resolve_meeting import _strip_name_qualifiers

    assert _strip_name_qualifiers("Jay Owens, CCA Systems (HeHim)") == "Jay Owens"


def test_p2_strip_trailing_paren_and_org_qualifier_unlocks_contact_match(tmp_path) -> None:
    """P-2 end-to-end: 'Jay Owens, Fixture Consulting (HeHim)' has no raw
    match against a contacts.json row named 'Jay Owens', but the
    P-2-stripped name does, unlocking the existing client page via rule 4
    (the "reach a client page" ceiling this task is scoped to -- reaching
    an ORG page via a name-only match remains Phase 2's lever per
    resolve_meeting.py:566-571, not attempted here). RED before P-2:
    res["rule"] == 7, res["home_path"] starts with
    "orgs/jay-owens-fixture-consulting"."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "fixture-consulting.md").write_text(
        "# Client: Fixture Consulting\n\n## Contacts\n", encoding="utf-8"
    )
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps(
            {
                "contacts": [
                    {"id": "fx-01", "name": "Jay Owens", "company": "Fixture Consulting", "emails": []},
                ]
            }
        ),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Intro call",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Jay Owens, Fixture Consulting (HeHim)",
                "email": None,
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="Fixture Consulting",
        domain=None,
        relationship="prospect",
        fireflies_id="01P2STRIP",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/fixture-consulting.md"
    assert res["rule"] == 4


# --- P-3: office hours ---


def test_p3_office_hours_title_routes_internal_over_client_email(tmp_path) -> None:
    """P-3: an office-hours-titled session resolves to
    orgs/clearworks-internal.md even when an attendee's email would
    otherwise win a client home via rule 3 (G0a-measured: 7 of the 12 real
    office-hours meetings currently land on clients/rethink-media.md only
    because one attendee's email happens to be present). RED before P-3:
    res["rule"] == 3, res["home_path"] == "clients/rethinkmedia-fixture.md"."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "rethinkmedia-fixture.md").write_text(
        "# Client: ReThink Media Fixture\n\n## Contacts\n\ndomains: rethinkmedia-fixture.test\n",
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="AI Office Hours (Weekly)",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Pat",
                "email": "pat@rethinkmedia-fixture.test",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="ReThink Media Fixture",
        domain="rethinkmedia-fixture.test",
        relationship="client",
        fireflies_id="01P3OFFICEHOURS",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 11
    assert res["home_path"] == "orgs/clearworks-internal.md"


def test_p3_title_anchor_ignores_office_hours_mentioned_only_in_body(tmp_path) -> None:
    """P-3 is TITLE-ANCHORED only, never a substring match anywhere in the
    body -- "office hours" appearing in the transcript text AND in the
    classifier's org_name, but NOT in the title, must not trigger it."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Weekly Sync",
        text="We should set up office hours for the team sometime.",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {
                "name": "Sam",
                "email": "sam@newco-fixture2.test",
                "side": "theirs",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
        ],
        org_name="office hours mentioned but irrelevant",
        domain="newco-fixture2.test",
        relationship="prospect",
        fireflies_id="01P3BODYONLY",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 6
    assert res["home_path"] == "orgs/newco-fixture2.md"


def test_p3_wins_over_rule10_community_org_ordering(tmp_path) -> None:
    """Coordinator correction 2026-09-08: P-3 must run BEFORE rule 10's
    community-org door (inserted after rules 1-2, before rule 10) -- an
    office-hours-titled, no-external-email, colleague-relationship meeting
    that WOULD otherwise qualify for rule 10's community-org creation
    instead resolves to orgs/clearworks-internal.md via P-3. RED before
    P-3, or if P-3 were placed AFTER rule 10: res["rule"] == 10,
    res["home_path"] == "orgs/new-prospect-community.md"."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="AI Office Hours (New Prospect Community)",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {"name": "Pat Doe", "email": None, "side": "unknown", "spoke": True, "notetaker": False, "handle": None},
            {"name": "Sam Roe", "email": None, "side": "unknown", "spoke": True, "notetaker": False, "handle": None},
        ],
        org_name="New Prospect Community",
        domain=None,
        relationship="colleague",
        confidence=0.55,
        meeting_type="other",
        fireflies_id="01P3WINSOVERR10",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 11
    assert res["home_path"] == "orgs/clearworks-internal.md"


def test_p3_neighbor_rule2_alias_wins_over_office_hours_title(tmp_path) -> None:
    """Coordinator correction 2026-09-08: P-3 sits AFTER rules 1-2, not
    before -- a title matching both a project alias AND "office hours"
    still resolves via rule 2, never P-3. RED if P-3 were placed before
    rules 1-2: res["rule"] == 11, res["node"] == "none"."""
    from resolve_meeting import main

    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True)
    (brain / "projects").mkdir()
    (brain / "orgs").mkdir()
    (brain / "clients" / "alloi.md").write_text(
        "# Client: Alloi\n\n## Contacts\n\ndomains: alloi.us\n",
        encoding="utf-8",
    )
    (brain / "projects" / "alloi-03.md").write_text(
        _node_page("alloi", "alloi-03", "tacticals, tactical report, arch tactical"),
        encoding="utf-8",
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_env(src, "Weekly tacticals office hours review")
    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai/agents/crm-codex/crm").mkdir(parents=True)
    (repo / "orgs/clearworksai/agents/crm-codex/crm/org-aliases.json").write_text("{}", encoding="utf-8")
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        '{"contacts":[]}', encoding="utf-8"
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 2
    assert res["node"] == "alloi-03"


def test_p3_protected_aia_la_ids_unchanged_with_all_four_rules_active(tmp_path) -> None:
    """Coordinator correction 2026-09-08 (Correction 2): protection is a
    FULL-RESOLUTION invariant, not just a P-3 skip. Both already-applied
    AIA LA office-hours meetings must keep their exact R4 home+rule
    (orgs/aia-la.md rule 10) even when a roster member (Mrin) and a P-2
    qualifier-laden name are ALSO present in the same meeting -- proving
    protected ids bypass P-1, P-2, P-3 and P-4 together, not one
    mechanism at a time. RED without the protected_ids mechanism (or with
    it applied only to P-3): res["rule"] == 11,
    res["home_path"] == "orgs/clearworks-internal.md"."""
    from resolve_meeting import PROTECTED_MEETING_IDS, main

    for protected_id in sorted(PROTECTED_MEETING_IDS):
        case_root = tmp_path / protected_id
        vault, repo = _seed_r4_vault(case_root)
        _write_roster(repo, ["Josh Weiss", "Mrin Sawant"])
        src = case_root / "env"
        src.mkdir(parents=True)
        participants = _r1_participants() + [
            {
                "name": "Mrin Sawant",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
            },
            {
                "name": "Priya Shah, New Prospect Co (HeHim)",
                "email": None,
                "side": "unknown",
                "spoke": True,
                "notetaker": False,
            },
        ]
        _write_source(
            src,
            title="AI Office Hours (AIA LA TAP Committee)",
            participants=participants,
            org_name="AIA LA (Office Hours community)",
            domain=None,
            relationship="colleague",
            confidence=0.55,
            meeting_type="other",
            fireflies_id=protected_id,
        )
        rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
        assert rc == 0, protected_id
        res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
        assert res["home_path"] == "orgs/aia-la.md", protected_id
        assert res["rule"] == 10, protected_id
        assert res["counterparty_slug"] == "aia-la", protected_id


# --- P-4: date-aware employer ---


def test_p4_employer_history_routes_by_meeting_date_not_current_company(tmp_path) -> None:
    """P-4: employer AT MEETING TIME wins over the CRM row's current
    company for a date inside the historical window (G0a-measured trap,
    modeled here on a synthetic contact/company pair, not the real
    production names: a contact's legacy-window meetings must not follow
    her CURRENT employer to the wrong client). RED before P-4:
    res["home_path"] == "clients/current-employer-fixture.md"."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "current-employer-fixture.md").write_text(
        "# Client: Current Employer Fixture\n\n## Contacts\n", encoding="utf-8"
    )
    (brain / "clients" / "legacy-employer-fixture.md").write_text(
        "# Client: Legacy Employer Fixture\n\n## Contacts\n", encoding="utf-8"
    )
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps(
            {
                "contacts": [
                    {"id": "fx-p4-01", "name": "Pat Doe", "company": "Current Employer Fixture", "emails": []},
                ]
            }
        ),
        encoding="utf-8",
    )
    _write_employer_history(
        repo,
        {"fx-p4-01": [{"date_from": "2025-10-01", "date_to": "2026-04-30", "slug": "legacy-employer-fixture"}]},
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Audit interview",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {"name": "Pat Doe", "email": None, "side": "unknown", "spoke": True, "notetaker": False, "handle": None},
        ],
        org_name="Current Employer Fixture",
        domain=None,
        relationship="client",
        occurred_at="2026-01-15T17:00:00Z",
        fireflies_id="01P4DATEWINDOW",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/legacy-employer-fixture.md"
    assert res["rule"] == 4


def test_p4_employer_history_falls_back_to_current_company_outside_range(tmp_path) -> None:
    """P-4 fallback guard (regression control, not a red-first test — the
    outcome here matches pre-P-4 behavior either way): a meeting dated
    AFTER the historical window's date_to falls back to the ordinary
    (current) company resolution."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients" / "current-employer-fixture.md").write_text(
        "# Client: Current Employer Fixture\n\n## Contacts\n", encoding="utf-8"
    )
    (brain / "clients" / "legacy-employer-fixture.md").write_text(
        "# Client: Legacy Employer Fixture\n\n## Contacts\n", encoding="utf-8"
    )
    (repo / "orgs/clearworksai/agents/crm-codex/crm/contacts.json").write_text(
        json.dumps(
            {
                "contacts": [
                    {"id": "fx-p4-01", "name": "Pat Doe", "company": "Current Employer Fixture", "emails": []},
                ]
            }
        ),
        encoding="utf-8",
    )
    _write_employer_history(
        repo,
        {"fx-p4-01": [{"date_from": "2025-10-01", "date_to": "2026-04-30", "slug": "legacy-employer-fixture"}]},
    )
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Audit interview",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {"name": "Pat Doe", "email": None, "side": "unknown", "spoke": True, "notetaker": False, "handle": None},
        ],
        org_name="Current Employer Fixture",
        domain=None,
        relationship="client",
        occurred_at="2026-08-01T17:00:00Z",
        fireflies_id="01P4OUTSIDERANGE",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/current-employer-fixture.md"
    assert res["rule"] == 4


def test_p4_missing_employer_history_file_is_noop(tmp_path) -> None:
    """Absent employer-history.json -> empty map, never an error."""
    from resolve_meeting import _load_employer_history

    repo = tmp_path / "repo"
    (repo / "orgs/clearworksai/agents/crm-codex/crm").mkdir(parents=True)
    assert _load_employer_history(repo) == {}


# --- Named G0a M-2 control (not in the batch, no pre-existing test) ---


def test_r4b_control_juan_202608_bare_single_token_name_rule7_unaffected(tmp_path) -> None:
    """G0a M-2 control (juan-202608, 01KZCYHQGQ6GPW7SB0QQBAG68M): a bare
    single-token external name's rule-7 person-page fallback (slugified
    with the occurred_at YYYYMM suffix) must be unaffected by P-1..P-4 --
    not a roster member, no qualifier to strip, no office-hours title, no
    employer-history.json entry. Regression control, not a red-first
    test: this outcome is unchanged before and after Phase 1."""
    from resolve_meeting import main

    vault, repo = _seed_brain(tmp_path)
    _write_roster(repo, ["Josh Weiss", "Mrin Sawant"])
    src = tmp_path / "env"
    src.mkdir()
    _write_source(
        src,
        title="Quick sync",
        participants=[
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "side": "ours",
                "spoke": True,
                "notetaker": False,
                "handle": None,
            },
            {"name": "Juan", "email": None, "side": "unknown", "spoke": True, "notetaker": False, "handle": None},
        ],
        org_name="Juan",
        domain=None,
        relationship="prospect",
        occurred_at="2026-08-12T17:00:00Z",
        fireflies_id="01KZCYHQGQ6GPW7SB0QQBAG68M",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(repo)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["rule"] == 7
    assert res["kind"] == "person"
    assert res["home_path"] == "orgs/juan-202608.md"
