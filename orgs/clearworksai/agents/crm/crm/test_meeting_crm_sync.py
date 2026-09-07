"""Tests for meeting-crm-sync.py (FR-007 CRM-sync consumer).

Two layers:
  * ArgvCaptureTests monkeypatch the ``_run`` seam to record produced commands WITHOUT
    executing them — proving the sales-only deal-stage gate (upsert-engagement.py is only
    ever invoked for sales meetings with a mapped deal_state + matching engagement).
  * RealWriteTests execute the real upsert-contact.py + add-interaction.py against temp
    CRM files (CRM_CONTACTS_PATH / CRM_INTERACTIONS_PATH / CRM_PIPELINE_PATH), so the
    contact upsert, the ONE-interaction-per-meeting append, and idempotency on re-run are
    asserted against actual file state. ff-extractor and upsert-engagement calls are faked
    (no live API keys / no pipeline.json writer dependency in-worktree).
"""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

CRM_DIR = Path(__file__).resolve().parent


def _load_worker():
    spec = importlib.util.spec_from_file_location("meeting_crm_sync", CRM_DIR / "meeting-crm-sync.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _write_event(tmp: Path, *, meeting_id, meeting_type, attendees, client="Acme", commitment_ids=None):
    """``attendees=None`` omits the key entirely — the legacy/no-attendees-
    field payload shape (N-1: falls back to full_meeting). Any other value,
    including ``[]``, writes that literal ``attendees`` value — a
    present-but-empty list is now authoritative (N-1), NOT a fallback
    trigger."""
    payload = {
        "meeting_id": meeting_id,
        "meeting_type": meeting_type,
        "client": client,
        "commitmentIds": commitment_ids or [],
        "writeback_ok": True,
    }
    if attendees is not None:
        payload["attendees"] = attendees
    path = tmp / f"ff-meeting-event-{meeting_id}.json"
    path.write_text(json.dumps(payload))
    return path


class ArgvCaptureTests(unittest.TestCase):
    """Assert produced commands + the sales-only stage gate without executing anything."""

    def setUp(self):
        self.mod = _load_worker()
        self.calls: list[list[str]] = []

        def fake_run(argv, env=None):
            self.calls.append(argv)
            # Emulate each writer's stdout so the worker can parse ids / results.
            if "upsert-contact.py" in argv[1]:
                idx = argv.index("--id") + 1
                return subprocess.CompletedProcess(argv, 0, argv[idx], "")
            if "ff-extractor.py" in argv[1]:
                return subprocess.CompletedProcess(argv, 0, self._ff_stdout, "")
            return subprocess.CompletedProcess(argv, 0, "{}", "")

        self._ff_stdout = json.dumps({"mode": "full", "meetings": []})
        self.mod._run = fake_run

    def tearDown(self):
        for k in ("CRM_CONTACTS_PATH", "CRM_PIPELINE_PATH", "FF_EVENT_PAYLOAD_PATH"):
            os.environ.pop(k, None)

    def _upsert_engagement_calls(self):
        return [c for c in self.calls if "upsert-engagement.py" in c[1]]

    def _contact_calls(self):
        return [c for c in self.calls if "upsert-contact.py" in c[1]]

    def _set_ff(self, *, meeting_id, deal_state):
        self._ff_stdout = json.dumps({
            "mode": "full",
            "meetings": [{"id": meeting_id, "deal_state": deal_state, "meeting_type": "sales",
                          "summary": {"overview": "ov"}, "title": "T"}],
        })

    def test_sales_meeting_mapped_dealstate_writes_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            ev = _write_event(tmp, meeting_id="M1", meeting_type="sales", attendees=["jane@acme.com"])
            os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
            (tmp / "pipeline.json").write_text(json.dumps(
                {"engagements": [{"clearpath_id": 42, "primary_contact_id": "jane", "contact_ids": ["jane"]}]}))
            os.environ["CRM_PIPELINE_PATH"] = str(tmp / "pipeline.json")
            self._set_ff(meeting_id="M1", deal_state="They gave a verbal yes, contract signed")

            result = self.mod.process(meeting_id="M1", event_file=None)

            ups = self._upsert_engagement_calls()
            self.assertEqual(len(ups), 1)
            self.assertEqual(ups[0][ups[0].index("--stage") + 1], "won")
            self.assertIn("42", ups[0])
            self.assertEqual(result["deal_stage"], "written")

    def test_non_sales_never_touches_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            ev = _write_event(tmp, meeting_id="M2", meeting_type="delivery", attendees=["jane@acme.com"])
            os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
            (tmp / "pipeline.json").write_text(json.dumps(
                {"engagements": [{"clearpath_id": 42, "primary_contact_id": "jane", "contact_ids": ["jane"]}]}))
            os.environ["CRM_PIPELINE_PATH"] = str(tmp / "pipeline.json")
            # Even a mapped deal_state must NOT flip a non-sales meeting.
            self._ff_stdout = json.dumps({"mode": "full", "meetings": [
                {"id": "M2", "deal_state": "contract signed", "meeting_type": "delivery"}]})

            result = self.mod.process(meeting_id="M2", event_file=None)

            self.assertEqual(self._upsert_engagement_calls(), [])
            self.assertEqual(result["deal_stage"], "skipped")
            self.assertEqual(result["reason"], "not_sales")

    def test_sales_unmapped_dealstate_no_stage_flip(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            ev = _write_event(tmp, meeting_id="M3", meeting_type="sales", attendees=["jane@acme.com"])
            os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
            (tmp / "pipeline.json").write_text(json.dumps(
                {"engagements": [{"clearpath_id": 7, "primary_contact_id": "jane", "contact_ids": ["jane"]}]}))
            os.environ["CRM_PIPELINE_PATH"] = str(tmp / "pipeline.json")
            self._set_ff(meeting_id="M3", deal_state="Moving from audit into implementation phase")

            result = self.mod.process(meeting_id="M3", event_file=None)

            self.assertEqual(self._upsert_engagement_calls(), [])  # unmapped free text -> no flip
            self.assertEqual(result["reason"], "deal_state_unmapped_preserved_as_text")

    def test_internal_attendees_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            ev = _write_event(tmp, meeting_id="M4", meeting_type="internal",
                              attendees=["josh@clearworks.ai", "jane@acme.com"])
            os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
            self._ff_stdout = json.dumps({"mode": "full", "meetings": []})

            self.mod.process(meeting_id="M4", event_file=None)

            contact_calls = self._contact_calls()
            self.assertEqual(len(contact_calls), 1)  # only the external attendee
            self.assertIn("jane@acme.com", contact_calls[0])


class RealWriteTests(unittest.TestCase):
    """Execute the real upsert-contact.py + add-interaction.py against temp CRM files."""

    def setUp(self):
        self.mod = _load_worker()
        self._tmp_ctx = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp_ctx.name)
        (self.tmp / "contacts.json").write_text(json.dumps({"version": "1.0.0", "contacts": []}))
        os.environ["CRM_CONTACTS_PATH"] = str(self.tmp / "contacts.json")
        os.environ["CRM_INTERACTIONS_PATH"] = str(self.tmp / "interactions.jsonl")
        os.environ["CRM_PIPELINE_PATH"] = str(self.tmp / "pipeline.json")
        # Real subprocess for the two present writers; fake ff-extractor + upsert-engagement.
        self._ff_meetings = []
        self._engagement_calls: list[list[str]] = []
        real_run = subprocess.run

        def routed_run(argv, env=None):
            if "ff-extractor.py" in argv[1]:
                return subprocess.CompletedProcess(
                    argv, 0, json.dumps({"mode": "full", "meetings": self._ff_meetings}), "")
            if "upsert-engagement.py" in argv[1]:
                self._engagement_calls.append(argv)
                return subprocess.CompletedProcess(argv, 0, json.dumps({"changes": ["stage"]}), "")
            return real_run(argv, capture_output=True, text=True, env=env, cwd=str(CRM_DIR))

        self.mod._run = routed_run

    def tearDown(self):
        self._tmp_ctx.cleanup()
        for k in ("CRM_CONTACTS_PATH", "CRM_INTERACTIONS_PATH", "CRM_PIPELINE_PATH", "FF_EVENT_PAYLOAD_PATH"):
            os.environ.pop(k, None)

    def _rows(self):
        p = self.tmp / "interactions.jsonl"
        if not p.exists():
            return []
        return [json.loads(ln) for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]

    def _contacts(self):
        return json.loads((self.tmp / "contacts.json").read_text())["contacts"]

    # (a) contact upserted; (b) exactly one interaction, idempotent on re-run
    def test_contact_and_single_interaction_idempotent(self):
        ev = _write_event(self.tmp, meeting_id="MR1", meeting_type="delivery", attendees=["jane@acme.com"])
        os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
        self._ff_meetings = [{"id": "MR1", "meeting_type": "delivery", "deal_state": "",
                              "title": "Kickoff", "summary": {"overview": "planning"}}]

        r1 = self.mod.process(meeting_id="MR1", event_file=None)

        contacts = self._contacts()
        self.assertEqual(len(contacts), 1)                       # (a) contact upserted
        self.assertEqual(contacts[0]["id"], "jane")
        rows = self._rows()
        self.assertEqual(len(rows), 1)                           # (b) exactly one interaction
        self.assertEqual(rows[0]["type"], "meeting")
        self.assertEqual(rows[0]["contact_id"], "jane")
        self.assertEqual(rows[0]["source_ref"], "fireflies:MR1")
        self.assertEqual(r1["interactions"], ["jane"])

        # SECOND run, same meeting_id -> no new interaction row (idempotent).
        self.mod.process(meeting_id="MR1", event_file=None)
        self.assertEqual(len(self._rows()), 1)
        self.assertEqual(len(self._contacts()), 1)

    def test_dual_attach_one_row_per_external_contact(self):
        ev = _write_event(self.tmp, meeting_id="MR2", meeting_type="delivery",
                          attendees=["jane@acme.com", "bob@acme.com", "josh@clearworks.ai"])
        os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
        self._ff_meetings = [{"id": "MR2", "meeting_type": "delivery", "deal_state": ""}]

        self.mod.process(meeting_id="MR2", event_file=None)

        rows = self._rows()
        cids = sorted(r["contact_id"] for r in rows)
        self.assertEqual(cids, ["bob", "jane"])                  # internal josh excluded
        self.assertTrue(all(r["source_ref"] == "fireflies:MR2" for r in rows))  # dual-attach by source_ref

    # (c) sales meeting -> deal_state written to pipeline via upsert-engagement
    def test_sales_writes_deal_stage(self):
        ev = _write_event(self.tmp, meeting_id="MR3", meeting_type="sales", attendees=["jane@acme.com"])
        os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
        (self.tmp / "pipeline.json").write_text(json.dumps(
            {"engagements": [{"clearpath_id": 9, "primary_contact_id": "jane", "contact_ids": ["jane"]}]}))
        self._ff_meetings = [{"id": "MR3", "meeting_type": "sales",
                              "deal_state": "They gave a verbal yes"}]

        result = self.mod.process(meeting_id="MR3", event_file=None)

        self.assertEqual(len(self._engagement_calls), 1)
        argv = self._engagement_calls[0]
        self.assertEqual(argv[argv.index("--stage") + 1], "won")
        self.assertIn("9", argv)
        self.assertEqual(result["deal_stage"], "written")
        # interaction still logged with the deal_state on the row
        self.assertEqual(self._rows()[0]["deal_state"], "They gave a verbal yes")

    # (c2) sales meeting, name-only engagement (clearpath_id null) -> select by --engagement-name (FR-007)
    def test_sales_name_only_engagement_uses_engagement_name(self):
        ev = _write_event(self.tmp, meeting_id="MR3b", meeting_type="sales", attendees=["jane@acme.com"])
        os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
        (self.tmp / "pipeline.json").write_text(json.dumps(
            {"engagements": [{"clearpath_id": None, "name": "Acme Local Deal",
                              "primary_contact_id": "jane", "contact_ids": ["jane"]}]}))
        self._ff_meetings = [{"id": "MR3b", "meeting_type": "sales",
                              "deal_state": "They gave a verbal yes"}]

        result = self.mod.process(meeting_id="MR3b", event_file=None)

        self.assertEqual(len(self._engagement_calls), 1)          # NOT silently skipped
        argv = self._engagement_calls[0]
        self.assertNotIn("--clearpath-id", argv)                  # no null id passed
        self.assertEqual(argv[argv.index("--engagement-name") + 1], "Acme Local Deal")
        self.assertEqual(result["deal_stage"], "written")

    # (d) non-sales -> pipeline.json UNTOUCHED
    def test_non_sales_pipeline_untouched(self):
        ev = _write_event(self.tmp, meeting_id="MR4", meeting_type="delivery", attendees=["jane@acme.com"])
        os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
        pipeline = {"engagements": [{"clearpath_id": 9, "primary_contact_id": "jane", "contact_ids": ["jane"]}]}
        (self.tmp / "pipeline.json").write_text(json.dumps(pipeline, indent=2))
        before = (self.tmp / "pipeline.json").read_text()
        self._ff_meetings = [{"id": "MR4", "meeting_type": "delivery", "deal_state": "contract signed"}]

        result = self.mod.process(meeting_id="MR4", event_file=None)

        self.assertEqual(self._engagement_calls, [])            # writer never invoked
        self.assertEqual((self.tmp / "pipeline.json").read_text(), before)  # byte-for-byte untouched
        self.assertEqual(result["reason"], "not_sales")
        self.assertEqual(len(self._rows()), 1)                  # interaction still logged

    # (e) missing deal_state on a sales meeting -> interaction logged, no crash, no stage
    def test_sales_missing_dealstate_still_logs_no_crash(self):
        ev = _write_event(self.tmp, meeting_id="MR5", meeting_type="sales", attendees=["jane@acme.com"])
        os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)
        (self.tmp / "pipeline.json").write_text(json.dumps(
            {"engagements": [{"clearpath_id": 9, "primary_contact_id": "jane", "contact_ids": ["jane"]}]}))
        self._ff_meetings = [{"id": "MR5", "meeting_type": "sales", "deal_state": ""}]

        result = self.mod.process(meeting_id="MR5", event_file=None)

        self.assertEqual(self._engagement_calls, [])            # no deal_state -> no stage write
        self.assertEqual(result["reason"], "no_deal_state")
        self.assertEqual(len(self._rows()), 1)                  # interaction still logged
        self.assertIsNone(self._rows()[0]["deal_state"])

    def test_event_file_fallback_path(self):
        # --event-file drives the sync when no --meeting-id is passed.
        ev = _write_event(self.tmp, meeting_id="MR6", meeting_type="delivery", attendees=["jane@acme.com"])
        self._ff_meetings = [{"id": "MR6", "meeting_type": "delivery", "deal_state": ""}]

        result = self.mod.process(meeting_id=None, event_file=str(ev))

        self.assertEqual(result["meeting_id"], "MR6")
        self.assertEqual(len(self._rows()), 1)


