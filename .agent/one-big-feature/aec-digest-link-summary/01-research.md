# 01 — Research: AEC digest link + summary

## Task origin
muse via frank2, task_1784569655156_93396649. Add clickable link + 1-line summary per article to the rendered Telegram AEC daily digest, with graceful fallback when no summary exists.

## Current state (verified by reading source 2026-07-20)

Base: `community/agents/research-agent/.claude/skills/research-pulse/`

### Ingestion — `scripts/delta_check.py`
- `parse_entries(body)` (line 101–125) builds inbox/delta items with keys **guid, title, url, pubdate ONLY** (item dict at lines 112–117). feedparser entries also expose `summary` (feedparser normalizes RSS `<description>` → `entry.summary`) but it is **discarded**.
- `_entry_value(entry, key)` (line 59–66) is the existing safe accessor — reuse it for `summary`.
- No HTML-strip helper exists anywhere in `scripts/` (grep confirmed: no `re.sub`/`html.unescape` usage). A small stdlib helper must be added.
- `poll_source` → `pulse_registry.record_delta(...)` and `summary["new_items"]` spread the full item dict, so a new `summary` key flows through with zero plumbing changes.

### Digest build — `scripts/daily_digest.py`
- `load_inbox` (line 57–88) returns raw inbox dicts — passes any key through untouched.
- `bucketize(items, registry)` (line 91–138) re-projects each item at lines 128–136 into `{title, url, source_name, source_id, pubdate}` — **`url` is already carried** (line 131) but then dropped by the renderer; `summary` is not projected at all.
- `render_telegram(digest)` (line 199–229): non-owner_voice items render one line only — `f"• {title} ({source_name}, {published})"` (line 226). **No url, no summary surfaced.**

### Tests — `tests/`
- Style: `unittest.TestCase` classes, `from __future__ import annotations`, `ROOT` sys.path insert, `PULSE_STATE_DIR` env patch, tempdirs, fixture XML in `tests/fixtures/`. Runnable under pytest.
- `tests/test_delta_check.py::test_run_summary_new_items_carries_item_payload` (line 125–128) asserts the **exact key set** `{"vertical", "source_id", "guid", "title", "url", "pubdate"}` — adding a `summary` key to parse_entries **will break this test**; it must be updated to include `"summary"`.
- Fixture feeds (`podcast_feed.xml`, `podcast_feed_plus_one.xml`, `youtube_videos.xml`) have **no `<description>` per item**, so `summary` defaults to `""` for them — no other assertions break (they check named keys/values, not key sets).
- `tests/test_daily_digest.py::test_render_telegram_sections` (line 294) shows the digest-dict-literal render test pattern to extend.

## Why RSS-summary capture beats per-article HTTP fetch (decided by Larry; confirmed correct)
1. **Determinism**: digest render is a pure function of state files; per-article fetch adds network nondeterminism to a currently offline render path.
2. **403 fragility**: many AEC trade sites (ENR, ConstructionDive) 403 non-browser agents; delta_check already needed a browser UA (line 27–30) just for feeds. The "graceful fallback" requirement collapses to "render link only when `summary == ''`" — no error handling needed.
3. **Zero new deps**: feedparser already parses `<description>`/`summary`; stripping HTML is stdlib (`re` + `html.unescape`).
4. **Free backfill semantics**: summary captured once at ingest, persisted in inbox.jsonl/deltas, replayable.

## Risks
- **R1 — key-set test break** (`test_run_summary_new_items_carries_item_payload`): known; spec updates the assertion.
- **R2 — Telegram markdown corruption**: underscores in URLs trigger stray italics (known fleet hazard). Mitigation: URLs rendered bare on their own line, no `_`/`*` wrapping; summary rendered plain text.
- **R3 — HTML in feed summaries**: RSS descriptions often carry `<p>`, `<a>`, entities. Mitigation: tag-strip regex + `html.unescape` + whitespace collapse + 160-char truncate.
- **R4 — backward compat**: existing inbox.jsonl rows lack `summary`. Mitigation: `item.get("summary") or ""` everywhere; empty renders exactly as today plus (if present) the url line.
- **R5 — message length**: up to 12 items × (+url +summary lines) grows the Telegram message; bounded by 6-per-bucket cap + 160-char summaries — well under Telegram's 4096 limit for typical days.
