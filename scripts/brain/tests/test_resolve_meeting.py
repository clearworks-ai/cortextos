"""FR-003: acceptance meeting title+aliases → alloi-03 rule 2."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


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
# homes from batch fireflies-20260907T173226Z. These tests use the REAL,
# read-only CRM closed sets (contacts.json/org-aliases.json have 521 real
# rows and messy real-world alias/company data that a hand-rolled stub can't
# reproduce) — see .pipeline/sdd/2026-09-06-brain-backfill-r4/resolver-fix-brief.md.
# Fixtures below carry ONLY participants + classification copied from the real
# envelopes (never transcript text).
REAL_REPO_ROOT = Path("/Users/joshweiss/code/cortextos")


def _seed_r4_vault(tmp_path: Path) -> Path:
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
    return vault


def test_r1_aia_office_hours_creates_community_org_not_person(tmp_path) -> None:
    """D-20: internal AIA LA teaching session — home is the community org page,
    never a person page carved from an attendee (was rule 7 -> orgs/douglas-teiger.md,
    01KYGEE6TGNCNZ1YMYHQMZH9KC)."""
    from resolve_meeting import main

    vault = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    participants = [
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
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(REAL_REPO_ROOT)])
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

    vault = _seed_r4_vault(tmp_path)
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
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(REAL_REPO_ROOT)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "orgs/aia-la.md"
    assert res["rule"] == 10
    assert res["counterparty_slug"] == "aia-la"


def test_r3_russian_riverkeeper_classification_over_minority_client(tmp_path) -> None:
    """D-20: 4 Russian Riverkeeper participants outnumber the 1 logictcg
    participant; no client/org page exists for Russian Riverkeeper yet, so
    the high-confidence classification creates one (was rule 3 ->
    clients/logictcg.md, 01KYGEE6SHKHM67BFY8B0DK1FP)."""
    from resolve_meeting import main

    vault = _seed_r4_vault(tmp_path)
    src = tmp_path / "env"
    src.mkdir()
    participants = [
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
    _write_source(
        src,
        title="Tech Committee Meeting #4",
        participants=participants,
        org_name="Russian Riverkeeper",
        domain="russianriverkeeper.org",
        relationship="client",
        confidence=0.85,
        meeting_type="delivery",
        deal_state="won",
        fireflies_id="01KYGEE6SHKHM67BFY8B0DK1FP",
    )
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(REAL_REPO_ROOT)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "orgs/russian-riverkeeper.md"
    assert res["rule"] == 9
    assert res["counterparty_slug"] == "russian-riverkeeper"
    assert res["created"] == {"kind": "org", "relationship": "client", "slug": "russian-riverkeeper"}


def test_r4_calasia_vs_allsafe_participant_count_weighting(tmp_path) -> None:
    """D-20: 3 CalAsia participants vs 1 AllSafe IT participant — pick by
    participant count (was rule 3 -> clients/allsafeit.md, alphabetical
    fallback, 01KZCM9K0PQJTS5S6BP1P2VKY9)."""
    from resolve_meeting import main

    vault = _seed_r4_vault(tmp_path)
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
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(REAL_REPO_ROOT)])
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

    vault = _seed_r4_vault(tmp_path)
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
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(REAL_REPO_ROOT)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/msia.md"
    assert res["rule"] == 4
    assert res["counterparty_slug"] == "msia"
    assert res["created"] is None


def test_control_kadre_low_confidence_classification_stays_rule3(tmp_path) -> None:
    """Control: 01KYZASJY2ZTWC9F4ET3QZ5RFZ. classification.confidence=0.6 is
    below the 0.8 rule-9 threshold, so the single-domain rule-3 pick is
    untouched (kadre)."""
    from resolve_meeting import main

    vault = _seed_r4_vault(tmp_path)
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
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(REAL_REPO_ROOT)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/kadre.md"
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "kadre"


def test_control_alloi_single_domain_candidate_stays_rule3(tmp_path) -> None:
    """Control: 01KZF3MM897VEM5FDQN5R7HASA. classification agrees with the
    only domain candidate — no rule-9 override, no contacts-name override
    (alloi)."""
    from resolve_meeting import main

    vault = _seed_r4_vault(tmp_path)
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
    rc = main(["--source", str(src), "--vault", str(vault), "--repo-root", str(REAL_REPO_ROOT)])
    assert rc == 0
    res = json.loads((src / "resolution.json").read_text(encoding="utf-8"))
    assert res["home_path"] == "clients/alloi.md"
    assert res["rule"] == 3
    assert res["counterparty_slug"] == "alloi"
