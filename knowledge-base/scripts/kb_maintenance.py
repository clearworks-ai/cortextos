#!/usr/bin/env python3
"""kb_maintenance — proactive content-health maintenance loop for the Clearworks corpus.

A 3-tier loop layered ON TOP of the existing kb-reconcile index-freshness machine
(see orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh + mmrag.py reconcile).
kb-reconcile answers "is every file on disk embedded / are edges current". This module
answers the orthogonal question DESIGN-D-knowledge-base.md raises: is the *content*
connected, non-duplicated, uncluttered, fresh, and still retrievable.

Design source: knowledge-sync/raw/areas/clearworks/altari-skilltree/DESIGN-D-knowledge-base.md §3.

Tiers
-----
Tier 1 — nightly deterministic sweep (zero-LLM). Six scans:
  1. dead wiki-link scan   — every [[link]] in wiki/ + raw/ resolves to a real file.
  2. orphan / index-drift  — wiki articles missing from _master-index.md; index entries
                             pointing at deleted files; raw files with zero inbound edges.
  3. junk allowlist audit  — files under the corpus that mmrag would embed but are junk
                             (reuses mmrag._is_ignored + an extension allowlist).
  4. exact-dup hash        — content-hash across raw+wiki; cluster identical bytes / paths.
  5. raw->wiki freshness   — via wiki/.synthesis-state.json, flag wiki articles whose
                             source raw file changed after the article was compiled.
  6. seed-query read canary— N seed kb-queries with an expected top-hit substring; fail
                             if a known fact stops retrieving ("smart stranger" test).

Tier 2 — weekly LLM verify (Haiku, candidates only). Structure wired; the LLM call is a
  documented, ready-to-enable stub gated on KB_MAINT_ENABLE_LLM. Runs ONLY on Tier-1
  candidates (near-dup clusters, staleness triage, contradiction diff, one-fact-one-home).

Tier 3 — event-driven. Given a kb-reconcile changed_files list (raw paths), map each to
  its wiki article via .synthesis-state.json and emit stale-candidate marks immediately.

Output routing (DESIGN-D §"Fix routing"):
  - one row per run -> state/kb-maintenance-ledger.jsonl (green/red, same shape as reconcile)
  - a findings file -> knowledge-sync/system/kb-maintenance/YYYY-MM-DD.md
  - mechanical fixes (index regen, unambiguous rename-link repair) -> auto-PR class
  - merges/deletions/rewrites -> bus-task class (larry); one weekly digest.
This module DETECTS and CLASSIFIES; it never mutates the corpus. Applying fixes is a
separate, approval-gated step per DESIGN-D ("Approval-required (never auto)").
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Iterable

# Reuse mmrag's ignore rules + content hash so the maintenance loop sees exactly the
# same file universe the indexer does (single source of truth for what "junk" is).
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import mmrag  # noqa: E402


# --------------------------------------------------------------------------- #
# Corpus geometry
# --------------------------------------------------------------------------- #

KS_ROOT = Path.home() / "code" / "knowledge-sync"
WIKI_ROOT = KS_ROOT / "wiki"
RAW_ROOT = KS_ROOT / "raw"
SYNTHESIS_STATE = WIKI_ROOT / ".synthesis-state.json"
MASTER_INDEX = WIKI_ROOT / "_master-index.md"

# Markdown/text content — the primary corpus body, used by scans that read file text
# (dead-link, dup, one-fact-one-home). Media/docs are legitimate index content too but
# aren't text-scannable, so those scans stick to markdown/txt.
ALLOWED_CONTENT_EXTS = {".md", ".markdown", ".txt"}

# The junk sweep's allowlist == exactly what mmrag will actually ingest. A file that is
# NOT mmrag-ignored and whose extension is NOT in mmrag.SUPPORTED_EXTS is genuine junk
# (e.g. .DS_Store, stray .json/.html scaffolding) that would otherwise pollute the index.
# Anchored to mmrag's own set so pdf/docx/png (intentionally embedded) are never flagged.
INGESTIBLE_EXTS = set(mmrag.SUPPORTED_EXTS)

# [[wikilink]] with optional |alias and optional #heading / trailing path.
WIKILINK_RE = re.compile(r"\[\[([^\]\|#]+)(?:#[^\]\|]+)?(?:\|[^\]]+)?\]\]")

# Fact-shaped tokens for the one-fact-one-home audit stub (Tier 2). Cheap grep anchors.
MUTABLE_FACT_PATTERNS = [
    re.compile(r"claude-(?:opus|sonnet|haiku)-[\w.\-]+", re.I),
    re.compile(r"\$\d[\d,]*(?:\.\d+)?(?:/mo|/month| per month)?", re.I),
    re.compile(r"https?://[^\s)]+", re.I),
]


# --------------------------------------------------------------------------- #
# Findings model
# --------------------------------------------------------------------------- #

# Routing classes per DESIGN-D §"Fix routing / approval queue".
ROUTE_AUTO_PR = "auto-pr"      # mechanical, git-tracked (index regen, unambiguous link repair)
ROUTE_BUS_TASK = "bus-task"    # merges/deletions/rewrites -> larry approval
ROUTE_DIGEST = "digest"        # informational, rolls into weekly digest only


@dataclass
class Finding:
    scan: str                       # which Tier-1/2/3 scan produced this
    kind: str                       # machine key, e.g. "dead_wikilink"
    route: str                      # ROUTE_* — how a fix would be applied
    path: str                       # primary file the finding is about (repo-relative)
    detail: str                     # human-readable description
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class ScanResult:
    findings: list[Finding] = field(default_factory=list)
    errored: bool = False           # scan itself failed (not the same as "found issues")
    error: str = ""

    def add(self, f: Finding) -> None:
        self.findings.append(f)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _rel(p: Path, root: Path | None = None) -> str:
    # Read KS_ROOT at call time (not as a default arg) so tests can monkeypatch it.
    root = root if root is not None else KS_ROOT
    try:
        return str(p.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(p)


def iter_content_files(roots: Iterable[Path]) -> Iterable[Path]:
    """Yield markdown/txt files under roots, honoring mmrag's ignore rules."""
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if mmrag._is_ignored(path):
                continue
            if path.suffix.lower() in ALLOWED_CONTENT_EXTS:
                yield path


