"""FR-006 seed layout under vault org-brain (not vault-root projects/)."""
from __future__ import annotations

from pathlib import Path

VAULT = Path("/Users/joshweiss/code/knowledge-sync")
ORG = VAULT / "raw/areas/clearworks/org-brain"


def _node_block(text: str) -> str:
    if "## Node" not in text:
        return ""
    rest = text.split("## Node", 1)[1]
    nxt = rest.find("\n## ")
    return rest if nxt < 0 else rest[:nxt]


def test_alloi_03_node_parent_and_aliases() -> None:
    p = ORG / "projects/alloi-03.md"
    assert p.is_file(), f"missing {p}"
    text = p.read_text(encoding="utf-8")
    node = _node_block(text)
    assert "parent: alloi-01" in node
    assert "tacticals" in node
    assert str(p).endswith("raw/areas/clearworks/org-brain/projects/alloi-03.md")
    assert text.startswith("# Client: Alloi — Tactical Reports")


def test_alloi_01_reporting_contract() -> None:
    p = ORG / "projects/alloi-01.md"
    assert p.is_file()
    text = p.read_text(encoding="utf-8")
    assert "kind: engagement" in _node_block(text)
    assert "cadence: weekly" in text
    assert "channel: email" in text
    assert "contact: marcos@alloi.us" in text
    assert "last_update:" in text


def test_templates_and_alloi_02_exist() -> None:
    assert (ORG / "projects/alloi-02.md").is_file()
    assert (ORG / "projects/_template.md").is_file()
    assert (ORG / "orgs/_template.md").is_file()
    tmpl = (ORG / "projects/_template.md").read_text(encoding="utf-8")
    assert "id: <client>-<nn>" in tmpl
    org_tmpl = (ORG / "orgs/_template.md").read_text(encoding="utf-8")
    assert "# <Name>" in org_tmpl
    assert "## Contacts" in org_tmpl


def test_alloi_client_freeze_and_domains() -> None:
    p = ORG / "clients/alloi.md"
    text = p.read_text(encoding="utf-8")
    heading = "## History (dated, newest first)"
    assert heading in text
    after = text.split(heading, 1)[1].lstrip("\n")
    marker = "<!-- frozen: entries below this marker are the pre-2026-09 client roll-up; new entries go above -->"
    # The marker's own contract is that NEW entries land ABOVE it (R4 backfill apply
    # 2026-09-07 did exactly that), so the seed-layout invariant is: the marker is
    # present in the History section and everything above it is a dated entry.
    history = after.split("\n## ", 1)[0]
    lines = [ln for ln in history.splitlines() if ln.strip()]
    assert marker in lines
    above = lines[: lines.index(marker)]
    # dated entry lines plus their indented sub-bullets (Outcomes/Decisions/...)
    assert all(ln.startswith("- 20") or ln.startswith("  ") for ln in above), above
    contacts = text.split("## Contacts", 1)[1].split("## ", 1)[0]
    assert "domains: alloi.us" in contacts
