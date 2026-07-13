# Master Plan — Industry Research Pulse (generalized vertical research system)

**Recovered from:** subagent transcript `e799bac3-e067-4914-abc0-c1b8907fe50e` (lines 51–67)  
**Timestamp:** 2026-07-13  
**Status:** SCOPE_LOCK (P2 ready for dispatch)

---

- **Slug:** `industry-research-pulse`
- **Bus task:** `task_1783899093796_83136743` (Josh via muse)
- **Framework:** one-big-feature (OBF)
- **Plan stage:** Fable 5 (Josh-selected), 2026-07-12
- **Owner agent (runtime):** muse (did the 3 manual verticals; cron + skill run under muse)
- **Repos touched:** `cortextos` (skill + cron config), `briefs` (dashboard widget — separate PR), `knowledge-sync` (framework docs — Larry-writable, no PR gate)

## Goal (verbatim scope)

A GENERALIZED, repeatable system to stand up "research pulse" coverage for ANY industry vertical. Currently AEC / loan-syndication / nonprofit were done MANUALLY by the muse agent; this generalizes that into a **skill + registry + cron + surface**. Flow per vertical:

> define industry+framing → discover sources (podcasts + YouTube channels + indicator/data sites) → document sources with a tag taxonomy → seed a NotebookLM notebook → generate an indicator-framework doc → periodic cron checks for new episodes/content and reports DELTAS → surface via briefs.clearworks.ai.

## Non-goals (explicit)

- NOT auto-adding every new episode as a NotebookLM source from the cron (50-source/notebook cap makes that self-destructive; deltas are *reported*, notebook stays show/channel-level). New-episode → notebook additions are a curated manual/skill action.
- NOT polling FRED/BLS time-series in the delta cron (data sites are documented in the framework doc with release cadence; series polling is a future phase).
- NOT a TS daemon/bus subsystem. Python scripts + JSON state + one cron entry + one Python dashboard collector. Zero new `package.json` deps, zero TS changes in cortextos.

## Architecture

```
                    ┌─────────────────────────────────────────────────────┐
                    │  research-pulse SKILL (muse)                        │
                    │  orgs/clearworksai/agents/muse/.claude/skills/      │
                    │  research-pulse/                                    │
                    │                                                     │
   "add industry X" │  SKILL.md  (add-industry orchestration, agent-run)  │
  ─────────────────▶│    │                                                │
                    │    ├─ scripts/discover.py     (Podcast Index +      │
                    │    │      YouTube channels + curated indicator      │
                    │    │      site catalog → candidates JSON)           │
                    │    ├─ scripts/pulse_registry.py (shared lib:        │
                    │    │      schema, facet vocab, atomic I/O)          │
                    │    ├─ scripts/seed_notebook.py (notebooklm CLI      │
                    │    │      loop: add + wait, dedupe, cap-aware)      │
                    │    ├─ scripts/delta_check.py   (cron engine:        │
                    │    │      conditional GET + GUID dedup)             │
                    │    └─ scripts/backfill.py      (registry from       │
                    │           existing notebook via source list)        │
                    └───────────────┬─────────────────────────────────────┘
                                    │ reads/writes (atomic tmp+rename)
                                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │  REGISTRY (spine) — muse runtime state, gitignored       │
        │  orgs/clearworksai/agents/muse/state/research-pulse/     │
        │    registry/<vertical>.json   (sources + tags + poll     │
        │                                state: etag/guid/checked) │
        │    pulse/<vertical>.json      (render-ready snapshot)    │
        └───────┬──────────────────────────────────┬───────────────┘
                │                                  │ read-only
   cron 2×/day  │                                  ▼
  ┌─────────────┴───────────┐        ┌──────────────────────────────┐
  │ muse cron               │        │ briefs dashboard (P3)        │
  │ research-pulse-delta    │        │ ~/code/briefs/publisher/     │
  │ (muse/config.json)      │        │ build_dashboard.py           │
  │ runs delta_check.py     │        │ collect_pulse_tab() →        │
  │ SILENT-OK if no deltas  │        │ "Industry Pulse" panel in    │
  └─────────────────────────┘        │ Library tab                  │
                                     │ → briefs.clearworks.ai       │
                                     └──────────────────────────────┘
   External:                          Docs:
   - api.podcastindex.org (free key)  - indicator-framework doc per vertical →
   - YouTube Data API v3 (optional;     ~/code/knowledge-sync/raw/areas/clearworks/
     yt-dlp fallback via yt-search)     research/<vertical>-indicator-framework-<date>.md
   - RSS feeds (conditional GET)        (replicates AEC template structure)
   - /tmp/whisper-venv/bin/notebooklm - NotebookLM notebooks (1 per vertical)
```

