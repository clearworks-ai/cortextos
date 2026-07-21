# Research — AEC digest 403 / no-transcript fix (ground truth)

Live-tested 2026-07-20 with the pipeline's Chrome UA against the actual RSS feeds.

## Finding 1 — the "Dezeen/BoA 403" premise is false for this pipeline
- The digest ingest (`delta_check.py`) reads **RSS feeds** via `requests`+`feedparser`; it never WebFetches article HTML.
- Dezeen feed (`https://www.dezeen.com/feed/`): HTTP **200**, first-entry summary **630 chars**.
- Business of Architecture feed (`https://businessofarchitecture.libsyn.com/rss`): HTTP **200**, first-entry summary **1498 chars**.
- No bot-detection 403 on this path. Nothing to fix for Dezeen/BoA; no browser-harness / UA-spoof work needed.

## Finding 2 — the real gap = YouTube Shorts with no description
- feedparser's `summary` field collapses to the bare title (~49 chars, == title) when a video has no description — every Short.
- Built Local (`src_built-local-with-mike-ghazaleh`) + Mike Ghazaleh are Shorts-heavy. Verified: entry 1/2 (Shorts) `summary == title`; entry 3 (regular video) has a 951-char description.
- Gap is **per-entry, not per-source**. No `media_description` field to fall back to (entry keys: id, link, summary, yt_videoid, yt_channelid, media_thumbnail/stats only). Captions are the only content source.

## Finding 3 — architecture
- Durable venv: `/Users/joshweiss/.venvs/research-pulse/bin/python` (feedparser 6.0.12, requests 2.34.2; youtube-transcript-api ABSENT).
- Two-step, **muse agent orchestrates**: `delta_check.py` prints `new_items` JSON → muse appends inbox lines → `daily_digest.py` renders. Script is pure-Python deterministic, no LLM client.
- Latent bug: muse cron append-set omits `summary`, though `daily_digest.py:135` reads it — rich RSS summaries never reach the digest today.

## Locked decision (Josh via frank2)
Option (b): LLM 1-line summary for description-less YouTube Shorts, capped 6/run, description-less entries only. Clean split — script fetches captions deterministically (testable), muse agent writes the LLM 1-liner from the excerpt (no anthropic SDK/key in cron).
