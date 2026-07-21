# OBF Master Plan — aec-digest-summary-403-fix

**Date:** 2026-07-20
**Repo:** /Users/joshweiss/code/cortextos
**Slug:** aec-digest-summary-403-fix
**Locked decision (Josh via frank2):** Option (b) — LLM 1-line summary for description-less YouTube Shorts only, capped at 6 per run. Deterministic RSS summaries untouched.

## Problem statement (grounded)

The original premise ("Dezeen + Business of Architecture 403 on WebFetch; route via browser-harness") is FALSE for this pipeline: the digest ingests RSS feeds via `requests`+`feedparser` (never WebFetches article HTML), and live tests with the pipeline's Chrome UA show both feeds return HTTP 200 with rich summaries (Dezeen 630 chars, BoA 1498 chars) — nothing to fix there.

The one real gap: **description-less YouTube Shorts**. When a YouTube video has no description, feedparser's `summary` collapses to the bare title (`summary == title`), so digest lines from Shorts-heavy channels (Built Local, Mike Ghazaleh) carry no summary. There is no `media_description` fallback field (verified: entry keys are id, link, summary, yt_videoid, yt_channelid, media_* thumbnails/stats only). Captions are the only content source. A latent second gap: the muse cron's inbox append-set omits `summary` entirely, so even rich RSS summaries never reach `inbox.jsonl` → `daily_digest.py` renders none (`daily_digest.py:135` reads `item.get("summary")`, `render_telegram` at :231-233 prints it).

## Architecture (clean deterministic/LLM split)

- **delta_check.py (deterministic, testable):** detect description-less YouTube entries; for those only, fetch a caption transcript via `youtube-transcript-api` and attach a bounded `caption_excerpt` (≤500 chars) to the new_item in the run summary JSON. Hard cap: 6 caption fetch attempts per run (whole run, all verticals). All failure modes degrade to current behavior. No anthropic SDK, no API key in the venv.
- **muse cron (the LLM step):** the cron prompt already runs delta_check and appends inbox lines. Two edits: (a) add `summary` to the append-set; (b) when an item carries `caption_excerpt`, muse writes one clean 1-line summary into the line's `summary` field. Excerpt itself is never stored in the inbox.
- **daily_digest.py / pulse_registry.py:** NO changes. `bucketize` already passes `summary` through (`daily_digest.py:135`); `record_delta` (`pulse_registry.py:314-327`) copies only guid/title/url/pubdate, so the deltas ring never bloats with excerpts.

## Exact change per file

### 1. `community/agents/research-agent/.claude/skills/research-pulse/scripts/delta_check.py`
- After the `requests` optional-import block (lines 17-20): add optional import `youtube_transcript_api.YouTubeTranscriptApi` (→ `None` on `ModuleNotFoundError`), mirroring the feedparser/requests pattern. `DEPENDENCY_MESSAGE` (line 28) unchanged — the dep is optional, its absence must not fail the run.
- After `SUMMARY_MAX_CHARS` (line 33): add `CAPTION_FETCH_CAP = 6` and `CAPTION_EXCERPT_MAX_CHARS = 500`.
- After `detect_new` (ends line 167), before `poll_source` (line 170): add four small functions — `new_caption_budget()`, `_youtube_video_id(guid)`, `is_descriptionless_youtube(item)`, `fetch_caption_excerpt(video_id, max_chars)` (reuses `clean_summary` line 81 for bounding), and `enrich_youtube_items(new_items, caption_budget, fetch_caption=...)`.
- `poll_source` (line 170): new optional param `caption_budget: dict | None = None`; after `new_items = detect_new(...)` (lines 201-205) call `enrich_youtube_items(new_items, caption_budget)` when both are non-empty. Enrichment is exception-proof by construction; caption failures NEVER increment `consecutive_errors` (line 219) or deactivate a source.
- `poll_vertical` (line 228): new optional param `caption_budget: dict | None = None`, threaded into `poll_source` (line 243).
- `main` (line 274): create one shared `caption_budget = new_caption_budget()` before the vertical loop (line 311) and pass it to every `poll_vertical` call (line 313) — the 6-cap is per RUN, not per vertical/source.
- `caption_excerpt` flows: item dict → `result["new_items"]` → `summary["new_items"]` (lines 260-264, 326-328) → printed JSON → muse. It is NOT written to the registry deltas ring or pulse snapshot.

### 2. `community/agents/research-agent/.claude/skills/research-pulse/tests/test_delta_check.py`
- Line 111-112: widen `patched_poll_vertical` signature to accept `caption_budget: dict | None = None` and pass it through — otherwise `main()`'s new kwarg breaks this existing test (the TypeError would be swallowed into `vertical_errors` and fail assertions).

### 3. NEW `community/agents/research-agent/.claude/skills/research-pulse/tests/test_caption_enrichment.py`
- Full unit suite (mocked caption fetch, zero live network) + NEW fixture `tests/fixtures/youtube_shorts_feed.xml`. Test list below.

