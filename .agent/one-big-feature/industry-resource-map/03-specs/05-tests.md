# Spec 05 — Tests + fixtures

**Target files (net-new):**
- `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/__init__.py` (1 byte)
- `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/test_resource_map.py`
- `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/test_registry_ref.py`
- `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/test_discover_internal.py`
- `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/fixtures/` (synthetic docs + fixture registries)

Convention: **exactly** mirror `research-pulse/tests/test_registry.py` — `from __future__ import
annotations`; stdlib `unittest` + `unittest.mock`; the `ROOT = Path(__file__).resolve().parent.parent`
+ `sys.path.insert(0, str(ROOT))` header so `from scripts import <mod>` resolves; `tempfile.
TemporaryDirectory` + `unittest.mock.patch.dict(os.environ, {...})` for state-dir isolation.
**Offline only** — never touch the network, the real muse state dir, or real client docs. Runner:
`python3 -m unittest discover -s .../industry-resource-map/tests`.

---

## 1. `tests/fixtures/` (net-new)

- **`docs/` synthetic doc tree** (for discovery — NO real client data):
  - `docs/audits/alloi-ai-operations-audit.md` — frontmatter `tags: [aec, audit]`, body mentions
    architecture/engineering. (Used to prove a high-score audit; the FILENAME is a fixture, not a
    code literal.)
  - `docs/audits/nonprofit-donor-audit.md` — off-topic for aec (low/zero score).
  - `docs/growth/marketing-intelligence-v2.md` and `docs/growth/marketing-intelligence-v3.md` —
    prove `-v<N>` version parse + latest selection over the CONFIRMED set.
  - `docs/research/aec-indicator-framework.md` — on-topic research doc.
  - `docs/research/ai-trends-generic.md` — ambiguous/low.
  - `docs/memory/2026-07-16-aec-firm-notes.md` — memory ref, on-topic.
  - A `roots.json` describing these dirs with their categories, passed via `--roots-json`.
- **`registry_fresh.json`** — minimal valid research-pulse-shape registry for `aec` with at least
  one source whose `last_checked` is "recent" (set at test runtime via `utc_now_iso()` so it never
  ages out) and `updated_at` recent.
- **`registry_stale.json`** — same shape, all `last_checked` old (e.g. 2026-01-01) OR null, to
  drive `is_stale: True`.
- Build fresh/stale registries programmatically in `setUp` where a runtime-relative timestamp is
  needed (a hardcoded "recent" date rots); static fixtures only for the clearly-old stale case.

## 2. `test_resource_map.py`

1. `test_new_manifest_schema_valid` — `new_manifest("aec","AEC")` → `validate_manifest == []`; the
   six internal list keys + `tooling` present and empty; `created`/`generated`/`updated` set.
2. `test_validate_rejects_bad_schema_version` / `_non_slug_vertical` / `_unknown_internal_key`.
3. `test_validate_rejects_unconfirmed_entry` — add a discovery entry with `confirmed: False`
   directly into `internal.client_audits`; `validate_manifest` returns the
   `"unconfirmed entry may not be persisted"` error, and `save_manifest` RAISES (nothing written).
4. `test_add_internal_entry_refuses_unconfirmed` — `add_internal_entry(..., {"confirmed": False})`
   raises `ValueError`.
5. `test_add_internal_entry_id_collision_suffix` — two entries same title → `-2` suffix; ids unique.
6. `test_save_load_roundtrip` — under a temp `RESOURCE_MAP_STATE_DIR`: save then load equal; the
   dir contains ONLY `aec.json` + `aec.md` (no temp leftovers).
7. `test_md_twin_rendered` — after save, `aec.md` exists and contains each category heading, the
   notebook URL, the freshness line, and a `## Gaps` section; empty categories render `_none_`.
8. `test_positioning_latest_highest_version` — two confirmed positioning docs (v2, v3); compose
   sets `latest: True` on v3 only; validator accepts (≤1 latest); a second `latest:true` → error.
9. `test_compute_gaps` — empty categories produce `"no confirmed <category>"`; unset freshness
   produces `"external freshness not checked"`.

## 3. `test_registry_ref.py`

