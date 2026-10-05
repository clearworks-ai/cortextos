#!/usr/bin/env python3
"""Daily watch on the Fireflies -> vault meeting loop, plus the Gmail client-state digest.

Every failure in the Fireflies chain has been SILENT. On 2026-09-13 a single session found
five, the oldest two months old: webhook-hub deploying from a `main` frozen since July,
BRIDGE_URL pointing at a dead ephemeral tunnel, a mismatched bridge secret, the bridge
wanting a signature the hub never sent, and a 374-sentence transcript rejected because its
`duration` was null. None of them logged anything anyone saw.

The one check that would have caught ALL of them in a day: compare what Fireflies has
against what landed in the vault, and say so out loud.

FR-009 INDEPENDENCE (G-07, G0B-16): this used to be one linear main() that returned
before ANY notification when FIREFLIES_API_KEY was missing, AND a later exception from
list_transcripts() (or anything else in the Fireflies body) was UNGUARDED and would still
crash before the Gmail digest ran. Both sections now catch their own exceptions
independently and main() always composes both result/error lines before sending.

Sends Josh one Telegram a day either way — a one-line heartbeat when clean, detail when
not. Silent-when-clean was the alternative and was rejected deliberately: a watcher nobody
hears from is indistinguishable from a watcher that has itself died.

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
from atomic import atomic_write  # noqa: E402
from fetch_fireflies import list_transcripts  # noqa: E402

REPO = Path("/Users/joshweiss/code/cortextos")
VAULT = Path("/Users/joshweiss/code/knowledge-sync")
ENVELOPES = VAULT / "raw/media/transcripts/fireflies"
STATE = VAULT / "raw/media/transcripts/_state"
# Post-subscription healthy path (e4021750 + 2026-09-30 activation). Failures
# at-or-before this instant are historical, not current provider health.
DEFAULT_CUTOVER_AT = "2026-10-01T00:00:00+00:00"
ACK_PATH = STATE / "meeting-loop-watch-ack.json"
TELEGRAM_CHAT_ID = "6690120787"
TELEGRAM_AGENT_DIR = REPO / "orgs/clearworksai/agents/pa-codex"

# Fireflies reports a transcript as ready long before it is useful; under this many
# sentences it is a no-show or an empty recording, not a pipeline failure.
MIN_SENTENCES = 20

HUB_HEALTH = "https://webhook-hub-production-0194.up.railway.app/healthz"
BRIDGE_HEALTH = "https://bridge.clearworks.ai/healthz"

# FR-002 default lookback window for the Gmail client-state poller — distinct
# from --days above, which is the Fireflies watch's own lookback.
GMAIL_POLL_WINDOW_DAYS = 3


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


def _parse_iso(value: object) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        try:
            dt = datetime.fromisoformat(str(value)[:19].replace("Z", "")).replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _load_ack() -> dict:
    doc = {"cutover_at": DEFAULT_CUTOVER_AT, "superseded": {}}
    if not ACK_PATH.is_file():
        return doc
    try:
        raw = json.loads(ACK_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return doc
    if not isinstance(raw, dict):
        return doc
    superseded = raw.get("superseded") if isinstance(raw.get("superseded"), dict) else {}
    return {"cutover_at": str(raw.get("cutover_at") or DEFAULT_CUTOVER_AT), "superseded": superseded}


def _save_ack(doc: dict) -> None:
    superseded = {}
    for mid, rec in (doc.get("superseded") or {}).items():
        if not isinstance(rec, dict):
            continue
        superseded[str(mid)] = {
            "class": rec.get("class") or "processing",
            "error_at": rec.get("error_at"),
        }
    payload = {
        "cutover_at": doc.get("cutover_at") or DEFAULT_CUTOVER_AT,
        "superseded": superseded,
    }
    atomic_write(ACK_PATH, (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode("utf-8"))


def _processing_error_doc(meeting_id: str) -> dict | None:
    path = STATE / f"fireflies-{meeting_id}" / "processing-error.json"
    if not path.is_file():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _processing_failure(meeting_id: str) -> str | None:
    path = STATE / f"fireflies-{meeting_id}" / "processing-error.json"
    if not path.is_file():
        return None
    doc = _processing_error_doc(meeting_id)
    if doc is None:
        return "processing-error.json is unreadable"
    if doc.get("class") != "processing":
        return "processing failure evidence is malformed"
    return str(doc.get("message") or f"returncode={doc.get('returncode')}")[:200]


def _is_active_failure(meeting_id: str, evidence_at: datetime | None, ack: dict) -> bool:
    cutover = _parse_iso(ack.get("cutover_at") or DEFAULT_CUTOVER_AT)
    rec = (ack.get("superseded") or {}).get(meeting_id)
    rec_at = _parse_iso(rec.get("error_at")) if isinstance(rec, dict) else None
    if evidence_at is not None and cutover is not None and evidence_at <= cutover:
        return False
    if evidence_at is not None and rec_at is not None and evidence_at == rec_at:
        return False
    return True


def _note_superseded(ack: dict, meeting_id: str, doc: dict | None) -> None:
    evidence_at = _parse_iso((doc or {}).get("at"))
    ack.setdefault("superseded", {})[meeting_id] = {
        "class": (doc or {}).get("class") or "processing",
        "error_at": evidence_at.isoformat() if evidence_at else None,
    }


def _source_sentence_count(meeting_id: str) -> int | None:
    path = ENVELOPES / meeting_id / "source.json"
    try:
        source = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    sentences = None
    if isinstance(source, dict):
        sentences = source.get("text_units")
        if sentences is None:
            sentences = source.get("sentences")
    return len(sentences) if isinstance(sentences, list) else None


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


def fireflies_section(args: argparse.Namespace) -> tuple[list[str], str | None, dict | None]:
    """The original meeting-loop watch, logic byte-identical, now wrapped so
    EVERY failure (missing key, list_transcripts raising, anything else)
    returns ([], err, None) instead of exiting main() early (G-07 / G0B-16).
    Never persists ACK_PATH; main() writes fingerprints only on the authorized
    non-dry-run path."""
    try:
        # G-DIG-4 (G2A-6): the secrets file is THIS section's input and nothing
        # else's, so it is read inside this section's own guard. main() used to
        # read it before either section ran, so a missing or unreadable
        # orgs/clearworksai/secrets.env crashed the whole watch and the Gmail
        # digest -- which needs no secrets at all -- never rendered.
        secrets = envparse.parse_env_file(brain_paths.secrets_path(REPO))
        api_key = secrets.get("FIREFLIES_API_KEY")
        if not api_key:
            return [], "no FIREFLIES_API_KEY", None

        rows = list_transcripts(api_key, throttle_s=1.0)
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
        recent = [r for r in rows if _occurred(r) >= cutoff]
        have = {p.name for p in ENVELOPES.iterdir() if p.is_dir()} if ENVELOPES.is_dir() else set()
        ack = _load_ack()
        ack_dirty = False

        missing, empty, incomplete, failed = [], [], [], []
        superseded = 0
        for row in sorted(recent, key=_occurred):
            mid = str(row.get("id"))
            if mid in have:
                if _source_sentence_count(mid) == 0:
                    empty.append((_occurred(row).date().isoformat(), mid, str(row.get("title") or "")[:48], 0))
                    continue
                # 2026-09-14 (ported from main 8c956a0b): an envelope dir only
                # proves FETCH happened. The receipt is written last, after
                # extract -> resolve -> file -> phase 3; a run that died at any
                # step (extract "Credit balance is too low", or the phase-3
                # sign-check) leaves the envelope and no receipt, and this watch
                # used to call that "filed". Key on the receipt instead.
                if not (STATE / f"fireflies-{mid}" / "receipt.json").exists():
                    doc = _processing_error_doc(mid)
                    failure = _processing_failure(mid)
                    entry = (_occurred(row).date().isoformat(), mid, str(row.get("title") or "")[:48])
                    if failure:
                        evidence_at = _parse_iso((doc or {}).get("at"))
                        if not _is_active_failure(mid, evidence_at, ack):
                            _note_superseded(ack, mid, doc)
                            ack_dirty = True
                            superseded += 1
                            continue
                        failed.append((*entry, failure))
                    else:
                        incomplete.append(entry)
                continue
            reason = _not_ready_reason(mid)
            count = _sentence_count(reason)
            entry = (_occurred(row).date().isoformat(), mid, str(row.get("title") or "")[:48], count)
            (empty if count is not None and count < MIN_SENTENCES else missing).append(entry)

        pending_ack = ack if ack_dirty else None

        hub, bridge = _probe(HUB_HEALTH), _probe(BRIDGE_HEALTH)
        transport_ok = hub == "ok" and bridge == "ok"
        newest = max((_occurred(r) for r in rows), default=None)

        if not missing and not incomplete and not failed and transport_ok:
            newest_line = (
                f"Newest: {newest.date().isoformat() if newest else 'none'} · hub {hub} · bridge {bridge}"
            )
            if superseded:
                filed = len(recent) - len(empty) - superseded
                lines = [
                    f"Meeting loop OK — {filed} current transcript(s) in the last {args.days}d with receipts; "
                    f"{superseded} historical no-receipt item(s) superseded, not current.",
                    newest_line,
                ]
            else:
                lines = [
                    f"Meeting loop OK — {len(recent)} transcript(s) in the last {args.days}d, all filed (receipts present).",
                    newest_line,
                ]
            if empty:
                lines.append(f"({len(empty)} empty recording(s) skipped, which is correct.)")
        else:
            lines = ["⚠️ Meeting loop needs a look."]
            if missing:
                lines.append(f"\n{len(missing)} transcript(s) NOT in the vault — content not yet verified:")
                lines += [f"- {d} {t} ({m})" for d, m, t, _ in missing[:10]]
            if incomplete:
                lines.append(f"\n{len(incomplete)} transcript(s) fetched but completion UNVERIFIED "
                             "(receipt missing — reconcile filing/task/draft evidence before replay):")
                lines += [f"- {d} {t} ({m})" for d, m, t in incomplete[:10]]
            if failed:
                lines.append(f"\n{len(failed)} transcript(s) have a recorded processing failure "
                             "(automatic replay held until explicit retry):")
                lines += [f"- {d} {t} ({m}) — {reason}" for d, m, t, reason in failed[:10]]
            if not transport_ok:
                lines.append(f"\nTransport: hub {hub} · bridge {bridge}")
            lines.append("\nCheck fetch/processing receipts and meeting-worker logs first. "
                         "If delivery is missing, check hub logs "
                         "(railway logs --service webhook-hub) for relay_failed.")
        return lines, None, pending_ack
    except Exception as exc:  # noqa: BLE001 — G0B-16: sections fail independently
        return [], f"{type(exc).__name__}: {exc}", None


def gmail_section_lines(args: argparse.Namespace) -> tuple[list[str], str | None]:
    """FR-009's client-state digest. Imports client_state_digest lazily and
    catches every Exception (G-DIG-2) so a Gmail-side failure — a bad vault
    path, a corrupt ledger, anything — never takes the Fireflies section down
    with it (the reverse of the old G-07 bug)."""
    try:
        import client_state_digest
        from observation_ledger import Ledger
        from runner import SubprocessRunner

        state_dir = Path(os.environ.get("CLIENT_STATE_DIR", REPO / "state/client-state"))
        vault = Path(os.environ.get("CLIENT_STATE_VAULT", VAULT))
        ledger = Ledger(state_dir / "observations.jsonl")
        lines = client_state_digest.gmail_section(
            state_dir, vault, ledger, datetime.now(timezone.utc), GMAIL_POLL_WINDOW_DAYS, SubprocessRunner()
        )
        return lines, None
    except Exception as exc:  # noqa: BLE001 — G-DIG-2 sections fail independently
        return [], f"{type(exc).__name__}: {exc}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="print, do not send")
    parser.add_argument("--days", type=int, default=7, help="how far back to look (Fireflies)")
    args = parser.parse_args(argv)

    # G0B-16: each section body is independently exception-guarded (inside
    # fireflies_section / gmail_section_lines) -- neither call here can take
    # the other section down with it, and main() itself now reads NOTHING that
    # either section could fail on (G-DIG-4).
    ff_lines, ff_err, pending_ack = fireflies_section(args)
    gm_lines, gm_err = gmail_section_lines(args)

    sections: list[str] = []
    sections.append(f"⚠️ Fireflies section error: {ff_err}" if ff_err else "\n".join(ff_lines))
    sections.append(f"⚠️ Gmail section error: {gm_err}" if gm_err else "\n".join(gm_lines))

    message = "\n\n".join(sections)
    print(message)
    if args.dry_run:
        return 0
    if pending_ack is not None:
        _save_ack(pending_ack)
    return 0 if send_telegram(message) else 1


if __name__ == "__main__":
    raise SystemExit(main())
