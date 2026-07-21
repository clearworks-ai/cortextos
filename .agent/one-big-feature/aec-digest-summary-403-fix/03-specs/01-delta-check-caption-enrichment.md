# Spec 01 — delta_check.py caption enrichment for description-less YouTube Shorts

**Target file:** `community/agents/research-agent/.claude/skills/research-pulse/scripts/delta_check.py` (line refs against HEAD as of 2026-07-20, 336 lines)
**Also touched:** `tests/test_delta_check.py` (one wrapper fix), NEW `tests/test_caption_enrichment.py`, NEW `tests/fixtures/youtube_shorts_feed.xml`
**Locked scope:** description-less YouTube entries ONLY; cap 6 caption fetch attempts per run; everything else byte-identical behavior.

## 1. Optional import (after `requests` block, lines 17-20)

Insert after line 20, mirroring the existing pattern:

```python
try:
    from youtube_transcript_api import YouTubeTranscriptApi
except ModuleNotFoundError:
    YouTubeTranscriptApi = None
```

Do NOT touch `DEPENDENCY_MESSAGE` (line 28) or the hard dep check in `main` (line 284) — this dep is optional; absence degrades gracefully.

## 2. Constants (after `SUMMARY_MAX_CHARS = 160`, line 33)

```python
CAPTION_FETCH_CAP = 6
CAPTION_EXCERPT_MAX_CHARS = 500
YOUTUBE_GUID_PREFIX = "yt:video:"
```

## 3. New functions (insert between `detect_new` ending at line 167 and `poll_source` at line 170)

```python
def new_caption_budget() -> dict:
    return {"remaining": CAPTION_FETCH_CAP}


def _youtube_video_id(guid: str) -> str | None:
    if isinstance(guid, str) and guid.startswith(YOUTUBE_GUID_PREFIX):
        video_id = guid[len(YOUTUBE_GUID_PREFIX):]
        if video_id:
            return video_id
    return None


def is_descriptionless_youtube(item: dict) -> bool:
    guid = str(item.get("guid") or "")
    if not guid.startswith(YOUTUBE_GUID_PREFIX):
        return False
    summary = str(item.get("summary") or "").strip()
    title = str(item.get("title") or "")
    return summary == "" or summary == clean_summary(title)


def fetch_caption_excerpt(
    video_id: str,
    max_chars: int = CAPTION_EXCERPT_MAX_CHARS,
) -> str | None:
    if YouTubeTranscriptApi is None:
        return None
    try:
        transcript = YouTubeTranscriptApi().fetch(video_id)
        text = " ".join(snippet.text for snippet in transcript)
    except Exception:
        return None
    excerpt = clean_summary(text, max_chars=max_chars)
    return excerpt or None


def enrich_youtube_items(
    new_items: list[dict],
    caption_budget: dict | None,
    fetch_caption=fetch_caption_excerpt,
) -> None:
    if not caption_budget:
        return
    for item in new_items:
        if int(caption_budget.get("remaining", 0) or 0) <= 0:
            return
        if not is_descriptionless_youtube(item):
            continue
        video_id = _youtube_video_id(str(item.get("guid") or ""))
        if not video_id:
            continue
        caption_budget["remaining"] = int(caption_budget["remaining"]) - 1
        try:
            excerpt = fetch_caption(video_id)
        except Exception:
            excerpt = None
        if excerpt:
            item["caption_excerpt"] = excerpt
```

Semantics locked in:
- Predicate is guid-based (`yt:video:` prefix from `_entry_guid`, line 73-78, which prefers the Atom `id`) — per-ENTRY detection, not per-source; regular videos on the same channel with real descriptions fail the predicate and pass through untouched.
- Title-equality compares `summary` against `clean_summary(title)` because `parse_entries` (line 131) stores the CLEANED summary while `title` (line 128) is raw — this catches the feedparser title-collapse exactly, including entity/whitespace variance.
- Budget decrements on every fetch ATTEMPT (success or failure) — bounds network calls at 6/run.
- Non-derivable video id → skip WITHOUT consuming budget.
- `enrich_youtube_items` mutates items in place, returns None, and cannot raise (fetch wrapped per item).
- Bounding reuses `clean_summary` (line 81) with `max_chars=500` — HTML-stripped, whitespace-collapsed, ellipsis-truncated.

## 4. `poll_source` (line 170)

