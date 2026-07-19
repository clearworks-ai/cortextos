# 06 — Adversarial Review: industry-resource-map (AEC MVP)

**Reviewer:** architect (Opus) · **Date:** 2026-07-18 · **Stage:** pipeline REVIEW
**Verdict:** PASS-WITH-NITS

Code is applied to the working tree at
`orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/`. Reviewed against the
five specs, ran the tests, and empirically checked the two prior "blocker" claims.

---

## Empirical test result (run myself)

```
python3 -m unittest discover -s .../industry-resource-map/tests
Ran 29 tests in 0.015s — OK
```

29/29 pass. cortextos build unaffected — this skill adds ZERO TypeScript and no `package.json`
deps (git status shows only the python skill files under `muse/.claude/skills/`). CLI init path
also exercised live: `python3 -m scripts.resource_map --init --vertical aec --display-name AEC`
writes a valid manifest + `.md` twin and prints the JSON path.

---

## Prior "blocker" disposition (both FALSE POSITIVES)

1. **"`os.sys.stderr` crashes"** — FALSE POSITIVE. Ran
   `python3 -c "import os; print(os.sys.stderr)"` → prints
   `<_io.TextIOWrapper name='<stderr>' mode='w'>`. CPython's `os` re-exports `sys`, so
   `os.sys.stderr` resolves. `resource_map.py` uses it at lines 608/615 in the `__main__` CLI
   guard only; it works. Not a defect. (Minor style: a direct `import sys` would be cleaner and
   matches `registry_ref.py`/`discover_internal.py`, but it is not a bug — logged as a nit.)

2. **"Tests need a static `docs/` fixture tree"** — FALSE POSITIVE as a blocker. All test
   modules isolate state via `tempfile.TemporaryDirectory()` (13 call sites across
   test_resource_map/test_registry_ref, 1 in test_discover_internal) plus `PULSE_STATE_DIR` /
   `RESOURCE_MAP_STATE_DIR` env overrides. A synthetic `fixtures/docs/` tree + `roots.json` +
   `registry_stale.json` DO exist and are used by discovery tests via `--roots-json` — that is
   the spec-05-mandated synthetic doc tree (no real client data), not a missing dependency.
   Fresh registries are built at runtime with `utc_now_iso()` so they never age out (spec 05 §1).
   Tests are offline and hermetic. Not a defect.

---

## Spec-by-spec coverage

**Spec 01 — manifest + schema (`resource_map.py`):** COVERED. Constants, `state_dir()` env
override, `manifest_path`/`manifest_md_path`, `slugify` (copied, not imported — spec §1),
`utc_now_iso`, `atomic_write_json` + added `atomic_write_text` (spec §7). `new_manifest` shape
matches §2 exactly incl. `external.freshness: {}`. `validate_manifest` enforces all §4 checks:
schema_version, slug vertical, exactly-six-list-keys + tooling (`internal has unknown key`),
required discovery fields, **`confirmed must be True` → "unconfirmed entry may not be
persisted"** (the persist-gate, line 208-209), unique ids across all discovery lists, ≤1
positioning `latest`, notebook/live_search shape, `gaps` list-of-strings. `load`/`save` +
`write_manifest_md` regenerate in lockstep (§6). Mutators `add_internal_entry` (refuses
`confirmed != True`, line 489), `set_external`, `add_notebook`, `add_live_search`, `set_tooling`,
`compute_gaps` all present (§8). `__main__ --init` present (§9). No registry read / discovery
here (§10). NIT: `mark_latest_positioning_docs` auto-picks highest-version latest — correct and
tested, but note the spec framed latest-selection as manifest-compose-time; implementation folds
it into `add_internal_entry`. Acceptable (validator still guards ≤1 latest).

