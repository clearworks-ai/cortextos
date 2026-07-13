# P2 Research — Delta-detection cron (specs 05 + 06)

**Slug:** `industry-research-pulse-p2`
**Parent epic:** `industry-research-pulse` (P1 merged — 470fbc9)
**Framework:** one-big-feature (OBF)
**Plan engine:** Fable 5 (Josh-confirmed for this mission, gate-enforced)
**Repo:** `/Users/joshweiss/code/cortextos`
**Build target dir (tracked, P1 Option-B location):** `community/agents/research-agent/.claude/skills/research-pulse/`

## Goal (verbatim from recovered master-plan, P2 section)

Build the delta-detection cron engine that periodically polls every source in each vertical
registry, detects NEW episodes/videos via HTTP conditional GET + immutable GUID dedup, records
deltas, refreshes the pulse snapshot, and reports via a 2×/day cron that is SILENT-OK when there
are no deltas.

Two specs:
- **Spec 05 — `delta_check.py`** (cron engine)
- **Spec 06 — `research-pulse-delta` cron entry** (config.json)

## Grounding — the existing P1 code this builds on

`community/agents/research-agent/.claude/skills/research-pulse/scripts/pulse_registry.py` (merged,
384 lines, pure stdlib). Public API `delta_check.py` MUST use (verified by reading source):

| Function | Signature | Use |
|---|---|---|
| `state_dir()` | `-> Path` | resolves `PULSE_STATE_DIR` env (default muse state dir) |
| `list_verticals()` | `-> list[str]` | enumerate registries to poll |
| `load_registry(vertical)` | `-> dict` | read one registry |
| `save_registry(registry)` | `-> Path` | atomic write back (etag/guid state) |
| `record_delta(registry, source_id, items)` | `-> None` | prepend to `deltas` ring (max 200) |
| `write_pulse_snapshot(registry)` | `-> Path` | refresh render-ready `pulse/<v>.json` |
| `utc_now_iso()` | `-> str` | timestamp |
| `validate_registry(registry)` | `-> list[str]` | pre/post integrity check |

`record_delta` item contract (each item dict MUST have): `guid`, `title`, `url`, `pubdate`.
It stamps `detected_at` itself. `write_pulse_snapshot` counts a source as errored when
`consecutive_errors >= 3`.

### Source poll-state fields (already in P1 schema — delta_check reads/writes these)

`feed_url` (poll target; `null`/empty = non-pollable data site → SKIP), `etag`, `last_modified`,
`last_seen_guid` (immutable episode/video GUID), `last_seen_pubdate` (ISO 8601 robustness
fallback), `last_checked` (ISO), `last_delta` (ISO of last NEW-items event), `consecutive_errors`
(int), `active` (bool — `false` sources are skipped).

## Technical approach

### HTTP conditional GET (bandwidth + correctness)
- Send `If-None-Modified` via `If-None-Match: <etag>` and `If-Modified-Since: <last_modified>`
  headers when the source has stored values.
- `304 Not Modified` → source unchanged, no parse, bump `last_checked`, reset
  `consecutive_errors` to 0. This is an OPTIMIZATION, never assumed — a feed that ignores
  conditional headers returns 200 + full body every time and GUID dedup is the correctness
  backstop.
- `200 OK` → parse body, store new `etag`/`Last-Modified` from response headers for next run.
- Use `requests` for the fetch (already a P1 dependency via discover.py) OR stdlib
  `urllib.request` to keep delta_check dependency-light; **decision for plan stage.** feedparser
  is the parse layer either way (recovered plan names feedparser explicitly).

### New-item detection (GUID-first, pubdate-fallback)
- Parse feed entries with `feedparser`. For each entry derive a stable id: prefer `entry.id`/
  `entry.guid`; YouTube RSS uses `yt:videoId` / `entry.id`.
- Walk entries newest-first; collect entries until we hit `last_seen_guid` (stop — everything
  after is already seen). Everything before it = NEW.
- **Backfilled-pubdate guard** (recovered-plan acceptance criterion): if `last_seen_guid` is
  present but NOT found among current entries (feed rotated it out, or GUID scheme changed),
  fall back to `last_seen_pubdate`: NEW = entries with `published_parsed > last_seen_pubdate`.
  This prevents a re-flood of false deltas when a GUID goes missing.
- **First-run guard:** when both `last_seen_guid` and `last_seen_pubdate` are null (never polled),
  DO NOT emit every historical episode as a delta — record the newest entry's guid+pubdate as the
  baseline and emit ZERO deltas. First run establishes state; deltas start on run 2. (This is what
  makes the acceptance criterion "run 2 returns 0 false-positive deltas" achievable.)