class EmailLessAttendeeTests(unittest.TestCase):
    """F-1 FINAL review: FR-004 fills bare NAME strings (no email) into
    fanout-meeting.json's attendees for email-less speakers; FR-009 requires
    they are NEVER upserted / logged. Live apply upserted two email-less
    contacts (ivette-ramos, joseph-chang) and wrote 8 rows instead of 6
    before this fix."""

    def setUp(self):
        self.mod = _load_worker()
        self.calls: list[list[str]] = []

        def fake_run(argv, env=None):
            self.calls.append(argv)
            if "upsert-contact.py" in argv[1]:
                idx = argv.index("--id") + 1
                return subprocess.CompletedProcess(argv, 0, argv[idx], "")
            return subprocess.CompletedProcess(argv, 0, "{}", "")

        self.mod._run = fake_run

    def tearDown(self):
        for k in ("CRM_CONTACTS_PATH", "CRM_PIPELINE_PATH", "FF_EVENT_PAYLOAD_PATH"):
            os.environ.pop(k, None)

    def _contact_calls(self):
        return [c for c in self.calls if "upsert-contact.py" in c[1]]

    def _interaction_calls(self):
        return [c for c in self.calls if "add-interaction.py" in c[1]]

    def test_crm_attendees_drops_name_only_entries(self):
        # Unit-level: the shared derivation function itself.
        full_meeting = {"attendees": ["marcos@alloi.us", "Ivette Ramos", "joe@alloi.us"]}
        self.assertEqual(
            self.mod.crm_attendees({}, full_meeting),
            ["marcos@alloi.us", "joe@alloi.us"],
        )

    def test_external_attendees_drops_name_only_entries(self):
        full_meeting = {"attendees": ["marcos@alloi.us", "Ivette Ramos", "joe@alloi.us"]}
        self.assertEqual(
            self.mod.external_attendees({}, full_meeting),
            [{"name": "", "email": "marcos@alloi.us"}, {"name": "", "email": "joe@alloi.us"}],
        )

    def test_crm_attendees_present_empty_list_is_authoritative(self):
        # N-1: event.json's "attendees" key present but [] means the
        # adapter already decided there are no external, emailed attendees
        # (FR-009 "no attendees -> write nothing") -- must NOT fall back to
        # full_meeting even though full_meeting has real emailed attendees.
        full_meeting = {"attendees": ["marcos@alloi.us", "joe@alloi.us"]}
        self.assertEqual(self.mod.crm_attendees({"attendees": []}, full_meeting), [])

    def test_crm_attendees_missing_key_falls_back_to_full_meeting(self):
        # N-1: only a WHOLLY ABSENT "attendees" key (legacy payload) falls
        # back to full_meeting.
        full_meeting = {"attendees": ["marcos@alloi.us", "Ivette Ramos", "joe@alloi.us"]}
        self.assertEqual(
            self.mod.crm_attendees({"meeting_id": "M9"}, full_meeting),
            ["marcos@alloi.us", "joe@alloi.us"],
        )

    def test_full_file_name_only_attendees_never_upserted(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            full = tmp / "fanout-meeting.json"
            full.write_text(json.dumps({
                "meetings": [{
                    "id": "M9",
                    "meeting_type": "delivery",
                    "attendees": ["marcos@alloi.us", "Ivette Ramos", "joe@alloi.us"],
                }]
            }))
            # event.json carries no attendees at all -> falls back to full_meeting.
            ev = _write_event(tmp, meeting_id="M9", meeting_type="delivery", attendees=None)
            os.environ["FF_EVENT_PAYLOAD_PATH"] = str(ev)

            result = self.mod.process(meeting_id="M9", event_file=None, full_file=str(full))

            contact_calls = self._contact_calls()
            self.assertEqual(len(contact_calls), 2)  # 2 emails only
            emails = {c[c.index("--email") + 1] for c in contact_calls}
            self.assertEqual(emails, {"marcos@alloi.us", "joe@alloi.us"})
            self.assertTrue(all("Ivette" not in " ".join(c) for c in contact_calls))

            interaction_calls = self._interaction_calls()
            self.assertEqual(len(interaction_calls), 2)  # 2 interaction rows, not 3
            self.assertEqual(result["external_attendees"], 2)


class FullFileTests(unittest.TestCase):
    def setUp(self):
        self.mod = _load_worker()
        self.calls: list[list[str]] = []

        def fake_run(argv, env=None):
            self.calls.append(argv)
            if "upsert-contact.py" in argv[1]:
                idx = argv.index("--id") + 1
                return subprocess.CompletedProcess(argv, 0, argv[idx], "")
            return subprocess.CompletedProcess(argv, 0, "{}", "")

        self.mod._run = fake_run
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        os.environ["CRM_CONTACTS_PATH"] = str(self.tmp_path / "contacts.json")
        os.environ["CRM_PIPELINE_PATH"] = str(self.tmp_path / "pipeline.json")

    def tearDown(self):
        self.tmp.cleanup()
        os.environ.pop("CRM_CONTACTS_PATH", None)
        os.environ.pop("CRM_PIPELINE_PATH", None)

    def test_full_file_skips_ff_extractor(self):
        full = self.tmp_path / "fanout-meeting.json"
        full.write_text(json.dumps({
            "meetings": [{
                "id": "01M1MW2GAZ1DQ0C6PG3KJ557JA",
                "meeting_type": "delivery",
                "summary": {"overview": "Scoped tactical reports."},
                "deal_state": None,
            }]
        }))
        event = _write_event(
            self.tmp_path, meeting_id="01M1MW2GAZ1DQ0C6PG3KJ557JA",
            meeting_type="delivery", attendees=["marcos@alloi.us"],
        )
        result = self.mod.process(
            meeting_id="01M1MW2GAZ1DQ0C6PG3KJ557JA",
            event_file=str(event),
            full_file=str(full),
        )
        assert not any("ff-extractor.py" in c[1] for c in self.calls)
        assert result["meeting_id"] == "01M1MW2GAZ1DQ0C6PG3KJ557JA"
        assert result["contacts"]


if __name__ == "__main__":
    unittest.main()
