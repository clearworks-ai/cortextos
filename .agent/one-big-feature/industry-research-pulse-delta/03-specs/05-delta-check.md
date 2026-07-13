# Spec 05 — Delta detection engine (`delta_check.py`)

**Target file (net-new):**
`community/agents/research-agent/.claude/skills/research-pulse/scripts/delta_check.py`

**Companion test deliverables (net-new, this spec):**
- `community/agents/research-agent/.claude/skills/research-pulse/tests/test_delta_check.py`
- `community/agents/research-agent/.claude/skills/research-pulse/tests/fixtures/podcast_feed.xml`
- `community/agents/research-agent/.claude/skills/research-pulse/tests/fixtures/podcast_feed_plus_one.xml`
- `community/agents/research-agent/.claude/skills/research-pulse/tests/fixtures/youtube_videos.xml`

Builds on the merged P1 library `scripts/pulse_registry.py` — use its real public API, do not
duplicate any of its logic.

---

## 1. Imports & dependency guard

- Import the sibling library exactly as `discover.py`/`seed_notebook.py` do:

  ```python
  try:
      from . import pulse_registry
  except ImportError:
      import pulse_registry  # type: ignore[no-redef]
  ```

- Third-party deps (`feedparser`, `requests`) are guarded, matching the discover.py precedent:

  ```python
  try:
      import feedparser
  except ModuleNotFoundError:
      feedparser = None

  try:
      import requests
  except ModuleNotFoundError:
      requests = None
  ```

- `main()` checks both BEFORE doing any work: if either is `None`, print an actionable message
  to stderr — `missing dependency: run pip install feedparser requests` — and exit 1. Never a
  bare traceback. (HTTP layer decision, per research doc: use `requests`, consistent with the
  existing P1 dependency in discover.py; feedparser is the parse layer.)

- Everything else is stdlib: `argparse`, `json`, `os`, `sys`, `time`/`calendar`, `datetime`.

## 2. pulse_registry API used (real signatures — verified against merged source)

| Function | Signature | Use here |
|---|---|---|
| `state_dir()` | `-> Path` | resolves `PULSE_STATE_DIR` env (default muse state dir) |
| `list_verticals()` | `-> list[str]` | enumerate registries to poll |
| `load_registry(vertical)` | `-> dict` | read + validate one registry (raises `FileNotFoundError` / `ValueError`) |
| `save_registry(registry)` | `-> Path` | validates, stamps `updated_at`, atomic write |
| `record_delta(registry, source_id, items)` | `-> None` | prepend items to `deltas` ring (max 200); stamps `detected_at` itself |
| `write_pulse_snapshot(registry)` | `-> Path` | refresh render-ready `pulse/<vertical>.json` |
| `utc_now_iso()` | `-> str` | all timestamps (`%Y-%m-%dT%H:%M:%SZ`) |

`record_delta` item contract: each item dict MUST carry exactly `guid`, `title`, `url`,
`pubdate` (all strings; `pubdate` ISO 8601 UTC in the `utc_now_iso()` format so
`pulse_registry._parse_iso8601` can read it back).

## 3. Function decomposition (signatures + behavior contracts)

### 3.1 `fetch_feed(url: str, etag: str | None, last_modified: str | None, timeout: int = 30) -> tuple[int, bytes, str | None, str | None]`

- Performs `requests.get(url, headers=..., timeout=timeout)`.
- Conditional-GET headers, sent only when stored values exist:
  - `If-None-Match: <etag>` when `etag` is truthy.
  - `If-Modified-Since: <last_modified>` when `last_modified` is truthy.
- Returns `(status_code, body_bytes, new_etag, new_last_modified)`:
  - `304` → `(304, b"", etag, last_modified)` (keep the stored values).
  - `200` → body bytes plus response headers `ETag` / `Last-Modified` (or `None` when the
    server omits them — a feed without them simply degrades to full fetch every run; 304 is an
    optimization, never assumed).
  - Any other status → raise (e.g. `resp.raise_for_status()`); the caller's per-source
    try/except owns it.
- No parsing here. This is the single seam the tests mock.

### 3.2 `parse_entries(body: bytes) -> list[dict]`

- `feedparser.parse(body)` → list of `{"guid", "title", "url", "pubdate"}` dicts, newest-first.
- **guid derivation (stable id):** prefer `entry.id` (feedparser maps both RSS `<guid>` and
  Atom `<id>` to `.id`; for YouTube channel feeds `entry.id` is `yt:video:<videoId>` and
  feedparser also exposes `entry.yt_videoid` — use `entry.id` first, fall back to
  `entry.get("guid")`, then `entry.get("yt_videoid")`). Skip entries with no derivable id.