## Registry schema (canonical — `schema_version: 1`)

One JSON file per vertical at `orgs/clearworksai/agents/muse/state/research-pulse/registry/<vertical>.json`:

```jsonc
{
  "schema_version": 1,
  "vertical": "aec",                          // slug, [a-z0-9-]+
  "display_name": "AEC — Architecture, Engineering & Construction",
  "framing": "1-3 sentence industry framing written at define time",
  "notebook_id": "7f3b85b7-5adc-4869-ace9-7e056354f4eb",   // NotebookLM UUID or null
  "framework_doc": "/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/research/aec-indicator-framework-2026-07-11.md",
  "topic_vocab_extra": [],                    // per-vertical additions to the topic facet vocabulary
  "created_at": "2026-07-13T00:00:00Z",
  "updated_at": "2026-07-13T00:00:00Z",
  "sources": [
    {
      "id": "src_trxl-podcast",               // "src_" + slugify(source_name), unique per vertical
      "source_name": "TRXL Podcast",
      "url": "https://trxl.co",               // canonical human page. Opaque non-empty string —
                                              // backfill (spec 08) may temporarily use
                                              // "notebooklm://<source_id>" placeholders
      "feed_url": "https://feeds.../trxl.rss",// poll target (RSS); null for non-pollable (data sites)
      "source_type": "podcast",               // podcast|youtube|article|data_feed|report
      "industry": ["aec"],                    // multi-tag allowed
      "tags": {                               // 7-facet taxonomy, controlled vocabulary
        "topic": ["innovation", "operations"],       // multi
        "signal": ["sentiment", "leading"],          // multi
        "authority": "industry_expert",              // single
        "cadence": "weekly",                         // single
        "quality": "high"                            // single
      },
      "notebooklm_source_id": "abc123...",    // null until seeded
      "etag": null,                           // conditional-GET state
      "last_modified": null,
      "last_seen_guid": null,                 // immutable episode/video GUID
      "last_seen_pubdate": null,              // ISO 8601, robustness fallback
      "last_checked": null,                   // ISO 8601
      "last_delta": null,                     // ISO of last time NEW items were found
      "consecutive_errors": 0,
      "active": true
    }
  ],
  "deltas": [                                 // ring buffer, newest first, max 200
    {
      "detected_at": "2026-07-13T06:15:00Z",
      "source_id": "src_trxl-podcast",
      "guid": "ep-uuid-12345",
      "title": "Episode 215: ...",
      "url": "https://...",
      "pubdate": "2026-07-12T12:30:00Z"
    }
  ]
}
```

**Facet vocabulary** (7-facet taxonomy = `source_type` + `industry` + the 5 `tags` facets; enforced by `pulse_registry.validate_registry`):
- `source_type`: podcast | youtube | article | data_feed | report
- `topic`: indicators | strategy | operations | regulation | innovation
- `signal`: leading | coincident | lagging | sentiment | macro | micro
- `authority`: academic | industry_expert | practitioner | news | vendor
- `cadence`: daily | weekly | monthly | quarterly | ad_hoc
- `quality`: high | medium | emerging | archival

Custom `topic` values beyond the base vocabulary are allowed per vertical (AEC needs km/ai-adoption etc.) via the `topic_vocab_extra: []` top-level field; all other facets are closed vocabularies.

**Pulse snapshot** (`pulse/<vertical>.json`, written by `write_pulse_snapshot()` — the render contract for briefs):

```jsonc
{
  "schema_version": 1,
  "vertical": "aec",
  "display_name": "AEC — Architecture, Engineering & Construction",
  "generated_at": "2026-07-13T06:15:20Z",
  "source_count": 39,
  "active_source_count": 37,
  "notebook_id": "7f3b85b7-...",
  "framework_doc": "/Users/.../aec-indicator-framework-2026-07-11.md",
  "latest_items": [                            // newest 5 deltas
    {"title": "...", "url": "...", "source_name": "TRXL Podcast", "pubdate": "..."}
  ],
  "trending_topics": [                         // topic-facet counts over deltas in last 7d
    {"topic": "innovation", "count": 4}
  ],
  "errors": 0                                  // sources currently in error state
}
```

