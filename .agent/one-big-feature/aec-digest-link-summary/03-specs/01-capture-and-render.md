# Spec 01 — Capture summary at ingestion, carry through digest, render link + summary

All paths relative to `community/agents/research-agent/.claude/skills/research-pulse/`.
Line numbers reference current file state (verified 2026-07-20). Style: `from __future__ import annotations` already present in all touched files; full type hints; stdlib only; no new deps; no comments on unchanged code.

---

## Change 1 — `scripts/delta_check.py`: `clean_summary()` helper + capture

### 1a. Imports (top of file, lines 3–8)
Add `html` and `re` to the stdlib import block, alphabetized:
```python
import argparse
import calendar
import html
import json
import os
import re
import sys
```

### 1b. Module constants (after `USER_AGENT` block, i.e. after line 30)
```python
SUMMARY_MAX_CHARS = 160
_TAG_RE = re.compile(r"<[^>]+>")
```

### 1c. New helper (place immediately after `_entry_guid`, i.e. after line 74)
Exact signature and behavior:
```python
def clean_summary(value: object, max_chars: int = SUMMARY_MAX_CHARS) -> str:
    if not isinstance(value, str) or not value:
        return ""
    text = html.unescape(_TAG_RE.sub(" ", value))
    text = " ".join(text.split())
    if len(text) > max_chars:
        text = text[: max_chars - 1].rstrip() + "…"
    return text
```
Behavior contract:
- Non-`str` or empty input → `""`.
- HTML tags replaced by a space, then entities unescaped (`&amp;` → `&`), then all whitespace runs (incl. newlines) collapsed to single spaces, stripped at ends (via `" ".join(text.split())`).
- If cleaned text exceeds `max_chars`, truncate so the final string is ≤ `max_chars` **including** the trailing `…` (U+2026, one char): slice to `max_chars - 1`, rstrip, append `…`.

### 1d. Capture in `parse_entries()` (item dict, lines 112–117)
Change the item dict to:
```python
        item = {
            "guid": guid,
            "title": _entry_value(entry, "title") or "",
            "url": _entry_value(entry, "link") or "",
            "pubdate": _epoch_to_iso(epoch),
            "summary": clean_summary(_entry_value(entry, "summary")),
        }
```
Note: feedparser normalizes RSS `<description>` → `entry.summary`; `_entry_value` (line 59) handles attr/dict access. No changes needed in `poll_source`/`poll_vertical` — `record_delta` and `new_items` spread the full item dict, so `summary` propagates to registry deltas, the pulse snapshot, and the inbox automatically.

---

## Change 2 — `scripts/daily_digest.py`: carry + render

### 2a. `bucketize()` — carry `summary` (appended dict, lines 128–136)
Change to:
```python
        buckets[bucket_name].append(
            {
                "title": title,
                "url": str(item.get("url") or ""),
                "source_name": str(source.get("source_name") or source_id or "unknown"),
                "source_id": source_id,
                "pubdate": str(item.get("pubdate") or ""),
                "summary": str(item.get("summary") or ""),
            }
        )
```
`item.get("summary") or ""` makes legacy inbox rows (no key) yield `""` — backward compatible.

### 2b. `render_telegram()` — surface link + summary (non-owner_voice loop, lines 221–226)
Replace the `else:` branch body with:
```python
        else:
            for item in items:
                title = str(item.get("title") or "").strip()
                source_name = str(item.get("source_name") or "unknown").strip()
                pubdate = str(item.get("pubdate") or "").strip()
                published = pubdate[:10] if len(pubdate) >= 10 else "unknown date"
                lines.append(f"• {title} ({source_name}, {published})")
                url = str(item.get("url") or "").strip()
                if url:
                    lines.append(f"  {url}")
                summary = str(item.get("summary") or "").strip()
                if summary:
                    lines.append(f"  {summary}")
```
Layout rules (Telegram-safe, phone-readable):
- URL rendered **bare** on its own 2-space-indented line — no markdown wrapping, no `_`/`*` decoration (underscores in URLs corrupt Telegram markdown; bare URLs auto-link).
- Summary rendered as plain text on its own 2-space-indented line — no italics/bold wrapping.
- Fallbacks: empty `summary` → url line only (no placeholder, no crash). Empty `url` AND empty `summary` → item block identical to current output (`• {title} ({source_name}, {published})` only). Empty `url` with non-empty `summary` → title line + summary line (no url line).
- `owner_voice` branch (lines 215–219) unchanged.

---

## Change 3 — `tests/test_delta_check.py`

### 3a. FIX existing assertion (test_run_summary_new_items_carries_item_payload, lines 125–128)
This test asserts an exact key set and WILL fail after Change 1d. Update to:
```python
            self.assertEqual(
                set(summary["new_items"][0].keys()),
                {"vertical", "source_id", "guid", "title", "url", "pubdate", "summary"},
            )
```
Optionally add below the existing value assertions (fixture has no `<description>`):
```python
            self.assertEqual(summary["new_items"][0]["summary"], "")
```

