"""atomic_write: temp + replace; dest mode 0o644."""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def test_atomic_write_replaces_and_sets_mode(tmp_path: Path) -> None:
    from atomic import atomic_write

    dest = tmp_path / "out.bin"
    dest.write_bytes(b"old")
    atomic_write(dest, b"new-bytes")
    assert dest.read_bytes() == b"new-bytes"
    mode = stat.S_IMODE(os.stat(dest).st_mode)
    assert mode == 0o644
    leftovers = list(tmp_path.glob(".tmp-*"))
    assert leftovers == []


def test_atomic_write_creates_parents(tmp_path: Path) -> None:
    from atomic import atomic_write

    dest = tmp_path / "nested" / "dir" / "file.txt"
    atomic_write(dest, b"ok")
    assert dest.read_bytes() == b"ok"
