# Spec 04 — Skill flow + SKILL.md

**Target files (net-new):**
- `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/SKILL.md`
- `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/scripts/__init__.py` (1 byte)

SKILL.md mirrors `research-pulse/SKILL.md` structure and tone exactly: YAML frontmatter
(`name` + `description` with trigger phrases), a `Run from:` fenced block, then `## Step 0` …
`## Step 7`, each with copy-paste bash / inline `python3 - <<PY` snippets. No Telegram from the
skill (the caller surfaces results).

---

## Frontmatter

```yaml
---
name: industry-resource-map
description: Build and maintain a reusable "resource map" for an industry vertical — a single manifest that references the research-pulse external registry (by path + notebook) and layers muse's internal resources on top (client audits, positioning docs, research docs, memory refs, notebooks, live-search patterns, resolved tooling paths) so research/content sessions stop re-discovering the same assets. Detects a stale registry and requests a research-pulse-delta refresh before composing. Triggers on "build the resource map for <industry>", "map my resources for <vertical>", "resource map aec".
---
```

## `Run from:`

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map
```

## Step 0 — Preflight (resolve tooling)

- `set -a; source /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/.env; set +a`
- Resolve the notebooklm binary (env → `/private/tmp/whisper-venv/bin/notebooklm` →
  `/tmp/whisper-venv/bin/notebooklm`):
  ```bash
  NOTEBOOKLM_BIN=${NOTEBOOKLM_BIN:-/private/tmp/whisper-venv/bin/notebooklm}
  [ -x "$NOTEBOOKLM_BIN" ] || NOTEBOOKLM_BIN=/tmp/whisper-venv/bin/notebooklm
  "$NOTEBOOKLM_BIN" status || echo "notebooklm unavailable — proceed degraded, record status in tooling"
  ```
- The resolved path + status will be written into `internal.tooling` at Step 6. This is the
  permanent fix for the recurring `find /` — the binary path is recorded once in the manifest.

## Step 1 — Define vertical (MVP: aec)

- `SLUG=aec`. Confirm the pulse this map layers on exists:
  ```bash
  test -f /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/state/research-pulse/registry/$SLUG.json \
    || { echo "no research-pulse registry for $SLUG — run the research-pulse skill first"; exit 1; }
  ```
- If `state/resource-map/$SLUG.json` already exists, switch to maintenance mode: load it and
  re-run Steps 2-6 to refresh (mirror research-pulse's "maintenance mode" note), preserving
  previously-confirmed internal entries the human still approves.

## Step 2 — Pull external (BY REFERENCE) + freshness + delta refresh

Run the freshness/refresh path (spec 03). This is the Josh stale-awareness requirement:

```bash
python3 -m scripts.registry_ref --vertical "$SLUG" --json
```

- If the output's `freshness.is_stale` is `true`, the module has ALREADY attempted the refresh
  (`refresh_if_stale(run=True)` runs `python3 .claude/skills/research-pulse/scripts/delta_check.py
  --vertical aec`). Read `action`:
  - `"refreshed"` → the delta cron engine ran and freshness was recomputed; proceed with the fresh
    numbers.
  - `"announced"` → refresh could not run (binary/deps missing or script absent); the report will
    carry `delta_refresh_command` + cron name `research-pulse-delta` so the human/next cron can
    refresh. Proceed but flag the map as built over a stale registry.
- Never edit `research-pulse/registry/aec.json` here — the delta engine owns those writes.
- Carry `registry_path`, `notebook_id`, `framework_doc`, `source_count`, `registry_updated_at`, and
  the whole `freshness` block into the manifest via `resource_map.set_external` + assigning
  `manifest["external"]["freshness"]`.

## Step 3 — Discover internal (glob+score) + curate (human confirm)

```bash
python3 -m scripts.discover_internal --vertical "$SLUG" --display-name "AEC" \
  --synonym architecture --synonym engineering --synonym construction --synonym aec \
  --synonym building --synonym design --synonym firm --synonym contractor --synonym infrastructure \
  --topic project_delivery --topic construction_spending --topic infrastructure \
  --out "/tmp/resource-map-candidates-$SLUG.json"
```

- Review `high` and `ambiguous` in the candidate file. **CURATE — human confirms:** for each
  candidate you approve, add it to the manifest with `confirmed: true`; DROP the rest. Ambiguous
  matches are an explicit yes/no — never bulk-accept the `ambiguous` tier blindly. `--topic` values
  come from the registry's `topic_vocab_extra`.
- Add confirmed entries with an inline snippet (mirror research-pulse's curate step):
  ```bash
  python3 - <<'PY'
  from scripts import resource_map
  m = resource_map.load_manifest("aec") if resource_map.manifest_path("aec").exists() \
      else resource_map.new_manifest("aec", "AEC")
  # for each human-approved candidate:
  resource_map.add_internal_entry(m, "client_audits", {
      "title": "...", "path": "...", "matched_terms": [...], "score": 0, "confirmed": True,
  })
  resource_map.save_manifest(m)
  PY
  ```
  `add_internal_entry` refuses `confirmed != True` — the gate holds even here.

## Step 4 — Record live-search patterns

- last30days stays a knox-subagent-only dispatch (muse CLAUDE.md hard rule) — DO NOT run it here.
- Record which last30days queries have returned real signal (with date) so future sessions reuse
  them: `resource_map.add_live_search(m, query="...", returned_signal=True, date="2026-07-18",
  note="...")`.

## Step 5 — Notebooks

- Record the research-pulse notebook from the registry `notebook_id` (Step 2) plus its URL
  `https://notebooklm.google.com/notebook/<notebook_id>`, and any human-added notebooks:
  `resource_map.add_notebook(m, title="Research Pulse: AEC", notebook_id="<id>", url="...",
  confirmed=True)`.

## Step 6 — Write manifest + `.md` twin

```bash
python3 - <<'PY'
from scripts import resource_map
m = resource_map.load_manifest("aec")
resource_map.set_tooling(m, {"notebooklm_bin": "<resolved path>", "notebooklm_status": "ok",
                             "resolved_at": resource_map.utc_now_iso()})
resource_map.compute_gaps(m)
print(resource_map.save_manifest(m))   # writes aec.json AND regenerates aec.md
PY
```

- `save_manifest` validates (unconfirmed entries cannot be persisted) and regenerates the `.md`
  twin in lockstep.

## Step 7 — Report

Final report must include:
- vertical slug + display name; manifest path + `.md` twin path.
- internal counts per category (client_audits, positioning_docs, research_docs, memory_refs,
  notebooks, live_search).
- external: registry path, `source_count`, notebook link, framework doc, AND freshness —
  `is_stale`, `age_hours`, and (if stale) the `delta_refresh_command` +
  cron `research-pulse-delta`.
- resolved tooling paths (notebooklm binary + status).
- `gaps[]` — categories that ended up empty.

Do not send Telegram from this skill. The caller decides how to surface the result. (Mirror
research-pulse Step 7 verbatim in intent.)

## `scripts/__init__.py`

One byte (newline), identical to research-pulse's `scripts/__init__.py`, so `python3 -m
scripts.<mod>` and `from scripts import <mod>` both resolve from the skill dir.

## Out of scope

- No new cron, no Telegram/bus, no NotebookLM seeding (that stays in research-pulse), no second
  vertical run.
