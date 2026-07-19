# OBF Master Plan — `industry-resource-map` skill (AEC-only MVP)

**Slug:** `industry-resource-map`
**Framework:** one-big-feature (OBF)
**Repo:** `/Users/joshweiss/code/cortextos`
**Research doc (source of truth):** `.agent/one-big-feature/industry-resource-map/01-research.md`
**Sibling skill mirrored:** `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/`

---

## 1. Objective

Build a NEW muse skill `industry-resource-map`, a sibling to `research-pulse`, that produces a
one-time-built, reusable **resource map per vertical** so every muse research/content session
stops re-discovering the same internal + external resources by hand (`find /` for the notebooklm
binary, grep-hunting for the Alloi audit / marketing-intelligence-v3, `notebooklm status` to learn
a notebook already exists).

The map for a vertical is a single manifest at
`orgs/clearworksai/agents/muse/state/resource-map/<vertical>.json` plus a human-readable
`<vertical>.md` twin. It:

- **references** the `research-pulse` registry for that vertical BY PATH + notebook_id (never
  copies or mutates it), and
- **adds** an `internal` block muse's own resources: client audits, positioning docs, ad-hoc
  research docs, distilled memory refs, notebooks, live-search patterns, and resolved tooling
  paths.

**MVP scope: AEC only.** Prove the pattern with one build. `aec` is the live/hot vertical.

**Josh hard requirement (drives the freshness design):** the skill must be AWARE of the
`research-pulse-delta` cron and be able to ASK it to refresh when the registry data is stale —
never assume the registry is current. The concrete mechanism is specified in §5 below and in
`03-specs/03-registry-reference-and-freshness.md`.

---

## 2. What already exists (do NOT rebuild — read/reference only)

- **`research-pulse` skill + library** (`.claude/skills/research-pulse/scripts/pulse_registry.py`,
  `discover.py`, `seed_notebook.py`, `backfill.py`). Owns curated recurring EXTERNAL sources.
  We import/copy NONE of it; we read its registry as data and mirror its coding conventions.
- **research-pulse registry** `orgs/clearworksai/agents/muse/state/research-pulse/registry/aec.json`
  (schema_version 1; `notebook_id`, `framework_doc`, `sources[]`, `deltas[]`, `updated_at`, and
  per-source `last_checked` / `last_delta`). READ-ONLY to this skill.
- **`research-pulse-delta` cron** — engine `delta_check.py` invoked as
  `python3 .claude/skills/research-pulse/scripts/delta_check.py [--vertical <slug>]`, prints a JSON
  run summary, refreshes `last_checked`/`last_delta`/`deltas` in the registry. Cron
  `research-pulse-delta` runs `15 6,18 * * *` (06:15 & 18:15 UTC). This skill DETECTS staleness and
  REQUESTS a refresh from this engine; it never re-implements polling.
- **NotebookLM AEC corpus** — notebook id `7f3b85b7-5adc-4869-ace9-7e056354f4eb`; binary at
  `/private/tmp/whisper-venv/bin/notebooklm` (also `/tmp/whisper-venv/bin/notebooklm`), NOT on
  PATH. Resolved by preflight, recorded in `tooling`.
- **Positioning corpus** — `marketing-intelligence-v3.md` (v3 current), Alloi AI Operations Audit,
  "integration failure not tool failure" thesis. Discovered by glob+score, human-confirmed.

---

## 3. File-by-file change list (exact target paths)

All new files live under the NEW skill dir, mirroring research-pulse. muse's `orgs/.../muse/` tree
is gitignored at the org level, but this skill is authored there because muse is the live runtime
owner and the sibling skill lives there; the build deliverable is the skill dir + its scripts +
tests. (Registry runtime state under `state/` is gitignored and rebuildable — never a PR artifact.)

