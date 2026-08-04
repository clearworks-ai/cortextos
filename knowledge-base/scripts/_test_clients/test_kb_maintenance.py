"""Tier-1 deterministic-scan tests for kb_maintenance.

Real cases over a temp corpus: dead-link, orphan/index-drift, junk, exact-dup, freshness,
plus Tier-3 event mapping and the injectable read-canary. No network, no live index.
"""

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import kb_maintenance as km


# --------------------------------------------------------------------------- #
# Fixture: a tiny knowledge-sync-shaped corpus rooted at tmp_path.
# --------------------------------------------------------------------------- #

@pytest.fixture
def corpus(tmp_path, monkeypatch):
    # Resolve so macOS /var -> /private/var symlink can't defeat _rel's relative_to.
    tmp_path = tmp_path.resolve()
    ks = tmp_path / "knowledge-sync"
    wiki = ks / "wiki"
    raw = ks / "raw"
    (wiki / "agents").mkdir(parents=True)
    (raw / "areas").mkdir(parents=True)

    # Re-root the module constants at the temp corpus.
    monkeypatch.setattr(km, "KS_ROOT", ks)
    monkeypatch.setattr(km, "WIKI_ROOT", wiki)
    monkeypatch.setattr(km, "RAW_ROOT", raw)
    monkeypatch.setattr(km, "MASTER_INDEX", wiki / "_master-index.md")
    monkeypatch.setattr(km, "SYNTHESIS_STATE", wiki / ".synthesis-state.json")
    return {"ks": ks, "wiki": wiki, "raw": raw}


