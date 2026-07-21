# 02 — Master Plan: aec-digest-link-summary

## Goal
Surface a clickable URL + 1-line HTML-stripped summary per article in the Telegram AEC daily digest. Summary captured deterministically at RSS ingestion (no per-article HTTP fetch). Graceful degradation: no summary → link only; no url → today's exact render.

Base dir: `community/agents/research-agent/.claude/skills/research-pulse/`

## Files touched (complete list)
1. `scripts/delta_check.py` — add stdlib HTML-strip/truncate helper `clean_summary()`; capture `summary` key in `parse_entries()`.
2. `scripts/daily_digest.py` — carry `summary` through `bucketize()`; render url + summary lines in `render_telegram()`.
3. `tests/test_delta_check.py` — fix key-set assertion (line 125–128) to include `"summary"`; add capture/strip/truncate tests.
4. `tests/test_daily_digest.py` — add render tests for the 4-case matrix; extend one bucketize assertion for carry-through.

No other files. No new runtime deps. No fixture changes (existing fixtures lack `<description>` and correctly exercise the empty-summary default).

## Ordered steps
1. **delta_check.py — helper**: add `import html`, `import re`; module-level `SUMMARY_MAX_CHARS = 160` and `_TAG_RE`; add `clean_summary(value: object, max_chars: int = SUMMARY_MAX_CHARS) -> str` (strip tags → unescape entities → collapse whitespace → truncate with `…`; non-str/empty → `""`).
2. **delta_check.py — capture**: in `parse_entries()` item dict (line 112–117), add `"summary": clean_summary(_entry_value(entry, "summary"))`. `record_delta`/`new_items` spread the dict — summary flows to registry deltas, pulse snapshot, and inbox with no further changes.
3. **daily_digest.py — carry**: in `bucketize()` appended dict (lines 128–136), add `"summary": str(item.get("summary") or "")`.
4. **daily_digest.py — render**: in `render_telegram()` non-owner_voice loop (lines 221–226), after the existing bullet line, append `  {url}` line when url non-empty, then `  {summary}` line when summary non-empty. Bare URL (no markdown wrapping — Telegram underscore hazard), plain-text summary.
5. **Tests**: update the one breaking assertion; add new tests per matrix below.
6. **Verify**: `python3 -m pytest community/agents/research-agent/.claude/skills/research-pulse/tests/ -x -q` — full suite green.

## Backward-compat guarantee
- Every read of `summary` uses `.get("summary") or ""` / `clean_summary` empty default — legacy inbox.jsonl rows, registry deltas, and pulse snapshots without the key parse and render without error.
- When `summary == ""` and `url == ""` (or url missing), rendered output for that item is byte-identical to today's `• {title} ({source_name}, {published})`.
- Existing fixture-driven tests keep passing unmodified except the single exact-key-set assertion, which is updated deliberately.

## Test matrix
| # | Case | File | Assertion |
|---|------|------|-----------|
| a1 | HTML stripped + entities unescaped + whitespace collapsed | test_delta_check.py | `clean_summary('<p>A &amp; B</p>\n  <b>C</b>')` == `"A & B C"` |
| a2 | Truncated at 160 chars with ellipsis | test_delta_check.py | `len(result) == 160`, endswith `"…"` |
| a3 | Non-string / missing → "" | test_delta_check.py | `clean_summary(None) == ""` |
| a4 | parse_entries captures summary from `<description>`; absent → "" | test_delta_check.py | inline XML feed: item with description → cleaned summary; fixture feed → `""` |
| a5 | Payload key set now includes summary (updated existing test) | test_delta_check.py | key set `{"vertical","source_id","guid","title","url","pubdate","summary"}` |
| b | Summary + url surfaced in render | test_daily_digest.py | bullet line, url line, summary line all present in order |
| c | Empty summary → link only, no summary/placeholder line | test_daily_digest.py | url line present; no summary text; line count check |
| d | Empty url + empty summary → legacy render unchanged | test_daily_digest.py | item block == exactly `• {title} ({source_name}, {published})` |
| e | bucketize carries summary; missing key defaults "" | test_daily_digest.py | bucketized item `["summary"]` values |

## Acceptance
- Full test suite green (`pytest tests/` under the skill dir).
- `daily_digest.py --dry-run` on synthetic state renders phone-readable output: bullet, bare clickable url, 1-line summary.
- No `any`-equivalents, strict style match (`from __future__ import annotations`, type hints), no new deps, no console noise.
