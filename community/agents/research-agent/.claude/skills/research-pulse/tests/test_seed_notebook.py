from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import pulse_registry
from scripts import seed_notebook as MODULE


class SeedNotebookTests(unittest.TestCase):
    def load_fixture(self, name: str) -> dict:
        with (FIXTURES / name).open(encoding="utf-8") as handle:
            return json.load(handle)

    def make_add_payload(self, source_id: str, url: str, title: str) -> dict:
        payload = self.load_fixture("nlm_source_add.json")
        payload["source"]["id"] = source_id
        payload["source"]["url"] = url
        payload["source"]["title"] = title
        return payload

    def make_notebook_create_payload(self, notebook_id: str, title: str) -> dict:
        payload = self.load_fixture("nlm_notebook_create.json")
        payload["notebook"]["id"] = notebook_id
        payload["notebook"]["title"] = title
        return payload

    def make_registry(self, count: int, *, qualities: list[str] | None = None, seeded: int = 0) -> dict:
        registry = pulse_registry.new_registry(
            "nonprofit",
            "Nonprofit",
            "Tracks nonprofit operating, funding, and regulatory signals.",
            notebook_id="nb-123",
        )
        qualities = qualities or ["high"] * count
        for idx in range(count):
            pulse_registry.add_source(
                registry,
                source_name=f"Source {idx + 1}",
                url=f"https://example.com/source-{idx + 1}",
                source_type="article",
                feed_url=None,
                tags={
                    "topic": ["operations"],
                    "signal": ["leading"],
                    "authority": "industry_expert",
                    "cadence": "weekly",
                    "quality": qualities[idx],
                },
                notebooklm_source_id=f"seeded-{idx + 1}" if idx < seeded else None,
            )
        return registry

    def save_registry(self, registry: dict, tmp: str) -> None:
        with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
            pulse_registry.save_registry(registry)

    def test_preflight_missing_bin_message(self) -> None:
        with unittest.mock.patch.object(MODULE, "NOTEBOOKLM_BIN", "/tmp/missing-notebooklm"):
            with unittest.mock.patch.object(MODULE.os.path, "exists", return_value=False):
                with self.assertRaisesRegex(RuntimeError, "pip install notebooklm-py into a durable venv"):
                    MODULE.preflight()

    def test_pick_seedable_quality_order_and_cap(self) -> None:
        registry = self.make_registry(
            6,
            qualities=["medium", "high", "archival", "high", "emerging", "medium"],
            seeded=1,
        )
        registry["sources"][4]["url"] = "notebooklm://existing"
        with contextlib.redirect_stderr(io.StringIO()):
            picked = MODULE.pick_seedable(registry, 4)
        self.assertEqual([source["source_name"] for source in picked], ["Source 2", "Source 4", "Source 6"])

        full = self.make_registry(45, seeded=45)
        with self.assertRaises(MODULE.CapError):
            MODULE.pick_seedable(full, 45)

    def test_seed_happy_path_persists_ids_incrementally(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry(3)
            self.save_registry(registry, tmp)
            calls: list[list[str]] = []

            def fake_run(args: list[str], **_: object) -> subprocess.CompletedProcess:
                calls.append(args)
                if args[1:4] == ["source", "list", "--notebook"]:
                    return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"sources": []}), stderr="")
                if args[1:3] == ["source", "add"]:
                    source_number = len([call for call in calls if call[1:3] == ["source", "add"]])
                    url = args[3]
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=json.dumps(self.make_add_payload(f"nlm-{source_number}", url, f"Source {source_number}")),
                        stderr="",
                    )
                if args[1:3] == ["source", "wait"]:
                    return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
                raise AssertionError(args)

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                    with contextlib.redirect_stderr(io.StringIO()):
                        succeeded, failed = MODULE.seed(registry, "nb-123", 45, False)
                    saved = pulse_registry.load_registry("nonprofit")

            self.assertEqual((succeeded, failed), (3, 0))
            self.assertEqual(
                [source["notebooklm_source_id"] for source in saved["sources"]],
                ["nlm-1", "nlm-2", "nlm-3"],
            )
            add_calls = [call for call in calls if call[1:3] == ["source", "add"]]
            wait_calls = [call for call in calls if call[1:3] == ["source", "wait"]]
            self.assertEqual(len(add_calls), 3)
            self.assertEqual(len(wait_calls), 3)

    def test_seed_partial_failure_exit_1(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry(3)
            self.save_registry(registry, tmp)

            def fake_run(args: list[str], **_: object) -> subprocess.CompletedProcess:
                if args[1:2] == ["status"]:
                    return subprocess.CompletedProcess(args, 0, stdout="ok", stderr="")
                if args[1:4] == ["source", "list", "--notebook"]:
                    return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"sources": []}), stderr="")
                if args[1:3] == ["source", "add"]:
                    url = args[3]
                    if url.endswith("source-2"):
                        return subprocess.CompletedProcess(args, 1, stdout="", stderr="hard failure")
                    suffix = url.rsplit("-", 1)[-1]
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=json.dumps(self.make_add_payload(f"nlm-{suffix}", url, f"Source {suffix}")),
                        stderr="",
                    )
                if args[1:3] == ["source", "wait"]:
                    return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
                raise AssertionError(args)

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE, "NOTEBOOKLM_BIN", "/tmp/notebooklm"):
                    with unittest.mock.patch.object(MODULE.os.path, "exists", return_value=True):
                        with unittest.mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                            with contextlib.redirect_stderr(io.StringIO()):
                                rc = MODULE.main(["--vertical", "nonprofit", "--limit", "45"])
                saved = pulse_registry.load_registry("nonprofit")

            self.assertEqual(rc, 1)
            self.assertEqual(saved["sources"][0]["notebooklm_source_id"], "nlm-1")
            self.assertIsNone(saved["sources"][1]["notebooklm_source_id"])
            self.assertEqual(saved["sources"][2]["notebooklm_source_id"], "nlm-3")

    def test_main_create_records_nested_notebook_id_in_registry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry(1)
            registry["notebook_id"] = None
            self.save_registry(registry, tmp)

            def fake_run(args: list[str], **_: object) -> subprocess.CompletedProcess:
                if args[1:2] == ["status"]:
                    return subprocess.CompletedProcess(args, 0, stdout="ok", stderr="")
                if args[1:2] == ["create"]:
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=json.dumps(self.make_notebook_create_payload("nb-new-1", "Created Notebook")),
                        stderr="",
                    )
                if args[1:4] == ["source", "list", "--notebook"]:
                    return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"sources": []}), stderr="")
                if args[1:3] == ["source", "add"]:
                    url = args[3]
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=json.dumps(self.make_add_payload("nlm-1", url, "Source 1")),
                        stderr="",
                    )
                if args[1:3] == ["source", "wait"]:
                    return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
                raise AssertionError(args)

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE, "NOTEBOOKLM_BIN", "/tmp/notebooklm"):
                    with unittest.mock.patch.object(MODULE.os.path, "exists", return_value=True):
                        with unittest.mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                            with contextlib.redirect_stderr(io.StringIO()):
                                rc = MODULE.main(["--vertical", "nonprofit", "--limit", "45", "--create"])
                saved = pulse_registry.load_registry("nonprofit")

            self.assertEqual(rc, 0)
            self.assertEqual(saved["notebook_id"], "nb-new-1")
            self.assertEqual(saved["sources"][0]["notebooklm_source_id"], "nlm-1")

    def test_idempotent_skip_already_seeded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry(2, seeded=2)
            self.save_registry(registry, tmp)
            calls: list[list[str]] = []

            def fake_run(args: list[str], **_: object) -> subprocess.CompletedProcess:
                calls.append(args)
                return subprocess.CompletedProcess(
                    args,
                    0,
                    stdout=json.dumps(self.load_fixture("nlm_source_list.json")),
                    stderr="",
                )

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                    succeeded, failed = MODULE.seed(registry, "nb-123", 45, False)

            self.assertEqual((succeeded, failed), (0, 0))
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][1:4], ["source", "list", "--notebook"])

    def test_reconcile_against_existing_notebook_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry(2)
            registry["sources"][0]["source_name"] = "Alpha Source"
            registry["sources"][0]["url"] = "https://youtube.com/channel/UCALPHA/"
            registry["sources"][1]["source_name"] = "Fresh Source"
            registry["sources"][1]["url"] = "https://example.com/fresh-source"
            self.save_registry(registry, tmp)
            fixture = {
                "sources": [
                    {
                        "index": 1,
                        "id": "nlm-existing-1",
                        "title": "Alpha Source - YouTube",
                        "type": "web_page",
                        "url": "https://youtube.com/channel/ucalpha",
                        "status": "ready",
                    }
                ]
            }

            def fake_run(args: list[str], **_: object) -> subprocess.CompletedProcess:
                if args[1:4] == ["source", "list", "--notebook"]:
                    return subprocess.CompletedProcess(args, 0, stdout=json.dumps(fixture), stderr="")
                if args[1:3] == ["source", "add"]:
                    url = args[3]
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=json.dumps(self.make_add_payload("nlm-new-2", url, "Fresh Source")),
                        stderr="",
                    )
                if args[1:3] == ["source", "wait"]:
                    return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
                raise AssertionError(args)

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                    with contextlib.redirect_stderr(io.StringIO()):
                        MODULE.seed(registry, "nb-123", 45, False)
                saved = pulse_registry.load_registry("nonprofit")

            self.assertEqual(saved["sources"][0]["notebooklm_source_id"], "nlm-existing-1")
            self.assertEqual(saved["sources"][1]["notebooklm_source_id"], "nlm-new-2")

    def test_nested_add_ids_record_and_second_run_reconciles_by_url_without_dupes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry(2)
            self.save_registry(registry, tmp)
            add_calls: list[list[str]] = []
            added_urls: list[str] = []

            def fake_run(args: list[str], **_: object) -> subprocess.CompletedProcess:
                if args[1:4] == ["source", "list", "--notebook"]:
                    if not added_urls:
                        return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"sources": []}), stderr="")
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=json.dumps(
                            {
                                "sources": [
                                    {
                                        "index": idx + 1,
                                        "id": f"nlm-{idx + 1}",
                                        "title": f"Source {idx + 1} - YouTube",
                                        "type": "web_page",
                                        "url": url,
                                        "status": "ready",
                                    }
                                    for idx, url in enumerate(added_urls)
                                ]
                            }
                        ),
                        stderr="",
                    )
                if args[1:3] == ["source", "add"]:
                    add_calls.append(args)
                    url = args[3]
                    added_urls.append(url)
                    idx = len(added_urls)
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=json.dumps(self.make_add_payload(f"nlm-{idx}", url, f"Source {idx}")),
                        stderr="",
                    )
                if args[1:3] == ["source", "wait"]:
                    return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
                raise AssertionError(args)

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                    with contextlib.redirect_stderr(io.StringIO()):
                        first_result = MODULE.seed(registry, "nb-123", 45, False)
                    first_saved = pulse_registry.load_registry("nonprofit")

                    for source in registry["sources"]:
                        source["notebooklm_source_id"] = None
                    pulse_registry.save_registry(registry)

                    before_second_run = len(add_calls)
                    with contextlib.redirect_stderr(io.StringIO()):
                        second_result = MODULE.seed(registry, "nb-123", 45, False)
                    second_saved = pulse_registry.load_registry("nonprofit")

            self.assertEqual(first_result, (2, 0))
            self.assertEqual(
                [source["notebooklm_source_id"] for source in first_saved["sources"]],
                ["nlm-1", "nlm-2"],
            )
            self.assertEqual(second_result, (0, 0))
            self.assertEqual(len(add_calls), before_second_run)
            self.assertEqual(
                [source["notebooklm_source_id"] for source in second_saved["sources"]],
                ["nlm-1", "nlm-2"],
            )

    def test_dry_run_no_subprocess(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry(
                12,
                qualities=["medium", "high", "archival", "high", "emerging", "medium", "high", "medium", "archival", "emerging", "high", "medium"],
            )
            self.save_registry(registry, tmp)
            stdout = io.StringIO()
            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE.subprocess, "run") as mocked_run:
                    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                        rc = MODULE.main(
                            [
                                "--vertical",
                                "nonprofit",
                                "--notebook-id",
                                "nb-123",
                                "--limit",
                                "10",
                                "--dry-run",
                            ]
                        )
            self.assertEqual(rc, 0)
            mocked_run.assert_not_called()
            payload = json.loads(stdout.getvalue())
            self.assertEqual(len(payload["planned_sources"]), 10)

    def test_rate_limit_retry_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            registry = self.make_registry(1)
            self.save_registry(registry, tmp)
            attempts = {"add": 0}

            def fake_run(args: list[str], **_: object) -> subprocess.CompletedProcess:
                if args[1:4] == ["source", "list", "--notebook"]:
                    return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"sources": []}), stderr="")
                if args[1:3] == ["source", "add"]:
                    attempts["add"] += 1
                    if attempts["add"] == 1:
                        return subprocess.CompletedProcess(
                            args,
                            1,
                            stdout="",
                            stderr="No result found for RPC ID",
                        )
                    url = args[3]
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=json.dumps(self.make_add_payload("nlm-1", url, "Source 1")),
                        stderr="",
                    )
                if args[1:3] == ["source", "wait"]:
                    return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
                raise AssertionError(args)

            with unittest.mock.patch.dict(os.environ, {"PULSE_STATE_DIR": tmp}, clear=False):
                with unittest.mock.patch.object(MODULE.subprocess, "run", side_effect=fake_run):
                    with unittest.mock.patch.object(MODULE.time, "sleep") as mocked_sleep:
                        with contextlib.redirect_stderr(io.StringIO()):
                            succeeded, failed = MODULE.seed(registry, "nb-123", 45, False)

            self.assertEqual((succeeded, failed), (1, 0))
            mocked_sleep.assert_called_once_with(60)


if __name__ == "__main__":
    unittest.main()
