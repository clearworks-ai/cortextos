"""FR-009 invariants + baseline (Part A). gmail_section tests added Task 19."""
from __future__ import annotations

import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

import client_state_digest as cs_digest  # noqa: E402
from observation_ledger import Ledger  # noqa: E402


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
    _page(vault, "clients", "acme-b", org_names=("acme corp",))  # dup via _norm_title, different spelling case
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
    # G-INV-1: FULL domain key only, never registrable_label — example.com and
    # example.org must never collapse to one "example" violation.
    vault = tmp_path / "vault"
    _page(vault, "clients", "tld-a", domains="example.com")
    _page(vault, "clients", "tld-b", domains="example.org")
    inv = cs_digest.compute_invariants(vault, _empty_ledger(tmp_path), "2026-01-01")
    flagged = {row["domain"] for row in inv["domain_multi"]}
    assert "example.com" not in flagged
    assert "example.org" not in flagged


def test_compute_invariants_missing_gmail_ref_post_epoch_only(tmp_path):
    # G-INV-2: fireflies: refs are never counted (the meeting pipeline appends
    # them daily — an all-source check would violate forever).
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