Signature becomes:

```python
def poll_source(source: dict, fetch=fetch_feed, caption_budget: dict | None = None) -> dict:
```

After `new_items = detect_new(...)` (lines 201-205), before the `source["etag"] = new_etag` line (206), insert:

```python
        if new_items and caption_budget is not None:
            enrich_youtube_items(new_items, caption_budget)
```

Guarantees: enrichment cannot raise, so the `except Exception` at line 218 (which increments `consecutive_errors` and can deactivate at 10) is reachable only by genuine feed errors, exactly as today. Default `caption_budget=None` keeps every existing caller/test byte-identical.

## 5. `poll_vertical` (line 228)

Signature becomes:

```python
def poll_vertical(
    vertical: str,
    dry_run: bool = False,
    fetch=fetch_feed,
    caption_budget: dict | None = None,
) -> dict:
```

Line 243 becomes:

```python
        result = poll_source(source, fetch=fetch, caption_budget=caption_budget)
```

No other changes — `record_delta` (pulse_registry.py:314-327) copies only guid/title/url/pubdate, so `caption_excerpt` never enters the registry deltas ring or pulse snapshot. It DOES flow into `summary["new_items"]` (lines 263-264 and 326-328) and out the JSON on stdout — that is the muse handoff.

## 6. `main` (line 274)

Immediately before the `for vertical in verticals:` loop (line 311), add:

```python
    caption_budget = new_caption_budget()
```

Line 313 becomes:

```python
            vertical_summary = poll_vertical(
                vertical, dry_run=args.dry_run, caption_budget=caption_budget
            )
```

One budget object shared across ALL verticals = 6 fetches per RUN.

## 7. REQUIRED fix to existing test — `tests/test_delta_check.py:111-112`

`main()` now passes `caption_budget=` to `poll_vertical`; the mock side_effect wrapper must accept it or the TypeError gets swallowed into `vertical_errors` and the test fails. Replace:

```python
            def patched_poll_vertical(vertical: str, dry_run: bool = False):
                return original_poll_vertical(vertical, dry_run=dry_run, fetch=fake_fetch)
```

with:

```python
            def patched_poll_vertical(
                vertical: str,
                dry_run: bool = False,
                caption_budget: dict | None = None,
            ):
                return original_poll_vertical(
                    vertical,
                    dry_run=dry_run,
                    fetch=fake_fetch,
                    caption_budget=caption_budget,
                )
```

No other existing test touches the changed signatures (all use keyword/default paths — verified).

## 8. NEW fixture — `tests/fixtures/youtube_shorts_feed.xml`

Model on the existing `youtube_videos.xml` (Atom + `yt:` + `media:` namespaces). Two entries, newest first:

- Entry `yt:video:short-1` "Margin Killers on Site" (published 2026-07-14T00:00:00+00:00, link `https://www.youtube.com/watch?v=short-1`) with a `media:group` containing `media:title` only — NO `media:description` (the Shorts case; feedparser collapses summary to the title).
- Entry `yt:video:long-1` "Episode 12: Backlog Deep Dive" (published 2026-07-13T00:00:00+00:00) with `media:group` containing `media:description` = "A 40-minute breakdown of how mid-size GCs are re-pricing backlog after the Q2 spend report." (the regular-video case).

In tests, do NOT hardcode feedparser's collapse output — parse the fixture and assert via the predicate (`is_descriptionless_youtube(entries[0]) is True`, `... entries[1] ... is False`) so the tests stay robust across feedparser minor versions.

## 9. NEW test file — `tests/test_caption_enrichment.py`

Match house style exactly: `from __future__ import annotations`, same sys.path bootstrap as `test_delta_check.py:14-20`, `unittest.TestCase`, `unittest.mock`, no live network anywhere. Mock the caption fetch either by injecting `fetch_caption=` into `enrich_youtube_items` or `unittest.mock.patch.object(MODULE, "fetch_caption_excerpt", ...)` for poll-level tests. Never import `youtube_transcript_api` in tests; patch `MODULE.YouTubeTranscriptApi`.

Helper: `def yt_item(guid="yt:video:v1", title="Site walk in 60s", summary="", url="https://www.youtube.com/watch?v=v1"): return {"guid": guid, "title": title, "url": url, "pubdate": "2026-07-14T00:00:00Z", "summary": summary}`