def build_slug_index(wiki_root: Path) -> dict[str, str]:
    """Map every resolvable name (slug, basename, area/basename) -> repo-rel path.

    Mirrors createSlugResolver's exact-match tier (resolve.ts): a [[link]] resolves if
    it matches a wiki article's basename, its area/basename slug, or (for raw notes) a
    raw markdown basename. Fuzzy/trigram resolution is intentionally NOT replicated —
    a dead-link scan must be conservative (only flag links with NO exact home).
    """
    index: dict[str, str] = {}

    def _add(key: str, rel: str) -> None:
        k = key.strip().lower()
        if k and k not in index:
            index[k] = rel

    # Wiki articles: basename and area/basename.
    if wiki_root.exists():
        for path in wiki_root.rglob("*.md"):
            if mmrag._is_ignored(path):
                continue
            rel = _rel(path)
            base = path.stem
            _add(base, rel)
            parent = path.parent.name
            if parent and parent != wiki_root.name:
                _add(f"{parent}/{base}", rel)

    # Raw notes are legitimate wikilink targets too (e.g. [[reference_...]]).
    if RAW_ROOT.exists():
        for path in RAW_ROOT.rglob("*.md"):
            if mmrag._is_ignored(path):
                continue
            _add(path.stem, _rel(path))

    return index


# --------------------------------------------------------------------------- #
# Tier 1 — deterministic scans
# --------------------------------------------------------------------------- #

def scan_dead_wikilinks(roots: list[Path], slug_index: dict[str, str]) -> ScanResult:
    """Scan 1: every [[link]] in wiki/ + raw/ must resolve to a real file."""
    res = ScanResult()
    try:
        for path in iter_content_files(roots):
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for m in WIKILINK_RE.finditer(text):
                target = m.group(1).strip()
                if not target:
                    continue
                key = target.lower()
                # Accept exact key, basename of a path-y link, or area/base form.
                if key in slug_index:
                    continue
                base_key = key.rsplit("/", 1)[-1]
                if base_key in slug_index:
                    continue
                res.add(Finding(
                    scan="dead_wikilink",
                    kind="dead_wikilink",
                    route=ROUTE_AUTO_PR,  # a rename repair is mechanical when target is unambiguous
                    path=_rel(path),
                    detail=f"[[{target}]] resolves to no file",
                    extra={"target": target},
                ))
    except Exception as exc:  # scan-level failure
        res.errored = True
        res.error = f"{type(exc).__name__}: {exc}"
    return res


