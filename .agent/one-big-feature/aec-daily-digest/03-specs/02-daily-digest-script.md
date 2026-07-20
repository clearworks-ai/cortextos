# Spec 02 — daily_digest.py + delta_check UA fix + owner-voice pool + cron wiring

## 1. Location

CREATE `/Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/scripts/daily_digest.py`

This is the dir where `delta_check.py` actually lives and where the cron points its interpreter (`/Users/joshweiss/.venvs/research-pulse/bin/python`). **Do NOT put it in the muse-tree skill copy** (`orgs/clearworksai/agents/muse/.claude/skills/research-pulse/scripts/`) — that copy has no `delta_check.py` and the cron never imports from it.

## 2. Imports / reuse

Follow `delta_check.py`'s exact import pattern (file:1-26):
```python
from __future__ import annotations
import argparse, hashlib, json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
try:
    from . import pulse_registry
except ImportError:
    import pulse_registry  # type: ignore[no-redef]
```
Reused from `pulse_registry`: `load_registry("aec")`, `state_dir()`, `atomic_write_json()`, `utc_now_iso()`. No feedparser/requests needed — this script reads the inbox, it never fetches feeds.

## 3. delta_check.py UA fix (MODIFY, tracked file)

In `community/agents/research-agent/.claude/skills/research-pulse/scripts/delta_check.py`, add one module-level constant (after `DEPENDENCY_MESSAGE`, ~line 27):
```python
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
```
and in `fetch_feed()` (currently lines 29-52), change the headers init from `headers: dict[str, str] = {}` to:
```python
headers: dict[str, str] = {"User-Agent": USER_AGENT}
```
Nothing else changes. (Verified with this exact UA via curl 2026-07-20: Dezeen `/feed/` and feedburner Archinect return 200; the previous 403s were UA-based. BoA's site feed and BLS still 403 — handled at the registry level, spec 01.) `discover.py:114` keeps its own `clearworks-research-pulse/1.0` UA — out of scope.

## 4. daily_digest.py — paths, constants, functions

```python
VERTICAL_DEFAULT = "aec"
TELEGRAM_CHAT_ID = "6690120787"          # informational; the script does NOT send
INBOX_PATH  = pulse_registry.state_dir() / "inbox.jsonl"
POOL_PATH   = pulse_registry.state_dir() / "owner_voice_pool.json"
PULSE_DIR   = pulse_registry.state_dir() / "pulse"     # dated file: pulse/YYYY-MM-DD.json
SPEND_TOPIC = "construction_spending"
TITLE_FILTERS = {"src_u-s-census-construction-spending": ["construction"]}
```
(`state_dir()` honors `PULSE_STATE_DIR` env → tests point it at a tmp dir, prod resolves to `orgs/clearworksai/agents/muse/state/research-pulse`.)

Function signatures (all pure except the two writers):

```python
def quote_id(quote: str) -> str
    # hashlib.sha1(quote.encode("utf-8")).hexdigest()[:12]

def load_inbox(vertical: str = VERTICAL_DEFAULT, since_hours: int = 24,
               now: datetime | None = None) -> list[dict]
    # Read INBOX_PATH line-by-line (json.loads per line, skip blank/corrupt lines).
    # Keep items where item["vertical"] == vertical and ingested_at >= now - since_hours.
    # ingested_at parses with the same "%Y-%m-%dT%H:%M:%SZ" format delta_check uses.
    # Returns newest-first by pubdate (fallback ingested_at). Missing file -> [].

def bucketize(items: list[dict], registry: dict) -> dict[str, list[dict]]
    # Deterministic (master plan §3):
    #   source = {s["id"]: s for s in registry["sources"]}.get(item["source_id"])
    #   skip if source is None or not source.get("active", True)
    #   skip if TITLE_FILTERS.get(source_id) and no keyword appears case-insensitively in title
    #   topics/signals from source["tags"]
    #   spend_confidence if SPEND_TOPIC in topics or ("indicators" in topics and "macro" in signals)
    #   else industry_news
    # Each emitted item: {title, url, source_name, source_id, pubdate}.
    # Dedupe by guid within the window (first wins). Cap each bucket at 6, newest first.
    # Returns {"industry_news": [...], "spend_confidence": [...]}.

def load_pool(path: Path = POOL_PATH) -> dict
    # json.load; missing file -> {"quotes": [], "surfaced": []}

def rotate_owner_voice(pool: dict, count: int = 1, save: bool = True) -> list[dict]
    # Pick the first `count` quotes whose quote_id(q["quote"]) is NOT in pool["surfaced"].
    # If fewer than count remain unsurfaced, reset pool["surfaced"] = [] first (cycle restarts).
    # Append picked ids to pool["surfaced"]; if save: pulse_registry.atomic_write_json(POOL_PATH, pool).
    # Returns the picked quote dicts [{quote, speaker, theme_tag}]. Empty pool -> [].
    # count=1 per goal Amendment 2: one unrepeated quote/day.

def build_digest(vertical: str = VERTICAL_DEFAULT, since_hours: int = 24,
                 now: datetime | None = None, rotate: bool = True) -> dict
    # registry = pulse_registry.load_registry(vertical)
    # buckets = bucketize(load_inbox(vertical, since_hours, now), registry)
    # buckets["owner_voice"] = rotate_owner_voice(load_pool(), count=1, save=rotate)
    # returns {"digest_date": "YYYY-MM-DD" (UTC now or --date),
    #          "generated_at": pulse_registry.utc_now_iso(),
    #          "vertical": vertical, "since_hours": since_hours,
    #          "buckets": buckets}

def render_telegram(digest: dict) -> str
    # The approved sample shape (sample-digest-output.md):
    #   🏗️ **AEC Daily Digest** | {digest_date}
    #   📰 **INDUSTRY** (firm-scale news)      -> "• {title} ({source_name}, {pubdate[:10]})" per item
    #   💰 **SPEND CONFIDENCE**                 -> same line shape
    #   🎙️ **OWNER VOICE** (from AEC Pulse research corpus)
    #                                           -> '> "{quote}" — {speaker}' per quote
    # Empty bucket renders the header + "• (no new items in window)".
    # Plain text, no markdown-underscore traps (titles go as-is; no local file paths).

def write_pulse_file(digest: dict) -> Path
    # path = PULSE_DIR / f"{digest['digest_date']}.json"
    # pulse_registry.atomic_write_json(path, digest); return path
    # (No collision with pulse/<vertical>.json snapshots — dates aren't vertical slugs,
    #  and list_verticals() globs registry/, not pulse/.)

def main(argv: list[str] | None = None) -> int
    # argparse: --vertical (default aec), --since-hours (int, default 24),
    #           --date (YYYY-MM-DD override for digest_date), --dry-run
    #           (dry-run: no pool rotation save, no pulse file write), --state-dir
    #           (sets PULSE_STATE_DIR like delta_check does).
    # digest = build_digest(...); if not dry-run: write_pulse_file(digest)
    # print(render_telegram(digest)); return 0.
    # Any exception: print(str(exc), file=sys.stderr); return 1.

if __name__ == "__main__":
    sys.exit(main())
```

## 5. Telegram send mechanism (master-plan decision 1)

`daily_digest.py` sends NOTHING. It writes the dated pulse file and prints the Telegram-formatted text to stdout. The `research-pulse-delta` cron's **morning agent run** reads that stdout and sends it to Telegram 6690120787 via the bus (`cortextos bus send-telegram 6690120787 '<text>'` / the agent's normal Telegram path — muse's other crons already send Telegram this way). Rationale: script stays pure and unit-testable; the agent layer already owns delivery + dedup.

## 6. Owner-voice pool — one-time extraction

Pool file (GITIGNORED live state, CREATE once):
`/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/state/research-pulse/owner_voice_pool.json`

Shape:
```json
{
  "quotes": [
    {"quote": "<verbatim quote>", "speaker": "<name, role/firm or 'principal via <podcast>'>", "theme_tag": "<one of: pricing_efficiency_penalty | ca_systems_integration_failure | proposal_operational_burden | ca_profitability_threat | systems_breakdown>"}
  ],
  "surfaced": []
}
```
`surfaced` holds 12-hex `sha1(quote)` ids — the rotation state lives in this same file (one atomic file, no drift).

Build it with the NotebookLM CLI (binary NOT on PATH; `use` sets the notebook context first — verified from `--help`):
```bash
/private/tmp/whisper-venv/bin/notebooklm use 7f3b85b7-5adc-4869-ace9-7e056354f4eb
/private/tmp/whisper-venv/bin/notebooklm ask "Give 15-20 verbatim quotes from firm owners/principals in this corpus about pricing and proposals, construction-administration-phase profitability, and systems/workflow breakdown — the 'integration failure, not tool failure' theme. For each: exact quote, speaker name + firm/role if stated, and which source it came from." --json
```
Parse the JSON answer into the pool shape (15-20 quotes; the 5 approved sample quotes from `sample-digest-output.md` are known-good seed entries — include them, mapping `speaker_or_source`→`speaker`). This runs ONCE at build time; corpus verified live 2026-07-20 (real Jack Sadler / Sally O'Connor quotes returned).

## 7. Cron wiring (GITIGNORED live state — edit in place)

File: `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/muse/config.json`, cron `research-pulse-delta` (schedule `15 6,18 * * *` — unchanged, NO new cron entry). APPEND this to the end of the existing `prompt` string:

```
MORNING DIGEST (only on the 06:15 firing — skip entirely if the current local hour is >= 12): after the inbox-append step, run `/Users/joshweiss/.venvs/research-pulse/bin/python /Users/joshweiss/code/cortextos/community/agents/research-agent/.claude/skills/research-pulse/scripts/daily_digest.py --vertical aec` and capture its stdout. The script writes the dated pulse file itself. Send the stdout text verbatim to Telegram 6690120787 — send it EVEN IF new_deltas was 0 (the digest also carries spend indicators and owner voice; the SILENT-OK rule above applies to the delta summary only, not the digest). If daily_digest.py exits non-zero, send a bus message to larry with its stderr — never page Josh raw.
```

Goal check "cron diff adds no second cron": the `crons` array length in config.json is unchanged; only this one prompt string grows.
