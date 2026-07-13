# OBF Master Plan — industry-research-pulse-p2 (Delta-detection cron)

**Slug:** `industry-research-pulse-p2`
**Parent epic:** `industry-research-pulse` (P1 merged — 470fbc9)
**Framework:** one-big-feature (OBF)
**Plan engine:** Fable 5 (Josh-confirmed, gate-enforced)
**Repo:** `/Users/joshweiss/code/cortextos`
**Research doc:** `.agent/one-big-feature/industry-research-pulse-p2/01-research.md`

---

## Goal (verbatim from research doc)

Build the delta-detection cron engine that periodically polls every source in each vertical
registry, detects NEW episodes/videos via HTTP conditional GET + immutable GUID dedup, records
deltas, refreshes the pulse snapshot, and reports via a 2×/day cron that is SILENT-OK when there
are no deltas.

## Scope (two specs)

| Spec | Deliverable | File |
|---|---|---|
| **05 — delta_check.py** | Cron engine: conditional GET, GUID+pubdate dedup, per-source error isolation, JSON run summary. Plus offline unit tests + 3 XML fixtures. | `03-specs/05-delta-check.md` |
| **06 — research-pulse-delta cron** | ONE new entry in the tracked `community/agents/research-agent/config.json` `crons` array. Schedule 06:15 & 18:15 UTC, SILENT-OK. | `03-specs/06-delta-cron.md` |

## Non-goals

- NO auto-adding new episodes as NotebookLM sources from the cron (50-source/notebook cap; deltas are *reported*, notebook stays show/channel-level).
- NO FRED/BLS time-series polling (data sites with `feed_url: null` are documented, not polled; series polling is a future phase).
- NO TypeScript source changes in cortextos. Python scripts + JSON state + one cron config entry only. Zero new `package.json` deps.

## Architecture

- `delta_check.py` is the cron engine. It sits beside the merged P1 library at
  `community/agents/research-agent/.claude/skills/research-pulse/scripts/` and drives everything
  through `pulse_registry`'s public API: `state_dir()` / `list_verticals()` / `load_registry()`
  to enumerate and read, then per changed source `record_delta(registry, source_id, items)`,
  then `write_pulse_snapshot(registry)`, then `save_registry(registry)` — record deltas, refresh
  snapshot, persist, in that order.
- Poll state (`etag`, `last_modified`, `last_seen_guid`, `last_seen_pubdate`, `last_checked`,
  `last_delta`, `consecutive_errors`, `active`) already lives on each source in the P1 registry
  schema — delta_check reads/writes those fields and nothing schema-new.
- HTTP layer: `requests` (P1 precedent via discover.py) for conditional GET; `feedparser` for
  parsing. 304 is an optimization; GUID dedup is the always-on correctness backstop.
- Per-source try/except isolation: one dead feed never aborts the run. `consecutive_errors >= 10`
  auto-deactivates the source and flags it in the run summary.
- The cron entry in the tracked `community/agents/research-agent/config.json` invokes
  `delta_check.py` 2×/day and applies the SILENT-OK / escalation reporting contract to the
  script's JSON run summary. Runtime activation (research-agent not currently running; muse is
  the live runtime owner but its config is gitignored) is a separate post-merge runtime op, not
  part of this build.

## File map (P2 deliverables — all under the TRACKED community path)

| Path | Kind |
|---|---|
| `community/agents/research-agent/.claude/skills/research-pulse/scripts/delta_check.py` | net-new CLI (cron engine) |
| `community/agents/research-agent/.claude/skills/research-pulse/tests/test_delta_check.py` | net-new unit tests |
| `community/agents/research-agent/.claude/skills/research-pulse/tests/fixtures/podcast_feed.xml` | net-new fixture (baseline RSS w/ GUIDs) |
| `community/agents/research-agent/.claude/skills/research-pulse/tests/fixtures/podcast_feed_plus_one.xml` | net-new fixture (same + one newer episode) |
| `community/agents/research-agent/.claude/skills/research-pulse/tests/fixtures/youtube_videos.xml` | net-new fixture (YouTube channel RSS w/ `yt:videoId`) |
| `community/agents/research-agent/config.json` | tracked-file edit (1 cron entry appended to `crons`) |

## Test strategy

Offline stdlib `unittest` + `unittest.mock` (matches P1). Mock the HTTP fetch layer (return
fixture bytes + controllable status/headers) — never touch the network. Required coverage
(8 points from the research doc):

1. **304 path** — conditional GET returns 304 → 0 deltas, `last_checked` bumped, no parse.
2. **New-GUID path** — `plus_one` fixture → exactly 1 delta with correct guid/title/url/pubdate.
3. **Backfilled-pubdate path** — `last_seen_guid` missing from feed → pubdate fallback finds the right NEW set, no re-flood.
4. **First-run guard** — null state → 0 deltas, baseline recorded.
5. **Error-count escalation** — fetch raises → `consecutive_errors` increments; at 10 → `active=false` + appears in summary `deactivated`.
6. **Non-pollable skip** — `feed_url` null → source skipped, no error.
7. **YouTube RSS** — `yt:videoId` id extraction works.
8. **Pulse snapshot refresh** — after deltas, `pulse/<v>.json` regenerated with new `latest_items`.

Plus: cortextos `npm run build && npm test` stays green (cron entry validated by existing
machinery; no TS changes).

## Acceptance criteria (verbatim from research doc)

- Two consecutive real runs against the nonprofit registry.
- Run 1 populates etag/guid state.
- Run 2 within minutes returns ≥1 `304/unchanged` AND 0 false-positive deltas.
- Unit tests cover 304 / new-GUID / backfilled-pubdate / error-count-escalation paths.
- Cron entry passes `npm run build && npm test`.

## Gates

- Merge → Josh approval (hard rule; PR only, never direct to main).
- No destructive/prod-data operations anywhere in this phase. Registry runtime state is
  gitignored and rebuildable (`backfill.py`); live-proof runs touch only the nonprofit registry.