| Path | Kind | Spec |
|---|---|---|
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/SKILL.md` | net-new — Step 0-7 runbook | 04 |
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/scripts/__init__.py` | net-new — 1-byte package marker (mirror research-pulse) | 04 |
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/scripts/resource_map.py` | net-new — manifest lib (schema, load/save, add-entry, md-twin writer) | 01 |
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/scripts/registry_ref.py` | net-new — read research-pulse registry by reference + freshness/staleness + delta-request builder | 03 |
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/scripts/discover_internal.py` | net-new — glob known roots + keyword-score + ambiguous→candidate CLI | 02 |
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/__init__.py` | net-new — 1-byte package marker | 05 |
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/test_resource_map.py` | net-new — manifest schema + md-twin + roundtrip | 05 |
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/test_registry_ref.py` | net-new — by-reference read + freshness/stale detection + delta-request | 05 |
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/test_discover_internal.py` | net-new — scoring + confirm-gating + no-hardcoded-paths | 05 |
| `orgs/clearworksai/agents/muse/.claude/skills/industry-resource-map/tests/fixtures/` (dir) | net-new — synthetic doc tree for discovery tests | 05 |

**No production TypeScript changes. No new cron.** (Freshness uses the EXISTING
`research-pulse-delta` engine.) No edits to any research-pulse file, no edits to
`research-pulse/registry/aec.json`, no new `package.json` deps.

---

## 4. Data model — `state/resource-map/aec.json`

`schema_version` starts at `1`. Full field-exact schema and validators are in
`03-specs/01-manifest-and-schema.md`; summary here:

```jsonc
{
  "schema_version": 1,
  "vertical": "aec",
  "display_name": "AEC",
  "generated_at": "2026-07-18T00:00:00Z",
  "updated_at":   "2026-07-18T00:00:00Z",

  "external": {                         // BY REFERENCE — never a copy of the registry contents
    "registry_path": "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/state/research-pulse/registry/aec.json",
    "notebook_id": "7f3b85b7",          // read from the registry at compose time
    "framework_doc": "/Users/.../research/aec-indicator-framework-2026-07-11.md",
    "source_count": 14,                 // snapshot count for the report, not a mirror of sources[]
    "registry_updated_at": "2026-07-18T13:15:24Z",
    "freshness": {                      // §5 — the stale-awareness contract
      "checked_at": "2026-07-18T00:00:00Z",
      "registry_updated_at": "2026-07-18T13:15:24Z",
      "most_recent_last_checked": "2026-07-18T13:15:24Z",
      "age_hours": 6.2,
      "stale_threshold_hours": 18,
      "is_stale": false,
      "delta_refresh_requested": false,
      "delta_refresh_command": "python3 .claude/skills/research-pulse/scripts/delta_check.py --vertical aec",
      "delta_cron_name": "research-pulse-delta"
    }
  },

  "internal": {
    "client_audits":    [ { "id","title","path","matched_terms":[],"score",  "confirmed":true } ],
    "positioning_docs": [ { "id","title","path","version","latest":true,"matched_terms":[],"score","confirmed":true } ],
    "research_docs":    [ { "id","title","path","matched_terms":[],"score","confirmed":true } ],
    "memory_refs":      [ { "id","title","path","matched_terms":[],"score","confirmed":true } ],
    "notebooks":        [ { "id","title","notebook_id","url","confirmed":true } ],
    "live_search":      [ { "query","returned_signal":true,"date":"2026-07-18","note" } ],
    "tooling":          { "notebooklm_bin":"/private/tmp/whisper-venv/bin/notebooklm", "notebooklm_status":"ok", "resolved_at":"..." }
  },

  "gaps": [ "no confirmed client_audits", "..." ]   // categories that ended up empty, for the report
}
```

Every `internal.*[]` entry that came from discovery carries `matched_terms[]`, `score`, and
`confirmed` (bool). **`confirmed` is only ever `true` in a written manifest** — discovery proposes,
a human confirms, and only confirmed entries are persisted (§6). `live_search` and `tooling` are
recorded directly (no ambiguity), `notebooks` may be seeded from the registry `notebook_id` +
human-added.

---

## 5. Stale-detection + delta-refresh mechanism (Josh hard requirement — concrete)

The skill NEVER assumes the registry is current. Mechanism (implemented in `registry_ref.py`,
spec 03; wired into SKILL.md Step 2):

1. **Read freshness metadata** from the research-pulse registry without mutating it:
   - registry-level `updated_at`
   - the MAX `last_checked` across all `sources[]` (the delta engine stamps `last_checked` on every
     source it polls, so this is the true "when did the pollers last run" signal — more reliable
     than `updated_at`, which also bumps on manual `save_registry`).
2. **Compute `age_hours`** = now − most-recent `last_checked` (fall back to `updated_at` if no
   source has `last_checked`). **Stale threshold = 18h** (the delta cron runs every 12h at
   `15 6,18 * * *`; 18h = 1.5 cycles, so a single missed cron does not trip it but a genuinely
   stalled poller does). Threshold is a module constant, override via `--stale-hours`.
3. **If stale** (`age_hours > stale_threshold_hours`): the skill does NOT silently proceed. It:
   - emits the exact refresh command
     `python3 .claude/skills/research-pulse/scripts/delta_check.py --vertical aec` and the cron
     name `research-pulse-delta` in the freshness block and in the report, AND
   - per SKILL.md Step 2, RUNS that command (delta engine is idempotent + safe — conditional GET,
     GUID dedup, per-source isolation; a re-run within minutes returns 304/0-delta), THEN re-reads
     freshness. If the binary/deps are unavailable it ANNOUNCES the stale state + command in the
     report and sets `delta_refresh_requested: true` — never fabricates freshness.
4. **`freshness.is_stale`, `.delta_refresh_requested`, `.delta_refresh_command`, `.delta_cron_name`**
   are all persisted in the manifest so a later reader knows exactly how current the external layer
   is and how to refresh it.

This is a READ + DETECT + REQUEST/RUN path against the existing engine. It writes NOTHING to the
research-pulse registry itself — `delta_check.py` owns those writes.

---

## 6. Internal discovery — glob + keyword-score, human-confirm gating

`discover_internal.py` (spec 02):

- **Known doc roots (module constants — directory roots ONLY, never per-client file paths):**
  - `~/code/knowledge-sync/raw/areas/clearworks/`           → client_audits, positioning, misc
  - `~/code/knowledge-sync/raw/areas/clearworks/research/`  → research_docs
  - `~/code/knowledge-sync/raw/areas/clearworks/growth/`    → positioning_docs (marketing-intelligence-vN)
  - `~/code/knowledge-sync/wiki/projects/`                  → client_audits (audit outputs)
  - `~/code/knowledge-sync/wiki/intelligence/`              → positioning_docs
  - `orgs/clearworksai/agents/muse/memory/`                 → memory_refs
  Roots are overridable via `--roots-json` for tests (fixtures). NO hardcoded `alloi.md` /
  `marketing-intelligence-v3.md` literals anywhere.
- **Scoring:** for each candidate `.md`/`.pdf` file, score = weighted count of vertical terms in
  filename (weight 3) + first-N-lines / frontmatter tags (weight 1). Term set = vertical slug +
  `display_name` tokens + `topic_vocab_extra` from the registry + a small built-in AEC synonym list
  passed IN (architecture, engineering, construction, aec, building, design, firm) — passed as a
  parameter, NOT hardcoded to AEC inside the scorer, so a second vertical needs no code change.
- **Category assignment** is by which root the file was found under (audit-root → client_audits,
  research-root → research_docs, growth/intelligence-root → positioning_docs, memory-root →
  memory_refs).
- **positioning version:** files matching `marketing-intelligence-v<N>` get `version: N`; the
  highest N across confirmed positioning docs is flagged `latest: true`.
- **Confidence tiers → gating:** `score >= HIGH_THRESHOLD` → **proposed, still requires human
  confirm**; `LOW_THRESHOLD <= score < HIGH_THRESHOLD` → **ambiguous, surfaced for explicit
  yes/no**; `score < LOW_THRESHOLD` → dropped, not shown. NOTHING is auto-included: every persisted
  entry is human-confirmed. `discover_internal.py` prints a candidate JSON (`--out`) that the human
  (via SKILL.md Step 3) curates into the confirmed set. The scorer never writes the manifest.

---

## 7. Skill flow (SKILL.md — mirrors research-pulse Step 0-7; spec 04)

- **Step 0 Preflight** — `source muse/.env`; resolve `NOTEBOOKLM_BIN` (env → `/private/tmp/...` →
  `/tmp/...`), run `notebooklm status`; degrade-and-report if unavailable; record resolved path +
  status into `tooling`.
- **Step 1 Define vertical** — fixed `aec` for MVP; confirm the research-pulse registry exists
  (`registry/aec.json`), else stop (this skill layers on an existing pulse).
- **Step 2 Pull external (BY REFERENCE + freshness)** — `registry_ref.py` reads the registry,
  extracts `notebook_id`/`framework_doc`/`source_count`, computes freshness (§5); if stale, run
  the delta command and re-check; record the freshness block. NEVER mutate the registry.
- **Step 3 Discover internal (glob+score) + curate (human confirm)** — run `discover_internal.py`,
  review candidates, confirm the yes/no set. Only confirmed entries proceed.
- **Step 4 Record live-search patterns** — add last30days queries that returned signal (with date);
  last30days itself stays a knox-subagent-only dispatch (existing muse CLAUDE.md rule) — this skill
  only REMEMBERS which queries worked, it does not run them.
- **Step 5 Notebooks** — record the registry notebook (`notebook_id` + notebooklm URL) and any
  human-added notebooks.
- **Step 6 Write manifest + .md twin** — `resource_map.py` validates + atomic-writes
  `state/resource-map/aec.json` and renders `state/resource-map/aec.md`.
- **Step 7 Report** — counts per internal category, external source_count + freshness/staleness +
  (if stale) the delta command, notebook link, resolved tooling paths, and `gaps[]`. No Telegram
  from the skill; the caller decides surfacing (mirror research-pulse Step 7).

---

## 8. Test plan (spec 05 — offline stdlib `unittest`, mirrors research-pulse tests)

All tests: `python3 -m unittest discover -s .../industry-resource-map/tests`; never touch network
or the real muse state dir (use `tempfile.TemporaryDirectory` + env overrides / `--roots-json`).

- **test_resource_map.py:** new-manifest schema valid; validator rejects bad schema_version,
  unknown category key, unconfirmed entry present in a persisted manifest, non-slug vertical;
  save/load roundtrip writes ONLY `<vertical>.json` (+ atomic, no temp leftovers); md-twin renders
  every category + freshness + gaps; positioning `latest:true` picks highest version.
- **test_registry_ref.py:** reads a fixture registry by reference (path + notebook_id) and does NOT
  write to it (mtime/content unchanged after the call); freshness fresh vs stale by `last_checked`
  age vs threshold; `updated_at` fallback when no source has `last_checked`; delta-request builder
  emits the exact `delta_check.py --vertical aec` command + cron name; stale triggers
  `is_stale:true` + `delta_refresh_command` populated.
- **test_discover_internal.py:** scoring ranks an on-topic filename above an off-topic one;
  HIGH/LOW/ambiguous tiering routed correctly; ambiguous surfaced (not auto-included) and absent
  from any auto-confirmed set; NO hardcoded client path — discovery over a synthetic
  `--roots-json` fixture tree finds files purely by score; category assigned by root; a second
  synthetic vertical works with the SAME code (term set is a parameter).

Plus cortextos `npm run build && npm test` stays green (zero TS changes).

---

## 9. Acceptance criteria

1. `state/resource-map/aec.json` is produced, validates against the spec-01 schema, and contains an
   `external` block that references (does not copy) `registry/aec.json` by path + notebook_id, and
   an `internal` block with the seven sub-keys.
2. Running the skill leaves `research-pulse/registry/aec.json` byte-identical (proven in
   test_registry_ref: content+mtime unchanged).
3. Freshness: with a stale fixture registry, the manifest's `freshness.is_stale` is `true` and
   `delta_refresh_command` = `python3 .claude/skills/research-pulse/scripts/delta_check.py --vertical aec`;
   with a fresh one, `is_stale` is `false`. SKILL.md Step 2 runs the delta command when stale.
4. Internal discovery surfaces ambiguous matches for yes/no and NEVER auto-includes them; no
   hardcoded per-client file paths exist anywhere in the scripts (grep-checkable).
5. `state/resource-map/aec.md` twin exists and is human-readable (categories, freshness, gaps).
6. All new unit tests pass; `npm run build && npm test` in cortextos stays green.

---

## 10. Out of scope (MVP)

- Any second vertical (nonprofit/ocg) — code must be vertical-agnostic but only `aec` is built/run.
- A new cron for the resource map (auto-refresh) — v1 is on-demand; the ONLY cron touched is the
  existing `research-pulse-delta`, which we invoke, not create.
- Auto client→vertical tagging automation; feeding the manifest into NotebookLM as sources;
  cross-vertical dedup; running last30days from this skill (stays knox-subagent dispatch).
- Any mutation of the research-pulse registry, its scripts, or its schema.

---

## 11. Gates

- Merge → Josh approval (PR only, never direct to main).
- No destructive/prod-data ops: the skill reads knowledge-sync docs read-only, reads the registry
  read-only, and writes ONLY under `state/resource-map/` (gitignored, rebuildable). The single
  side-effect on external state is invoking the already-safe `delta_check.py` engine when stale.
