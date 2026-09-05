"""FR-001 fetch_fireflies: envelope + sha256 + meta; exit 2 on fetch fail."""
from __future__ import annotations

import hashlib
import io
import json
import sys
from pathlib import Path
from urllib.error import HTTPError

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def _transcript(**over: object) -> dict:
    t = {
        "id": "abc12345zzzz",
        "title": "Tacticals",
        "date": "2026-09-04T17:00:00.000Z",
        "duration": 12.0,
        "organizer_email": "josh@clearworks.ai",
        "participants": ["Josh Weiss"],
        "meeting_attendees": [
            {"displayName": "Josh Weiss", "email": "josh@clearworks.ai"},
            {"displayName": "Marcos", "email": "marcos@alloi.us"},
        ],
        "sentences": [
            {
                "index": i,
                "speaker_name": "Josh Weiss",
                "text": f"hello {i}",
                "start_time": float(i),
            }
            for i in range(20)
        ],
        "summary": {
            "overview": "Talked tacticals.",
            "action_items": "",
            "keywords": "",
            "bullet_gist": "",
            "short_summary": "",
        },
    }
    t.update(over)
    return t


class _Resp:
    def __init__(self, payload: dict) -> None:
        self._raw = json.dumps({"data": {"transcript": payload}}).encode()

    def read(self) -> bytes:
        return self._raw

    def __enter__(self) -> "_Resp":
        return self

    def __exit__(self, *_a: object) -> bool:
        return False


def test_missing_key_exits_2(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fetch_fireflies import main

    monkeypatch.delenv("FIREFLIES_API_KEY", raising=False)
    secrets = tmp_path / "orgs/clearworksai/secrets.env"
    secrets.parent.mkdir(parents=True)
    secrets.write_text("OTHER=1\n", encoding="utf-8")
    rc = main(
        [
            "--meeting-id",
            "x",
            "--vault",
            str(tmp_path / "vault"),
            "--repo-root",
            str(tmp_path),
        ]
    )
    assert rc == 2


def test_graphql_errors_exit_2_write_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fetch_fireflies import main

    class Err:
        def read(self) -> bytes:
            return json.dumps({"errors": [{"message": "nope"}], "data": None}).encode()

        def __enter__(self) -> "Err":
            return self

        def __exit__(self, *_a: object) -> bool:
            return False

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    monkeypatch.setattr("urllib.request.urlopen", lambda *_a, **_k: Err())
    vault = tmp_path / "vault"
    rc = main(["--meeting-id", "x", "--vault", str(vault), "--repo-root", str(tmp_path)])
    assert rc == 2
    assert not (vault / "raw/media/transcripts/fireflies/x/source.json").exists()


def test_short_transcript_exits_2_unless_allow_short(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fetch_fireflies import main

    short = _transcript(sentences=[{"index": 0, "speaker_name": "A", "text": "hi", "start_time": 0}])
    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    monkeypatch.setattr("urllib.request.urlopen", lambda *_a, **_k: _Resp(short))
    vault = tmp_path / "vault"
    rc = main(["--meeting-id", "abc12345zzzz", "--vault", str(vault)])
    assert rc == 2
    env_dir = vault / "raw/media/transcripts/fireflies/abc12345zzzz"
    assert not (env_dir / "source.json").exists()
    rc2 = main(["--meeting-id", "abc12345zzzz", "--vault", str(vault), "--allow-short"])
    assert rc2 == 0
    assert (env_dir / "source.json").is_file()


def test_iso_from_fireflies_date_variants() -> None:
    from datetime import datetime, timezone

    from fetch_fireflies import _iso_from_fireflies_date

    ms = 1788548400000
    expected = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")
    assert _iso_from_fireflies_date(ms) == expected
    assert _iso_from_fireflies_date(str(ms)) == expected
    assert _iso_from_fireflies_date("2026-09-04T17:00:00.000Z") == "2026-09-04T17:00:00.000Z"
    assert _iso_from_fireflies_date(None) is None


def test_envelope_converts_epoch_ms_date() -> None:
    from datetime import datetime, timezone

    from fetch_fireflies import envelope_from_transcript

    ms = 1788548400000
    tr = _transcript(date=ms)
    env = envelope_from_transcript(tr)
    expected = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")
    assert env["occurred_at"] == expected


def test_spoke_matching_is_case_insensitive() -> None:
    from fetch_fireflies import envelope_from_transcript

    tr = _transcript(
        meeting_attendees=[{"displayName": "Joseph Chang", "email": "joseph@example.com"}],
        sentences=[{"index": 0, "speaker_name": "joseph chang", "text": "hi", "start_time": 0.0}],
    )
    env = envelope_from_transcript(tr)
    part = next(p for p in env["participants"] if p["email"] == "joseph@example.com")
    assert part["spoke"] is True


def test_writes_canonical_envelope_and_skips_existing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from fetch_fireflies import main

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")
    monkeypatch.setattr("urllib.request.urlopen", lambda *_a, **_k: _Resp(_transcript()))
    vault = tmp_path / "vault"
    mid = "abc12345zzzz"
    rc = main(["--meeting-id", mid, "--vault", str(vault)])
    assert rc == 0
    env_dir = vault / "raw/media/transcripts/fireflies" / mid
    raw = (env_dir / "source.json").read_bytes()
    assert raw == json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    envelope = json.loads(raw)
    assert envelope["schema"] == "brain.source/1"
    sha = hashlib.sha256(raw).hexdigest()
    assert (env_dir / "source.sha256").read_text(encoding="utf-8").strip() == sha
    meta = json.loads((env_dir / "source.json").with_name("meta.json").read_text(encoding="utf-8"))
    assert "fetched_at" in meta
    first = capsys.readouterr().out.strip()
    assert sha in first
    # second run does not overwrite
    (env_dir / "source.json").write_bytes(raw + b"")
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not refetch")),
    )
    rc2 = main(["--meeting-id", mid, "--vault", str(vault)])
    assert rc2 == 0
    assert capsys.readouterr().out.strip() == sha


def test_path_traversal_meeting_id_rejected_exit_64(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from fetch_fireflies import main

    monkeypatch.setenv("FIREFLIES_API_KEY", "k")

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("must not make network call")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    vault = tmp_path / "vault"
    rc = main(["--meeting-id", "../../target", "--vault", str(vault)])
    assert rc == 64
    assert "invalid meeting id" in capsys.readouterr().err
    assert not vault.exists() or not any(vault.rglob("source.json"))
