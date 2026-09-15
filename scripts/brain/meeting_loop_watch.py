#!/usr/bin/env python3
"""Daily watch on the Fireflies -> vault meeting loop.

Every failure in this chain has been SILENT. On 2026-09-13 a single session found
five, the oldest two months old: webhook-hub deploying from a `main` frozen since
July, BRIDGE_URL pointing at a dead ephemeral tunnel, a mismatched bridge secret,
the bridge wanting a signature the hub never sent, and a 374-sentence transcript
rejected because its `duration` was null. None of them logged anything anyone saw.

The one check that would have caught ALL of them in a day: compare what Fireflies
has against what landed in the vault, and say so out loud.

Sends Josh one Telegram a day either way — a one-line heartbeat when clean, detail
when not. Silent-when-clean was the alternative and was rejected deliberately: a
watcher nobody hears from is indistinguishable from a watcher that has itself died.

  python3 meeting_loop_watch.py [--dry-run] [--days N]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import envparse  # noqa: E402
import paths as brain_paths  # noqa: E402
from fetch_fireflies import list_transcripts  # noqa: E402

REPO = Path("/Users/joshweiss/code/cortextos")
VAULT = Path("/Users/joshweiss/code/knowledge-sync")
ENVELOPES = VAULT / "raw/media/transcripts/fireflies"
STATE = VAULT / "raw/media/transcripts/_state"
TELEGRAM_CHAT_ID = "6690120787"
TELEGRAM_AGENT_DIR = REPO / "orgs/clearworksai/agents/pa-codex"

# Fireflies reports a transcript as ready long before it is useful; under this many
# sentences it is a no-show or an empty recording, not a pipeline failure.
MIN_SENTENCES = 20

HUB_HEALTH = "https://webhook-hub-production-0194.up.railway.app/healthz"
BRIDGE_HEALTH = "https://bridge.clearworks.ai/healthz"


def _occurred(row: dict) -> datetime:
    value = row.get("dateString") or row.get("date")
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 1e11 else value
        return datetime.fromtimestamp(seconds, timezone.utc)
    return datetime.fromisoformat(str(value)[:19].replace("Z", "")).replace(tzinfo=timezone.utc)


def _probe(url: str) -> str:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.7.1"})
        with urllib.request.urlopen(req, timeout=15) as response:
            return "ok" if response.status == 200 else f"HTTP {response.status}"
    except Exception as exc:  # noqa: BLE001 — any failure is the finding
        return f"unreachable ({type(exc).__name__})"


def _not_ready_reason(meeting_id: str) -> str | None:
    """Why fetch skipped a meeting, if it recorded one."""
    error_path = STATE / f"fireflies-{meeting_id}" / "fetch-error.json"
    if not error_path.is_file():
        return None
    try:
        return str(json.loads(error_path.read_text()).get("message") or "")
    except (OSError, ValueError):
        return None


def _sentence_count(reason: str | None) -> int | None:
    if not reason or "sentences=" not in reason:
        return None
    try:
        return int(reason.split("sentences=", 1)[1].split()[0].strip())
    except (ValueError, IndexError):
        return None


def send_telegram(text: str) -> bool:
    env = dict(os.environ)
    env["CTX_AGENT_DIR"] = str(TELEGRAM_AGENT_DIR)
    try:
        result = subprocess.run(
            ["cortextos", "bus", "send-telegram", TELEGRAM_CHAT_ID, text],
            capture_output=True, text=True, timeout=60, env=env,
        )
        if result.returncode != 0:
            print(f"telegram failed rc={result.returncode}: {result.stderr.strip()[:200]}", file=sys.stderr)
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError) as exc:
        print(f"telegram failed: {exc}", file=sys.stderr)
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="print, do not send")
    parser.add_argument("--days", type=int, default=7, help="how far back to look")
    args = parser.parse_args()

    secrets = envparse.parse_env_file(brain_paths.secrets_path(REPO))
    api_key = secrets.get("FIREFLIES_API_KEY")
    if not api_key:
        print("no FIREFLIES_API_KEY", file=sys.stderr)
        return 2

    rows = list_transcripts(api_key, throttle_s=1.0)
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    recent = [r for r in rows if _occurred(r) >= cutoff]
    have = {p.name for p in ENVELOPES.iterdir() if p.is_dir()} if ENVELOPES.is_dir() else set()

    missing, empty, incomplete = [], [], []
    for row in sorted(recent, key=_occurred):
        mid = str(row.get("id"))
        if mid in have:
            # 2026-09-14: an envelope dir only proves FETCH happened. The
            # receipt is written last, after extract → resolve → file → phase 3;
            # a run that died at any step (extract "Credit balance is too low",
            # or the phase-3 sign-check) leaves the envelope and no receipt, and
            # this watch used to call that "filed". Key on the receipt instead.
            if not (STATE / f"fireflies-{mid}" / "receipt.json").exists():
                incomplete.append((_occurred(row).date().isoformat(), mid, str(row.get("title") or "")[:48]))
            continue
        reason = _not_ready_reason(mid)
        count = _sentence_count(reason)
        entry = (_occurred(row).date().isoformat(), mid, str(row.get("title") or "")[:48], count)
        (empty if count is not None and count < MIN_SENTENCES else missing).append(entry)

    hub, bridge = _probe(HUB_HEALTH), _probe(BRIDGE_HEALTH)
    transport_ok = hub == "ok" and bridge == "ok"
    newest = max((_occurred(r) for r in rows), default=None)

    if not missing and not incomplete and transport_ok:
        lines = [
            f"Meeting loop OK — {len(recent)} transcript(s) in the last {args.days}d, all filed (receipts present).",
            f"Newest: {newest.date().isoformat() if newest else 'none'} · hub {hub} · bridge {bridge}",
        ]
        if empty:
            lines.append(f"({len(empty)} empty recording(s) skipped, which is correct.)")
    else:
        lines = ["⚠️ Meeting loop needs a look."]
        if missing:
            lines.append(f"\n{len(missing)} transcript(s) NOT in the vault and not empty:")
            lines += [f"- {d} {t} ({m})" for d, m, t, _ in missing[:10]]
        if incomplete:
            lines.append(f"\n{len(incomplete)} transcript(s) fetched but NOT processed (no receipt — "
                         "the run died after fetch; re-run run_meeting.py --apply for each):")
            lines += [f"- {d} {t} ({m})" for d, m, t in incomplete[:10]]
        if not transport_ok:
            lines.append(f"\nTransport: hub {hub} · bridge {bridge}")
        lines.append("\nEvery failure in this chain has been silent — check the hub logs "
                     "(railway logs --service webhook-hub) for relay_failed.")

    message = "\n".join(lines)
    print(message)
    if args.dry_run:
        return 0
    return 0 if send_telegram(message) else 1


if __name__ == "__main__":
    raise SystemExit(main())
