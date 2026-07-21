# REVIEW — aec-digest-link-summary / 04-implement.diff

## VERDICT: PASS

Reviewed against `03-specs/01-capture-and-render.md`. Diff verified as applied to the working tree; claims checked against real source, and the full suite executed.

**Test evidence:**
- `/usr/bin/python3 -m pytest tests/ -q` → **66 passed** (interpreter has `feedparser`, lacks `requests`).
- Homebrew `python3` (has `requests`, lacks `feedparser`): 7 failures post-diff vs 6 failures pre-diff (verified via `git stash` baseline run) — all are the pre-existing environmental `feedparser is None` class; the single "new" failure is the new `parse_entries` test, which requires feedparser exactly like the 6 pre-existing ones. No regression introduced.

---

## Checklist findings

### 1. Scope — OK
`git status --porcelain` under `community/agents/research-agent/.claude/skills/research-pulse/` shows exactly the 4 in-scope files (`scripts/delta_check.py`, `scripts/daily_digest.py`, `tests/test_delta_check.py`, `tests/test_daily_digest.py`); `git diff --stat` = 162 insertions, 6 deletions, 4 files. No scope creep. (Repo-root `state/pipeline-run.json` is modified but is pipeline state, not part of this diff artifact.)

### 2. Backward compat — OK
- `daily_digest.py:135` `"summary": str(item.get("summary") or "")` — missing key → `None`... actually `.get` → `None` → `or ""` → `""`; explicit `None` → `""`; falsy non-str values coerced to `""`. Correct.
- `render_telegram` (daily_digest.py:228-233): both url and summary lines are conditional on non-empty strip; legacy item with no url/summary renders byte-identical to legacy (proven by `test_render_telegram_no_url_no_summary_matches_legacy`, which asserts the next line is the bucket separator `""` and no `https://` anywhere).

### 3. clean_summary correctness — OK
- `delta_check.py:81-88`. Truncation: `text[:159].rstrip() + "…"` → exactly 160 chars for the all-`x` case (test asserts `len == SUMMARY_MAX_CHARS`); when `rstrip()` removes boundary whitespace the result is ≤160, which matches the spec contract ("≤ max_chars including the trailing …"). `len(text) == 160` correctly not truncated.
- `<[^>]+>`: negated class matches newlines, so multi-line tags strip correctly. Unclosed `<foo` (no `>`) and empty `<>` are left literal — accepted, spec dictates this exact regex.
- Non-string input (`None`, `123`) and `""` → `""` via `isinstance` guard; tested.
- Strip-then-unescape order is spec-mandated; see non-blocking note 1.

### 4. Telegram safety — Acceptable, not a defect
The message already uses `**bold**` headers, so it is markdown-bearing; a bare URL or summary containing `_` could trigger stray italics under legacy-Markdown parse mode (known fleet issue: `feedback_telegram_underscore_markdown_corruption`). However the spec explicitly chose bare unwrapped URLs (auto-link) and plain-text summaries, and any escaping belongs in the delivery layer, not the renderer. Recorded as non-blocking risk (note 2), not a diff defect.

### 5. Test coverage — OK
- All 4 required cases asserted: surface (url line + summary line at exact indices), empty-summary → link-only, no-url/no-summary → legacy-identical, bucketize carry-through + default `""` for legacy spend rows.
- The pre-existing key-set assertion (`test_delta_check.py:127-129`) was updated to include `"summary"` — without this the suite would have gone red; also adds `summary == ""` value assertion per spec's optional line.
- The two mock-shim edits are **legitimate and necessary, not coverage-weakening**:
  - `test_fetch_feed_sends_user_agent` (test_daily_digest.py:475-483): old `patch.object(DELTA.requests, "get", ...)` throws `AttributeError` when `requests` is `None` (delta_check.py:17-20 guarded import — true under `/usr/bin/python3`). New whole-module Mock preserves the identical assertions (User-Agent header content).
  - `test_run_summary...` (test_delta_check.py:201): `patch.object(MODULE, "requests", object())` defeats the `main()` dependency guard at delta_check.py:284 (`if feedparser is None or requests is None: return 1`) — required for the test to reach the updated key-set assertion under an interpreter lacking `requests`; network is never hit because `poll_vertical` is mocked. Net effect: the suite is now fully green under one interpreter for the first time (baseline had zero interpreters where everything passed).

### 6. Hygiene — OK
No `print` debug, no dead code, no comments on unchanged code. New imports `html` and `re` are stdlib, correctly alphabetized. Full type hints on `clean_summary`. `…` escape ≡ spec's literal `…` (single char).

---

## Non-blocking notes
1. **Strip-then-unescape ordering** (delta_check.py:84, spec-mandated): double-escaped feeds (`&lt;b&gt;text&lt;/b&gt;` inside the summary value) unescape into literal `<b>text</b>` in the rendered summary after tag-stripping. Rare in practice; if it shows up in real digests, a second `_TAG_RE.sub` pass after unescape fixes it.
2. **Telegram underscore risk** (checklist 4): if digest delivery uses legacy Markdown parse mode, `_` in URLs/summaries can italicize. Mitigate at the delivery layer (plain parse mode or MarkdownV2 escaping) — out of scope here.
3. **Untested fallback branch**: "empty url + non-empty summary → title line + summary line" (spec Change 2b fallback #3) has no dedicated test; the spec's own test list omitted it too. Trivially covered by the conditional structure; add later if churn touches `render_telegram`.
4. `clean_summary(value, max_chars=0)` would misbehave (`text[:-1]`), but no call site passes a non-default `max_chars`; the parameter exists per spec signature.