def scan_orphans(wiki_root: Path, master_index: Path) -> ScanResult:
    """Scan 2: wiki articles missing from _master-index.md, and index entries whose
    target file no longer exists (index drift)."""
    res = ScanResult()
    try:
        indexed_targets: set[str] = set()
        index_text = ""
        if master_index.exists():
            index_text = master_index.read_text(encoding="utf-8", errors="ignore")
        # _master-index lines look like: - [title](wiki/<area>/slug.md) `area`
        for m in re.finditer(r"\]\(([^)]+\.md)\)", index_text):
            indexed_targets.add(m.group(1).strip())

        # (a) index entries -> deleted files
        for tgt in sorted(indexed_targets):
            # targets are relative to knowledge-sync root (wiki/...).
            candidate = KS_ROOT / tgt
            if not candidate.exists():
                res.add(Finding(
                    scan="orphan",
                    kind="index_points_at_deleted",
                    route=ROUTE_AUTO_PR,  # regenerating the index drops the stale entry
                    path=tgt,
                    detail=f"_master-index.md links {tgt} which no longer exists",
                ))

        # (b) wiki articles not present in the master index
        if wiki_root.exists():
            for path in wiki_root.rglob("*.md"):
                if mmrag._is_ignored(path):
                    continue
                if path.name in ("_master-index.md", "_index.md", "Index.md"):
                    continue
                rel = _rel(path)  # e.g. wiki/agents/larry.md
                if rel not in indexed_targets:
                    res.add(Finding(
                        scan="orphan",
                        kind="wiki_article_unindexed",
                        route=ROUTE_AUTO_PR,  # index regen adds it
                        path=rel,
                        detail=f"{rel} is not listed in _master-index.md",
                    ))
    except Exception as exc:
        res.errored = True
        res.error = f"{type(exc).__name__}: {exc}"
    return res


def scan_junk(roots: list[Path]) -> ScanResult:
    """Scan 3: files NOT ignored by mmrag but outside the content allowlist — i.e. things
    that would get embedded but are not KB content (stray binaries, json, html, etc.)."""
    res = ScanResult()
    try:
        for root in roots:
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                if mmrag._is_ignored(path):
                    continue  # mmrag already drops it — not junk-in-index
                suffix = path.suffix.lower()
                if suffix in INGESTIBLE_EXTS:
                    continue  # mmrag legitimately embeds this (md/txt/pdf/docx/png/...)
                # Not ignored AND not ingestible == junk that would pollute the index.
                res.add(Finding(
                    scan="junk",
                    kind="non_content_in_corpus",
                    route=ROUTE_BUS_TASK,  # quarantine is approval-required per DESIGN-D
                    path=_rel(path),
                    detail=f"non-ingestible file ({suffix or 'no-ext'}) inside a reconcile root",
                    extra={"ext": suffix},
                ))
    except Exception as exc:
        res.errored = True
        res.error = f"{type(exc).__name__}: {exc}"
    return res


def scan_exact_dups(roots: list[Path]) -> ScanResult:
    """Scan 4: content-hash across roots; cluster files with identical bytes at >1 path."""
    res = ScanResult()
    try:
        by_hash: dict[str, list[str]] = defaultdict(list)
        for path in iter_content_files(roots):
            try:
                h = mmrag._file_content_hash(path)
            except OSError:
                continue
            by_hash[h].append(_rel(path))
        for h, paths in by_hash.items():
            if len(paths) > 1:
                paths_sorted = sorted(paths)
                res.add(Finding(
                    scan="exact_dup",
                    kind="exact_duplicate_cluster",
                    route=ROUTE_BUS_TASK,  # a merge/delete decision is approval-required
                    path=paths_sorted[0],
                    detail=f"{len(paths_sorted)} byte-identical files: {', '.join(paths_sorted)}",
                    extra={"hash": h, "paths": paths_sorted},
                ))
    except Exception as exc:
        res.errored = True
        res.error = f"{type(exc).__name__}: {exc}"
    return res


