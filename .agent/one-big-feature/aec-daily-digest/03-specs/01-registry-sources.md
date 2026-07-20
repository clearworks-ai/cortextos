# Spec 01 — aec.json registry changes

Target file (GITIGNORED live state — edit in place, NOT via PR; back up first):
`/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/state/research-pulse/registry/aec.json`

Procedure: `cp aec.json aec.json.bak-aec-daily-digest` → apply edits below → validate with
`/Users/joshweiss/.venvs/research-pulse/bin/python -c "import sys; sys.path.insert(0,'/Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/scripts'); import pulse_registry; pulse_registry.load_registry('aec'); print('aec.json valid')"`
Do the edit outside the 06:15/18:15 PT cron minutes (delta_check rewrites this file).

Every feed URL below was live-verified 2026-07-20 with a Chrome UA via curl: **200 + real RSS/Atom XML** unless stated otherwise. Vocab used is exactly the `test_registry.py` vocab (topic: indicators/strategy/operations/regulation/innovation + this registry's `topic_vocab_extra` = project_delivery/construction_spending/infrastructure; signal: leading/coincident/lagging/sentiment/macro/micro; authority: academic/industry_expert/practitioner/news/vendor; cadence: daily/weekly/monthly/quarterly/ad_hoc; quality: high/medium/emerging/archival). IDs follow `pulse_registry.slugify` (`src_<slug>`).

## 1. Fix null feed_url rows (never-polled fixes)

**src_u-s-census-construction-spending** — set:
```json
"feed_url": "https://www.census.gov/economic-indicators/indicator.xml"
```
(VERIFIED 200, RSS 2.0.) Keep `source_type: "data_feed"`, keep tags as-is (`topic: ["indicators","construction_spending"]` → spend_confidence). NOTE: this feed carries ALL Census economic-indicator releases, not just construction — `daily_digest.py` applies a per-source title filter `["construction"]` (spec 02 §4) so only Construction Spending releases surface. `delta_check.py` polls any row with a non-null feed_url regardless of source_type, so this row becomes pollable.

**src_dodge-architecture-billings-index** — set:
```json
"feed_url": "https://www.construction.com/feed/",
"source_type": "article",
"tags": {
  "topic": ["indicators", "construction_spending", "project_delivery"],
  "signal": ["leading"],
  "authority": "industry_expert",
  "cadence": "monthly",
  "quality": "high"
}
```
(VERIFIED 200, RSS 2.0 — Dodge Construction Network news feed.) `construction_spending` topic added → deterministic spend_confidence. Type report→article because it now has a real article feed.

**src_bls** — feed_url stays `null` (null-ok for `data_feed` per `validate_registry` — feed_url is only required for podcast/youtube). **Fact: BLS hard-403s curl even with a full browser UA (WAF), verified 2026-07-20 on `bls.gov/feed/bls_latest.rss` and `ces.rss`** — there is no feed delta_check can poll. Change tags only:
```json
"tags": {
  "topic": ["indicators", "operations"],
  "signal": ["coincident", "macro"],
  "authority": "academic",
  "cadence": "monthly",
  "quality": "high"
}
```
("macro" added so any future BLS-sourced item deterministically buckets to spend_confidence.) How it's polled: indirectly — NAHB Eye on Housing and Calculated Risk (both added below, both pollable) cover BLS construction-employment/price releases same-day. Keep `active: true` (delta_check silently skips null-feed rows; costs nothing).

**src_fred** — feed_url stays `null`. **Fact: FRED retired its RSS feeds (no feed endpoint exists to poll).** Tags already `topic:["indicators"], signal:["macro"]` → spend_confidence; leave row unchanged. How it's polled: indirectly via Calculated Risk (below), which reports the same macro series.

## 2. NEW industry-news rows (firm-scale, Amendment 1 compliant)

Append these complete rows to `sources[]` exactly as written.

```json
{
  "id": "src_business-of-architecture",
  "source_name": "Business of Architecture",
  "url": "https://www.businessofarchitecture.com",
  "feed_url": "https://businessofarchitecture.libsyn.com/rss",
  "source_type": "podcast",
  "industry": ["aec"],
  "tags": {
    "topic": ["strategy", "operations"],
    "signal": ["sentiment"],
    "authority": "industry_expert",
    "cadence": "weekly",
    "quality": "high"
  },
  "notebooklm_source_id": null,
  "etag": null,
  "last_modified": null,
  "last_seen_guid": null,
  "last_seen_pubdate": null,
  "last_checked": null,
  "last_delta": null,
  "consecutive_errors": 0,
  "active": true
}
```
(Feed note: BoA's own `businessofarchitecture.com/feed/` returns a hard 403 "Public RSS Feed Unavailable" even with a browser UA — the UA fix does NOT clear it. The libsyn podcast feed above is their real public feed, VERIFIED 200.)

```json
{
  "id": "src_entrearchitect",
  "source_name": "EntreArchitect",
  "url": "https://entrearchitect.com",
  "feed_url": "https://entrearchitect.com/feed/",
  "source_type": "article",
  "industry": ["aec"],
  "tags": {
    "topic": ["strategy", "operations"],
    "signal": ["sentiment"],
    "authority": "practitioner",
    "cadence": "weekly",
    "quality": "high"
  },
  "notebooklm_source_id": null,
  "etag": null,
  "last_modified": null,
  "last_seen_guid": null,
  "last_seen_pubdate": null,
  "last_checked": null,
  "last_delta": null,
  "consecutive_errors": 0,
  "active": true
}
```

```json
{
  "id": "src_archinect",
  "source_name": "Archinect",
  "url": "https://archinect.com",
  "feed_url": "https://feeds.feedburner.com/archinect",
  "source_type": "article",
  "industry": ["aec"],
  "tags": {
    "topic": ["strategy", "innovation"],
    "signal": ["coincident"],
    "authority": "news",
    "cadence": "daily",
    "quality": "high"
  },
  "notebooklm_source_id": null,
  "etag": null,
  "last_modified": null,
  "last_seen_guid": null,
  "last_seen_pubdate": null,
  "last_checked": null,
  "last_delta": null,
  "consecutive_errors": 0,
  "active": true
}
```
(`archinect.com/news/rss` 404s; the feedburner Atom feed is the live one, VERIFIED 200.)

```json
{
  "id": "src_dezeen",
  "source_name": "Dezeen",
  "url": "https://www.dezeen.com",
  "feed_url": "https://www.dezeen.com/feed/",
  "source_type": "article",
  "industry": ["aec"],
  "tags": {
    "topic": ["innovation"],
    "signal": ["coincident"],
    "authority": "news",
    "cadence": "daily",
    "quality": "high"
  },
  "notebooklm_source_id": null,
  "etag": null,
  "last_modified": null,
  "last_seen_guid": null,
  "last_seen_pubdate": null,
  "last_checked": null,
  "last_delta": null,
  "consecutive_errors": 0,
  "active": true
}
```
(This is the "Dezeen UA-fix" from the goal: feed is live; the prior 403 was the missing User-Agent in `delta_check.fetch_feed` — fixed in spec 02 §3.)

```json
{
  "id": "src_construction-physics",
  "source_name": "Construction Physics",
  "url": "https://www.construction-physics.com",
  "feed_url": "https://www.construction-physics.com/feed",
  "source_type": "article",
  "industry": ["aec"],
  "tags": {
    "topic": ["innovation", "operations"],
    "signal": ["micro"],
    "authority": "industry_expert",
    "cadence": "weekly",
    "quality": "high"
  },
  "notebooklm_source_id": null,
  "etag": null,
  "last_modified": null,
  "last_seen_guid": null,
  "last_seen_pubdate": null,
  "last_checked": null,
  "last_delta": null,
  "consecutive_errors": 0,
  "active": true
}
```
(Brian Potter's Substack; `/feed` VERIFIED 200. Tagged `signal:["micro"]` deliberately — NOT indicators+macro — so his macro-flavored essays stay in industry_news per the deterministic rule.)

## 3. NEW spend-confidence rows

```json
{
  "id": "src_calculated-risk",
  "source_name": "Calculated Risk",
  "url": "https://www.calculatedriskblog.com",
  "feed_url": "https://www.calculatedriskblog.com/feeds/posts/default",
  "source_type": "article",
  "industry": ["aec"],
  "tags": {
    "topic": ["indicators"],
    "signal": ["macro", "leading"],
    "authority": "industry_expert",
    "cadence": "daily",
    "quality": "high"
  },
  "notebooklm_source_id": null,
  "etag": null,
  "last_modified": null,
  "last_seen_guid": null,
  "last_seen_pubdate": null,
  "last_checked": null,
  "last_delta": null,
  "consecutive_errors": 0,
  "active": true
}
```
(Blogger Atom feed, VERIFIED 200. indicators+macro → spend_confidence.)

```json
{
  "id": "src_nahb-eye-on-housing",
  "source_name": "NAHB Eye on Housing",
  "url": "https://eyeonhousing.org",
  "feed_url": "https://eyeonhousing.org/feed/",
  "source_type": "article",
  "industry": ["aec"],
  "tags": {
    "topic": ["indicators", "construction_spending"],
    "signal": ["macro", "leading"],
    "authority": "industry_expert",
    "cadence": "daily",
    "quality": "high"
  },
  "notebooklm_source_id": null,
  "etag": null,
  "last_modified": null,
  "last_seen_guid": null,
  "last_seen_pubdate": null,
  "last_checked": null,
  "last_delta": null,
  "consecutive_errors": 0,
  "active": true
}
```
(WordPress feed, VERIFIED 200. construction_spending → spend_confidence.)

## 4. Mega-GC deactivations (Amendment 1: firm-scale only)

**src_construction-dive** — set `"active": false`. Dropped per goal ("drop Construction Dive unless filterable to firm-scale"): its firehose is mega-GC/megaproject-dominant (Skanska $7B, Tutor Perini $140M came from this source) and there is no deterministic firm-scale filter. Keep the row (history/deltas intact), just stop polling.

**src_engineering-news-record** — set `"active": false`. Same rationale: ENR is mega-project/ENR-400-dominant; reviving it with the UA fix would refill industry_news with exactly the items the goal's spot check forbids. (Decision extends the goal's named drop to ENR on the same Amendment-1 ground; trivially reversible by flipping `active` back if Josh wants ENR.)

`daily_digest.py` additionally skips inbox items whose source is inactive/unknown (spec 02 §4), so already-ingested Skanska/Tutor-Perini inbox lines can never reach a digest.

## 5. Explicitly NOT added

**Building Design+Construction (bdcnetwork.com) — DROPPED.** Verified 2026-07-20: `rss.xml`, `/rss/all`, `/feeds/news` all 404; the homepage's own advertised `<link rel=alternate type=application/rss+xml>` href (`/__rss/website-scheduled-content.xml?input=...`) ALSO returns 404. No working feed exists to poll — do not add a dead row (it would just climb `consecutive_errors` to auto-deactivation).

## 6. Post-edit checks (codexer runs these)

1. `load_registry("aec")` validation one-liner (top of this spec) exits clean.
2. URL-uniqueness sanity: no new row's normalized `url` collides with an existing row (checked by the validator).
3. `test_registry.py` still green in both suites (spec 03) — it is fixture-based and unaffected by row adds, but run it.
4. Row count: 14 existing + 7 new = 21 sources; 2 now `active:false` (construction-dive, engineering-news-record); null feed_url remaining: exactly `src_fred`, `src_bls` (documented above).
