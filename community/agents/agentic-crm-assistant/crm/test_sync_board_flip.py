#!/usr/bin/env python3
"""Behavioral tests for the WS9 direction-flipped sync-board.py.

Run from community/agents/agentic-crm-assistant/crm:

    python3 test_sync_board_flip.py

Exits 0 on all-pass, 1 on any failure. Zero external dependencies; a fake
urlopen records every request. The acceptance-critical assertion: after
EVERY code path, pipeline.json bytes are IDENTICAL to before — this module
must contain no code path that writes pipeline.json.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SYNC_BOARD_PATH = HERE / "sync-board.py"


def _load():
    spec = importlib.util.spec_from_file_location("sync_board_flip", SYNC_BOARD_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sync_board_mod = _load()

FAILURES = []


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


class FakeResponse:
    def __init__(self, payload, status=200):
        self._body = json.dumps(payload).encode("utf-8")
        self.status = status

    def read(self):
        return self._body

    def close(self):
        pass


class FakeUrlopen:
    """Records GETs (str url) and PUTs (urllib Request) without any network."""

    def __init__(self, board_payload):
        self.board_payload = board_payload
        self.gets = []
        self.puts = []
        self.fail_get = False

    def __call__(self, target, timeout=None):
        if isinstance(target, urllib.request.Request):
            self.puts.append(
                {
                    "url": target.full_url,
                    "method": target.get_method(),
                    "body": json.loads(target.data.decode("utf-8")),
                    "content_type": target.get_header("Content-type"),
                }
            )
            return FakeResponse({"ok": True})
        self.gets.append(target)
        if self.fail_get:
            raise OSError("simulated network failure")
        return FakeResponse(self.board_payload)


PIPELINE_FIXTURE = {
    "version": "1.0.0",
    "source": "test",
    "updated_at": "2026-07-01T00:00:00+00:00",
    "engagements": [
        {
            "name": "Busywork Audit",
            "client_org": "SEIU 521",
            "stage": "won",
            "archived": False,
        },
        {
            "name": "Platform Assessment",
            "client_org": "Stoss Landscape",
            "stage": "lead",
        },
    ],
}

BOARD_FIXTURE = {
    "deals": [
        # Conflicting stage: board says 'proposal', pipeline says 'won'.
        {
            "id": "seiu-521-busywork-audit",
            "name": "Busywork Audit",
            "client_org": "SEIU 521",
            "stage": "proposal",
            "archived": False,
        },
        # Board-only deal: reported, never merged into pipeline.
        {
            "id": "ghost-org-phantom-deal",
            "name": "Phantom Deal",
            "client_org": "Ghost Org",
            "stage": "lead",
            "archived": False,
        },
    ]
}


def _write_pipeline_fixture(tmp: Path) -> Path:
    path = tmp / "pipeline.json"
    path.write_text(json.dumps(PIPELINE_FIXTURE, indent=2) + "\n", encoding="utf-8")
    return path


def _run(pipeline_path, fake, token="tok"):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = sync_board_mod.sync_board(
            pipeline_path=pipeline_path,
            base_url="https://board.example",
            token=token,
            urlopen=fake,
            timestamp="2026-07-03T00:00:00+00:00",
        )
    return rc, json.loads(out.getvalue())


def test_no_pipeline_write_capability():
    print("\n[test 1] sync-board.py has NO code capable of writing pipeline.json")
    source = SYNC_BOARD_PATH.read_text(encoding="utf-8")
    _check("no write_pipeline function exists", "write_pipeline" not in source)
    _check("no write_text call in module", ".write_text(" not in source)
    _check("no os.replace (atomic-write idiom) in module", "os.replace" not in source)
    _check("no NamedTemporaryFile (write idiom) in module", "NamedTemporaryFile" not in source)
    _check("no json.dump-to-file in module", "json.dump(" not in source)
    _check(
        "module namespace exposes no write_pipeline",
        not hasattr(sync_board_mod, "write_pipeline"),
    )


def test_pushes_pipeline_state_to_board():
    print("\n[test 2] pushes pipeline state to the board; pipeline.json byte-identical")
    with tempfile.TemporaryDirectory() as tmp:
        pipeline_path = _write_pipeline_fixture(Path(tmp))
        before = pipeline_path.read_bytes()
        fake = FakeUrlopen(BOARD_FIXTURE)

        rc, summary = _run(pipeline_path, fake)
        _check("exit code 0", rc == 0)
        _check("fetched board once via GET", len(fake.gets) == 1)
        _check(
            "GET hit /api/crm/deals with token",
            fake.gets[0] == "https://board.example/api/crm/deals?token=tok",
            detail=fake.gets[0],
        )
        _check("pushed exactly 2 deals", summary["pushed"] == 2, detail=str(summary))
        _check("two PUT requests sent", len(fake.puts) == 2)

        by_id = {p["body"]["id"]: p for p in fake.puts}
        _check(
            "conflicting deal pushed with PIPELINE stage (pipeline wins)",
            by_id["seiu-521-busywork-audit"]["body"]["stage"] == "won",
        )
        _check(
            "missing-on-board engagement pushed as new deal",
            by_id["stoss-landscape-platform-assessment"]["body"]["stage"] == "lead",
        )
        payload = by_id["seiu-521-busywork-audit"]["body"]
        _check(
            "payload keyed by engagement_board_id with stage/archived/name/client_org",
            set(payload) == {"id", "name", "client_org", "stage", "archived"}
            and payload["name"] == "Busywork Audit"
            and payload["client_org"] == "SEIU 521"
            and payload["archived"] is False,
            detail=str(payload),
        )
        _check("PUT method used", all(p["method"] == "PUT" for p in fake.puts))
        _check(
            "PUT body is json",
            all(p["content_type"] == "application/json" for p in fake.puts),
        )

        _check(
            "conflict REPORTED not merged",
            summary["conflicts"]
            == [
                {
                    "id": "seiu-521-busywork-audit",
                    "board_stage": "proposal",
                    "pipeline_stage": "won",
                    "resolution": "pipeline_wins",
                }
            ],
            detail=str(summary["conflicts"]),
        )
        _check(
            "board-only deal REPORTED not merged",
            summary["board_only"] == ["ghost-org-phantom-deal"],
        )
        _check(
            "ACCEPTANCE: pipeline.json bytes IDENTICAL after push run",
            pipeline_path.read_bytes() == before,
        )


def test_noop_when_board_matches():
    print("\n[test 3] no-op when board already matches pipeline")
    with tempfile.TemporaryDirectory() as tmp:
        pipeline_path = _write_pipeline_fixture(Path(tmp))
        before = pipeline_path.read_bytes()
        board = {
            "deals": [
                {
                    "id": "seiu-521-busywork-audit",
                    "name": "Busywork Audit",
                    "client_org": "SEIU 521",
                    "stage": "won",
                    "archived": False,
                },
                {
                    "id": "stoss-landscape-platform-assessment",
                    "name": "Platform Assessment",
                    "client_org": "Stoss Landscape",
                    "stage": "lead",
                    "archived": False,
                },
            ]
        }
        fake = FakeUrlopen(board)
        rc, summary = _run(pipeline_path, fake)
        _check("exit code 0", rc == 0)
        _check("nothing pushed", summary["pushed"] == 0)
        _check("no PUTs sent", len(fake.puts) == 0)
        _check("noop reported", summary["noop"] is True)
        _check(
            "ACCEPTANCE: pipeline.json bytes IDENTICAL after noop run",
            pipeline_path.read_bytes() == before,
        )


def test_missing_token_is_warn_exit_0():
    print("\n[test 4] missing token → warn + exit 0, no network, no writes")
    with tempfile.TemporaryDirectory() as tmp:
        pipeline_path = _write_pipeline_fixture(Path(tmp))
        before = pipeline_path.read_bytes()
        fake = FakeUrlopen(BOARD_FIXTURE)
        rc, summary = _run(pipeline_path, fake, token="")
        _check("exit code 0", rc == 0)
        _check("no requests at all", len(fake.gets) == 0 and len(fake.puts) == 0)
        _check("noop summary", summary == {"pushed": 0, "conflicts": [], "board_only": [], "noop": True})
        _check(
            "ACCEPTANCE: pipeline.json bytes IDENTICAL after missing-token run",
            pipeline_path.read_bytes() == before,
        )


def test_fetch_failure_is_safe():
    print("\n[test 5] board fetch failure → exit 0, no pushes, no writes")
    with tempfile.TemporaryDirectory() as tmp:
        pipeline_path = _write_pipeline_fixture(Path(tmp))
        before = pipeline_path.read_bytes()
        fake = FakeUrlopen(BOARD_FIXTURE)
        fake.fail_get = True
        rc, summary = _run(pipeline_path, fake)
        _check("exit code 0", rc == 0)
        _check("no PUTs after failed fetch", len(fake.puts) == 0)
        _check("noop summary on fetch failure", summary["noop"] is True and summary["pushed"] == 0)
        _check(
            "ACCEPTANCE: pipeline.json bytes IDENTICAL after fetch-failure run",
            pipeline_path.read_bytes() == before,
        )


if __name__ == "__main__":
    test_no_pipeline_write_capability()
    test_pushes_pipeline_state_to_board()
    test_noop_when_board_matches()
    test_missing_token_is_warn_exit_0()
    test_fetch_failure_is_safe()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} assertion(s)")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL PASS (5 scenarios)")
    sys.exit(0)
