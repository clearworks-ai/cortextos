# AEC Daily Digest — Research (OBF stage 1)

Slug: `aec-daily-digest` · Repo root: `/Users/joshweiss/code/cortextos` · Target subtree: `orgs/clearworksai/agents/muse`
Goal (binding): `orgs/clearworksai/agents/muse/state/goals/aec-daily-digest.md`
Deadline: real output before Mon 2026-07-20 ~08:00 PT / 15:00Z (AIA office hours).

## 1. What is being built
A new `daily_digest.py` that emits a **3-bucket** AEC digest and folds into the EXISTING research-pulse cron's morning firing (no new cron):
```
{ "industry_news": [...], "spend_confidence": [...], "owner_voice": [...] }
```
Plus registry (`aec.json`) source-additions + null-feed_url fixes, a static owner-voice quote pool from the NotebookLM "AEC Pulse Research" corpus, a test, and a live run that reaches Telegram (chat 6690120787) with all 3 buckets populated.

Scope is `orgs/clearworksai/agents/muse` only. **No schema change** — new sources are rows in `aec.json` `sources[]` with the same fields as existing entries. Single repo, single cohesive feature → **OBF** (not M2C1).

## 2. Grounded facts (verified reads, 2026-07-20)

### Cron (fold into it — do NOT add a new cron)
- Def: `orgs/clearworksai/agents/muse/config.json:61-65`. Schedule `15 6,18 * * *` (6:15 AM/PM PST). Morning firing = the digest slot.
- Invokes: `~/.venvs/research-pulse/bin/python community/agents/research-agent/.claude/skills/research-pulse/scripts/delta_check.py`.
- `delta_check.py` prints a JSON summary to stdout; muse parses + appends items to inbox.jsonl. `daily_digest.py` reads that inbox to assemble buckets.

### delta_check.py — the real inbox + fetch path
- Script: `community/agents/research-agent/.claude/skills/research-pulse/scripts/delta_check.py`.
- Inbox (JSONL, one item/line): `orgs/clearworksai/agents/muse/state/research-pulse/inbox.jsonl`.
- Item schema (`parse_entries()`, ~L97-121): `{ guid, title, url, pubdate }`; muse adds `ingested_at, vertical, source_id` on ingest.
- Fetch: `fetch_feed()` ~L29-52 → `requests.get(url, headers=headers, timeout=...)`. Headers set = `If-None-Match` (etag) + `If-Modified-Since` ONLY. **No User-Agent** → ENR/Dezeen/Archinect 403 (confirmed live 2026-07-19). FIX: add a browser-ish UA. Pattern already in `discover.py:114` (`"User-Agent": "clearworks-research-pulse/1.0"`) — but that string still 403s some sites; use a real browser UA for the firm-scale sources.
- Poll loop `poll_source()` ~L151-206: skips inactive + null feed_url; parses via `feedparser`; diffs vs `last_seen_guid/pubdate`.

### Registry: aec.json
- File: `orgs/clearworksai/agents/muse/state/research-pulse/registry/aec.json`.
- Source entry fields: `id (src_<slug>)`, `source_name`, `url`, `feed_url (string|null)`, `source_type (podcast|youtube|article|data_feed|report)`, `industry[]`, `tags{topic[],signal[],authority,cadence,quality}`, `notebooklm_source_id`, poll metadata (`etag, last_modified, last_seen_guid, last_seen_pubdate, last_checked, consecutive_errors, active`).
- Null feed_url today: `src_fred`, `src_bls`, `src_u-s-census-construction-spending`, `src_dodge-architecture-billings-index`. Goal says fix the never-polled ones.

