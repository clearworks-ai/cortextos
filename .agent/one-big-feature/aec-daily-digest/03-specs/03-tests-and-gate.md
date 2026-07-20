# Spec 03 — tests, gate commands, live-run verification

## 1. New test file

CREATE `/Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/tests/test_daily_digest.py`

Follow the exact pattern of the sibling tests (`test_registry.py:1-46`): `unittest.TestCase`, `ROOT = Path(__file__).resolve().parent.parent` inserted into `sys.path`, `from scripts import daily_digest as MODULE` and `from scripts import pulse_registry`, all state under a `tempfile.TemporaryDirectory` patched into `PULSE_STATE_DIR` via `unittest.mock.patch.dict(os.environ, ...)` — never the real muse state dir.

Fixture builder (per-test): `pulse_registry.new_registry("aec", "AEC", "test")` with `topic_vocab_extra = ["construction_spending", "project_delivery", "infrastructure"]`, then `add_source` rows:
- `News Blog` — article, topic `["strategy"]`, signal `["sentiment"]` → industry_news
- `Macro Indicator` — article, topic `["indicators"]`, signal `["macro","leading"]` → spend_confidence
- `Spend Feed` — data_feed, feed_url set, topic `["indicators","construction_spending"]`, signal `["coincident"]` → spend_confidence
- `Mega GC Wire` — article, then set `active = False` (simulates deactivated construction-dive/ENR)
Save via `save_registry`; write `inbox.jsonl` in the tmp state dir with one item per source (vertical `"aec"`, fresh `ingested_at`), including a Skanska-style title (`"Skanska reports record $7B order intake"`) on the inactive source and one non-aec-vertical item; write `owner_voice_pool.json` with 2 quotes and `"surfaced": []`.