- **title:** `entry.get("title", "")`. **url:** `entry.get("link", "")`.
- **pubdate:** from `entry.get("published_parsed")` (fall back `updated_parsed`) converted to
  ISO 8601 UTC via `calendar.timegm` + `datetime.fromtimestamp(..., timezone.utc)` formatted
  `%Y-%m-%dT%H:%M:%SZ`; empty string when absent.
- Sort defensively newest-first by the parsed time struct (entries missing dates keep feed
  order at the tail).

### 3.3 `detect_new(entries: list[dict], last_seen_guid: str | None, last_seen_pubdate: str | None) -> list[dict]`

Pure function; `entries` is newest-first from `parse_entries`.

1. **First-run guard:** if BOTH `last_seen_guid` and `last_seen_pubdate` are falsy → return `[]`.
   (First run establishes baseline state only; deltas start on run 2. This is what makes the
   acceptance criterion "run 2 returns 0 false-positive deltas" achievable.)
2. **GUID-first:** if `last_seen_guid` is present among the entries' guids → NEW = all entries
   strictly BEFORE it in newest-first order (walk newest-first, collect until hitting
   `last_seen_guid`, stop).
3. **Backfilled-pubdate fallback:** if `last_seen_guid` is set but NOT found among current
   entries (feed rotated it out, or GUID scheme changed) → NEW = entries whose parsed pubdate
   is strictly greater than `last_seen_pubdate`. Entries without a parseable pubdate are NOT
   new under fallback (prevents a re-flood of false deltas).
4. If `last_seen_guid` is null but `last_seen_pubdate` is set → same pubdate comparison as (3).
5. Returns the NEW subset, newest-first.

### 3.4 `poll_source(source: dict, fetch=fetch_feed) -> dict`

Polls ONE source dict (mutates its poll-state fields in place) and returns a per-source result:
`{"source_id": str, "status": "skipped" | "not_modified" | "changed" | "unchanged" | "error", "new_items": list[dict], "deactivated": bool}`.

- **Skip guards (no fetch, no state change):** `source["active"]` is falsy → skipped;
  `source["feed_url"]` is `None`/empty → skipped (non-pollable data site).
- **Whole body in one try/except** — any exception (network, HTTP status, parse) is caught here:
  - increment `source["consecutive_errors"]`
  - if `source["consecutive_errors"] >= 10` → set `source["active"] = False`,
    `deactivated = True` (10 consecutive errors ≈ 5 days of dead feed at 2×/day)
  - set `source["last_checked"] = utc_now_iso()`
  - return status `"error"`. NEVER re-raise — one dead feed must not abort the run.
- **304 path:** `fetch` returns status 304 → NO parse, 0 new items,
  `last_checked = utc_now_iso()`, `consecutive_errors = 0`, status `"not_modified"`.
- **200 path:**
  1. `entries = parse_entries(body)`
  2. `new_items = detect_new(entries, source["last_seen_guid"], source["last_seen_pubdate"])`
  3. Update state (exact P1 schema field names):
     - `source["etag"] = new_etag` and `source["last_modified"] = new_last_modified`
       (from the response; may be `None`)
     - if entries exist: `source["last_seen_guid"] = entries[0]["guid"]` and
       `source["last_seen_pubdate"] = entries[0]["pubdate"]` (newest entry — this is also how
       the first run records its baseline)
     - `source["last_checked"] = utc_now_iso()`
     - `source["consecutive_errors"] = 0`
     - iff `new_items`: `source["last_delta"] = utc_now_iso()`
  4. status `"changed"` when `new_items` non-empty, else `"unchanged"`.

### 3.5 `poll_vertical(vertical: str, dry_run: bool = False, fetch=fetch_feed) -> dict`

- `registry = pulse_registry.load_registry(vertical)` (its internal `validate_registry` is the
  pre-check; a `ValueError`/`FileNotFoundError` here is a hard config error — let it propagate
  to `main`).
- Loop `registry["sources"]`, calling `poll_source` on each; accumulate per-source results.
- For each source with `new_items`:
  `pulse_registry.record_delta(registry, source_id, new_items)`.
- Then, in this exact order (record deltas → refresh snapshot → persist), when NOT `dry_run`:
  1. `pulse_registry.write_pulse_snapshot(registry)`
  2. `pulse_registry.save_registry(registry)`
- `dry_run=True` → all polling/detection runs, NOTHING is written to disk (no snapshot, no
  registry save).
- Returns a per-vertical aggregate used to build the run summary (counts + `deactivated` +
  `error_sources` id lists).

### 3.6 `main(argv: list[str] | None = None) -> int`

