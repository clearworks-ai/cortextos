"""FR-002 extract_meeting: one mocked claude -p; schema reject; exit 3."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))


def _source_envelope() -> dict:
    return {
        "schema": "brain.source/1",
        "source": {"kind": "fireflies", "id": "abc12345"},
        "title": "Tacticals",
        "occurred_at": "2026-09-04T17:00:00Z",
        "duration_s": 12,
        "participants": [
            {
                "name": "Josh Weiss",
                "email": "josh@clearworks.ai",
                "handle": None,
                "side": "ours",
                "spoke": True,
                "notetaker": False,
            }
        ],
        "text_units": [{"i": 0, "speaker": "Josh Weiss", "text": "hello", "ts": 0}],
        "native_summary": {"overview": "Talked.", "action_items": None, "keywords": None, "bullet_gist": None, "short_summary": None},
    }


def _model_obj() -> dict:
    return {
        "schema": "brain.extraction/1",
        "classification": {
            "org_name": "Alloi",
            "domain": "alloi.us",
            "relationship": "client",
            "confidence": 0.9,
            "evidence": "hello",
        },
        "summary": {"overview": "Talked.", "bullets": ["hello"]},
        "decisions": [],
        "commitments": [],
        "proposed_delivery_state": None,
        "deal_state": "won",
        "meeting_type": "delivery",
    }


def _write_source(dir_path: Path) -> bytes:
    raw = json.dumps(_source_envelope(), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    (dir_path / "source.json").write_bytes(raw)
    return raw


def _claude_json(
    result_obj: dict,
    subtype: str = "success",
    total_cost_usd: float = 0.0851578,
    include_model_usage: bool = True,
) -> str:
    wrapper: dict = {
        "type": "result",
        "subtype": subtype,
        "result": json.dumps(result_obj),
        "total_cost_usd": total_cost_usd,
        "usage": {"input_tokens": 2, "output_tokens": 4},
    }
    if include_model_usage:
        wrapper["modelUsage"] = {
            "claude-sonnet-5": {"inputTokens": 2, "outputTokens": 4, "costUSD": total_cost_usd}
        }
    return json.dumps(wrapper)


def test_missing_extraction_calls_claude(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from extract_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _write_source(src)
    calls: list[object] = []

    class Proc:
        def __init__(self) -> None:
            self.returncode = 0
            self.stdout = _claude_json(_model_obj())
            self.stderr = ""

    def fake_run(cmd, **kwargs):
        calls.append((list(cmd), kwargs.get("cwd"), kwargs.get("input")))
        return Proc()

    monkeypatch.setattr("subprocess.run", fake_run)
    rc = main(["--source", str(src)])
    assert rc == 0
    assert len(calls) == 1
    assert calls[0][0][:4] == ["claude", "-p", "--setting-sources", ""]
    assert "--disallowedTools" in calls[0][0]
    out = json.loads((src / "extraction.json").read_text(encoding="utf-8"))
    assert out["schema"] == "brain.extraction/1"
    sha = hashlib.sha256((src / "source.json").read_bytes()).hexdigest()
    assert out["inputSha"] == sha
    assert out["cost_usd"] == 0.0851578
    assert out["model_receipt"] == "claude-sonnet-5"
    assert out["usage"] == {"input_tokens": 2, "output_tokens": 4}


def test_missing_model_usage_receipt_unverified(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from extract_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _write_source(src)

    class Proc:
        def __init__(self) -> None:
            self.returncode = 0
            self.stdout = _claude_json(_model_obj(), include_model_usage=False)
            self.stderr = ""

    monkeypatch.setattr("subprocess.run", lambda *_a, **_k: Proc())
    rc = main(["--source", str(src)])
    assert rc == 0
    out = json.loads((src / "extraction.json").read_text(encoding="utf-8"))
    assert out["model_receipt"] == "unverified"
    assert out["cost_usd"] == 0.0851578


def test_matching_input_sha_skips_claude(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from extract_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    raw = _write_source(src)
    sha = hashlib.sha256(raw).hexdigest()
    extraction = _model_obj()
    extraction.update(
        {
            "inputSha": sha,
            "promptSha": "old",
            "model": "sonnet",
            "cost_usd": 0,
            "extracted_at": "2026-01-01T00:00:00Z",
        }
    )
    (src / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")

    def boom(*_a, **_k):
        raise AssertionError("claude must not run")

    monkeypatch.setattr("subprocess.run", boom)
    rc = main(["--source", str(src)])
    assert rc == 0


def test_unknown_key_and_unknown_enum_exit_3(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from extract_meeting import validate_extraction

    good = _model_obj()
    good.update(
        {
            "inputSha": "a",
            "promptSha": "b",
            "model": "sonnet",
            "cost_usd": 0,
            "extracted_at": "t",
            "model_receipt": "claude-sonnet-5",
            "usage": {},
        }
    )
    validate_extraction(good)
    bad_key = dict(good)
    bad_key["nope"] = 1
    with pytest.raises(ValueError):
        validate_extraction(bad_key)
    bad_enum = json.loads(json.dumps(good))
    bad_enum["classification"]["relationship"] = "unknown"
    with pytest.raises(ValueError):
        validate_extraction(bad_enum)

    src = tmp_path / "env"
    src.mkdir()
    _write_source(src)

    class Proc:
        returncode = 1
        stdout = ""
        stderr = "fail"

    monkeypatch.setattr("subprocess.run", lambda *_a, **_k: Proc())
    from extract_meeting import main

    rc = main(["--source", str(src)])
    assert rc == 3
    assert not (src / "extraction.json").exists()


def test_claude_not_logged_in_prints_reason(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from extract_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    _write_source(src)

    class Proc:
        returncode = 1
        stdout = json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "is_error": True,
                "result": "Not logged in · Please run /login",
            }
        )
        stderr = ""

    monkeypatch.setattr("subprocess.run", lambda *_a, **_k: Proc())
    rc = main(["--source", str(src)])
    assert rc == 3
    assert "Not logged in" in capsys.readouterr().err
    assert not (src / "extraction.json").exists()


def test_reextract_refused_when_receipt_exists(tmp_path: Path) -> None:
    from extract_meeting import main

    src = tmp_path / "env"
    src.mkdir()
    raw = _write_source(src)
    sha = hashlib.sha256(raw).hexdigest()
    extraction = _model_obj()
    extraction.update(
        {
            "inputSha": "stale",
            "promptSha": "x",
            "model": "sonnet",
            "cost_usd": 0,
            "extracted_at": "t",
        }
    )
    (src / "extraction.json").write_text(json.dumps(extraction), encoding="utf-8")
    receipt_root = tmp_path / "vault/raw/media/transcripts/_state/fireflies-abc12345"
    receipt_root.mkdir(parents=True)
    (receipt_root / "receipt.json").write_text("{}", encoding="utf-8")
    rc = main(["--source", str(src), "--re-extract", "--vault", str(tmp_path / "vault")])
    assert rc == 3
    # stale without --re-extract also 3
    rc2 = main(["--source", str(src)])
    assert rc2 == 3
    _ = sha
