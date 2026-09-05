"""FR-003: acceptance meeting title+aliases → alloi-03 rule 2."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

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


def test_sha_mismatch_exits_4(tmp_path) -> None:
    from resolve_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    (src / "source.json").write_text("{}", encoding="utf-8")
    (src / "source.sha256").write_text("deadbeef\n", encoding="utf-8")
    rc = main(["--source", str(src), "--vault", str(tmp_path), "--repo-root", str(tmp_path)])
    assert rc == 4