- Dependency guard first (section 1) → exit 1 with the pip-install message on failure.
- `argparse` flags:
  - `--vertical <slug>` — optional filter; poll only that vertical. Absent → poll every
    vertical from `pulse_registry.list_verticals()`.
  - `--state-dir <path>` — optional; when given, set `os.environ["PULSE_STATE_DIR"]` before any
    registry call (`pulse_registry.state_dir()` reads the env at call time).
  - `--dry-run` — poll + detect, write nothing.
- **Hard config errors → exit 1** with a plain stderr message: no registries found
  (`list_verticals()` empty), `--vertical` names a missing/invalid registry
  (`FileNotFoundError`/`ValueError` from `load_registry`), or bad state dir.
- Otherwise **exit 0 always** — per-source isolation means a partial run is still a success.
- Prints exactly one JSON object (the run summary) to stdout.
- Standard entry: `if __name__ == "__main__": sys.exit(main())`.

## 4. Run-summary JSON shape (stdout — drives spec 06 cron behavior)

```json
{
  "verticals_polled": 3,
  "sources_polled": 41,
  "sources_304": 12,
  "sources_changed": 2,
  "sources_errored": 1,
  "new_deltas": 3,
  "deactivated": ["src_dead-feed"],
  "error_sources": ["src_dead-feed"]
}
```

- `sources_polled` counts sources actually fetched (skipped sources — inactive or
  `feed_url: null` — are excluded from all counts).
- `sources_304` = `"not_modified"` results; `sources_changed` = `"changed"` results;
  `sources_errored` = `"error"` results this run.
- `new_deltas` = total NEW items recorded across all sources/verticals.
- `deactivated` = source ids auto-deactivated THIS run (crossed the >=10 threshold).
- `error_sources` = source ids that errored this run.

## 5. Edge cases (explicit)

- `feed_url` null/empty → skip, no error, no state change.
- `active: false` → skip.
- 304 → 0 deltas + `last_checked` bumped + `consecutive_errors` reset to 0 + NO parse.
- Feed omits ETag/Last-Modified → store `None`, full fetch next run; GUID dedup is the
  correctness backstop (304 never assumed).
- `last_seen_guid` set but absent from feed → pubdate fallback (no re-flood).
- Both `last_seen_guid` and `last_seen_pubdate` null → first-run baseline, 0 deltas.
- Empty feed (0 entries) on 200 → 0 deltas, state timestamps bumped, guid/pubdate untouched.

## 6. Tests — `tests/test_delta_check.py`

Offline stdlib `unittest` + `unittest.mock`, matching the P1 test suite's conventions
(see `tests/test_registry.py` / `tests/test_discover.py`). Mock ONLY the `fetch_feed` seam
(inject via the `fetch=` parameter or `mock.patch`) returning fixture bytes + controllable
status/etag/last-modified; never touch the network. Use a `tempfile.TemporaryDirectory` +
`PULSE_STATE_DIR` env override for registry/pulse writes.

Fixtures (net-new, this spec):
- `fixtures/podcast_feed.xml` — baseline RSS 2.0 podcast feed, >=3 items with `<guid>` +
  `<pubDate>`, newest-first.
- `fixtures/podcast_feed_plus_one.xml` — identical + ONE newer episode prepended.
- `fixtures/youtube_videos.xml` — YouTube channel Atom feed with `yt:videoId` entries
  (namespace `xmlns:yt="http://www.youtube.com/xml/schemas/2015"`).

Required coverage (the 8 points — see master plan Test strategy):
1. 304 path — 0 deltas, `last_checked` bumped, parse never called.
2. New-GUID path — baseline seen, `plus_one` fixture → exactly 1 delta with correct
   guid/title/url/pubdate.
3. Backfilled-pubdate path — `last_seen_guid` not in feed → pubdate fallback yields the right
   NEW set, no re-flood.
4. First-run guard — null state → 0 deltas, newest guid+pubdate recorded as baseline.
5. Error-count escalation — fetch raises → `consecutive_errors` increments; at 10 →
   `active=false` and id appears in summary `deactivated`.
6. Non-pollable skip — `feed_url: null` → skipped, no error, no counts.
7. YouTube RSS — `yt:videoId`-style id extraction works on `youtube_videos.xml`.
8. Pulse snapshot refresh — after a delta run, `pulse/<vertical>.json` exists and its
   `latest_items` contains the new item.

Runner: `python3 -m unittest discover -s community/agents/research-agent/.claude/skills/research-pulse/tests`.

## 7. Out of scope for this spec

- No NotebookLM interaction of any kind.
- No FRED/BLS/data-site polling (those sources have `feed_url: null` and are skipped).
- No changes to `pulse_registry.py` or any other P1 file.
- No Telegram/bus sending from the script itself — reporting policy lives in the cron prompt
  (spec 06); the script's contract ends at the JSON run summary on stdout.
