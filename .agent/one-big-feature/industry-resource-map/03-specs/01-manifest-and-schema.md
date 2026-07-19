# Spec 01 — Manifest library + schema (`resource_map.py`)

**Target file (net-new):**
`orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/scripts/resource_map.py`

Mirror `research-pulse/scripts/pulse_registry.py` line-for-line in style: `from __future__ import
annotations`, module-level constants, `state_dir()` reading an env override, `atomic_write_json`,
`validate_*` returning `list[str]`, `load_*`/`save_*`, `utc_now_iso()`. Strict typing, no `any`
equivalent (no bare `dict` where a shape is known-in-comment), no `print` except in a `__main__`
CLI. Pure-stdlib only (`json`, `os`, `re`, `tempfile`, `datetime`, `pathlib`, `argparse`).

---

## 1. Constants

```python
SCHEMA_VERSION = 1

DEFAULT_STATE_DIR = (
    "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/state/resource-map"
)

INTERNAL_LIST_KEYS = (
    "client_audits",
    "positioning_docs",
    "research_docs",
    "memory_refs",
    "notebooks",
    "live_search",
)
# "tooling" is an object, handled separately from the list keys above.
```

- `state_dir() -> Path` reads `RESOURCE_MAP_STATE_DIR` env (default `DEFAULT_STATE_DIR`), mirrors
  `pulse_registry.state_dir()` exactly (env override for tests).
- `manifest_path(vertical) -> Path` → `state_dir() / f"{vertical}.json"`.
- `manifest_md_path(vertical) -> Path` → `state_dir() / f"{vertical}.md"`.
- Reuse the slug regex from pulse_registry's convention: `_SLUG_RE = re.compile(r"[a-z0-9]+")`,
  `slugify(name)` identical semantics (raise `ValueError` on empty). Do NOT import pulse_registry —
  copy the tiny helper to keep the skills independent.
- `utc_now_iso() -> str` → `datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")`.
- `atomic_write_json(path, data)` — copy pulse_registry's implementation verbatim
  (NamedTemporaryFile in the same dir, `json.dump(indent=2)`, trailing newline, `fsync`,
  `os.replace`, temp cleanup in `finally`).

## 2. `new_manifest(vertical, display_name) -> dict`

- Raise `ValueError` if `vertical != slugify(vertical)`.
- Returns:

```python
{
    "schema_version": SCHEMA_VERSION,
    "vertical": vertical,
    "display_name": display_name,
    "generated_at": now,
    "updated_at": now,
    "external": {
        "registry_path": None,
        "notebook_id": None,
        "framework_doc": None,
        "source_count": 0,
        "registry_updated_at": None,
        "freshness": {},          # populated by registry_ref (spec 03); {} = not-yet-checked
    },
    "internal": {
        "client_audits": [],
        "positioning_docs": [],
        "research_docs": [],
        "memory_refs": [],
        "notebooks": [],
        "live_search": [],
        "tooling": {},
    },
    "gaps": [],
}
```

## 3. Entry shapes (documented; validated in §4)

- **Discovery-sourced list entry** (`client_audits`, `positioning_docs`, `research_docs`,
  `memory_refs`): `{ "id": str, "title": str, "path": str, "matched_terms": list[str],
  "score": int|float, "confirmed": bool }`. `positioning_docs` entries additionally allow
  `"version": int|None` and `"latest": bool`.
- **`notebooks`** entry: `{ "id": str, "title": str, "notebook_id": str, "url": str,
  "confirmed": bool }`.
- **`live_search`** entry: `{ "query": str, "returned_signal": bool, "date": "YYYY-MM-DD",
  "note": str }` (no `confirmed` — recorded directly, not discovered).
- **`tooling`** object: free-form string→(str|bool|None) map; MUST include key `notebooklm_bin`
  (path or `None`) when preflight ran.

