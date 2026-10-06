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

With --send, sends Josh one Telegram — a one-line heartbeat when clean, detail when
not. Silent-when-clean was the alternative and was rejected deliberately: a watcher nobody
hears from is indistinguishable from a watcher that has itself died.

  python3 meeting_loop_watch.py [--send | --dry-run] [--days N]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import getaddresses, parsedate_to_datetime
from pathlib import Path
from typing import Literal, TypedDict

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


class IdentityEvidence(TypedDict):
    path: str
    sha256: str


class RecoveryIdentity(TypedDict):
    """Operator-verified identity; the watcher never registers these records."""
    kind: Literal["verified_manual_recovery"]
    meeting_id: str
    source_ref: str
    error_at: str
    error_sha256: str
    verifier: str
    verified_at: str
    draft_id: str
    gmail_message_id: str
    account: str
    recipient: str
    identity_evidence: IdentityEvidence


class VerifiedManualRecovery(RecoveryIdentity):
    """identity_evidence pins a manual-recovery-identity/v1 SENT artifact."""
    scope: Literal["recap_sent_only"]


class CompletedTaskEvidence(IdentityEvidence):
    task_id: str
    result: str


class ProposalEvidence(IdentityEvidence):
    # SHA of canonical row JSON, NOT the mutable whole JSONL ledger.
    id: str