1. `test_read_registry_ref_readonly` — snapshot the fixture registry's bytes + mtime, call
   `read_registry_ref("aec")`, assert bytes + mtime unchanged AND the returned dict has
   `registry_path`, `notebook_id`, `framework_doc`, `source_count`, `registry_updated_at` (never
   the full `sources`).
2. `test_freshness_fresh` — fresh registry (recent `last_checked`) → `is_stale: False`,
   `age_hours` small.
3. `test_freshness_stale_by_last_checked` — stale registry → `is_stale: True`.
4. `test_freshness_updated_at_fallback` — registry whose sources all have `last_checked: null` but
   a recent `updated_at` → uses `updated_at`; old `updated_at` too → `is_stale: True`.
5. `test_freshness_no_signal_is_stale` — no `last_checked` and no `updated_at` → `is_stale: True`,
   `age_hours: None`.
6. `test_build_delta_command_exact` — `build_delta_command("aec") ==
   "python3 .claude/skills/research-pulse/scripts/delta_check.py --vertical aec"`; freshness block's
   `delta_refresh_command` equals it and `delta_cron_name == "research-pulse-delta"`.
7. `test_request_delta_refresh_announce_only` — `run=False` → `mock` `subprocess.run` NOT called;
   returns `requested:True, ran:False`.
8. `test_request_delta_refresh_runs` — `run=True` with a mocked `subprocess.run` (returncode 0,
   stdout a JSON summary) and a fake `agent_home` whose `DELTA_SCRIPT_REL` file exists (create it
   in the temp tree) → asserts the invoked argv is `[sys.executable, <script>, "--vertical",
   "aec"]` with `cwd == agent_home`, and the parsed `summary` is returned.
9. `test_request_delta_refresh_script_missing` — `run=True` but script absent → `ran:False`,
   `reason:"delta_script_missing"`, no raise.
10. `test_refresh_if_stale_announced_when_run_false` and `_refreshed_when_run_true` — the
    `action` field is `"none"` (fresh), `"announced"` (stale + announce-only), or `"refreshed"`
    (stale + successful run, freshness recomputed).

Use `PULSE_STATE_DIR` env override to point `registry_ref` at the fixture registry dir.

## 4. `test_discover_internal.py`

1. `test_scoring_ranks_on_topic_above_off_topic` — over the fixture `--roots-json` tree, the
   aec audit outscores the nonprofit audit; matched_terms captured.
2. `test_tiering_high_ambiguous_drop` — assert files land in the right tier by threshold
   (`HIGH_THRESHOLD`/`LOW_THRESHOLD`); a `drop` file is absent from BOTH `high` and `ambiguous`.
3. `test_ambiguous_not_auto_included` — an ambiguous-tier file appears ONLY under `ambiguous`
   (surfaced for yes/no), never in `high`, and the output carries no `confirmed` field anywhere.
4. `test_category_by_root` — a file under the audits root → `category: client_audits`; growth root
   → `positioning_docs`; research root → `research_docs`; memory root → `memory_refs`.
5. `test_version_parse` — `marketing-intelligence-v3.md` → `version: 3`; a non-versioned doc →
   `version: None`. (Regex is generic `-v(\d+)`, not a filename literal.)
6. `test_no_hardcoded_client_paths` — read `discover_internal.py` source text and assert it does
   NOT contain client-specific filename literals (`alloi`, `marcos`, `msia`, `ocg`,
   `marketing-intelligence-v3`) — only directory roots + generic regexes. This is the machine-check
   of the "no hardcoded per-client paths" rule.
7. `test_second_vertical_same_code` — run `discover(build_terms("nonprofit","Nonprofit",[],
   ["donor","grant","fundraising","501c3"]), ...)` over the fixture tree and assert the nonprofit
   audit now scores highest — proving the term set is a parameter and the scorer is vertical-
   agnostic (no code change for a new vertical).

## 5. Green-build requirement

- `python3 -m unittest discover -s orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests`
  passes.
- cortextos `npm run build && npm test` stays green — this build adds ZERO TypeScript and no
  `package.json` deps (pure-python skill, mirroring research-pulse which added none either).

## 6. Out of scope

- No integration test that hits the real network, real registry, or real notebooklm.
- No test that runs the actual `delta_check.py` engine end-to-end (spec 03 tests MOCK
  `subprocess.run`); the delta engine has its own suite under research-pulse.