Test cases + exact assertions:

1. `test_predicate_true_on_empty_summary` — `is_descriptionless_youtube(yt_item(summary=""))` is True.
2. `test_predicate_true_when_summary_equals_cleaned_title` — item with `title="Margins &amp; backlog"` and `summary=MODULE.clean_summary("Margins &amp; backlog")` → True.
3. `test_predicate_false_on_real_summary` — `yt_item(summary="A real 2-sentence description of the video.")` → False.
4. `test_predicate_false_on_non_youtube_guid` — `yt_item(guid="episode-4", summary="")` → False.
5. `test_video_id_extraction` — `_youtube_video_id("yt:video:abc123") == "abc123"`; `_youtube_video_id("episode-4") is None`; `_youtube_video_id("yt:video:") is None`.
6. `test_cap_six_attempts_per_shared_budget` — budget = `MODULE.new_caption_budget()`; two lists of 4 description-less items each (8 unique guids); `fetch = unittest.mock.Mock(return_value="captions text")`; call `enrich_youtube_items(list_a, budget, fetch_caption=fetch)` then `(list_b, budget, fetch_caption=fetch)`. Assert `fetch.call_count == 6`; all 4 of list_a have `caption_excerpt`; exactly 2 of list_b do; `budget["remaining"] == 0`.
7. `test_fetch_none_leaves_item_untouched_and_source_healthy` — `poll_source` with a fake feed fetch returning `youtube_shorts_feed.xml` bytes (source primed with `last_seen_guid`/`last_seen_pubdate` = older entry so the Short is new), `caption_budget=new_caption_budget()`, and `MODULE.fetch_caption_excerpt` patched to return `None`. Assert result `status == "changed"`, `"caption_excerpt" not in result["new_items"][0]`, `source["consecutive_errors"] == 0`, `source["active"]` is True.
8. `test_raising_fetch_is_swallowed` — same as 6's setup but `fetch = Mock(side_effect=RuntimeError("boom"))` on a 2-item list: no raise, no `caption_excerpt` keys, `fetch.call_count == 2`, budget decremented by 2.
9. `test_dep_missing_returns_none` — `with unittest.mock.patch.object(MODULE, "YouTubeTranscriptApi", None): self.assertIsNone(MODULE.fetch_caption_excerpt("abc123"))`.
10. `test_real_rss_summary_never_summarized` — `fetch = Mock()`; `enrich_youtube_items([yt_item(summary="Real description here.")], new_caption_budget(), fetch_caption=fetch)`; assert `fetch.assert_not_called()` and item `summary == "Real description here."` and no `caption_excerpt` key. Repeat with a podcast-guid item.
11. `test_excerpt_bounded_at_max_chars` — patch `MODULE.YouTubeTranscriptApi` with a stub whose `fetch(video_id)` returns a list of objects each having `.text` totaling >2000 chars; `excerpt = MODULE.fetch_caption_excerpt("abc123")`; assert `len(excerpt) == MODULE.CAPTION_EXCERPT_MAX_CHARS` and `excerpt.endswith("…")`.
12. `test_no_budget_means_no_enrichment` — `poll_source(source, fetch=fake_fetch)` (no `caption_budget`) with `MODULE.fetch_caption_excerpt` patched to a Mock → `assert_not_called()`, result identical shape to today.
13. `test_run_summary_carries_caption_excerpt_end_to_end` — temp `PULSE_STATE_DIR`, registry with one `youtube` source (`feed_url="https://www.youtube.com/feeds/videos.xml?channel_id=UC-test"`), primed last_seen to the older fixture entry; `poll_vertical("nonprofit", fetch=fake_fetch, caption_budget=new_caption_budget())` with `MODULE.fetch_caption_excerpt` patched to return `"He walks the site and calls out three margin leaks."`. Assert the run summary `new_items[0]["caption_excerpt"]` equals that string, `new_items[0]["guid"] == "yt:video:short-1"`, and the saved registry `deltas[0]` has NO `caption_excerpt` key.

## 10. Verification commands

```bash
cd /Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse
python3 -m unittest discover -s tests -v          # full suite green (stdlib + feedparser only; caption dep never imported by tests)
```

Style gates: typed signatures (`dict | None`), small pure functions, no `print` in library code, no new hard deps, no changes to `poll_source` error/deactivation logic beyond the two inserted lines.