---

## PHASES (each independently shippable + testable)

### P1 — Registry + add-industry skill, proven end-to-end on ONE vertical

**Specs:** `01`, `02`, `03`, `04` (plus `backfill.py` code from spec `08`, which ships in this PR but executes in P4)  
**PR target:** `cortextos`

**Scope:**
- Build `pulse_registry.py` (schema, validation, atomic I/O), `discover.py`, `seed_notebook.py`, and the `research-pulse` SKILL.md orchestration.
- **Validation vertical: nonprofit** — notebook `e9b95342-0b2e-4564-8ada-5bb4cede530b` already exists with 0 sources; the skill run must take it from nothing → populated registry → seeded notebook → indicator-framework doc.

**Acceptance criteria:**
- `registry/nonprofit.json` validates
- ≥10 tagged sources in registry
- ≥8 seeded NotebookLM sources with stored `notebooklm_source_id`
- framework doc exists in knowledge-sync replicating the AEC template structure
- all unit tests pass offline

**File deliverables:**
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/SKILL.md`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/templates/indicator-framework-template.md`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/scripts/pulse_registry.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/scripts/__init__.py` (empty)
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/scripts/discover.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/scripts/seed_notebook.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/scripts/backfill.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/__init__.py` (empty)
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/test_registry.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/test_discover.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/test_seed_notebook.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/test_backfill.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/fixtures/*.xml,*.json`

---

### P2 — Delta-detection cron

**Specs:** `05`, `06`  
**PR target:** `cortextos` (same or follow-up)

**Scope:**
- `delta_check.py` (feedparser conditional GET, ETag/Last-Modified, GUID+pubdate dedup, per-source error isolation)
- `research-pulse-delta` cron in `muse/config.json` (every 12h, SILENT-OK)

**Acceptance criteria:**
- Two consecutive real runs against nonprofit registry
- Run 1 populates etag/guid state
- Run 2 within minutes returns ≥1 `304/unchanged` and 0 false-positive deltas
- Unit tests cover 304 path, new-GUID path, backfilled-pubdate path, and error-count escalation
- Cron entry passes `npm run build && npm test` (crons-schema validation)

**File deliverables:**
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/scripts/delta_check.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/test_delta_check.py`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/fixtures/podcast_feed.xml`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/fixtures/podcast_feed_plus_one.xml`
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/fixtures/youtube_videos.xml`
- `orgs/clearworksai/agents/muse/config.json` (1 cron entry added to array)

---

### P3 — briefs.clearworks.ai Pulse widget

**Spec:** `07`  
**PR target:** `briefs` repo (separate — different repo, different test suite)

**Scope:**
- `collect_pulse_tab(env)` in `publisher/build_dashboard.py`, added to the Library tab's `library_sections`
- Per-vertical card: last update, latest 5 items, trending topic chips, links to framework doc + NotebookLM notebook

**Acceptance criteria:**
- `python3 -m pytest publisher/tests/test_dashboard.py` green including new tests
- local `build_html()` renders the panel from fixture snapshots
- live dashboard rebuild (existing `daily-ops-dashboard` cron path) shows the panel with real nonprofit data
- graceful "No pulse data" when the snapshot dir is empty/absent

**File deliverables:**
- `/Users/joshweiss/code/briefs/publisher/build_dashboard.py` (modified)
- `/Users/joshweiss/code/briefs/publisher/tests/test_dashboard.py` (modified)

---

### P4 — Backfill the 3 existing verticals

**Spec:** `08`  
**Runtime work:** muse using P1 tooling (`backfill.py`); no new code PR expected beyond `backfill.py` (shipped in P1's PR)

**Scope:**
- AEC (39-source notebook `7f3b85b7-…`) and loan-syndication (`8a4e41a4-…`, 5 sources) registries built from `notebooklm source list --json` + curator tag pass using the existing AEC framework doc
- nonprofit already done in P1
- loan-syndication + any missing framework docs generated

**Acceptance criteria:**
- 3 registry files validate
- AEC registry has ≥30 active sources with feed_urls resolved for all podcast/youtube sources
- first delta run over all 3 completes with 0 crashes
- briefs panel shows 3 vertical cards

**Runtime execution plan:**

| Vertical | Notebook | Work |
|---|---|---|
| `aec` | `7f3b85b7-5adc-4869-ace9-7e056354f4eb` (~39 sources, LIVE — read-only backfill, add no sources) | `backfill.py` → curator pass using the existing framework doc (`aec-indicator-framework-2026-07-11.md`: its 7 per-source taxonomies map to tags; its 3 categories → `topic_vocab_extra`). Resolve feed_urls for all podcast/YouTube sources (Podcast Index lookup by title via discover.py providers). Set `framework_doc` to the existing doc. |
| `loan-syndication` | `8a4e41a4-1511-486e-bf99-57be4a80fbd3` (5 sources) | `backfill.py` → curator pass → then run the FULL research-pulse skill in maintenance mode to grow to 10+ sources and generate its (missing) framework doc. |
| `nonprofit` | `e9b95342-0b2e-4564-8ada-5bb4cede530b` | Already complete from P1 validation. `--merge` reconcile only (no-op expected). |

---

## File map (all deliverables)

| Path | Phase | Kind |
|---|---|---|
| `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/SKILL.md` | P1 | skill doc |
| `.../research-pulse/templates/indicator-framework-template.md` | P1 | doc template |
| `.../research-pulse/scripts/pulse_registry.py` | P1 | shared lib |
| `.../research-pulse/scripts/__init__.py` | P1 | empty (test imports) |
| `.../research-pulse/scripts/discover.py` | P1 | CLI |
| `.../research-pulse/scripts/seed_notebook.py` | P1 | CLI |
| `.../research-pulse/scripts/backfill.py` | P1 (used P4) | CLI |
| `.../research-pulse/scripts/delta_check.py` | P2 | CLI (cron engine) |
| `.../research-pulse/tests/__init__.py` | P1 | empty (test imports) |
| `.../research-pulse/tests/test_registry.py` | P1 | unit tests |
| `.../research-pulse/tests/test_discover.py` | P1 | unit tests |
| `.../research-pulse/tests/test_seed_notebook.py` | P1 | unit tests |
| `.../research-pulse/tests/test_backfill.py` | P1 (used P4) | unit tests |
| `.../research-pulse/tests/test_delta_check.py` | P2 | unit tests |
| `.../research-pulse/tests/fixtures/*.xml,*.json` | P1/P2 | test fixtures |
| `orgs/clearworksai/agents/muse/config.json` (crons array — 1 new entry) | P2 | config edit |
| `/Users/joshweiss/code/briefs/publisher/build_dashboard.py` (new collector) | P3 | modify |
| `/Users/joshweiss/code/briefs/publisher/tests/test_dashboard.py` (new tests) | P3 | modify |
| `~/code/knowledge-sync/raw/areas/clearworks/research/<vertical>-indicator-framework-<date>.md` | P1/P4 | runtime doc output |
| `orgs/clearworksai/agents/muse/state/research-pulse/**` | runtime | gitignored state |

---

## Credentials / environment (document in SKILL.md; live in `orgs/clearworksai/agents/muse/.env`)

| Var | Required | Notes |
|---|---|---|
| `PODCASTINDEX_API_KEY` / `PODCASTINDEX_API_SECRET` | P1 discover | Free registration at api.podcastindex.org. Auth = headers `X-Auth-Key`, `X-Auth-Date`, `Authorization: sha1(key+secret+date)` |
| `YOUTUBE_API_KEY` | optional | Data API v3 `search?type=channel`; when absent, `discover.py` falls back to yt-dlp (same engine as `~/.claude/skills/yt-search/scripts/search.py`) |
| `FRED_API_KEY` | optional | Only used to enrich framework docs with live series links; NOT polled by cron |
| `NOTEBOOKLM_BIN` | default `/tmp/whisper-venv/bin/notebooklm` | Auth: josh@clearworks.ai. /tmp is wiped on reboot — see risks |
| `PULSE_STATE_DIR` | default `orgs/clearworksai/agents/muse/state/research-pulse` | Overridable for tests and for briefs collector |

Python deps for scripts (NOT package.json — python env, matches yt-search precedent of pip tools): `feedparser`, `requests` (both preinstalled-or-pip; scripts must fail with an actionable `pip install feedparser requests` message, never a bare traceback). `pulse_registry.py` itself is pure stdlib — zero third-party imports.

---

## Test strategy

- **Skill scripts:** stdlib `unittest` + `unittest.mock`, zero network. Fixture RSS XML (podcast feed, YouTube `videos.xml`) + fixture JSON (Podcast Index, notebooklm CLI output). Run: `python3 -m unittest discover -s orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests`.
- **cortextos TS suite:** untouched code paths; `npm run build && npm test` must stay green (cron config entry is validated by existing `src/bus/crons-schema.ts` machinery).
- **briefs:** extend `publisher/tests/test_dashboard.py`; run `python3 -m pytest publisher/tests/`.
- **Live proof (per Josh's verify-outcome discipline):** P1 = nonprofit notebook shows sources in NotebookLM UI + `source list --json` count matches registry; P2 = two consecutive cron-path runs with 304 evidence in the run summary; P3 = screenshot of briefs.clearworks.ai Library tab.

---

## Risks & mitigations

1. **`/tmp/whisper-venv` is ephemeral** (reboot wipes it). All notebooklm calls go through `NOTEBOOKLM_BIN`; `seed_notebook.py` preflights `<bin> status` and emits reinstall instructions (`pip install notebooklm-py` into a durable venv) on failure. Recommend migrating the venv to `~/.venvs/notebooklm` during P1 implementation (1-line env change, no code change).
2. **NotebookLM API is reverse-engineered** — could break without notice. ALL notebooklm interaction is isolated in `seed_notebook.py` + `backfill.py`; the registry/delta/briefs chain has zero NotebookLM dependency and keeps working if it breaks.
3. **~50-source notebook cap.** `seed_notebook.py` enforces a `--limit` (default 45), seeds `quality:high` first, and refuses (with a clear message) rather than silently truncating.
4. **Feeds without ETag/Last-Modified support** — conditional GET degrades to full fetch; GUID dedup is the correctness backstop and always runs. 304 is an optimization, never assumed.
5. **Registry is gitignored runtime state** (muse/state is ignored — verified via `git check-ignore`). It is fully rebuildable: `backfill.py` reconstructs from the NotebookLM notebook + framework doc. Not a data-loss-critical store.
6. **Shared checkout clobber risk** (fleet memory rule): all new files are net-new paths; the only tracked-file edits are `muse/config.json` (P2) and briefs repo files (P3) — both land via PR, not working-tree drift.
7. **Podcast Index key doesn't exist yet** — free, but registration is a human step. `discover.py` must run degraded (YouTube + curated sites only) with a warning when the key is missing so P1 is never blocked on it.

---

## Gates

- Merge of each PR → Josh approval (hard rule).
- No destructive/prod-data operations anywhere in this epic.
- P1 live validation writes only to the empty nonprofit notebook — no touching the live AEC notebook until P4.

---

## Spec Summary (8 total)

### P1 Specs (4)
1. **Spec 01 — Registry library (`pulse_registry.py`)**: Pure stdlib schema/validation/atomic I/O. Spine of system.
2. **Spec 02 — Source discovery (`discover.py`)**: CLI turns "industry + queries" into candidates JSON via Podcast Index, YouTube, yt-dlp fallback, curated sites.
3. **Spec 03 — NotebookLM seeder (`seed_notebook.py`)**: Isolates all NotebookLM interaction; seeds registry sources into notebooks, loop-and-wait, cap-aware, idempotent.
4. **Spec 04 — research-pulse skill (add-industry orchestration)**: Agent-facing SKILL.md playbook; orchestrates P1 specs + framework-doc generation.

### P2 Specs (2)
5. **Spec 05 — Delta detection engine (`delta_check.py`)**: Cron workhorse; polls all sources with HTTP conditional GET, detects new episodes/videos by GUID, records deltas.
6. **Spec 06 — research-pulse-delta cron**: One new entry in muse/config.json; runs every 12h (06:15, 18:15 UTC), SILENT-OK if no deltas.

### P3 Specs (1)
7. **Spec 07 — briefs.clearworks.ai Pulse widget**: New "Industry Pulse" panel in Library tab; per-vertical cards showing latest items, trending topics, links.

### P4 Specs (1)
8. **Spec 08 — Backfill tooling + 3 existing verticals**: `backfill.py` reconstructs registries from existing NotebookLM notebooks; ships in P1 PR, executes in P4 runtime work by muse.

