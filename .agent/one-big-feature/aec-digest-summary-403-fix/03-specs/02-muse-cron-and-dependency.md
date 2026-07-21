# Spec 02 — Muse cron prompt edit + youtube-transcript-api dependency

## A. Muse cron prompt — `orgs/clearworksai/agents/muse/config.json` (line 64)

Target: the `prompt` string of the cron object named `research-pulse-delta` (name at line 61, prompt at line 64). This is a tracked file in a shared checkout — the edit ships on the feature branch via PR, never a live working-tree hand-edit outside the branch.

Two surgical string edits inside the existing prompt (leave every other sentence byte-identical, including the SILENT-OK, Telegram-digest, larry-escalation, MORNING DIGEST, and update-cron-fire clauses):

### Edit A1 — add `summary` to the append-set

Replace this exact substring:

```
append one JSON line {ingested_at, vertical, source_id, guid, title, url, pubdate} to state/research-pulse/inbox.jsonl, skipping any guid already present in that file.
```

with:

```
append one JSON line {ingested_at, vertical, source_id, guid, title, url, pubdate, summary} to state/research-pulse/inbox.jsonl, skipping any guid already present in that file (copy summary verbatim from the new_items entry; empty string if absent).
```

Rationale (latent gap): `daily_digest.py` reads `item.get("summary")` from inbox lines (`daily_digest.py:135`) and renders it (`:231-233`), but the current append-set drops it — rich RSS summaries (Dezeen 630 chars, BoA 1498 chars, already arriving via feedparser) never reach the digest today.

### Edit A2 — insert the caption-summary instruction

Immediately after the (edited) append sentence from A1 and before the `SILENT-OK:` sentence, insert:

```
CAPTION SUMMARIES: if a new_items entry carries a caption_excerpt field (delta_check attaches it only to description-less YouTube Shorts, at most 6 per run), write a single clean one-line summary (plain text, max 160 chars, no quotes/markdown/emoji) derived from that caption_excerpt into the inbox line's summary field in place of the empty summary. Do this ONLY for entries carrying caption_excerpt; NEVER rewrite or replace a non-empty summary that came from the feed; NEVER store the raw caption_excerpt in the inbox line.
```

### Post-edit checks

- `python3 -c "import json; json.load(open('orgs/clearworksai/agents/muse/config.json'))"` — file still valid JSON (the inserted text contains no double quotes or backslashes, so JSON-string escaping is unaffected; keep it that way).
- Grep the saved prompt for both `pubdate, summary}` and `CAPTION SUMMARIES:` to confirm both edits landed in the ONE `research-pulse-delta` prompt (not any other cron).

## B. Dependency — `youtube-transcript-api`

The skill currently has NO requirements file; deps live only informally in the durable venv (`/Users/joshweiss/.venvs/research-pulse`: feedparser 6.0.12, requests 2.34.2 — verified 2026-07-20, youtube-transcript-api absent).

### B1. Create `community/agents/research-agent/.claude/skills/research-pulse/requirements.txt`

Exact contents:

```
feedparser>=6.0
requests>=2.31
youtube-transcript-api>=1.0,<2
```

The `<2` pin locks the 1.x instance API the code targets (`YouTubeTranscriptApi().fetch(video_id)` returning snippets with `.text`); 0.x used a different classmethod API and any future 2.x may break it again.

### B2. Install into the durable venv (one-time operational step, done at implementation time — not in tests, not in the cron)

```bash
/Users/joshweiss/.venvs/research-pulse/bin/pip install -r /Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/requirements.txt
/Users/joshweiss/.venvs/research-pulse/bin/python -c "from youtube_transcript_api import YouTubeTranscriptApi; print('ok')"
```

### B3. Explicit non-goals

- Do NOT add `youtube-transcript-api` to `DEPENDENCY_MESSAGE` or the hard dep check in `delta_check.py:284` — it is optional; the script must keep running (current behavior, no enrichment) if it is missing.
- Do NOT add the anthropic SDK or any API key to the venv — the LLM step is muse's cron prompt only.
- Do NOT change the cron schedule (`15 6,18 * * *`) or any other cron.

## C. Acceptance

1. Muse cron prompt contains both edits; JSON valid; no other prompt characters changed.
2. `requirements.txt` exists with the exact three lines above.
3. Venv import check passes.
4. A live `delta_check.py` run in the venv exits 0 and prints valid JSON both before and after the pip install.