### 3b. New tests (append inside `DeltaCheckTests`, matching existing unittest style)
```python
    def test_clean_summary_strips_html_and_collapses_whitespace(self) -> None:
        raw = "<p>Margins &amp; backlog</p>\n  <b>held firm</b> in Q2"
        self.assertEqual(MODULE.clean_summary(raw), "Margins & backlog held firm in Q2")

    def test_clean_summary_truncates_with_ellipsis(self) -> None:
        raw = "x" * 400
        cleaned = MODULE.clean_summary(raw)
        self.assertEqual(len(cleaned), MODULE.SUMMARY_MAX_CHARS)
        self.assertTrue(cleaned.endswith("…"))

    def test_clean_summary_non_string_returns_empty(self) -> None:
        self.assertEqual(MODULE.clean_summary(None), "")
        self.assertEqual(MODULE.clean_summary(""), "")
        self.assertEqual(MODULE.clean_summary(123), "")

    def test_parse_entries_captures_summary_and_defaults_empty(self) -> None:
        feed = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Summary Feed</title>
    <item>
      <title>With description</title>
      <link>https://example.com/a</link>
      <guid>guid-a</guid>
      <pubDate>Tue, 14 Jul 2026 00:00:00 GMT</pubDate>
      <description>&lt;p&gt;Firm margins &amp;amp; backlog held&lt;/p&gt;</description>
    </item>
    <item>
      <title>Without description</title>
      <link>https://example.com/b</link>
      <guid>guid-b</guid>
      <pubDate>Mon, 13 Jul 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
"""
        entries = MODULE.parse_entries(feed)
        self.assertEqual(entries[0]["guid"], "guid-a")
        self.assertEqual(entries[0]["summary"], "Firm margins & backlog held")
        self.assertEqual(entries[1]["guid"], "guid-b")
        self.assertEqual(entries[1]["summary"], "")
```
(Note: `<description>` content is XML-escaped HTML — feedparser yields `<p>Firm margins &amp; backlog held</p>`, which `clean_summary` strips/unescapes to the asserted string. This test requires real `feedparser`; it is importable in this suite — existing tests call `MODULE.parse_entries` on fixtures unconditionally.)

---

## Change 4 — `tests/test_daily_digest.py`

Append inside `DailyDigestTests` (matching the digest-dict-literal pattern of `test_render_telegram_sections`, line 294):

```python
    def test_render_telegram_surfaces_url_and_summary(self) -> None:
        digest = {
            "digest_date": "2026-07-20",
            "buckets": {
                "industry_news": [
                    {
                        "title": "Firm operators share margin playbooks",
                        "source_name": "News Blog",
                        "pubdate": "2026-07-20T04:30:00Z",
                        "url": "https://example.com/news/item",
                        "summary": "Operators detail how CA-phase discipline preserves design margin.",
                    }
                ],
                "spend_confidence": [],
                "owner_voice": [],
            },
        }

        rendered = MODULE.render_telegram(digest)
        lines = rendered.splitlines()
        idx = lines.index("• Firm operators share margin playbooks (News Blog, 2026-07-20)")
        self.assertEqual(lines[idx + 1], "  https://example.com/news/item")
        self.assertEqual(
            lines[idx + 2],
            "  Operators detail how CA-phase discipline preserves design margin.",
        )

    def test_render_telegram_empty_summary_renders_link_only(self) -> None:
        digest = {
            "digest_date": "2026-07-20",
            "buckets": {
                "industry_news": [
                    {
                        "title": "Firm operators share margin playbooks",
                        "source_name": "News Blog",
                        "pubdate": "2026-07-20T04:30:00Z",
                        "url": "https://example.com/news/item",
                        "summary": "",
                    }
                ],
                "spend_confidence": [],
                "owner_voice": [],
            },
        }

        rendered = MODULE.render_telegram(digest)
        lines = rendered.splitlines()
        idx = lines.index("• Firm operators share margin playbooks (News Blog, 2026-07-20)")
        self.assertEqual(lines[idx + 1], "  https://example.com/news/item")
        self.assertEqual(lines[idx + 2], "")

    def test_render_telegram_no_url_no_summary_matches_legacy(self) -> None:
        digest = {
            "digest_date": "2026-07-20",
            "buckets": {
                "industry_news": [
                    {
                        "title": "Firm operators share margin playbooks",
                        "source_name": "News Blog",
                        "pubdate": "2026-07-20T04:30:00Z",
                    }
                ],
                "spend_confidence": [],
                "owner_voice": [],
            },
        }

        rendered = MODULE.render_telegram(digest)
        lines = rendered.splitlines()
        idx = lines.index("• Firm operators share margin playbooks (News Blog, 2026-07-20)")
        self.assertEqual(lines[idx + 1], "")
        self.assertNotIn("https://", rendered)

    def test_bucketize_carries_summary_and_defaults_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry()
            items = self.make_inbox_items(registry)
            items[0]["summary"] = "Operators detail CA-phase discipline."
            self.write_state(tmp, registry, items, self.make_quotes())

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                digest = MODULE.build_digest(since_hours=48, now=self.now, rotate=False)

        news = digest["buckets"]["industry_news"]
        self.assertEqual(news[0]["summary"], "Operators detail CA-phase discipline.")
        spend = digest["buckets"]["spend_confidence"]
        self.assertTrue(all(item["summary"] == "" for item in spend))
```
Note: `make_inbox_items` puts "Firm operators share margin playbooks" (News Blog) into `industry_news`; Macro Indicator + Spend Feed items land in `spend_confidence` and have no `summary` key → assert default `""`.

The empty-line assertions (`lines[idx + 1] == ""` / `lines[idx + 2] == ""`) hold because these digests contain exactly one industry_news item, so the next emitted line is the blank bucket separator (`lines.append("")` at daily_digest.py line 227).

---

## Verification (run after implementation)
```bash
cd /Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse
python3 -m pytest tests/ -x -q
```
All tests green, including the updated key-set assertion. No other files modified; `git diff --stat` must show exactly the 4 files above.