`id` for discovery entries: `f"{category_prefix}_{slugify(title-or-filename-stem)}"` with a
numeric `-2`, `-3` suffix on collision (mirror `pulse_registry.add_source`'s collision loop).
Prefixes: `aud_`, `pos_`, `res_`, `mem_`, `nb_`.

## 4. `validate_manifest(manifest) -> list[str]`

Return a list of human-readable error strings (empty = valid), mirroring
`pulse_registry.validate_registry`'s style. Checks:

1. `manifest` is a dict; `schema_version == SCHEMA_VERSION`; `vertical` non-empty and
   `== slugify(vertical)`; `display_name` non-empty string.
2. `external` is a dict; `registry_path` is `None` or a non-empty string; `freshness` is a dict.
3. `internal` is a dict containing EXACTLY the six list keys + `tooling`; any unknown key under
   `internal` → error `"internal has unknown key: <k>"`; each list key maps to a list; `tooling`
   maps to a dict.
4. For every entry in the four discovery list keys:
   - required keys present (`id`, `title`, `path`, `matched_terms`, `score`, `confirmed`);
     `matched_terms` is a list; `score` is an int/float; `confirmed` is a bool.
   - **`confirmed` MUST be `True`** — a persisted manifest may only contain confirmed entries.
     `confirmed: False` in a to-be-saved manifest → error
     `"<key>[<i>] unconfirmed entry may not be persisted"`. (This is the enforcement point for the
     "human confirms, nothing auto-included" rule — the writer physically cannot persist an
     unconfirmed discovery entry.)
   - `id` unique across ALL discovery lists combined; duplicate → error.
   - `path` non-empty string.
5. `positioning_docs`: at most ONE entry with `latest: True`; `version` (when present) is an int.
6. `notebooks`: each has `notebook_id` (non-empty), `url` (non-empty), `confirmed: True`.
7. `live_search`: each has `query` (non-empty), `returned_signal` (bool), `date` matching
   `^\d{4}-\d{2}-\d{2}$`.
8. `gaps` is a list of strings.

## 5. `load_manifest(vertical) -> dict`

- Path from `manifest_path`; `FileNotFoundError` if absent.
- `json.load`, then `validate_manifest`; raise `ValueError(f"manifest invalid: {'; '.join(errors)}")`
  on errors (mirror `load_registry`).

## 6. `save_manifest(manifest) -> Path`

- `validate_manifest` first; raise on errors (nothing is written if invalid — the unconfirmed-entry
  check in §4.4 fires here).
- Stamp `manifest["updated_at"] = utc_now_iso()`.
- `atomic_write_json(manifest_path(manifest["vertical"]), manifest)`.
- Then call `write_manifest_md(manifest)` (§7) so the `.md` twin is always regenerated in lockstep.
- Return the JSON path.

## 7. `write_manifest_md(manifest) -> Path`

Render a human-readable Markdown twin to `manifest_md_path(vertical)` via `atomic_write_json`'s
sibling `atomic_write_text(path, text)` (add a text variant — same tempfile+replace pattern).
Sections (skip a section's rows but KEEP its heading when empty, appending `_none_`):

```
# {display_name} Resource Map

Generated {generated_at} · updated {updated_at} · schema v{schema_version}

## External (research-pulse — by reference)
- Registry: `{registry_path}`
- Notebook: `{notebook_id}` — https://notebooklm.google.com/notebook/{notebook_id}
- Framework doc: `{framework_doc}`
- Sources (registry): {source_count}
- Freshness: {is_stale ? "STALE" : "fresh"} — age {age_hours}h (threshold {stale_threshold_hours}h)
  - Refresh: `{delta_refresh_command}`  (cron `{delta_cron_name}`)   [only when is_stale]

## Client Audits
- **{title}** — `{path}`  (score {score}, terms: {matched_terms})

## Positioning Docs
- **{title}** {latest ? "· LATEST" : ""} {version!=None ? "(v{version})" : ""} — `{path}`

## Research Docs
- ...

## Memory Refs
- ...

## Notebooks
- **{title}** — `{notebook_id}` {url}

## Live Search Patterns
- `{query}` — {returned_signal ? "signal" : "no signal"} ({date}) {note}

## Tooling
- notebooklm_bin: `{...}` (status {...})

## Gaps
- {gap}
```

Underscore-heavy paths are wrapped in backticks (they are already, above) — no raw `_` in prose
(Telegram markdown safety, per fleet rule; the caller may forward this file).

## 8. Small mutators (keep the CLI/SKILL glue thin)

- `add_internal_entry(manifest, category, entry) -> dict` — validates `category` in the four
  discovery keys, assigns/uniquifies `id` if absent, appends, returns the entry. Refuses
  `confirmed` other than `True` (raise `ValueError`) so the confirm-gate holds at the API layer too.
- `set_external(manifest, *, registry_path, notebook_id, framework_doc, source_count,
  registry_updated_at)` — populate the `external` block (freshness set separately by spec 03).
- `add_notebook`, `add_live_search`, `set_tooling` — thin appenders/setters.
- `compute_gaps(manifest) -> list[str]` — for each empty discovery/notebook/live_search category,
  append `f"no confirmed {category}"`; also `"external freshness not checked"` when
  `external.freshness` is `{}`; store on `manifest["gaps"]`.

## 9. `__main__` CLI (optional glue used by SKILL.md)

`argparse` sub-behaviors are minimal — SKILL.md drives most steps via inline `python3 - <<PY`
snippets (mirror research-pulse). Provide at minimum:
`python3 -m scripts.resource_map --init --vertical aec --display-name AEC` → writes an empty valid
manifest + twin and prints the JSON path. `sys.exit(0/1)`; errors to stderr, never a bare traceback.

## 10. Out of scope

- No registry reading here (that is spec 03's `registry_ref.py`).
- No discovery/scoring here (spec 02's `discover_internal.py`).
- No network, no NotebookLM calls, no Telegram/bus.
