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
) -> None:
    source = {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": fireflies_id},
        "title": title,
        "occurred_at": "2026-09-04T17:00:00Z",
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
