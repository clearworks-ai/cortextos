# Spec 02 — Internal discovery (`discover_internal.py`)

**Target file (net-new):**
`orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/scripts/discover_internal.py`

Glob known documentation roots + keyword-score candidate files against a vertical term set, tier by
confidence, and emit a candidate JSON for human curation. **This script never writes the manifest
and never auto-includes anything** — it PROPOSES; the human (SKILL.md Step 3) confirms.

Style: mirror `research-pulse/scripts/discover.py` — `from __future__ import annotations`, stdlib
`argparse`/`json`/`os`/`re`/`pathlib`, guarded 3rd-party import only if truly needed (it is NOT —
this is pure stdlib; do not add deps). No `print` except in the `__main__`/`main()` CLI.

---

## 1. Known roots (module constants — DIRECTORY roots only, NEVER per-client file paths)

```python
HOME = Path(os.path.expanduser("~"))

KNOWN_ROOTS = [
    {"path": HOME / "code/knowledge-sync/raw/areas/clearworks",          "category": "client_audits",    "recursive": False},
    {"path": HOME / "code/knowledge-sync/raw/areas/clearworks/research", "category": "research_docs",    "recursive": False},
    {"path": HOME / "code/knowledge-sync/raw/areas/clearworks/growth",   "category": "positioning_docs", "recursive": False},
    {"path": HOME / "code/knowledge-sync/wiki/projects",                 "category": "client_audits",    "recursive": False},
    {"path": HOME / "code/knowledge-sync/wiki/intelligence",             "category": "positioning_docs", "recursive": False},
    {"path": HOME / "code/cortextos/orgs/clearworksai/agents/muse/memory", "category": "memory_refs",    "recursive": False},
]
```

- Roots are DIRECTORIES; category is by root. **No filename literals** like `alloi.md` or
  `marketing-intelligence-v3.md` appear anywhere — grep-checkable (a test asserts the source
  contains no such literal). This is the "no hardcoded per-client paths" rule.
- **Override for tests:** `--roots-json <path>` supplies a list of `{path, category, recursive}`
  dicts, replacing `KNOWN_ROOTS`. Tests point this at a synthetic fixture tree so discovery is
  provable without real client data.
- Candidate file extensions: `.md`, `.pdf` (constant `CANDIDATE_EXTS = (".md", ".pdf")`). Skip
  dotfiles, `.trash/`, `_quarantine`*, `__pycache__`.

## 2. Term set (parameterized — NOT hardcoded to AEC in the scorer)

`build_terms(vertical: str, display_name: str, topic_vocab_extra: list[str], synonyms:
list[str]) -> list[str]`:

- lowercase, split `display_name` on non-alphanumerics, union with `slugify(vertical)` tokens,
  `topic_vocab_extra`, and the passed `synonyms`; drop tokens shorter than 3 chars; dedupe.
- The caller (SKILL.md / CLI) passes the AEC synonym list
  `["architecture","engineering","construction","aec","building","design","firm","contractor",
  "infrastructure"]` via `--synonym` (repeatable) — it is NOT embedded in the scoring function, so a
  second vertical reuses the same code with a different synonym list. A test proves a second
  synthetic vertical works with no code change.

## 3. Scoring

`score_file(path: Path, terms: list[str]) -> tuple[int, list[str]]`:

- Read filename stem (lowercased) and the first `HEAD_LINES = 40` lines of the file (for `.pdf`,
  attempt a lightweight text read; if unreadable, score on filename only — never crash on a binary
  PDF, catch and degrade). Frontmatter `tags:`/`area:` lines count as body.
- For each term: if in filename stem → +`FILENAME_WEIGHT` (=3); else if in body head →
  +`BODY_WEIGHT` (=1). Collect the matched terms.
- Return `(score, matched_terms)`. Deterministic; no network.

## 4. Confidence tiers (constants)

```python
HIGH_THRESHOLD = 4     # proposed (still requires human confirm)
LOW_THRESHOLD  = 2     # >= LOW and < HIGH → ambiguous (explicit yes/no)
                       # < LOW → dropped, not surfaced
```

`tier(score) -> "high" | "ambiguous" | "drop"`.

## 5. `discover(roots, terms) -> list[dict]`

- Walk each root (non-recursive per the root's `recursive` flag; recursive=True walks subdirs but
  still skips the excluded dir names in §1).
- For each candidate file: `score_file`, `tier`. Skip `drop`.
- Build a candidate dict:
  `{ "category": root_category, "title": <filename stem, human-cased>, "path": str(abs_path),
     "score": int, "matched_terms": [...], "tier": "high"|"ambiguous", "version": <int|None> }`.
  - `version`: if the stem matches `marketing-intelligence-v(\d+)` (regex, generic — matches ANY
    `-v<N>` positioning doc, not a hardcoded filename) set `version=N`, else `None`.
- **positioning latest flag is NOT set here** — that is decided at manifest-compose time over the
  CONFIRMED set (spec 01 validates ≤1 latest). Discovery only records `version`.
- Return candidates sorted by `(category, -score, path)`.
- **Never** returns `confirmed`; candidates are proposals. The `high` tier is "strong proposal",
  NOT "auto-include" — the SKILL.md/CLI contract is that even `high` candidates are shown to the
  human for confirm (the human can bulk-accept `high`, but the code never persists without that
  step).

## 6. `main(argv) -> int` (CLI)

Flags:
- `--vertical <slug>` (required)
- `--display-name <str>` (required)
- `--synonym <str>` (repeatable) → synonyms list
- `--topic <str>` (repeatable) → topic_vocab_extra (SKILL.md passes the registry's values)
- `--roots-json <path>` (optional test override)
- `--out <path>` (required) → write the candidate JSON

Output JSON:
```json
{
  "vertical": "aec",
  "generated_at": "2026-07-18T00:00:00Z",
  "terms": ["aec","architecture",...],
  "high": [ {candidate}, ... ],
  "ambiguous": [ {candidate}, ... ]
}
```
- `high` and `ambiguous` are the two surfaced tiers; dropped files are omitted entirely.
- Print the `--out` path to stdout; `sys.exit(0)`. Missing/inaccessible roots are skipped with a
  stderr note (not fatal — a missing root just yields no candidates). Truly fatal (bad
  `--roots-json`) → stderr message + `exit 1`, never a bare traceback.

## 7. Tests hook (detail in spec 05)

- Test suite drives `discover()` / `main()` with `--roots-json` pointing at
  `tests/fixtures/` synthetic trees; asserts ranking, tiering, category-by-root, version parse,
  and a second-vertical run with a different synonym list. A source-scan test asserts NO
  client-specific filename literal appears in `discover_internal.py`.

## 8. Out of scope

- No manifest writes (spec 01), no registry reads (spec 03), no NotebookLM, no network.
- No auto-confirm: the script's output is candidates only; confirmation is a human SKILL.md step.
