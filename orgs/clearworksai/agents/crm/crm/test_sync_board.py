from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("sync-board.py")
SPEC = importlib.util.spec_from_file_location("sync_board_script", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load sync-board.py for tests")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    def __init__(self, payload: dict[str, object], status: int = 200) -> None:
        self.payload = payload
        self.status = status

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")

    def close(self) -> None:
        return None


class SyncBoardTests(unittest.TestCase):
    def write_pipeline(self, directory: Path, engagements: list[dict[str, object]]) -> Path:
        engagements = [
            {"record_id": engagement.get("record_id", f"test:deal:{index}"), **engagement}
            for index, engagement in enumerate(engagements, start=1)
        ]
        pipeline_path = directory / "pipeline.json"
        pipeline_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "source": "test",
                    "stage_mapping": {},
                    "engagements": engagements,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        return pipeline_path

    def read_pipeline(self, path: Path) -> dict[str, object]:
        return json.loads(path.read_text(encoding="utf-8"))

    def test_board_stage_change_updates_engagement_and_second_run_is_noop(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            pipeline_path = self.write_pipeline(
                tmp_path,
                [
                    {
                        "name": "Automation Sprint",
                        "client_org": "Acme",
                        "stage": "lead",
                        "stage_changed_at": "2026-01-01T00:00:00Z",
                    }
                ],
            )

            def urlopen(_request: object, timeout: int = 10) -> FakeResponse:
                del timeout
                return FakeResponse(
                    {
                        "deals": [
                            {
                                "id": "test:deal:1",
                                "stage": "qualified",
                            }
                        ]
                    }
                )

            first = MODULE.sync_board(
                pipeline_path=pipeline_path,
                base_url="https://briefs.example",
                token="abc123",
                urlopen=urlopen,
                timestamp="2026-06-10T12:00:00Z",
            )
            self.assertEqual(first, 0)
            payload = self.read_pipeline(pipeline_path)
            engagement = payload["engagements"][0]
            self.assertEqual(engagement["stage"], "qualified")
            self.assertEqual(engagement["stage_changed_at"], "2026-06-10T12:00:00Z")

            snapshot = pipeline_path.read_text(encoding="utf-8")
            second = MODULE.sync_board(
                pipeline_path=pipeline_path,
                base_url="https://briefs.example",
                token="abc123",
                urlopen=urlopen,
                timestamp="2026-06-10T12:00:00Z",
            )
            self.assertEqual(second, 0)
            self.assertEqual(pipeline_path.read_text(encoding="utf-8"), snapshot)

    def test_crm_authoritative_engagement_keeps_stage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pipeline_path = self.write_pipeline(
                Path(tmp),
                [
                    {
                        "name": "Automation Sprint",
                        "client_org": "Acme",
                        "stage": "qualified",
                        "stage_changed_at": "2026-01-01T00:00:00Z",
                        "crm_authoritative": True,
                    }
                ],
            )

            def urlopen(_request: object, timeout: int = 10) -> FakeResponse:
                del timeout
                return FakeResponse(
                    {
                        "deals": [
                            {
                                "id": "test:deal:1",
                                "stage": "lead",
                            }
                        ]
                    }
                )

            first = MODULE.sync_board(
                pipeline_path=pipeline_path,
                base_url="https://briefs.example",
                token="abc123",
                urlopen=urlopen,
                timestamp="2026-06-10T12:00:00Z",
            )
            self.assertEqual(first, 0)
            payload = self.read_pipeline(pipeline_path)
            engagement = payload["engagements"][0]
            self.assertEqual(engagement["stage"], "qualified")
            self.assertEqual(engagement["stage_changed_at"], "2026-01-01T00:00:00Z")

            snapshot = pipeline_path.read_text(encoding="utf-8")
            second = MODULE.sync_board(
                pipeline_path=pipeline_path,
                base_url="https://briefs.example",
                token="abc123",
                urlopen=urlopen,
                timestamp="2026-06-10T12:00:00Z",
            )
            self.assertEqual(second, 0)
            self.assertEqual(pipeline_path.read_text(encoding="utf-8"), snapshot)

    def test_non_authoritative_still_reverts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pipeline_path = self.write_pipeline(
                Path(tmp),
                [
                    {
                        "name": "Automation Sprint",
                        "client_org": "Acme",
                        "stage": "qualified",
                        "stage_changed_at": "2026-01-01T00:00:00Z",
                    }
                ],
            )

            def urlopen(_request: object, timeout: int = 10) -> FakeResponse:
                del timeout
                return FakeResponse(
                    {
                        "deals": [
                            {
                                "id": "test:deal:1",
                                "stage": "lead",
                            }
                        ]
                    }
                )

            result = MODULE.sync_board(
                pipeline_path=pipeline_path,
                base_url="https://briefs.example",
                token="abc123",
                urlopen=urlopen,
                timestamp="2026-06-10T12:00:00Z",
            )
            self.assertEqual(result, 0)
            payload = self.read_pipeline(pipeline_path)
            engagement = payload["engagements"][0]
            self.assertEqual(engagement["stage"], "lead")
            self.assertEqual(engagement["stage_changed_at"], "2026-06-10T12:00:00Z")

    def test_crm_authoritative_still_archives(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pipeline_path = self.write_pipeline(
                Path(tmp),
                [
                    {
                        "name": "Automation Sprint",
                        "client_org": "Acme",
                        "stage": "qualified",
                        "stage_changed_at": "2026-01-01T00:00:00Z",
                        "crm_authoritative": True,
                    }
                ],
            )

            def urlopen(_request: object, timeout: int = 10) -> FakeResponse:
                del timeout
                return FakeResponse(
                    {
                        "deals": [
                            {
                                "id": "test:deal:1",
                                "stage": "lead",
                                "archived": True,
                            }
                        ]
                    }
                )

            result = MODULE.sync_board(
                pipeline_path=pipeline_path,
                base_url="https://briefs.example",
                token="abc123",
                urlopen=urlopen,
                timestamp="2026-06-10T12:00:00Z",
            )
            self.assertEqual(result, 0)
            payload = self.read_pipeline(pipeline_path)
            engagement = payload["engagements"][0]
            self.assertEqual(engagement["stage"], "qualified")
            self.assertEqual(engagement["stage_changed_at"], "2026-01-01T00:00:00Z")
            self.assertTrue(engagement["archived"])

    def test_board_archived_flag_marks_engagement_archived(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pipeline_path = self.write_pipeline(
                Path(tmp),
                [{"name": "Automation Sprint", "client_org": "Acme", "stage": "lead"}],
            )

            def urlopen(_request: object, timeout: int = 10) -> FakeResponse:
                del timeout
                return FakeResponse(
                    {
                        "deals": [
                            {
                                "id": "test:deal:1",
                                "stage": "lead",
                                "archived": True,
                            }
                        ]
                    }
                )

            MODULE.sync_board(
                pipeline_path=pipeline_path,
                base_url="https://briefs.example",
                token="abc123",
                urlopen=urlopen,
                timestamp="2026-06-10T12:00:00Z",
            )
            payload = self.read_pipeline(pipeline_path)
            self.assertTrue(payload["engagements"][0]["archived"])

    def test_engagement_absent_from_board_is_left_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pipeline_path = self.write_pipeline(
                Path(tmp),
                [{"name": "Automation Sprint", "client_org": "Acme", "stage": "lead"}],
            )
            before = pipeline_path.read_text(encoding="utf-8")

            def urlopen(_request: object, timeout: int = 10) -> FakeResponse:
                del timeout
                return FakeResponse({"deals": []})

            MODULE.sync_board(
                pipeline_path=pipeline_path,
                base_url="https://briefs.example",
                token="abc123",
                urlopen=urlopen,
                timestamp="2026-06-10T12:00:00Z",
            )
            self.assertEqual(pipeline_path.read_text(encoding="utf-8"), before)

    def test_board_fetch_failure_keeps_pipeline_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pipeline_path = self.write_pipeline(
                Path(tmp),
                [{"name": "Automation Sprint", "client_org": "Acme", "stage": "lead"}],
            )
            before = pipeline_path.read_text(encoding="utf-8")

            def urlopen(_request: object, timeout: int = 10) -> FakeResponse:
                del timeout
                raise OSError("network down")

            MODULE.sync_board(
                pipeline_path=pipeline_path,
                base_url="https://briefs.example",
                token="abc123",
                urlopen=urlopen,
                timestamp="2026-06-10T12:00:00Z",
            )
            self.assertEqual(pipeline_path.read_text(encoding="utf-8"), before)

    def test_same_company_deals_are_updated_only_by_stable_record_id(self) -> None:
        engagements = [
            {"record_id": "deal:closed", "client_org": "Acme", "name": "Audit", "stage": "won"},
            {"record_id": "deal:monthly", "client_org": "Acme", "name": "Monthly", "stage": "lead"},
        ]
        updated, changed, _events = MODULE.reconcile_engagements(
            engagements,
            [{"id": "deal:monthly", "stage": "qualified"}],
            changed_at="2026-08-23T00:00:00Z",
        )
        self.assertEqual(changed, 1)
        self.assertEqual(updated[0]["stage"], "won")
        self.assertEqual(updated[1]["stage"], "qualified")

    def test_closed_deal_cannot_be_reopened(self) -> None:
        with self.assertRaisesRegex(ValueError, "create a new deal record"):
            MODULE.reconcile_engagements(
                [{"record_id": "deal:closed", "client_org": "Acme", "name": "Audit", "stage": "won"}],
                [{"id": "deal:closed", "stage": "lead"}],
                changed_at="2026-08-23T00:00:00Z",
            )


if __name__ == "__main__":
    unittest.main()
