# scripts/brain/tests/test_backfill.py
from __future__ import annotations

import json
import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def _rows():
    return [
        {"id": "B", "title": "Second", "date": 1756771200000, "duration": 30.0, "participants": ["a@x.io", "b@y.io"]},
        {"id": "A", "title": "First", "date": 1756684800000, "duration": 12.5, "participants": ["a@x.io"]},
        {"id": "C", "title": "Third", "date": 1757116800000, "duration": None, "participants": []},
    ]


def _receipt(vault: Path, mid: str, vault_sha: str | None) -> None:
    import progress
    p = progress.receipt_path(vault, "fireflies", mid)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"meeting_id": mid, "vault_sha": vault_sha}), encoding="utf-8")


def test_build_manifest_sorts_converts_and_marks_applied(tmp_path):
    import backfill

    vault = tmp_path / "vault"
    _receipt(vault, "A", "deadbeef")      # applied
    _receipt(vault, "B", None)            # receipt without vault_sha = NOT applied
    rows = backfill.build_manifest(_rows(), vault=vault, kind="fireflies", since=None, until=None)
    assert [r["id"] for r in rows] == ["A", "B", "C"]
    assert rows[0] == {"kind": "fireflies", "id": "A", "title": "First", "occurred_at": "2025-09-01T00:00:00+00:00",
                       "duration_s": 750, "participant_count": 1, "already_applied": True}
    assert rows[1]["already_applied"] is False and rows[1]["duration_s"] == 1800
    assert rows[2]["duration_s"] is None and rows[2]["participant_count"] == 0


def test_build_manifest_drops_unsafe_ids(tmp_path):
    import backfill
    rows = _rows() + [{"id": "../etc/passwd", "title": "evil", "date": 1756684800000, "duration": 1.0, "participants": []},
                      {"id": "fireflies:PREFIXED", "title": "p", "date": 1756684800000, "duration": 1.0, "participants": []}]
    out = backfill.build_manifest(rows, vault=tmp_path / "v", kind="fireflies", since=None, until=None)
    assert [r["id"] for r in out] == ["A", "B", "C"] and backfill.build_manifest.invalid == 2


def test_build_manifest_since_until_window(tmp_path):
    import backfill

    rows = backfill.build_manifest(_rows(), vault=tmp_path / "v", kind="fireflies", since="2025-09-02", until="2025-09-02")
    assert [r["id"] for r in rows] == ["B"]
    rows = backfill.build_manifest(_rows(), vault=tmp_path / "v", kind="fireflies", since="2025-09-02", until=None)
    assert [r["id"] for r in rows] == ["B", "C"]


def test_cmd_list_writes_manifest_and_prints_counts(tmp_path, monkeypatch, capsys):
    import backfill

    vault = tmp_path / "vault"
    _receipt(vault, "A", "deadbeef")
    monkeypatch.setattr(backfill, "list_transcripts", lambda api_key, **kw: _rows())
    monkeypatch.setattr(backfill, "load_api_key", lambda repo: "k")
    monkeypatch.setattr(backfill, "_batch_id", lambda kind: f"{kind}-20260906T000000Z")
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "list"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "manifest: 3 total, 1 already applied, 2 pending" in out
    doc = json.loads((vault / "raw/media/transcripts/_backfill/fireflies-20260906T000000Z/manifest.json").read_text(encoding="utf-8"))
    assert doc["batch_id"] == "fireflies-20260906T000000Z" and [r["id"] for r in doc["rows"]] == ["A", "B", "C"]


def test_cmd_list_refuses_unknown_source_and_missing_key(tmp_path, monkeypatch, capsys):
    import backfill

    assert backfill.main(["--source", "omi", "--vault", str(tmp_path), "list"]) == 64
    assert backfill.main(["--source", "fireflies", "--vault", str(tmp_path), "--batch", "../etc", "dry-run"]) == 64
    assert backfill.main(["--source", "fireflies", "--vault", str(tmp_path), "--batch", "fireflies-20260906T000000Z/x", "apply"]) == 64
    monkeypatch.setattr(backfill, "load_api_key", lambda repo: "")
    assert backfill.main(["--source", "fireflies", "--vault", str(tmp_path), "--repo-root", str(tmp_path), "list"]) == 2
    assert "FIREFLIES_API_KEY" in capsys.readouterr().err
