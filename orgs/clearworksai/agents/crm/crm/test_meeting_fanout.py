"""Tests for FR-004 meeting-fanout.py.

All external effects (bus, http, subprocess, telegram) run through the injectable Deps seam,
so no test touches a real bus, network, or the live followups/interactions store. A couple of
tests exercise the real add-followup.py + the prod_post_briefs DEGRADED path directly.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CRM_DIR = Path(__file__).resolve().parent
ADD_FOLLOWUP = CRM_DIR / "add-followup.py"


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "meeting_fanout", CRM_DIR / "meeting-fanout.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    # Register before exec so dataclass annotation resolution (Python 3.12+) can find the
    # module in sys.modules while `@dataclass` processes Callable-typed fields.
    sys.modules["meeting_fanout"] = module
    spec.loader.exec_module(module)
    return module


mf = _load_module()


# ── fake side-effect seams ───────────────────────────────────────────────────


class FakeBus:
    """Records every sink call and drives a per-source-key fire-once dedup."""

    def __init__(self, *, briefs_env_present: bool = True):
        self.tasks: list[dict] = []
        self.approvals: list[dict] = []
        self.followups: list[dict] = []
        self.briefs: list[dict] = []
        self.telegrams: list[tuple[str, str]] = []
        self._surfaced: set[str] = set()
        self._briefs_env_present = briefs_env_present
        self._counter = 0

    def _next(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}-{self._counter}"

    def load_full(self, meeting_id: str) -> dict:  # overridden per test
        raise NotImplementedError

    def create_task(self, *, title, assignee, needs_approval=False, desc=None, due=None) -> str:
        tid = self._next("task")
        self.tasks.append(
            {
                "id": tid,
                "title": title,
                "assignee": assignee,
                "needs_approval": needs_approval,
                "desc": desc,
                "due": due,
            }
        )
        return tid

    def create_approval(self, *, title, category="external-comms", context="", client=None) -> str:
        aid = self._next("approval")
        self.approvals.append(
            {"id": aid, "title": title, "category": category, "context": context, "client": client}
        )
        return aid

    def post_briefs(self, commitment: dict) -> bool:
        if not self._briefs_env_present:
            return False  # DEGRADED
        self.briefs.append(commitment)
        return True

    def add_followup(self, *, contact_id, due_date, reason, source_ref="meeting-fanout") -> str:
        fid = self._next("followup")
        self.followups.append(
            {"id": fid, "contact_id": contact_id, "due_date": due_date, "reason": reason}
        )
        return fid

    def send_telegram(self, chat_id: str, message: str) -> None:
        self.telegrams.append((chat_id, message))

    def dedup_surface(self, source_key: str) -> bool:
        if source_key in self._surfaced:
            return False  # SKIP — already surfaced
        self._surfaced.add(source_key)
        return True  # SURFACE — first sight

    def deps(self, full_payload: dict) -> "mf.Deps":
        return mf.Deps(
            load_full=lambda _mid: full_payload,
            create_task=self.create_task,
            create_approval=self.create_approval,
            post_briefs=self.post_briefs,
            add_followup=self.add_followup,
            send_telegram=self.send_telegram,
            dedup_surface=self.dedup_surface,
        )


def make_meeting(commitments, *, meeting_id="M1", meeting_type="sales", client="Acme", title="Acme sync"):
    return {
        "mode": "full",
        "meetings": [
            {
                "id": meeting_id,
                "title": title,
                "meeting_type": meeting_type,
                "client_context": client,
                "next_steps": commitments,
            }
        ],
    }


def commitment(cid, text, owner_identity, *, direction="outbound", deadline=""):
    return {
        "commitmentId": cid,
        "text": text,
        "owner_identity": owner_identity,
        "direction": direction,
        "deadline": deadline,
    }


# ── tests ────────────────────────────────────────────────────────────────────


class OwnerRoutingTests(unittest.TestCase):
    def test_each_commitment_creates_task_with_resolved_owner(self):
        bus = FakeBus()
        payload = make_meeting(
            [
                commitment("c1", "Send the proposal", "jose@acme.com", deadline="2026-08-15"),
                commitment("c2", "Draft the SOW", "amy@acme.com", deadline="2026-08-16"),
            ],
            meeting_type="delivery",
        )
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.tasks), 2)
        self.assertEqual(bus.tasks[0]["assignee"], "jose@acme.com")
        self.assertEqual(bus.tasks[1]["assignee"], "amy@acme.com")

    def test_needs_owner_routed_to_triage_not_dropped(self):
        bus = FakeBus()
        payload = make_meeting(
            [commitment("c1", "Follow up on pricing", "NEEDS-OWNER:unknown-person", deadline="2026-08-15")]
        )
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.tasks), 1)  # never silently dropped
        self.assertEqual(bus.tasks[0]["assignee"], mf.TRIAGE_OWNER)

    def test_empty_owner_routed_to_triage(self):
        bus = FakeBus()
        payload = make_meeting([commitment("c1", "Do the thing", "", deadline="2026-08-15")])
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(bus.tasks[0]["assignee"], mf.TRIAGE_OWNER)


class ClientFacingTests(unittest.TestCase):
    def test_client_facing_creates_approval_also(self):
        bus = FakeBus()
        payload = make_meeting(
            [commitment("c1", "Email revised quote to client", "jose@acme.com", deadline="2026-08-15")],
            meeting_type="sales",
            client="Acme",
        )
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.tasks), 1)
        self.assertTrue(bus.tasks[0]["needs_approval"])
        self.assertEqual(len(bus.approvals), 1)
        self.assertEqual(bus.approvals[0]["category"], "external-comms")

    def test_internal_meeting_no_approval(self):
        bus = FakeBus()
        payload = make_meeting(
            [commitment("c1", "Update the roadmap doc", "josh@clearworks.ai", deadline="2026-08-15")],
            meeting_type="internal",
            client="",
        )
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.approvals), 0)
        self.assertFalse(bus.tasks[0]["needs_approval"])

    def test_inbound_commitment_not_client_facing(self):
        # They committed to us (inbound) — never an external-comms send from us.
        bus = FakeBus()
        payload = make_meeting(
            [commitment("c1", "Client sends signed contract", "jose@acme.com", direction="inbound", deadline="2026-08-15")],
            meeting_type="sales",
            client="Acme",
        )
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.approvals), 0)
        self.assertFalse(bus.tasks[0]["needs_approval"])


class BriefsTests(unittest.TestCase):
    def test_briefs_post_attempted(self):
        bus = FakeBus(briefs_env_present=True)
        payload = make_meeting([commitment("c1", "Send proposal", "jose@acme.com", deadline="2026-08-15")])
        result = mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(result.briefs_attempted, 1)
        self.assertEqual(result.briefs_degraded, 0)
        self.assertEqual(len(bus.briefs), 1)

    def test_briefs_degraded_when_env_missing_no_crash(self):
        bus = FakeBus(briefs_env_present=False)
        payload = make_meeting([commitment("c1", "Send proposal", "jose@acme.com", deadline="2026-08-15")])
        result = mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(result.briefs_attempted, 0)
        self.assertEqual(result.briefs_degraded, 1)
        # other sinks still fired despite DEGRADED BRIEFS
        self.assertEqual(len(bus.tasks), 1)

    def test_prod_post_briefs_degraded_path_real(self):
        # Real prod_post_briefs with env cleared → DEGRADED (False), no crash, no network.
        old = {k: os.environ.pop(k, None) for k in ("BRIEFS_INGEST_URL", "TASKS_INGEST_TOKEN")}
        try:
            self.assertFalse(mf.prod_post_briefs({"id": "c1", "text": "x"}))
        finally:
            for k, v in old.items():
                if v is not None:
                    os.environ[k] = v


class FollowupRowTests(unittest.TestCase):
    def test_followup_row_per_commitment_owner_matched(self):
        bus = FakeBus()
        payload = make_meeting(
            [
                commitment("c1", "Send proposal", "jose@acme.com", deadline="2026-08-15"),
                commitment("c2", "Book kickoff", "amy@acme.com", deadline="2026-08-20"),
            ]
        )
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.followups), 2)
        self.assertEqual(bus.followups[0]["contact_id"], "jose@acme.com")  # owner-matched
        self.assertEqual(bus.followups[1]["contact_id"], "amy@acme.com")
        self.assertNotEqual(bus.followups[0]["contact_id"], bus.followups[1]["contact_id"])

    def test_needs_owner_followup_routed_to_triage(self):
        bus = FakeBus()
        payload = make_meeting([commitment("c1", "Chase", "NEEDS-OWNER:x", deadline="2026-08-15")])
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(bus.followups[0]["contact_id"], mf.TRIAGE_OWNER)

    def test_no_deadline_no_followup_row(self):
        bus = FakeBus()
        payload = make_meeting([commitment("c1", "Someday task", "jose@acme.com", deadline="")])
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.followups), 0)  # no concrete due → no followup row
        self.assertEqual(len(bus.tasks), 1)  # task still created

    def test_real_add_followup_writes_owner_matched_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = os.environ.copy()
            env["CRM_FOLLOWUPS_PATH"] = str(Path(tmp) / "followups.jsonl")
            r = subprocess.run(
                [
                    "python3", str(ADD_FOLLOWUP),
                    "--contact-id", "jose@acme.com",
                    "--due-date", "2026-08-15",
                    "--reason", "Send proposal",
                ],
                capture_output=True, text=True, env=env,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            fid = r.stdout.strip()
            self.assertTrue(fid.startswith("followup-jose@acme.com-2026-08-15"))
            # Re-run is idempotent (same id, no duplicate row).
            r2 = subprocess.run(
                [
                    "python3", str(ADD_FOLLOWUP),
                    "--contact-id", "jose@acme.com",
                    "--due-date", "2026-08-15",
                    "--reason", "Send proposal",
                ],
                capture_output=True, text=True, env=env,
            )
            self.assertEqual(r2.stdout.strip(), fid)
            rows = Path(env["CRM_FOLLOWUPS_PATH"]).read_text().splitlines()
            self.assertEqual(len([ln for ln in rows if ln.strip()]), 1)


class TelegramBatchingTests(unittest.TestCase):
    def test_telegram_sent_once_per_meeting_not_per_commitment(self):
        bus = FakeBus()
        payload = make_meeting(
            [
                commitment("c1", "Send proposal", "jose@acme.com", deadline="2026-08-15"),
                commitment("c2", "Draft SOW", "amy@acme.com", deadline="2026-08-16"),
                commitment("c3", "Book kickoff", "jose@acme.com", deadline="2026-08-17"),
            ]
        )
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.telegrams), 1)  # ONE message for the whole meeting
        chat_id, message = bus.telegrams[0]
        self.assertEqual(chat_id, mf.DEFAULT_TELEGRAM_CHAT_ID)
        # the one batched message references all three commitments
        self.assertIn("Send proposal", message)
        self.assertIn("Draft SOW", message)
        self.assertIn("Book kickoff", message)


class DedupTests(unittest.TestCase):
    def test_rerun_same_commitment_ids_all_sinks_skip(self):
        bus = FakeBus()
        payload = make_meeting(
            [
                commitment("c1", "Send proposal", "jose@acme.com", deadline="2026-08-15"),
                commitment("c2", "Draft SOW", "amy@acme.com", deadline="2026-08-16"),
            ],
            meeting_type="sales",
            client="Acme",
        )
        # First run fans everything.
        r1 = mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(r1.surfaced), 2)
        tasks_after_1 = len(bus.tasks)
        approvals_after_1 = len(bus.approvals)
        followups_after_1 = len(bus.followups)
        briefs_after_1 = len(bus.briefs)
        telegrams_after_1 = len(bus.telegrams)
        # Second run (same bus = same dedup ledger) → all SKIP, zero new effects.
        r2 = mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(r2.surfaced), 0)
        self.assertEqual(len(r2.skipped), 2)
        self.assertEqual(len(bus.tasks), tasks_after_1)
        self.assertEqual(len(bus.approvals), approvals_after_1)
        self.assertEqual(len(bus.followups), followups_after_1)
        self.assertEqual(len(bus.briefs), briefs_after_1)
        self.assertEqual(len(bus.telegrams), telegrams_after_1)  # no second Telegram
        self.assertFalse(r2.telegram_sent)

    def test_partial_dedup_only_new_commitment_fans(self):
        bus = FakeBus()
        first = make_meeting([commitment("c1", "Send proposal", "jose@acme.com", deadline="2026-08-15")])
        mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(first))
        # Now a re-run where c1 is already surfaced but c2 is new.
        second = make_meeting(
            [
                commitment("c1", "Send proposal", "jose@acme.com", deadline="2026-08-15"),
                commitment("c2", "New task", "amy@acme.com", deadline="2026-08-16"),
            ]
        )
        r = mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(second))
        self.assertEqual([c.commitment_id for c in r.surfaced], ["c2"])
        self.assertEqual([c.commitment_id for c in r.skipped], ["c1"])
        self.assertEqual(len(bus.tasks), 2)  # c1 (run 1) + c2 (run 2), not 3


class ZeroCommitmentTests(unittest.TestCase):
    def test_zero_commitment_meeting_no_sinks_no_crash(self):
        bus = FakeBus()
        payload = make_meeting([])
        result = mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.tasks), 0)
        self.assertEqual(len(bus.followups), 0)
        self.assertEqual(len(bus.briefs), 0)
        self.assertEqual(len(bus.telegrams), 0)
        self.assertFalse(result.telegram_sent)

    def test_missing_meeting_no_sinks_no_crash(self):
        bus = FakeBus()
        payload = {"mode": "full", "meetings": []}
        result = mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload))
        self.assertEqual(len(bus.tasks), 0)
        self.assertFalse(result.telegram_sent)


class DryRunTests(unittest.TestCase):
    def test_dry_run_records_dedup_but_fires_no_sinks(self):
        bus = FakeBus()
        payload = make_meeting([commitment("c1", "Send proposal", "jose@acme.com", deadline="2026-08-15")])
        result = mf.fanout(meeting_id="M1", event_file=None, deps=bus.deps(payload), dry_run=True)
        self.assertEqual(len(result.surfaced), 1)
        self.assertEqual(len(bus.tasks), 0)
        self.assertEqual(len(bus.followups), 0)
        self.assertEqual(len(bus.telegrams), 0)


class EventFileTests(unittest.TestCase):
    def test_event_file_client_makes_outbound_client_facing(self):
        # Meeting object has no client/type, but the FR-002 event file supplies client → sales-ish.
        bus = FakeBus()
        payload = make_meeting(
            [commitment("c1", "Email quote", "jose@acme.com", deadline="2026-08-15")],
            meeting_type="",
            client="",
        )
        with tempfile.TemporaryDirectory() as tmp:
            ef = Path(tmp) / "ff-meeting-event-m1.json"
            ef.write_text('{"meeting_id":"M1","client":"Acme","meeting_type":"sales","title":"Acme"}')
            mf.fanout(meeting_id="M1", event_file=str(ef), deps=bus.deps(payload))
        self.assertEqual(len(bus.approvals), 1)  # client came from the event file
        self.assertTrue(bus.tasks[0]["needs_approval"])


if __name__ == "__main__":
    unittest.main()