def load_synthesis_state(state_path: Path) -> dict[str, dict[str, Any]]:
    if not state_path.exists():
        return {}
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def scan_freshness(state: dict[str, dict[str, Any]]) -> ScanResult:
    """Scan 5: for each compiled wiki article, if its source raw file's current sha differs
    from the sha recorded at compile time, the article is a stale-candidate."""
    res = ScanResult()
    try:
        for slug, entry in state.items():
            if not isinstance(entry, dict):
                continue
            raw_rel = entry.get("raw_path")
            wiki_rel = entry.get("wiki_path")
            recorded_sha = entry.get("raw_sha")
            if not raw_rel or not recorded_sha:
                continue
            raw_abs = KS_ROOT / raw_rel
            if not raw_abs.exists():
                res.add(Finding(
                    scan="freshness",
                    kind="wiki_source_deleted",
                    route=ROUTE_BUS_TASK,  # rewrite/retire decision
                    path=wiki_rel or slug,
                    detail=f"source {raw_rel} for wiki article no longer exists",
                    extra={"raw_path": raw_rel},
                ))
                continue
            try:
                current_sha = mmrag._file_content_hash(raw_abs)
            except OSError:
                continue
            if current_sha != recorded_sha:
                res.add(Finding(
                    scan="freshness",
                    kind="wiki_stale_vs_raw",
                    route=ROUTE_BUS_TASK,  # a rewrite is approval-required
                    path=wiki_rel or slug,
                    detail=f"raw source {raw_rel} changed since article compiled",
                    extra={"raw_path": raw_rel, "recorded_sha": recorded_sha, "current_sha": current_sha},
                ))
    except Exception as exc:
        res.errored = True
        res.error = f"{type(exc).__name__}: {exc}"
    return res


# Seed read-canary: known facts and a substring expected in the top retrieval hit path.
# Kept tiny + high-signal; expand as canonical homes stabilize. Runs kb-query via the
# provided runner so tests can inject a stub (no network / no index dependency in CI).
DEFAULT_SEED_QUERIES: list[dict[str, str]] = [
    {"query": "larry engineering supervisor agent", "expect_path_substr": "larry"},
    {"query": "kb reconcile nightly cron", "expect_path_substr": "reconcile"},
    {"query": "model routing table cost tier", "expect_path_substr": "model"},
]


def scan_read_canary(
    seeds: list[dict[str, str]],
    query_runner: Callable[[str], list[str]] | None,
) -> ScanResult:
    """Scan 6: run each seed query; fail if the expected substring is absent from every
    returned top-hit path. query_runner(query) -> list of result paths (top-first)."""
    res = ScanResult()
    if query_runner is None:
        # Canary is optional at the deterministic tier; absence of a runner is not a
        # scan error — it's simply not exercised (documented, ready to enable).
        return res
    try:
        for seed in seeds:
            q = seed["query"]
            expect = seed["expect_path_substr"].lower()
            try:
                hits = query_runner(q) or []
            except Exception as exc:  # a single query failing is a real canary failure
                res.add(Finding(
                    scan="read_canary",
                    kind="seed_query_errored",
                    route=ROUTE_BUS_TASK,
                    path="",
                    detail=f"seed query {q!r} errored: {type(exc).__name__}: {exc}",
                    extra={"query": q},
                ))
                continue
            if not any(expect in h.lower() for h in hits):
                res.add(Finding(
                    scan="read_canary",
                    kind="seed_query_regressed",
                    route=ROUTE_BUS_TASK,  # a retrieval regression needs investigation
                    path="",
                    detail=f"seed query {q!r} no longer returns a hit containing {expect!r}",
                    extra={"query": q, "hits": hits[:5]},
                ))
    except Exception as exc:
        res.errored = True
        res.error = f"{type(exc).__name__}: {exc}"
    return res


