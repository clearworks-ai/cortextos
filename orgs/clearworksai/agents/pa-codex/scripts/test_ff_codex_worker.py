from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("ff-extractor.py")
SPEC = importlib.util.spec_from_file_location("ff_extractor_codex_tests", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load ff-extractor.py")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CodexBatchTests(unittest.TestCase):
    def result(self) -> dict[str, object]:
        return {
            "meetings": [
                {
                    "id": "meeting_123",
                    "is_casual": False,
                    "action_items": [
                        {"action": "Send proposal", "owner": "Josh", "dueDate": "Friday", "status": "pending"}
                    ],
                    "decisions": ["Agreed to the pilot"],
                    "deal_state": "Moved to proposal",
                }
            ]
        }

    def test_one_bounded_codex_invocation_per_actionable_batch(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            calls.append(command)
            output_path = Path(command[command.index("--output-last-message") + 1])
            output_path.write_text(json.dumps(self.result()), encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")

        batch = [{"id": "meeting_123", "title": "Acme", "client_context": "", "transcript": "Josh: I'll send it Friday."}]
        result = MODULE.run_codex_batch(batch, run_process=fake_run)

        self.assertEqual(len(calls), 1)
        self.assertEqual(result["meeting_123"]["action_items"][0]["action"], "Send proposal")
        command = calls[0]
        self.assertEqual(command[:2], [MODULE.CODEX_BINARY, "exec"])
        self.assertIn("--ephemeral", command)
        self.assertIn("--sandbox", command)
        self.assertIn("read-only", command)
        self.assertNotIn("openrouter", " ".join(command).lower())

    def test_empty_batch_makes_zero_codex_calls(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        self.assertEqual(MODULE.run_codex_batch([], run_process=fake_run), {})
        self.assertEqual(calls, [])

    def test_multiple_meetings_still_make_one_codex_call(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            calls.append(command)
            output_path = Path(command[command.index("--output-last-message") + 1])
            payload = self.result()
            payload["meetings"].append(
                {
                    "id": "meeting_456",
                    "is_casual": True,
                    "action_items": [],
                    "decisions": [],
                    "deal_state": "",
                }
            )
            output_path.write_text(json.dumps(payload), encoding="utf-8")
            prompt = str(kwargs["input"])
            self.assertIn("meeting_123", prompt)
            self.assertIn("meeting_456", prompt)
            self.assertIn("Existing Acme context", prompt)
            return subprocess.CompletedProcess(command, 0, "", "")

        batch = [
            {
                "id": "meeting_123",
                "title": "Acme",
                "client_context": "Existing Acme context",
                "transcript": "Josh: I'll send it Friday.",
            },
            {"id": "meeting_456", "title": "Coffee", "client_context": "", "transcript": "Small talk."},
        ]
        result = MODULE.run_codex_batch(batch, run_process=fake_run)

        self.assertEqual(len(calls), 1)
        self.assertEqual(set(result), {"meeting_123", "meeting_456"})

    def test_structured_output_fails_closed_when_meeting_is_omitted(self) -> None:
        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            output_path = Path(command[command.index("--output-last-message") + 1])
            output_path.write_text('{"meetings": []}', encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")

        with self.assertRaisesRegex(ValueError, "omitted"):
            MODULE.run_codex_batch(
                [{"id": "meeting_123", "title": "Acme", "client_context": "", "transcript": "text"}],
                run_process=fake_run,
            )

    def test_structured_output_fails_closed_for_unknown_meeting(self) -> None:
        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            output_path = Path(command[command.index("--output-last-message") + 1])
            payload = self.result()
            payload["meetings"][0]["id"] = "unknown"
            output_path.write_text(json.dumps(payload), encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")

        with self.assertRaisesRegex(ValueError, "unknown or duplicate"):
            MODULE.run_codex_batch(
                [{"id": "meeting_123", "title": "Acme", "client_context": "", "transcript": "text"}],
                run_process=fake_run,
            )

    def test_structured_output_fails_closed_for_duplicate_meeting(self) -> None:
        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            output_path = Path(command[command.index("--output-last-message") + 1])
            payload = self.result()
            payload["meetings"].append(dict(payload["meetings"][0]))
            output_path.write_text(json.dumps(payload), encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")

        with self.assertRaisesRegex(ValueError, "unknown or duplicate"):
            MODULE.run_codex_batch(
                [{"id": "meeting_123", "title": "Acme", "client_context": "", "transcript": "text"}],
                run_process=fake_run,
            )

    def test_structured_output_fails_closed_for_invalid_action_shape(self) -> None:
        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            output_path = Path(command[command.index("--output-last-message") + 1])
            payload = self.result()
            payload["meetings"][0]["action_items"][0]["owner"] = 7
            output_path.write_text(json.dumps(payload), encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")

        with self.assertRaisesRegex(ValueError, "action item"):
            MODULE.run_codex_batch(
                [{"id": "meeting_123", "title": "Acme", "client_context": "", "transcript": "text"}],
                run_process=fake_run,
            )

    def test_missing_result_file_fails_closed(self) -> None:
        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(command, 0, "", "")

        with self.assertRaisesRegex(ValueError, "did not produce"):
            MODULE.run_codex_batch(
                [{"id": "meeting_123", "title": "Acme", "client_context": "", "transcript": "text"}],
                run_process=fake_run,
            )

    def test_nonzero_codex_exit_fails_closed(self) -> None:
        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(command, 9, "", "subscription unavailable")

        with self.assertRaisesRegex(RuntimeError, "exit 9"):
            MODULE.run_codex_batch(
                [{"id": "meeting_123", "title": "Acme", "client_context": "", "transcript": "text"}],
                run_process=fake_run,
            )

    def test_codex_timeout_fails_closed(self) -> None:
        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            raise subprocess.TimeoutExpired(command, timeout=3)

        with self.assertRaisesRegex(RuntimeError, "timed out"):
            MODULE.run_codex_batch(
                [{"id": "meeting_123", "title": "Acme", "client_context": "", "transcript": "text"}],
                run_process=fake_run,
            )

    def test_fixture_parity_preserves_deterministic_refinement(self) -> None:
        transcript = {
            "id": "meeting_123",
            "title": "Acme Follow Up",
            "date": "2026-06-08T16:00:00Z",
            "sentences": [{"speaker_name": "Josh Weiss", "text": "I'll send the proposal Friday."}],
        }
        commitments, drop_reason = MODULE.extract_commitments_for_transcript(
            transcript,
            analysis=self.result()["meetings"][0],
        )
        self.assertIsNone(drop_reason)
        self.assertEqual(len(commitments), 1)
        self.assertRegex(commitments[0].id, r"^ff_meeting_123_[0-9a-f]{12}$")

    def test_source_has_no_openrouter_network_or_key_dependency(self) -> None:
        source = MODULE_PATH.read_text(encoding="utf-8").lower()
        self.assertNotIn("openrouter", source)
        self.assertNotIn("openrouter_api_key", source)


class CronWrapperTests(unittest.TestCase):
    WRAPPER = Path(__file__).parents[1] / "bin" / "ff-extractor-cron.sh"

    def run_wrapper(self, extractor_rc: int) -> tuple[subprocess.CompletedProcess[str], str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / "bus.log"
            fake_bus = root / "cortextos"
            fake_python = root / "python3"
            fake_extractor = root / "ff-extractor.py"
            fake_bus.write_text(
                "#!/bin/sh\necho \"$*\" >> \"$BUS_LOG\"\n"
                "if [ \"$1 $2\" = \"bus create-task\" ]; then echo task_test; fi\n",
                encoding="utf-8",
            )
            fake_python.write_text(f"#!/bin/sh\nexit {extractor_rc}\n", encoding="utf-8")
            fake_extractor.write_text("# fixture\n", encoding="utf-8")
            fake_bus.chmod(0o755)
            fake_python.chmod(0o755)
            env = {
                **os.environ,
                "CTX_AGENT_DIR": str(root),
                "CORTEXTOS_BIN": str(fake_bus),
                "PYTHON_BIN": str(fake_python),
                "EXTRACTOR_PATH": str(fake_extractor),
                "ENV_FILE": str(root / "missing.env"),
                "BUS_LOG": str(log),
            }
            completed = subprocess.run(["bash", str(self.WRAPPER)], env=env, text=True, capture_output=True, check=False)
            return completed, log.read_text(encoding="utf-8")

    def test_nonzero_extractor_blocks_task_and_wrapper_fails(self) -> None:
        completed, log = self.run_wrapper(7)
        self.assertEqual(completed.returncode, 7)
        self.assertIn("bus update-task task_test blocked", log)
        self.assertNotIn("bus complete-task", log)

    def test_success_completes_task(self) -> None:
        completed, log = self.run_wrapper(0)
        self.assertEqual(completed.returncode, 0)
        self.assertIn("bus complete-task task_test", log)
        self.assertNotIn("bus update-task task_test blocked", log)


if __name__ == "__main__":
    unittest.main()
