"""FR-011 journaled S/L/R rename on temp dirs. Never promote the live store."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

_IMPORT_DIR = Path(tempfile.mkdtemp(prefix="mmrag-promote-import-"))
os.environ["MMRAG_DIR"] = str(_IMPORT_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

import mmrag_recovery

LIVE_KB = Path.home() / ".cortextos/cortextos1/orgs/clearworksai/knowledge-base"


def _seed(tmp_path):
    kb = tmp_path / "knowledge-base"
    live = kb / "chromadb"
    side = kb / "recovery-side" / "chromadb"
    live.mkdir(parents=True)
    side.mkdir(parents=True)
    (live / "chroma.sqlite3").write_bytes(b"old-live")
    (side / "chroma.sqlite3").write_bytes(b"new-side")
    (kb / "NATIVE_HOLD").write_text('{"mode":"exclusive"}\n', encoding="utf-8")
    (kb / "config.json").write_text('{"default_collection":"shared"}\n', encoding="utf-8")
    return kb


def test_promote_refuses_without_independent_review(tmp_path):
    kb = _seed(tmp_path)
    with pytest.raises(mmrag_recovery.PromoteRefused):
        mmrag_recovery.promote_side_store(
            kb,
            conservation_pass=True,
            gold_pass=True,
            independent_review_pass=False,
            human_l0=True,
            hold_active=True,
        )
    assert (kb / "chromadb" / "chroma.sqlite3").read_bytes() == b"old-live"


def test_promote_renames_and_journals_collection_then_rollback(tmp_path):
    kb = _seed(tmp_path)
    receipt = mmrag_recovery.promote_side_store(
        kb,
        conservation_pass=True,
        gold_pass=True,
        independent_review_pass=True,
        human_l0=True,
        hold_active=True,
    )
    assert receipt["result"] == "PROMOTE_OK"
    assert (kb / "chromadb" / "chroma.sqlite3").read_bytes() == b"new-side"
    assert (kb / "chromadb.rollback" / "chroma.sqlite3").read_bytes() == b"old-live"
    assert json.loads((kb / "config.json").read_text(encoding="utf-8"))["default_collection"] == (
        "shared-clearworksai"
    )
    assert (kb / "NATIVE_HOLD").is_file()
    rolled = mmrag_recovery.rollback_promoted_store(kb)
    assert rolled["result"] == "ROLLBACK_OK"
    assert (kb / "chromadb" / "chroma.sqlite3").read_bytes() == b"old-live"
    assert json.loads((kb / "config.json").read_text(encoding="utf-8"))["default_collection"] == "shared"


def test_promote_refuses_live_kb_without_epoch():
    with pytest.raises(mmrag_recovery.LiveEpochBlocked):
        mmrag_recovery.promote_side_store(
            LIVE_KB,
            conservation_pass=True,
            gold_pass=True,
            independent_review_pass=True,
            human_l0=True,
            hold_active=True,
        )