class VerifiedDraftRecovery(RecoveryIdentity):
    scope: Literal["recap_draft_created_and_surfaced"]
    meeting_title: str
    source_evidence: IdentityEvidence
    error_evidence: IdentityEvidence
    crm_task: CompletedTaskEvidence
    draft_task: CompletedTaskEvidence
    crm_task_id: str
    draft_task_id: str
    from_header: str
    to_header: str
    subject: str
    thread_id: str
    draft_created_at: str
    surfaced_at: str
    excluded_proposals: list[ProposalEvidence]


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
    doc = {"cutover_at": DEFAULT_CUTOVER_AT, "superseded": {}, "verified_manual_recoveries": {}}
    if not ACK_PATH.is_file():
        return doc
    try:
        raw = json.loads(ACK_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return doc
    if not isinstance(raw, dict):
        return doc
    superseded = raw.get("superseded") if isinstance(raw.get("superseded"), dict) else {}
    return {"cutover_at": str(raw.get("cutover_at") or DEFAULT_CUTOVER_AT), "superseded": superseded,
            "verified_manual_recoveries": raw.get("verified_manual_recoveries", {})}


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
        # Preserve provenance verbatim, including invalid records for audit.
        # Classification validates on every read; a save cannot bless evidence.
        "verified_manual_recoveries": doc.get("verified_manual_recoveries", {}),
    }
    atomic_write(ACK_PATH, (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode("utf-8"))


def _pinned_json(ref: dict, expected_path: Path | None = None) -> dict:
    path = Path(ref["path"])
    if not path.is_absolute() or (expected_path is not None and path.resolve() != expected_path.resolve()):
        raise ValueError("wrong evidence path")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != ref["sha256"]:
        raise ValueError("changed evidence")
    doc = json.loads(raw)
    if not isinstance(doc, dict):
        raise ValueError("malformed evidence")
    return doc


def _completed_task(ref: CompletedTaskEvidence) -> dict:
    if any(not isinstance(ref.get(k), str) or not ref[k].strip() for k in ("task_id", "result")):
        raise ValueError("malformed task binding")
    task = _pinned_json(ref)
    if (task.get("id") != ref["task_id"] or task.get("status") != "completed"
            or not ref["result"] or task.get("result") != ref["result"]):
        raise ValueError("task completion does not match")
    return task


def _draft_created_and_surfaced(rec: VerifiedDraftRecovery, evidence: dict, doc: dict) -> bool:
    """The draft-worker contract requires CRM + created/surfaced, never SENT.

    identity_evidence is the hash-pinned PA metadata receipt, not a new
    normalized claim. Proposal refs pin canonical row bytes so unrelated
    appends to their JSONL ledger cannot invalidate this reconciliation.
    """
    nested = {"identity_evidence", "source_evidence", "error_evidence", "crm_task", "draft_task", "excluded_proposals"}
    if any(not isinstance(rec.get(k), str) or not rec[k].strip()
           for k in VerifiedDraftRecovery.__required_keys__ - nested):
        return False
    mid = rec["meeting_id"]
    source = _pinned_json(rec["source_evidence"], ENVELOPES / mid / "source.json")
    error = _pinned_json(rec["error_evidence"], STATE / f"fireflies-{mid}" / "processing-error.json")
    if source.get("title") != rec["meeting_title"] or error != doc or "sent_at" in rec or "sent" in rec:
        return False
    crm = _completed_task(rec["crm_task"])
    draft = _completed_task(rec["draft_task"])
    if (crm["id"] != rec["crm_task_id"] or draft["id"] != rec["draft_task_id"]
            or crm["id"] == draft["id"] or not all(value in draft["result"] for value in (
            mid, rec["meeting_title"], rec["draft_id"], rec["recipient"]))):
        return False
    if not re.search(r"(?:^|[.;]\s*)surfaced link to Josh(?:[.;]|$)", draft["result"], re.IGNORECASE):
        return False
    text = evidence["text"].replace(r"\\n", "\n").replace(r"\n", "\n")
    blocks = re.findall(r"Result rc=0:\n((?:- [^\n]+\n?)+)", text)
    if len(blocks) != 1:
        return False
    pairs = re.findall(r"^- ([^:]+): (.+)$", blocks[0], re.MULTILINE)
    headers = dict(pairs)
    if len(pairs) != len(headers) or headers.get("labels") != "[DRAFT]":
        return False
    expected = {"id": rec["gmail_message_id"].removeprefix("gmail:"), "threadId": rec["thread_id"],
                "From": rec["from_header"], "To": rec["to_header"], "Subject": rec["subject"]}
    if any(headers.get(k) != v for k, v in expected.items()):
        return False
    if ([email for _, email in getaddresses([headers["From"]])] != [rec["account"]]
            or [email for _, email in getaddresses([headers["To"]])] != [rec["recipient"]]):
        return False
    times = [datetime.fromisoformat(rec[k].replace("Z", "+00:00"))
             for k in ("error_at", "draft_created_at", "surfaced_at", "verified_at")]
    failed_at, created_at, surfaced_at, verified_at = times
    crm_at, task_created, task_completed, headers_at = [datetime.fromisoformat(value.replace("Z", "+00:00"))
        for value in (crm["completed_at"], draft["created_at"], draft["completed_at"], evidence["timestamp"])]
    if (not all(t.tzinfo for t in [*times, crm_at, task_created, task_completed, headers_at])
            or not failed_at <= created_at <= surfaced_at <= verified_at
            or not failed_at <= crm_at <= verified_at or not surfaced_at <= headers_at <= verified_at
            or created_at != task_created or surfaced_at != task_completed
            or parsedate_to_datetime(headers["Date"]) != created_at):
        return False
    refs = rec["excluded_proposals"]
    if not isinstance(refs, list) or len(refs) != 2 or len({r["id"] for r in refs}) != 2:
        return False
    for ref in refs:
        path = Path(ref["path"])
        if not path.is_absolute():
            return False
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        matches = [row for row in rows if isinstance(row, dict) and row.get("id") == ref["id"]]
        if len(matches) != 1:
            return False
        row = matches[0]
        raw = json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        if (hashlib.sha256(raw).hexdigest() != ref["sha256"] or row.get("status") != "open"
                or row.get("source_ref") != rec["source_ref"] or row.get("sent") or row.get("sent_at")):
            return False
    return True


def _verified_manual_recovery(meeting_id: str, doc: dict | None, ack: dict) -> str | None:
    """Return only the verified scope, never canonical processing completion.

    This is a local audit boundary, not a Gmail lookup or authorization to
    replay. Missing/changed evidence must leave the original failure active.
    """
    records = ack.get("verified_manual_recoveries")
    rec = records.get(meeting_id) if isinstance(records, dict) else None
    if not isinstance(rec, dict) or not doc or doc.get("class") != "processing":
        return None
    string_fields = RecoveryIdentity.__required_keys__ - {"identity_evidence"}
    if any(not isinstance(rec.get(k), str) or not rec[k].strip() for k in string_fields):
        return None
    if not re.fullmatch(r"r[0-9]+", rec["draft_id"]) or not re.fullmatch(r"gmail:[0-9a-f]+", rec["gmail_message_id"]):
        return None
    evidence_ref = rec.get("identity_evidence")
    if not isinstance(evidence_ref, dict) or not isinstance(evidence_ref.get("path"), str):
        return None
    evidence_path = Path(evidence_ref["path"])
    if not evidence_path.is_absolute():
        return None
    try:
        error = (STATE / f"fireflies-{meeting_id}" / "processing-error.json").read_bytes()
        evidence_bytes = evidence_path.read_bytes()
        evidence = json.loads(evidence_bytes)
        source = json.loads((ENVELOPES / meeting_id / "source.json").read_bytes())
        if not isinstance(evidence, dict) or not isinstance(source, dict):
            return None
        if (rec["kind"] != "verified_manual_recovery" or rec["meeting_id"] != meeting_id
                or rec["source_ref"] != f"fireflies:{meeting_id}"
                or rec["scope"] not in ("recap_sent_only", "recap_draft_created_and_surfaced")
                or rec["error_at"] != doc.get("at")
                or json.loads(error) != doc
                or rec["error_sha256"] != hashlib.sha256(error).hexdigest()
                or evidence_ref.get("sha256") != hashlib.sha256(evidence_bytes).hexdigest()
                or source.get("source") != {"kind": "fireflies", "id": meeting_id}):
            return None
        participants = source.get("participants")
        if not isinstance(participants, list) or not all(
                any(isinstance(p, dict) and p.get("email") == rec[field] and p.get("side") == side
                    for p in participants) for field, side in (("account", "ours"), ("recipient", "theirs"))):
            return None
        if rec["scope"] == "recap_draft_created_and_surfaced":
            return rec["scope"] if _draft_created_and_surfaced(rec, evidence, doc) else None
        if evidence.get("schema") != "manual-recovery-identity/v1":
            return None
        identity_fields = ("source_ref", "draft_id", "gmail_message_id", "account", "recipient")
        if any(evidence.get(k) != rec[k] for k in identity_fields):
            return None
        labels = evidence.get("label_ids")
        if (not isinstance(labels, list) or not all(isinstance(label, str) for label in labels)
                or "SENT" not in labels or "DRAFT" in labels):
            return None
        # Strict timezone-bearing timestamps: the legacy display parser's
        # permissive fallback must not validate an attestation.
        failed_at = datetime.fromisoformat(rec["error_at"].replace("Z", "+00:00"))
        sent_at = datetime.fromisoformat(evidence["sent_at"].replace("Z", "+00:00"))
        verified_at = datetime.fromisoformat(rec["verified_at"].replace("Z", "+00:00"))
        if not all(d.tzinfo for d in (failed_at, sent_at, verified_at)) or not failed_at <= sent_at <= verified_at:
            return None
        return rec["scope"]
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None


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


def _is_active_failure(evidence_at: datetime | None, ack: dict) -> bool:
    cutover = _parse_iso(ack.get("cutover_at") or DEFAULT_CUTOVER_AT)
    # A legacy timestamp-only ACK cannot identify a post-cutover attempt.
    # Those require the fingerprint + verified manual recovery chain above.
    if evidence_at is not None and cutover is not None and evidence_at <= cutover:
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
    """EVERY failure (missing key, list_transcripts raising, anything else)
    returns ([], err, None) instead of exiting main() early (G-07 / G0B-16).
    Never persists ACK_PATH; main() writes historical ACKs only with --send.
    Manual recovery evidence is read-only on every path."""
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
        recovered = 0
        draft_reconciled = 0
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
                        recovery_scope = _verified_manual_recovery(mid, doc, ack)
                        if recovery_scope:
                            if recovery_scope == "recap_draft_created_and_surfaced":
                                draft_reconciled += 1
                            else:
                                recovered += 1
                            continue
                        evidence_at = _parse_iso((doc or {}).get("at"))
                        if not _is_active_failure(evidence_at, ack):
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
            if superseded or recovered or draft_reconciled:
                filed = len(recent) - len(empty) - superseded - recovered - draft_reconciled
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
        if recovered:
            lines.append(f"{recovered} recap(s) manually recovered/superseded; "
                         "canonical processing remains unverified. "
                         "Separate proposal obligations are unchanged.")
        if draft_reconciled:
            lines.append("manually reconciled: CRM debrief complete; recap draft created/surfaced; "
                         "not sent; proposals open.")
            lines.append("canonical processing remains unverified.")
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
    parser = argparse.ArgumentParser(epilog=(
        "Promotion requirement: update meeting-loop-watch and meeting-loop-watch-pm "
        "to include --send atomically with watcher promotion. Default and --dry-run print only."
    ))
    parser.add_argument("--send", action="store_true", help="explicitly send Telegram and persist historical ACKs")
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
    if args.dry_run or not args.send:
        return 0
    if pending_ack is not None:
        _save_ack(pending_ack)
    return 0 if send_telegram(message) else 1


if __name__ == "__main__":
    raise SystemExit(main())