Required test methods (asserts per the goal's DONE-when):

1. `test_build_digest_three_way_bucketing` — `MODULE.build_digest(since_hours=48)` returns `buckets` with EXACTLY the keys `industry_news`, `spend_confidence`, `owner_voice`; the News Blog item is in industry_news; the Macro Indicator + Spend Feed items are in spend_confidence; **owner_voice is non-empty**.
2. `test_no_mega_gc_in_industry_news` — no item from the inactive source appears in ANY bucket; explicitly assert no title containing `"Skanska"`/`"Tutor Perini"` in `industry_news`.
3. `test_unknown_source_and_wrong_vertical_skipped` — an inbox item with an unregistered `source_id` and the non-aec item are absent from all buckets.
4. `test_title_filter_census` — with a source whose id is forced to `src_u-s-census-construction-spending` (build the row dict directly, id included, matching the fixture pattern of `test_registry.test_validate_rejects_duplicate_id...` which builds rows via json round-trip), an item titled "Advance Retail Sales" is skipped and one titled "Construction Spending May 2026" lands in spend_confidence.
5. `test_owner_voice_rotation_no_repeat_and_reset` — two successive `rotate_owner_voice(pool, count=1)` calls return different quotes; after the pool is exhausted, `surfaced` resets and rotation restarts; `surfaced` persists to the pool file (re-load and check).
6. `test_render_telegram_sections` — rendered text contains all three section headers (`INDUSTRY`, `SPEND CONFIDENCE`, `OWNER VOICE`) and the digest date; empty-bucket placeholder line renders when a bucket is empty.
7. `test_write_pulse_file_dated_path` — `write_pulse_file` writes `<state>/pulse/YYYY-MM-DD.json` matching `digest_date`, valid JSON round-trip equal to the digest dict.
8. `test_since_hours_window` — an inbox item with `ingested_at` 72h old is excluded at `since_hours=24`, included at `since_hours=96`.
9. `test_fetch_feed_sends_user_agent` — (delta_check UA fix) `unittest.mock.patch` `delta_check.requests.get` to capture kwargs; call `delta_check.fetch_feed("https://x/feed", None, None)`; assert `headers["User-Agent"] == delta_check.USER_AGENT` and it starts with `"Mozilla/5.0"`. (Lives in this file to avoid touching `test_delta_check.py`.)

## 2. Registry test must still pass with the new rows

`test_registry.py` (both copies) is fixture-based — the aec.json row additions don't touch it, but it gates the vocab every new row uses. Additionally validate the LIVE registry after the spec-01 edit:

```bash
/Users/joshweiss/.venvs/research-pulse/bin/python -c "import sys; sys.path.insert(0,'/Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/scripts'); import pulse_registry; r = pulse_registry.load_registry('aec'); print('aec.json valid,', len(r['sources']), 'sources')"
```
Expected: `aec.json valid, 21 sources` (load_registry raises on any invalid row).

## 3. Gate commands (exact, all must be green before PR)

```bash
# 1) Repo-wide TS gate (the goal's stated gate)
cd /Users/joshweiss/code/cortextos && npm run build && npm test

# 2) Python suite — FACT (verified 2026-07-20): pytest is NOT installed in the durable venv.
#    One-time install, then run pytest over BOTH research-pulse test dirs:
/Users/joshweiss/.venvs/research-pulse/bin/python -m pip install pytest
/Users/joshweiss/.venvs/research-pulse/bin/python -m pytest \
  /Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/tests \
  /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests -q
# Fallback if the pip install is refused (tests are stdlib unittest — pytest optional):
/Users/joshweiss/.venvs/research-pulse/bin/python -m unittest discover -s \
  /Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/tests -v
/Users/joshweiss/.venvs/research-pulse/bin/python -m unittest discover -s \
  /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/.claude/skills/research-pulse/tests -v

# 3) Live registry validation (section 2 above)
```

## 4. Live-run verification (real corpus, real inbox, real Telegram)

Run in order after all code + registry changes are in place:

1. **Pool build (one-time, real NotebookLM pull):** spec 02 §6 commands (`notebooklm use 7f3b85b7-...` then `ask ... --json`); verify `owner_voice_pool.json` exists with 15-20 quotes, `surfaced: []`, and zero placeholder text.
2. **Feed revival:** `/Users/joshweiss/.venvs/research-pulse/bin/python /Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/scripts/delta_check.py --vertical aec` — summary JSON shows the new sources polled with NO errors for src_dezeen / src_archinect / src_entrearchitect / src_business-of-architecture / src_calculated-risk / src_nahb-eye-on-housing / src_construction-physics (UA fix proven live), and construction-dive/ENR are skipped (inactive).
3. **Dry-run digest:** `daily_digest.py --vertical aec --since-hours 336 --dry-run` → stdout shows all 3 sections; no state written. (336h window because new sources have no prior `last_seen_guid` — first delta_check run seeds them and only newer items flow; widen the window or run delta_check twice across a real posting interval if industry_news is empty on first pass.)
4. **Real run:** same command without `--dry-run` → `state/research-pulse/pulse/<today>.json` exists; `surfaced` in the pool grew by 1.
5. **Telegram:** send the stdout text to 6690120787 (via muse agent / `cortextos bus send-telegram`); confirm receipt on the phone — all 3 buckets populated.
6. **Mega-GC spot check (goal):** `python -c` load `pulse/<today>.json` and assert no title in `industry_news` matches `skanska|tutor perini` (case-insensitive) — must be empty.
7. **Cron check:** diff of muse `config.json` shows the `crons` array length unchanged (prompt-only edit).

## 5. Acceptance checklist (copied verbatim from the goal's DONE-when)

- [ ] aec.json sources have real non-null feed_url, pass test_registry.py, industry-news has no mega-contractor items (spot check for Skanska/Tutor Perini-style)
- [ ] daily_digest.py test proves correctly-bucketed 3-way JSON from a real inbox read plus quote pool
- [ ] cron diff adds no second cron
- [ ] build+test pass
- [ ] live run reaches Telegram, all 3 buckets populated

(Caveat carried from the master plan §7: `src_fred`/`src_bls` legitimately remain `feed_url:null` `data_feed` rows — FRED retired RSS, BLS WAF-blocks non-browser fetches; both verified live. All POLLABLE fixes are real non-null URLs.)

HALT after PR opened + gates green — Josh merges, not the pipeline.
