# AEC Daily Digest — Master Plan (OBF stage 2)

Slug: `aec-daily-digest` · Repo: `/Users/joshweiss/code/cortextos` · Planner: Fable (Josh-picked)
Research: `.agent/one-big-feature/aec-daily-digest/01-research.md` (authoritative on paths/schemas)
Binding goal: `orgs/clearworksai/agents/muse/state/goals/aec-daily-digest.md`
Approved output shape: `orgs/clearworksai/agents/larry/.agent/one-big-feature/aec-daily-digest/sample-digest-output.md`
Deadline: real digest reaches Telegram before Mon 2026-07-20 ~08:00 PT.

## 1. Scope statement

Build `daily_digest.py` (new script in the community research-pulse skill, sibling of `delta_check.py`) that reads muse's research-pulse inbox and emits a deterministic 3-bucket AEC digest — `{industry_news, spend_confidence, owner_voice}` — writes it to a dated pulse file, and prints Telegram-ready text. Plus: fix the missing User-Agent in `delta_check.py` fetch (403 root cause on Dezeen/Archinect/ENR), fix/extend the `aec.json` registry (7 new firm-scale + spend sources with live-verified feed URLs, 4 null-feed fixes, 2 mega-GC deactivations), build a one-time static owner-voice quote pool from the NotebookLM "AEC Pulse Research" corpus, extend the EXISTING `research-pulse-delta` cron prompt's morning firing (no new cron), and add a unit test. Single repo, single cohesive feature, no schema change → OBF.

Out of scope: any new cron; any mega-GC content (Skanska/Tutor Perini-scale); any change outside the community research-pulse skill + muse state/config; merging (Josh-only).

## 2. The 4 open decisions (research §4) — RESOLVED