### 4. `orgs/clearworksai/agents/muse/config.json` (line 64, `research-pulse-delta` cron prompt; cron name at line 61)
- (a) Append-set `{ingested_at, vertical, source_id, guid, title, url, pubdate}` → add `summary` (fixes the latent gap: rich RSS summaries currently never reach the inbox).
- (b) Insert a CAPTION SUMMARIES instruction: for items carrying `caption_excerpt` (≤6/run, description-less YouTube only), muse writes a single plain 1-line summary (≤160 chars) derived from the excerpt into the line's `summary`; never store the raw excerpt; never rewrite a non-empty feed summary.
- Tracked file → change ships via branch/PR like the code, never a live working-tree hand-edit (shared-checkout rule).

### 5. NEW `community/agents/research-agent/.claude/skills/research-pulse/requirements.txt` (dependency decision)
- Skill has no requirements file today; create one at the skill root recording the full durable-venv dep set:
  ```
  feedparser>=6.0
  requests>=2.31
  youtube-transcript-api>=1.0,<2
  ```
- Install (one-time, durable venv): `/Users/joshweiss/.venvs/research-pulse/bin/pip install -r /Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/requirements.txt`
- Pin `<2` because the 1.x instance API (`YouTubeTranscriptApi().fetch(video_id)` → snippets with `.text`) is what the code targets.

## Graceful-degradation matrix (all rows: run summary JSON stays valid, exit 0, `consecutive_errors` untouched, source stays active, `summary` field left as-is)

| Condition | Behavior |
|---|---|
| `youtube-transcript-api` not installed | `YouTubeTranscriptApi is None` → `fetch_caption_excerpt` returns `None` → no enrichment |
| Transcripts disabled / no captions for video | Exception caught inside `fetch_caption_excerpt` → `None` → skip |
| Network error / timeout on caption fetch | Same → `None` → skip |
| Empty/whitespace-only transcript | `clean_summary` yields `""` → treated as `None` → no `caption_excerpt` key |
| guid not `yt:video:*` (can't derive video id) | Skip item, budget NOT consumed |
| Budget exhausted (6 attempts used) | Remaining candidates skipped silently |
| Unexpected raise from injected fetch | Per-item try/except in `enrich_youtube_items` → skip |
| `caption_budget=None` (direct callers / old code paths) | Enrichment entirely bypassed — exact current behavior |

Budget semantics: decrement on each fetch ATTEMPT (success or failure) — the cap bounds network calls, not successes.

## Test list (all mocked, no live network)

1. Detection predicate: empty summary + `yt:video:` guid → True.
2. Detection predicate: `summary == clean_summary(title)` (title-equal collapse, incl. whitespace/entity variance) → True.
3. Detection predicate: real distinct summary → False.
4. Detection predicate: non-YouTube guid (podcast) with empty summary → False.
5. `_youtube_video_id`: `"yt:video:abc123"` → `"abc123"`; non-prefixed → `None`.
6. Cap: 8 description-less Shorts across two sources in one run → mock fetch called exactly 6 times; budget shared across `poll_source` calls (4 + 2 enrichment split).
7. Graceful fallback: fetch returns `None` → item has no `caption_excerpt` key, `poll_source` status `"changed"`, `consecutive_errors == 0`.
8. Raising fetch → same guarantees as (7); no deactivation.
9. Dep missing: `YouTubeTranscriptApi = None` patch → `fetch_caption_excerpt` returns `None`.
10. Real-RSS-summary entry untouched: fetch mock never called, `summary` passes through byte-identical.
11. Excerpt bounded: long transcript → `len ≤ CAPTION_EXCERPT_MAX_CHARS`, ellipsis-terminated.
12. Backward compat: `poll_source` without `caption_budget` → fetch never called.
13. End-to-end: `poll_vertical` over `youtube_shorts_feed.xml` fixture with budget → run-summary `new_items` entry carries `caption_excerpt`.
14. Existing suite (`test_delta_check.py`, `test_daily_digest.py`, etc.) stays green.

## Out of scope (locked)

- NO Dezeen/BoA/browser-harness/WebFetch work (false premise).
- NO changes to `daily_digest.py`, `pulse_registry.py`, feed-health logic, or bucketing.
- NO anthropic SDK / LLM calls inside any script — the LLM step lives only in the muse cron prompt.
- NO summarization of entries that already carry a real RSS summary.

## Acceptance criteria

1. `python -m unittest discover` (from the skill root) green — new + existing tests.
2. Run summary JSON schema unchanged except optional `caption_excerpt` on qualifying new_items.
3. `delta_check.py` runs cleanly in the durable venv both WITH and WITHOUT `youtube-transcript-api` installed.
4. Muse cron prompt updated per spec 02; `summary` in append-set.
5. `requirements.txt` created; dep installed in `/Users/joshweiss/.venvs/research-pulse`.
6. PR (never direct push to main) — Josh approves merge.

## Specs

- `03-specs/01-delta-check-caption-enrichment.md` — code + tests (verbatim scope).
- `03-specs/02-muse-cron-and-dependency.md` — cron-prompt edit + dep declaration/install.