**Spec 02 — discovery (`discover_internal.py`):** COVERED. `KNOWN_ROOTS` are directory roots
only, category-by-root; `--roots-json` override; `CANDIDATE_EXTS`, skip dotfiles/`.trash`/
`_quarantine`/`__pycache__`. `build_terms` parameterized (synonyms passed in, not embedded —
proven by the second-vertical test). `score_file` filename(+3)/body(+1), PDF/binary degrades via
`errors="ignore"` + `OSError` guard (never crashes). `tier` HIGH=4/LOW=2/drop. `discover`
sorts `(category, -score, path)`, records generic `-v(\d+)` version, never emits `confirmed`.
`test_no_hardcoded_client_paths` passes → no client filename literals in source. Proposes only;
human confirms downstream (§8).

**Spec 03 — registry reference + freshness (`registry_ref.py`):** COVERED. `registry_path`
honors `PULSE_STATE_DIR`, read-only. `read_registry_ref` returns the snapshot (no `sources`
copy) and is proven byte+mtime-stable by `test_read_registry_ref_readonly`. `compute_freshness`
uses MAX `last_checked`, falls back to `updated_at`, `is_stale` on age>threshold OR no signal,
`age_hours: None` when no reference. `build_delta_command` returns the EXACT asserted string.
`request_delta_refresh` run=False announces (subprocess NOT called — mocked test), run=True
invokes `[sys.executable, script, "--vertical", v]` with `cwd=agent_home`, missing script →
`reason:"delta_script_missing"` (no raise). `refresh_if_stale` returns
`none`/`announced`/`refreshed` and recomputes post-refresh. Never writes the registry (§8).

**Spec 04 — SKILL.md + `scripts/__init__.py`:** COVERED with nits (below). Frontmatter, `Run
from:`, Steps 0-7 present; matches research-pulse tone; no Telegram from the skill. `__init__.py`
is 1 byte. NITS: Step 2 has no explicit `set_external()` / `external["freshness"]=` snippet (the
functions exist and are tested — the skill prose says "carry ... into the manifest" but gives no
copy-paste block, unlike Steps 3/4/6). Step 5 (Notebooks) is prose-only — no `add_notebook()`
snippet though the function exists and is tested. These reduce copy-paste fidelity vs
research-pulse; they are documentation gaps, not code defects.

**Spec 05 — tests + fixtures:** COVERED. All three test modules + `fixtures/docs/` synthetic
tree + `roots.json` + `registry_stale.json` present; fresh registries built at runtime; offline;
29 tests green. Covers schema/validate/unconfirmed-reject/id-collision/roundtrip/md-twin/
positioning-latest/gaps (resource_map), readonly/fresh/stale/updated_at-fallback/no-signal/
exact-command/announce/run/script-missing/refresh actions (registry_ref), and
ranking/tiering/ambiguous/category-by-root/version/no-hardcoded-literals/second-vertical
(discover).

---

## Genuine nits (non-blocking)

1. **`request_delta_refresh` run=True leaves `subprocess.TimeoutExpired` unwrapped**
   (`registry_ref.py:143-149`, `timeout=600`). A 10-min delta hang raises `TimeoutExpired` up
   through `refresh_if_stale` → CLI, producing a traceback rather than a structured
   `ran:False, reason:"timeout"`. The DEFAULT path is `run=False` (announce-only, safe), and
   SKILL.md Step 2 calls the module without forcing run, so the exposure is narrow — but a
   `try/except subprocess.TimeoutExpired` returning a reason dict would match the module's own
   "report, don't raise" contract used everywhere else. Recommend a follow-up one-liner.
2. **SKILL.md Step 2 lacks a `set_external()` snippet; Step 5 lacks an `add_notebook()`
   snippet** — both functions exist and are tested; add the copy-paste blocks for parity with
   Steps 3/4/6.
3. **Style: `os.sys.stderr` in `resource_map.py` CLI** — works, but `import sys` (as the sibling
   modules do) is cleaner. Cosmetic.

None of the nits block merge. Items 1 and 2 are worth a small follow-up commit.

---

## Verdict

**PASS-WITH-NITS** — 29/29 tests green, all five specs covered, both prior "blockers" are
false positives (proven empirically), core Josh requirement (stale-aware, by-reference,
delta-refresh-requesting, no-registry-mutation, human-confirm-gate) is implemented and tested.
