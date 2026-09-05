"""FR-001 envparse: never `source` secrets.env; fixture file, not live secrets."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


FIXTURE = """# fixture — not live secrets
FIREFLIES_API_KEY=ff_test_not_a_real_key
API_KEY_21ST=op://Vault/item/credential
QUOTED="hello world"
INLINE=plain # comment
"""


def _write_fixture(tmp_path: Path) -> Path:
    p = tmp_path / "secrets.env"
    p.write_bytes(b"\xef\xbb\xbf" + FIXTURE.replace("\n", "\r\n").encode("utf-8"))
    return p


def test_bash_source_breaks_on_unquoted_op_ref(tmp_path: Path) -> None:
    p = _write_fixture(tmp_path)
    r = subprocess.run(
        ["bash", "-c", f"set -euo pipefail; source {p}"],
        capture_output=True,
        text=True,
    )
    assert r.returncode != 0, "unquoted op:// must break bash source (why we parse, not source)"


def test_parse_returns_fireflies_and_op_ref_without_source(tmp_path: Path) -> None:
    from envparse import parse_env_file

    p = _write_fixture(tmp_path)
    got = parse_env_file(p)
    assert got.get("FIREFLIES_API_KEY") == "ff_test_not_a_real_key"
    assert got.get("API_KEY_21ST") == "op://Vault/item/credential"
    assert got.get("QUOTED") == "hello world"
    assert got.get("INLINE") == "plain"


def test_parse_missing_fireflies_is_detectable(tmp_path: Path) -> None:
    from envparse import parse_env_file

    p = tmp_path / "secrets.env"
    p.write_text("OTHER=1\n", encoding="utf-8")
    got = parse_env_file(p)
    assert "FIREFLIES_API_KEY" not in got