def run_tier1(
    roots: list[Path] | None = None,
    wiki_root: Path = WIKI_ROOT,
    master_index: Path = MASTER_INDEX,
    synthesis_state_path: Path = SYNTHESIS_STATE,
    seeds: list[dict[str, str]] | None = None,
    query_runner: Callable[[str], list[str]] | None = None,
) -> dict[str, ScanResult]:
    """Run all six deterministic scans, returning {scan_name: ScanResult}."""
    if roots is None:
        roots = [WIKI_ROOT, RAW_ROOT]
    slug_index = build_slug_index(wiki_root)
    state = load_synthesis_state(synthesis_state_path)
    return {
        "dead_wikilink": scan_dead_wikilinks(roots, slug_index),
        "orphan": scan_orphans(wiki_root, master_index),
        "junk": scan_junk(roots),
        "exact_dup": scan_exact_dups(roots),
        "freshness": scan_freshness(state),
        "read_canary": scan_read_canary(seeds or DEFAULT_SEED_QUERIES, query_runner),
    }


# --------------------------------------------------------------------------- #
# Tier 2 — weekly LLM verify (Haiku, candidates only). Structure wired; LLM = stub.
# --------------------------------------------------------------------------- #

def _haiku_verdict_stub(prompt: str) -> dict[str, Any]:
    """Ready-to-enable Haiku call. Disabled by default so the weekly job is deterministic
    and free until Josh enables it. Enable by exporting KB_MAINT_ENABLE_LLM=1 and wiring
    an Anthropic client here (latest Haiku per fleet model doctrine — no pinned legacy id).

    Returns {"enabled": bool, "verdict": str, "prompt_chars": int}.
    """
    if os.environ.get("KB_MAINT_ENABLE_LLM", "").strip() not in ("1", "true", "yes"):
        return {"enabled": False, "verdict": "stub", "prompt_chars": len(prompt)}
    # --- enable path (intentionally not wired to network in this build) --------------
    # from anthropic import Anthropic
    # client = Anthropic()
    # msg = client.messages.create(model="<latest-haiku>", max_tokens=256,
    #                              messages=[{"role": "user", "content": prompt}])
    # return {"enabled": True, "verdict": msg.content[0].text, "prompt_chars": len(prompt)}
    raise NotImplementedError(
        "KB_MAINT_ENABLE_LLM is set but the Haiku client is not wired in this build. "
        "Wire the Anthropic call in _haiku_verdict_stub before enabling."
    )


def run_tier2(tier1: dict[str, ScanResult], verdict_fn: Callable[[str], dict[str, Any]] | None = None) -> dict[str, Any]:
    """Weekly LLM verify over Tier-1 candidates ONLY (never the whole corpus).

    Four checks per DESIGN-D §Tier 2 — each builds candidate prompts from Tier-1 output
    and asks the LLM for a verdict. With the stub, every check reports how many candidates
    it WOULD send, proving the wiring without spending tokens.
    """
    verdict_fn = verdict_fn or _haiku_verdict_stub

    def _candidates(scan: str) -> list[Finding]:
        return list(tier1.get(scan, ScanResult()).findings)

    checks: dict[str, dict[str, Any]] = {}

    # near-dup clusters (would use embedding cosine >0.92; seeded here by exact-dup output)
    dup_c = _candidates("exact_dup")
    checks["near_dup"] = {
        "candidates": len(dup_c),
        "sample": verdict_fn("near-dup merge? " + (dup_c[0].detail if dup_c else "none")),
    }
    # staleness triage over freshness stale-candidates
    stale_c = [f for f in _candidates("freshness") if f.kind == "wiki_stale_vs_raw"]
    checks["staleness_triage"] = {
        "candidates": len(stale_c),
        "sample": verdict_fn("does this article assert mutable facts contradicted by newer raw? " +
                             (stale_c[0].detail if stale_c else "none")),
    }
    # contradiction spot-check (entities with both wiki + fresh raw edges) — seeded by freshness
    checks["contradiction_spotcheck"] = {
        "candidates": len(stale_c),
        "sample": verdict_fn("diff wiki claims vs newer raw for contradictions: " +
                             (stale_c[0].extra.get("raw_path", "none") if stale_c else "none")),
    }
    # one-fact-one-home audit (Altari rule 3, mechanized)
    checks["one_fact_one_home"] = _one_fact_one_home_candidates()
    return {"enabled": os.environ.get("KB_MAINT_ENABLE_LLM", "") in ("1", "true", "yes"),
            "checks": checks}