1. **Telegram send owner → daily_digest.py builds the formatted text + writes the dated pulse file; the cron's morning agent run sends it via Telegram (bus send-telegram to 6690120787).** Verified: the `research-pulse-delta` cron prompt is an agent prompt and muse's other crons already instruct "Send Telegram 6690120787:" — the agent can send. Keeps the script pure/testable (no network side effects in the script itself).
2. **UA header → a single module-level constant `USER_AGENT` (real browser UA string) in `delta_check.py`, applied unconditionally inside `fetch_feed()`.** Verified live 2026-07-20: Dezeen `/feed/` and feedburner Archinect return 200 with a Chrome UA via curl. No shared helper file — one constant, one line in the one fetch path; `daily_digest.py` never fetches feeds (it reads the inbox), so it doesn't need the UA.
3. **Source set → 7 new rows, all feed URLs live-verified 200 with real XML on 2026-07-20** (exact rows in `03-specs/01-registry-sources.md`): Business of Architecture (libsyn podcast feed — the site's own `/feed/` is hard-403 "Public RSS Feed Unavailable"), EntreArchitect, Archinect (feedburner), Dezeen, Construction Physics (industry_news); Calculated Risk, NAHB Eye on Housing (spend_confidence). **Building Design+Construction is DROPPED** — its advertised RSS href 404s live (verified; see spec 01 §5). **Construction Dive and ENR are deactivated** (`active:false`) — both are mega-GC-dominant and not deterministically firm-scale-filterable; this is what guarantees the goal's Skanska/Tutor-Perini spot check passes. Census gets the live Census economic-indicators RSS; Dodge gets the live construction.com feed; FRED + BLS stay `feed_url:null` (null-ok for `data_feed` per validator) with documented indirect coverage — FRED retired RSS, BLS WAF 403s even browser-UA curl (both verified).
4. **Owner-voice pool → single file `orgs/clearworksai/agents/muse/state/research-pulse/owner_voice_pool.json`** holding both the static quotes AND the rotation state: `{"quotes":[{"quote","speaker","theme_tag"}], "surfaced":["<12-hex sha1 of quote text>", ...]}`. One atomic file (written via `pulse_registry.atomic_write_json`), no separate rotation file to drift. One unrepeated quote/day (goal Amendment 2); when exhausted, `surfaced` resets.

## 3. Deterministic bucketing algorithm (code, not stored on items)

For each inbox item (`vertical=="aec"`, within the digest window), resolve `item.source_id` → registry source row:

```
skip item if source is unknown OR source.active is false          # kills mega-GC (deactivated sources)
skip item if source_id has a TITLE_FILTER and no keyword matches   # only src_u-s-census-construction-spending: ["construction"]
topics  = set(source.tags.topic);  signals = set(source.tags.signal)
bucket  = "spend_confidence"  if ("construction_spending" in topics)
                              or ("indicators" in topics and "macro" in signals)
          else "industry_news"
```

`owner_voice` is its own bucket from the static pool (never tag-derived). With the tag fixes in spec 01, this rule lands: FRED/BLS/Census/Dodge-ABI/Calculated-Risk/NAHB → spend_confidence; all podcasts/YouTube/blogs/Archinect/Dezeen → industry_news. Pure function of (item, registry) — fully unit-testable.

## 4. File inventory

**Lane A — git-tracked, ships via PR** (verified tracked; community tree is the canonical one — the cron invokes `delta_check.py` HERE, and the muse-tree skill copy has no `delta_check.py`; do NOT duplicate into the muse tree):

| # | Path | Action |
|---|------|--------|
| 1 | `community/agents/research-agent/.claude/skills/research-pulse/scripts/daily_digest.py` | CREATE — spec 02 |
| 2 | `community/agents/research-agent/.claude/skills/research-pulse/scripts/delta_check.py` | MODIFY — `USER_AGENT` constant + one header line in `fetch_feed()` (~L35-40) — spec 02 §3 |
| 3 | `community/agents/research-agent/.claude/skills/research-pulse/tests/test_daily_digest.py` | CREATE — spec 03 |

**Lane B — GITIGNORED live state (verified with `git check-ignore` 2026-07-20): applied directly on disk, can NOT ship via PR.** Codexer edits these in place; the PR description must list them as "live-state changes applied outside the diff":

| # | Path | Action |
|---|------|--------|
| 4 | `orgs/clearworksai/agents/muse/state/research-pulse/registry/aec.json` | MODIFY — 7 new rows, 4 feed/tag fixes, 2 deactivations — spec 01. Validate after edit with `load_registry("aec")`. Back up the file first (`cp aec.json aec.json.bak-aec-daily-digest`). |
| 5 | `orgs/clearworksai/agents/muse/config.json` | MODIFY — append the morning-digest step to the `research-pulse-delta` cron `prompt` (same cron, no new cron entry) — spec 02 §7 |
| 6 | `orgs/clearworksai/agents/muse/state/research-pulse/owner_voice_pool.json` | CREATE — one-time NotebookLM extraction — spec 02 §6 |

Edit timing for #4: the cron fires 06:15/18:15 PT and rewrites `aec.json`; apply the registry edit outside those minutes and re-validate.

## 5. Gate / test strategy

All gates in `03-specs/03-tests-and-gate.md`. Summary:
1. `cd /Users/joshweiss/code/cortextos && npm run build && npm test` — repo-wide green (TS gate; does not cover Python but is the goal's stated gate).
2. Python suite green in the durable venv. **Fact: pytest is NOT installed in `~/.venvs/research-pulse` (verified);** one-time `pip install pytest` into that venv, then run pytest over BOTH research-pulse test dirs (community + muse copies — both have `test_registry.py`). Fallback: `python -m unittest discover`.
3. Live registry validation: `pulse_registry.load_registry("aec")` raises on any invalid row.
4. Live-run proof: real `delta_check.py` run (403s cleared), real `daily_digest.py` run, real Telegram receipt with all 3 buckets, mega-GC grep empty.

## 6. Partial-ship fallback (deadline is Mon 08:00 PT)

If the full chain can't land in time, ship in this order and tell Josh which half shipped: (a) registry source-adds + feed fixes (Lane B #4, validated); (b) owner-voice pool build (#6); (c) one MANUAL digest run + Telegram send using `daily_digest.py` even if the cron-prompt wiring (#5) and PR polish are deferred. The cron-prompt edit is the safest thing to defer — the digest still exists as a manually-runnable script.

## 7. DONE when (copied verbatim from the goal)

- aec.json sources have real non-null feed_url, pass test_registry.py, industry-news has no mega-contractor items (spot check for Skanska/Tutor Perini-style)
- daily_digest.py test proves correctly-bucketed 3-way JSON from a real inbox read plus quote pool
- cron diff adds no second cron
- build+test pass
- live run reaches Telegram, all 3 buckets populated

(Per goal: FRED/BLS remain null-feed `data_feed` rows — validator-legal, never polled by delta_check, coverage documented via Calculated Risk/NAHB/Census. Flagged here so the "real non-null feed_url" line is read as "the pollable fixes are real", not as inventing a FRED RSS that no longer exists.)

HALT conditions (from goal): PR opened + gates green → stop, report, await Josh's merge approval. Gate failure → stop and report, no silent fix-forward. Ambiguity → ask.