def _write(p: Path, text: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------- #
# Scan 1 — dead wikilinks
# --------------------------------------------------------------------------- #

def test_dead_wikilink_detected_and_live_link_passes(corpus):
    wiki, raw = corpus["wiki"], corpus["raw"]
    _write(wiki / "agents" / "larry.md", "# Larry\n")
    # one live link (resolves to larry), one dead link (no such file), alias + heading forms.
    _write(raw / "areas" / "note.md",
           "See [[larry]] and [[larry#identity]] and [[larry|the eng lead]].\n"
           "Broken: [[does-not-exist]].\n")

    slug_index = km.build_slug_index(wiki)
    res = km.scan_dead_wikilinks([wiki, raw], slug_index)

    assert res.errored is False
    targets = {f.extra["target"] for f in res.findings}
    assert targets == {"does-not-exist"}, targets
    assert all(f.route == km.ROUTE_AUTO_PR for f in res.findings)


# --------------------------------------------------------------------------- #
# Scan 2 — orphan / index drift
# --------------------------------------------------------------------------- #

def test_orphan_unindexed_article_and_stale_index_entry(corpus):
    wiki = corpus["wiki"]
    _write(wiki / "agents" / "larry.md", "# Larry\n")
    _write(wiki / "agents" / "frank2.md", "# Frank2\n")  # exists but will be omitted from index
    # master index lists larry (ok) + a deleted file (drift). Omits frank2 (orphan).
    _write(wiki / "_master-index.md",
           "# Wiki Master Index\n\n"
           "- [larry](wiki/agents/larry.md) `agents`\n"
           "- [ghost](wiki/agents/ghost.md) `agents`\n")

    res = km.scan_orphans(wiki, wiki / "_master-index.md")
    assert res.errored is False
    kinds = {(f.kind, f.path) for f in res.findings}
    assert ("wiki_article_unindexed", "wiki/agents/frank2.md") in kinds
    assert ("index_points_at_deleted", "wiki/agents/ghost.md") in kinds
    # larry is both present and indexed -> no finding for it
    assert not any(f.path == "wiki/agents/larry.md" for f in res.findings)


# --------------------------------------------------------------------------- #
# Scan 3 — junk allowlist audit
# --------------------------------------------------------------------------- #

def test_junk_flags_non_ingestible_but_not_ignored_dirs_or_real_content(corpus):
    wiki, raw = corpus["wiki"], corpus["raw"]
    _write(wiki / "agents" / "larry.md", "# ok\n")          # md: ingestible -> not flagged
    _write(raw / "areas" / "notes.json", "{}")              # json IS in mmrag.SUPPORTED -> not flagged
    _write(raw / "areas" / ".DS_Store", "junkbytes")        # no-ext, not ingestible -> flagged
    _write(raw / "areas" / "scan.pbm", "P1")                # .pbm not ingestible -> flagged
    _write(raw / "areas" / "photo.png", "PNGDATA")          # png IS ingestible -> not flagged
    # inside an mmrag-ignored dir -> NOT flagged (indexer already drops it)
    _write(raw / "areas" / ".trash" / "old.bin", "x")

    res = km.scan_junk([wiki, raw])
    assert res.errored is False
    flagged = {f.path for f in res.findings}
    assert "raw/areas/.DS_Store" in flagged
    assert "raw/areas/scan.pbm" in flagged
    # ingestible content (md/json/png) is NOT junk
    assert "wiki/agents/larry.md" not in flagged
    assert "raw/areas/notes.json" not in flagged
    assert "raw/areas/photo.png" not in flagged
    # ignored-dir files are already dropped by the indexer
    assert not any(".trash" in p for p in flagged)
    assert all(f.route == km.ROUTE_BUS_TASK for f in res.findings)


# --------------------------------------------------------------------------- #
# Scan 4 — exact duplicate hash
# --------------------------------------------------------------------------- #

def test_exact_dup_clusters_identical_bytes(corpus):
    wiki, raw = corpus["wiki"], corpus["raw"]
    body = "# Same Fact\n\nModel X is live.\n"
    _write(wiki / "agents" / "a.md", body)
    _write(raw / "areas" / "b.md", body)             # byte-identical dup at a different path
    _write(raw / "areas" / "c.md", body + "extra\n")  # different -> not a dup

    res = km.scan_exact_dups([wiki, raw])
    assert res.errored is False
    assert len(res.findings) == 1
    cluster = res.findings[0]
    assert cluster.kind == "exact_duplicate_cluster"
    assert set(cluster.extra["paths"]) == {"wiki/agents/a.md", "raw/areas/b.md"}
    # hash matches the actual content
    assert cluster.extra["hash"] == hashlib.sha256(body.encode()).hexdigest()
    assert cluster.route == km.ROUTE_BUS_TASK


# --------------------------------------------------------------------------- #
# Scan 5 — raw->wiki freshness
# --------------------------------------------------------------------------- #

def test_freshness_flags_changed_and_deleted_sources(corpus):
    ks, wiki, raw = corpus["ks"], corpus["wiki"], corpus["raw"]

    # article A: source unchanged since compile -> fresh (no finding)
    fresh_body = "raw content fresh\n"
    _write(raw / "areas" / "fresh.md", fresh_body)
    fresh_sha = hashlib.sha256(fresh_body.encode()).hexdigest()
    _write(wiki / "agents" / "fresh-wiki.md", "# fresh\n")

    # article B: source has since changed -> stale
    _write(raw / "areas" / "stale.md", "NEW content that changed\n")
    old_sha = hashlib.sha256(b"OLD content at compile time\n").hexdigest()
    _write(wiki / "agents" / "stale-wiki.md", "# stale\n")

    # article C: source deleted entirely
    _write(wiki / "agents" / "gone-wiki.md", "# gone\n")

    state = {
        "fresh": {"raw_path": "raw/areas/fresh.md", "wiki_path": "wiki/agents/fresh-wiki.md", "raw_sha": fresh_sha},
        "stale": {"raw_path": "raw/areas/stale.md", "wiki_path": "wiki/agents/stale-wiki.md", "raw_sha": old_sha},
        "gone":  {"raw_path": "raw/areas/deleted.md", "wiki_path": "wiki/agents/gone-wiki.md", "raw_sha": "deadbeef"},
    }
    res = km.scan_freshness(state)
    assert res.errored is False
    by_kind = {(f.kind, f.path) for f in res.findings}
    assert ("wiki_stale_vs_raw", "wiki/agents/stale-wiki.md") in by_kind
    assert ("wiki_source_deleted", "wiki/agents/gone-wiki.md") in by_kind
    # the fresh article produces NO finding
    assert not any(f.path == "wiki/agents/fresh-wiki.md" for f in res.findings)


# --------------------------------------------------------------------------- #
# Scan 6 — read canary (injectable runner, no live index)
# --------------------------------------------------------------------------- #

def test_read_canary_passes_and_regresses():
    seeds = [{"query": "larry agent", "expect_path_substr": "larry"}]

    def good_runner(_q):
        return ["wiki/agents/larry.md", "raw/x.md"]

    def bad_runner(_q):
        return ["wiki/agents/frank2.md"]  # no larry hit -> regression

    def erroring_runner(_q):
        raise RuntimeError("index offline")

    ok = km.scan_read_canary(seeds, good_runner)
    assert ok.findings == []

    regressed = km.scan_read_canary(seeds, bad_runner)
    assert len(regressed.findings) == 1
    assert regressed.findings[0].kind == "seed_query_regressed"

    errored = km.scan_read_canary(seeds, erroring_runner)
    assert errored.findings[0].kind == "seed_query_errored"

    # No runner => canary not exercised, not an error.
    none_run = km.scan_read_canary(seeds, None)
    assert none_run.findings == [] and none_run.errored is False


# --------------------------------------------------------------------------- #
# Tier 3 — event-driven marks
# --------------------------------------------------------------------------- #

def test_tier3_maps_changed_raw_to_wiki(corpus, tmp_path):
    state_path = corpus["wiki"] / ".synthesis-state.json"
    state = {
        "a": {"raw_path": "raw/areas/changed.md", "wiki_path": "wiki/agents/a.md", "raw_sha": "x"},
        "b": {"raw_path": "raw/areas/other.md", "wiki_path": "wiki/agents/b.md", "raw_sha": "y"},
    }
    state_path.write_text(json.dumps(state), encoding="utf-8")

    # one changed file maps, one has no wiki article -> ignored; leading ./ tolerated
    findings = km.tier3_event_marks(["./raw/areas/changed.md", "raw/areas/untracked.md"], state_path)
    assert len(findings) == 1
    assert findings[0].path == "wiki/agents/a.md"
    assert findings[0].kind == "wiki_stale_candidate_event"


# --------------------------------------------------------------------------- #
# Orchestration + ledger/findings output
# --------------------------------------------------------------------------- #

def test_run_tier1_and_ledger_row_green_when_no_scan_crashes(corpus, tmp_path):
    wiki, raw = corpus["wiki"], corpus["raw"]
    _write(wiki / "agents" / "larry.md", "# Larry\n")
    _write(wiki / "_master-index.md",
           "# idx\n\n- [larry](wiki/agents/larry.md) `agents`\n")
    _write(raw / "areas" / "note.md", "[[does-not-exist]] link\n")

    tier1 = km.run_tier1(roots=[wiki, raw], wiki_root=wiki,
                         master_index=wiki / "_master-index.md",
                         synthesis_state_path=wiki / ".synthesis-state.json")
    row = km.compose_ledger_row(tier1, "2026-08-04T00:00:00Z")
    assert row["green"] is True  # no scan crashed
    assert row["counts"]["dead_wikilink"] == 1
    assert row["total_findings"] >= 1

    ledger = tmp_path / "state" / "ledger.jsonl"
    km.append_ledger(row, ledger)
    written = [json.loads(l) for l in ledger.read_text().splitlines()]
    assert written[-1]["run"] == "kb-maintenance-nightly"

    findings_file = km.write_findings_file(tier1, tmp_path / "findings", "2026-08-04T00:00:00Z")
    content = findings_file.read_text()
    assert "KB maintenance findings" in content
    assert "does-not-exist" in content


def test_run_tier2_stub_disabled_by_default_counts_candidates(corpus):
    wiki, raw = corpus["wiki"], corpus["raw"]
    body = "dup\n"
    _write(wiki / "agents" / "a.md", body)
    _write(raw / "areas" / "b.md", body)
    tier1 = km.run_tier1(roots=[wiki, raw], wiki_root=wiki,
                         master_index=wiki / "_master-index.md",
                         synthesis_state_path=wiki / ".synthesis-state.json")
    out = km.run_tier2(tier1)
    assert out["enabled"] is False  # KB_MAINT_ENABLE_LLM not set
    # near-dup check saw the exact-dup cluster as a candidate
    assert out["checks"]["near_dup"]["candidates"] == 1
    assert out["checks"]["near_dup"]["sample"]["enabled"] is False