def _one_fact_one_home_candidates(roots: list[Path] | None = None) -> dict[str, Any]:
    """Grep-extract mutable-fact tokens (model ids, prices, URLs) appearing in >1 file.
    Deterministic candidate generation; the LLM (Tier 2) would nominate the canonical home."""
    if roots is None:
        roots = [WIKI_ROOT, RAW_ROOT]
    homes: dict[str, set[str]] = defaultdict(set)
    for path in iter_content_files(roots):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel = _rel(path)
        for pat in MUTABLE_FACT_PATTERNS:
            for m in pat.finditer(text):
                homes[m.group(0).strip()].add(rel)
    multi = {fact: sorted(paths) for fact, paths in homes.items() if len(paths) > 1}
    return {"multi_home_facts": len(multi), "sample": dict(list(multi.items())[:5])}


# --------------------------------------------------------------------------- #
# Tier 3 — event-driven stale marks
# --------------------------------------------------------------------------- #

def tier3_event_marks(changed_files: list[str], synthesis_state_path: Path = SYNTHESIS_STATE) -> list[Finding]:
    """Given kb-reconcile changed_files (raw paths, repo-rel), mark each mapped wiki
    article a stale-candidate immediately (feeds Tier 1/2 without waiting for mtime drift)."""
    state = load_synthesis_state(synthesis_state_path)
    # Build raw_path -> wiki_path map once.
    raw_to_wiki: dict[str, str] = {}
    for entry in state.values():
        if isinstance(entry, dict) and entry.get("raw_path") and entry.get("wiki_path"):
            raw_to_wiki[entry["raw_path"]] = entry["wiki_path"]
    findings: list[Finding] = []
    for raw_rel in changed_files:
        raw_norm = raw_rel.lstrip("./")
        wiki_rel = raw_to_wiki.get(raw_norm)
        if not wiki_rel:
            continue
        findings.append(Finding(
            scan="tier3_event",
            kind="wiki_stale_candidate_event",
            route=ROUTE_BUS_TASK,
            path=wiki_rel,
            detail=f"raw source {raw_norm} changed in last reconcile — mark {wiki_rel} stale-candidate",
            extra={"raw_path": raw_norm},
        ))
    return findings


# --------------------------------------------------------------------------- #
# Ledger + findings output
# --------------------------------------------------------------------------- #

def summarize(tier1: dict[str, ScanResult]) -> dict[str, Any]:
    counts = {name: len(r.findings) for name, r in tier1.items()}
    errored = {name: r.error for name, r in tier1.items() if r.errored}
    total = sum(counts.values())
    # green == no scan crashed. Findings themselves are the corpus's health signal, not a
    # failure of the sweep — mirrors reconcile's "did the run itself succeed" semantics.
    green = len(errored) == 0
    return {"counts": counts, "total_findings": total, "errored_scans": errored, "green": green}


def compose_ledger_row(tier1: dict[str, ScanResult], ts: str, run: str = "kb-maintenance-nightly") -> dict[str, Any]:
    summ = summarize(tier1)
    return {"ts": ts, "run": run, **summ}


def append_ledger(row: dict[str, Any], ledger_path: Path) -> None:
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(row) + "\n"
    # Append is atomic enough for a single-writer nightly cron; write line then flush+fsync.
    with open(ledger_path, "a", encoding="utf-8") as fh:
        fh.write(line)
        fh.flush()
        os.fsync(fh.fileno())