- After processing: set `last_seen_guid`/`last_seen_pubdate` to the newest entry, `last_checked`
  now, and `last_delta` now iff NEW items were found.

### Per-source error isolation
- Each source polled in its own try/except. A network error / parse failure on ONE source:
  increment its `consecutive_errors`, log, CONTINUE to the next source. Never abort the run.
- Success resets `consecutive_errors` to 0.
- **Auto-deactivate:** when `consecutive_errors >= 10`, set `active = false` and flag the source
  in the run summary (needs attention). 10 consecutive errors ≈ 5 days of dead feed at 2×/day.

### Run summary + reporting contract (drives spec 06 cron behavior)
`delta_check.py` prints a JSON run summary to stdout: `{verticals_polled, sources_polled,
sources_304, sources_changed, sources_errored, new_deltas, deactivated:[...],
error_sources:[...]}`. Exit 0 always (per-source isolation means a partial run is still a
success); reserve non-zero exit for a hard config error (no registries, bad state dir).

### Cron behavior (spec 06)
- Entry in `community/agents/research-agent/config.json` `crons` array (tracked file; consistent
  with P1 Option-B tracked location). Schedule: 06:15 & 18:15 UTC (every 12h, offset from the top
  of the hour to avoid feed-server rush).
- **SILENT-OK:** `new_deltas == 0` and no errors → log the run, send NOTHING to Telegram.
- **Escalate:** `new_deltas >= 10` in one run → Telegram digest (newest items grouped by vertical).
  Any source hitting the consecutive-error deactivate threshold → a message to larry (eng owner),
  never Josh raw (Railway/feed-health = larry). Matches the fleet SILENT-OK rule.

## Runtime-home decision (fork resolved once, per autonomous-loop rule)
P1 promoted the skill to `community/agents/research-agent/` (tracked; `orgs/…/muse` is gitignored).
The **tracked, PR-able** cron deliverable therefore lands in
`community/agents/research-agent/config.json`. muse is the live runtime owner (per plan), but its
config is gitignored so cannot be the shipped artifact. **Post-merge runtime-activation** (start
research-agent OR register the cron on live muse pointing at the tracked `delta_check.py` path) is
a separate runtime op — noted, NOT a blocker for the P2 build/PR. Flagged to Josh in the surface.

## Test strategy (offline, stdlib unittest + mock — matches P1)
Fixtures (net-new): `podcast_feed.xml` (baseline RSS w/ GUIDs), `podcast_feed_plus_one.xml` (same
+ one newer episode), `youtube_videos.xml` (YouTube channel RSS w/ `yt:videoId`). Mock the HTTP
layer (return fixture bytes + controllable status/headers), never touch the network.

Required unit coverage (recovered-plan acceptance):
1. **304 path** — conditional GET returns 304 → 0 deltas, `last_checked` bumped, no parse.
2. **New-GUID path** — `plus_one` fixture → exactly 1 delta, correct guid/title/url/pubdate.
3. **Backfilled-pubdate path** — `last_seen_guid` missing from feed → pubdate fallback finds the
   right NEW set, no re-flood.
4. **First-run guard** — null state → 0 deltas, baseline recorded.
5. **Error-count escalation** — fetch raises → `consecutive_errors` increments; at 10 →
   `active=false` + appears in summary `deactivated`.
6. **Non-pollable skip** — `feed_url` null → source skipped, no error.
7. **YouTube RSS** — `yt:videoId` id extraction works.
8. **Pulse snapshot refresh** — after deltas, `pulse/<v>.json` regenerated with new `latest_items`.

`npm run build && npm test` in cortextos MUST stay green — the cron config entry is validated by
existing `src/bus/crons-schema.ts`; no TS source changes.

## Acceptance criteria (P2, verbatim from recovered master-plan)
- Two consecutive real runs against the nonprofit registry.
- Run 1 populates etag/guid state.
- Run 2 within minutes returns ≥1 `304/unchanged` AND 0 false-positive deltas.
- Unit tests cover 304 / new-GUID / backfilled-pubdate / error-count-escalation paths.
- Cron entry passes `npm run build && npm test`.

## Risks
1. **Feeds without ETag/Last-Modified** → conditional GET degrades to full fetch; GUID dedup is the
   always-on backstop. 304 never assumed.
2. **feedparser not installed** → script must fail with actionable `pip install feedparser requests`
   message, never a bare traceback (matches P1 precedent).
3. **GUID scheme drift** across a feed's history → pubdate fallback + first-run guard prevent a
   false-delta flood.
4. **Live-proof needs a real seeded registry** — nonprofit registry from P1 validation is the
   proving ground; runtime state is gitignored + rebuildable (backfill.py), so not data-critical.