### test_registry.py — what a new row must satisfy
- `orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests/test_registry.py:76-130` → validates via `pulse_registry.validate_registry()`:
  - topic ∈ {indicators,strategy,operations,regulation,innovation} (or `registry.topic_vocab_extra[]`)
  - signal ∈ {leading,coincident,lagging,sentiment,macro,micro}
  - authority ∈ {academic,industry_expert,practitioner,news,vendor}
  - cadence ∈ {daily,weekly,monthly,quarterly,ad_hoc}
  - quality ∈ {high,medium,emerging,archival}
  - feed_url required for pollable types (podcast/youtube/article); may be null for data_feed/report
  - source_type ∈ SOURCE_TYPES; URL uniqueness (normalized); `notebooklm://` scheme allowed for non-pollable
- **New source rows MUST carry a full valid `tags{}` block** or they fail this test.

### Bucketing (deterministic, in code — NOT stored on the item)
- Rule (goal L10): topic ∈ {indicators, construction_spending} / macro-signal tied to spend/housing/billings → `spend_confidence`; else → `industry_news`. Cross-ref item `source_id` → `aec.json` source `tags`.
- `owner_voice` is its OWN bucket — from the static NotebookLM pool, not tag-derived.

### Owner-voice pool (Amendment 2)
- NotebookLM corpus id `7f3b85b7-5adc-4869-ace9-7e056354f4eb`. Binary `/private/tmp/whisper-venv/bin/notebooklm` (NOT on PATH; call full path). `notebooklm ask "<q>" --json`.
- Query ONCE for ~15-20 quotes on pricing/proposals/CA-phase/systems-breakdown tied to "integration failure, not tool failure"; store as static JSON pool; surface one unrepeated quote/day (rotate).
- VERIFIED LIVE 2026-07-20: notebooklm returns real quotes (Jack Sadler/Part Three, etc.) — zero placeholders needed. See sample.

### Output + delivery
- Dated file: `orgs/clearworksai/agents/muse/state/research-pulse/pulse/YYYY-MM-DD.json` (3-bucket schema).
- Telegram: chat 6690120787. No dedicated Telegram fn in the scripts today — muse crons emit via the agent runtime / comms layer. daily_digest.py should assemble the Telegram-formatted message; the send folds into the cron's morning run (the muse agent prompt sends it), OR daily_digest.py shells `cortextos bus send-telegram`. Decide in plan: prefer daily_digest.py emitting the formatted text to stdout/return + the cron sending, to keep the script side-effect-light. **Plan must pin ONE mechanism.**

### Build/test gate
- Root `package.json` build=tsup, test=vitest → **TypeScript only; does NOT cover Python.**
- daily_digest.py is Python → its real gate is `~/.venvs/research-pulse/bin/python -m pytest` on the research-pulse tests + `test_registry.py`. Plan must state: run `npm run build && npm test` (repo-wide green) AND the pytest suite (registry + new daily_digest test). No staging env in this repo — partial-ship fallback allowed (source-adds + 1 manual digest, defer cron polish).

## 3. Proof already in hand
Sample 3-bucket output (real data, live notebooklm quotes, zero placeholders): `orgs/clearworksai/agents/larry/.agent/one-big-feature/aec-daily-digest/sample-digest-output.md`. Sent to Josh 2026-07-20; he approved proceeding (picked Fable plan engine). Proves the shape + that owner-voice extraction works.

## 4. Open decisions for the plan stage
1. Telegram send owner: script-shells-`bus send-telegram` vs script-returns-text + cron-sends. (Recommend: script builds text, cron sends — keeps script pure/testable.)
2. UA header: single browser UA constant reused by fetch_feed; confirm it clears the firm-scale 403s.
3. New source rows: exact 6-7 firm-scale sources + valid tags blocks (Business of Architecture, EntreArchitect, Archinect UA-fix, Dezeen UA-fix, Building Design+Construction, Construction Physics; drop Construction Dive unless firm-scale-filterable). Spend-confidence: Calculated Risk, NAHB Eye on Housing, fixed FRED/BLS/Census feed_urls.
4. Owner-voice pool storage path + rotation-state file (which quotes already surfaced).