def write_findings_file(tier1: dict[str, ScanResult], out_dir: Path, ts: str, tier3: list[Finding] | None = None) -> Path:
    day = ts.split("T")[0]
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{day}.md"
    summ = summarize(tier1)
    lines = [
        f"# KB maintenance findings — {day}",
        "",
        f"Run at `{ts}`. Total findings: **{summ['total_findings']}**. "
        f"Sweep {'GREEN' if summ['green'] else 'RED (a scan crashed)'}.",
        "",
        "| scan | findings |",
        "|---|---|",
    ]
    for name, n in summ["counts"].items():
        lines.append(f"| {name} | {n} |")
    if summ["errored_scans"]:
        lines += ["", "## Scan errors", ""]
        for name, err in summ["errored_scans"].items():
            lines.append(f"- **{name}**: {err}")
    # Group findings by scan, cap per-scan output so a runaway scan can't produce a 50k-line file.
    CAP = 200
    for name, res in tier1.items():
        if not res.findings:
            continue
        lines += ["", f"## {name} ({len(res.findings)})", ""]
        for f in res.findings[:CAP]:
            lines.append(f"- `[{f.route}]` {f.path or '(corpus)'} — {f.detail}")
        if len(res.findings) > CAP:
            lines.append(f"- … and {len(res.findings) - CAP} more (see ledger row).")
    if tier3:
        lines += ["", f"## tier3_event ({len(tier3)})", ""]
        for f in tier3[:CAP]:
            lines.append(f"- `[{f.route}]` {f.path} — {f.detail}")
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out_path


# --------------------------------------------------------------------------- #
# kb-query runner (real, for the live canary; injectable for tests)
# --------------------------------------------------------------------------- #

def default_query_runner(query: str) -> list[str]:
    """Run `cortextos bus kb-query` and return result paths, top-first. Best-effort:
    any failure raises so the canary records it as a seed_query_errored finding."""
    import subprocess

    proc = subprocess.run(
        ["cortextos", "bus", "kb-query", "--org", "clearworksai", "--json", "--query", query],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[:300] or f"exit {proc.returncode}")
    data = json.loads(proc.stdout)
    results = data.get("results") or data.get("hits") or []
    paths: list[str] = []
    for r in results:
        p = r.get("path") or r.get("source_path") or r.get("file") or ""
        if p:
            paths.append(p)
    return paths


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="KB proactive content-health maintenance (3-tier)")
    parser.add_argument("--tier", choices=["1", "2", "all"], default="1",
                        help="1 = nightly deterministic (default); 2 = +weekly LLM verify; all = both")
    parser.add_argument("--ledger", default=str(
        Path(__file__).resolve().parents[2] /
        "orgs/clearworksai/agents/larry/state/kb-maintenance-ledger.jsonl"))
    parser.add_argument("--findings-dir", default=str(KS_ROOT / "system" / "kb-maintenance"))
    parser.add_argument("--canary", action="store_true",
                        help="run the seed read-canary against the live index (needs cortextos bus)")
    parser.add_argument("--dry-run", action="store_true",
                        help="print findings JSON to stdout; do not write ledger/findings file")
    parser.add_argument("--json", action="store_true", help="print the ledger row as JSON to stdout")
    parser.add_argument("--changed-files", default="",
                        help="comma-separated raw paths from kb-reconcile (Tier 3 event marks)")
    args = parser.parse_args(argv)

    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    runner = default_query_runner if args.canary else None
    tier1 = run_tier1(query_runner=runner)

    tier3: list[Finding] = []
    if args.changed_files.strip():
        changed = [c for c in (x.strip() for x in args.changed_files.split(",")) if c]
        tier3 = tier3_event_marks(changed)

    row = compose_ledger_row(tier1, ts)
    if tier3:
        row["tier3_event_marks"] = len(tier3)

    tier2_out = None
    if args.tier in ("2", "all"):
        tier2_out = run_tier2(tier1)
        row["tier2"] = {"enabled": tier2_out["enabled"],
                        "checks": {k: v.get("candidates", v.get("multi_home_facts", 0))
                                   for k, v in tier2_out["checks"].items()}}

    if args.dry_run:
        out = {"ledger_row": row}
        if tier2_out:
            out["tier2"] = tier2_out
        # findings inline for evidence capture
        out["findings"] = {name: [asdict(f) for f in res.findings] for name, res in tier1.items()}
        if tier3:
            out["tier3_findings"] = [asdict(f) for f in tier3]
        print(json.dumps(out, indent=2))
        return 0 if row["green"] else 1

    append_ledger(row, Path(args.ledger))
    findings_path = write_findings_file(tier1, Path(args.findings_dir), ts, tier3=tier3)
    if args.json:
        row["findings_file"] = str(findings_path)
        print(json.dumps(row))
    else:
        print(f"kb-maintenance: {row['total_findings']} findings, "
              f"{'green' if row['green'] else 'RED'}; findings -> {findings_path}")
    return 0 if row["green"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
