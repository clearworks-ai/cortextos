# scripts/brain/tests/test_backfill.py
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

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


def test_build_manifest_counts_dateless_rows(tmp_path):
    import backfill

    rows = _rows() + [
        {"id": "D", "title": "no date", "date": None, "duration": 1.0, "participants": []},
        {"id": "E", "title": "bad date", "date": "not-a-number", "duration": 1.0, "participants": []},
    ]
    out = backfill.build_manifest(rows, vault=tmp_path / "v", kind="fireflies", since=None, until=None)
    assert [r["id"] for r in out] == ["A", "B", "C"]
    assert backfill.build_manifest.skipped_no_date == 2


def test_build_manifest_dedupes_paged_duplicate_ids(tmp_path):
    import backfill

    rows = _rows() + [{"id": "A", "title": "First (dup page)", "date": 1756684800000, "duration": 12.5, "participants": ["a@x.io"]}]
    out = backfill.build_manifest(rows, vault=tmp_path / "v", kind="fireflies", since=None, until=None)
    assert [r["id"] for r in out] == ["A", "B", "C"]
    assert backfill.build_manifest.duplicates == 1


def test_cmd_list_rejects_malformed_since_and_writes_no_manifest(tmp_path, monkeypatch):
    import backfill

    vault = tmp_path / "vault"
    monkeypatch.setattr(backfill, "list_transcripts", lambda api_key, **kw: _rows())
    monkeypatch.setattr(backfill, "load_api_key", lambda repo: "k")
    with pytest.raises(SystemExit) as excinfo:
        backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path),
                       "list", "--since", "2025-9-2"])
    assert excinfo.value.code == 2
    assert not (vault / "raw/media/transcripts/_backfill").exists()


def test_cmd_list_refuses_unknown_source_and_missing_key(tmp_path, monkeypatch, capsys):
    import backfill

    assert backfill.main(["--source", "omi", "--vault", str(tmp_path), "list"]) == 64
    assert backfill.main(["--source", "fireflies", "--vault", str(tmp_path), "--batch", "../etc", "dry-run"]) == 64
    assert backfill.main(["--source", "fireflies", "--vault", str(tmp_path), "--batch", "fireflies-20260906T000000Z/x", "apply"]) == 64
    monkeypatch.setattr(backfill, "load_api_key", lambda repo: "")
    assert backfill.main(["--source", "fireflies", "--vault", str(tmp_path), "--repo-root", str(tmp_path), "list"]) == 2
    assert "FIREFLIES_API_KEY" in capsys.readouterr().err


# --- dry-run --------------------------------------------------------------------
def _seed_batch(tmp_path: Path, ids=("A", "B", "C"), applied=()):
    import backfill
    vault = tmp_path / "vault"
    rows = [{"kind": "fireflies", "id": i, "title": f"T{i}", "occurred_at": f"2025-09-0{n+1}T00:00:00+00:00",
             "duration_s": 600, "participant_count": 1, "already_applied": i in applied} for n, i in enumerate(ids)]
    bd = backfill.batch_dir(vault, "fireflies-20260906T000000Z")
    bd.mkdir(parents=True)
    (bd / "manifest.json").write_text(json.dumps({"batch_id": "fireflies-20260906T000000Z", "kind": "fireflies", "rows": rows}), encoding="utf-8")
    return vault, bd


def _fake_run_meeting(vault: Path, *, cost=0.5, rc_for=None, fetch_error_for=None, extracted_before=False, fail_after_extract=None):
    """Fake run_meeting.main: writes the envelope files a real --dry-run leaves
    behind and prints a capture with the FR-012 + phase-3 nouns."""
    rc_for = rc_for or {}
    fetch_error_for = fetch_error_for or {}
    fail_after_extract = fail_after_extract or {}
    attempts: dict[str, int] = {}

    def fake(argv):
        mid = argv[argv.index("--meeting-id") + 1]
        assert "--dry-run" in argv and "--vault" in argv
        print(f"note: dry-run for {mid}", file=sys.stderr)  # review I5(b): stderr capture contract
        attempts[mid] = attempts.get(mid, 0) + 1
        if mid in fetch_error_for:
            import fetch_fireflies
            fetch_fireflies.write_fetch_error(vault, "fireflies", mid, fetch_error_for[mid], status=401, message="nope")
            return 2
        if mid in rc_for:
            return rc_for[mid]
        env = vault / "raw/media/transcripts/fireflies" / mid
        env.mkdir(parents=True, exist_ok=True)
        (env / "resolution.json").write_text(json.dumps({"home_path": f"clients/{mid.lower()}.md", "rule": 2, "node": "none",
                                                          "counterparty_slug": mid.lower(), "created": None}), encoding="utf-8")
        (env / "validated.json").write_text(json.dumps({"decisions": [1, 2], "commitments": [1], "open_questions": [],
                                                         "dropped": {"decisions": 0, "commitments": 1, "open_questions": 0}}), encoding="utf-8")
        ex = env / "extraction.json"
        if not ex.exists():  # extract_meeting.py short-circuits on a matching inputSha: no re-extract, no new cost
            at = "2020-01-01T00:00:00Z" if extracted_before else f"2099-01-01T00:00:0{attempts[mid]}Z"
            ex.write_text(json.dumps({"inputSha": "x", "cost_usd": cost, "extracted_at": at}), encoding="utf-8")
        if mid in fail_after_extract and attempts[mid] <= fail_after_extract[mid]:
            return 6
        print(f"home=clients/{mid.lower()}.md node=none rule=2\n--- a/x\nquotes kept decisions=2 commitments=1 open_questions=0\n"
              f"tasks:\nsubject: Recap\nphase3-preview: v1\nwould-touch: STATE.md\n"
              + ("would-write: raw/areas/x.md\nwould-write-body:\n**Classification:** GOOD\nwould-write-end\n" if mid != "C" else "would-write: skip: no-engagement\n")
              + f"would-file: {mid}")
        return 0
    return fake


def _bp(bd: Path):
    return json.loads((bd / "batch-progress.json").read_text(encoding="utf-8"))


def test_dry_run_records_rows_and_writes_captures(tmp_path, monkeypatch, capsys):
    import backfill
    vault, bd = _seed_batch(tmp_path, applied=("A",))
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, cost=0.4))
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"])
    assert rc == 0, capsys.readouterr()
    doc = _bp(bd)
    assert set(doc["rows"]) == {"fireflies:B", "fireflies:C"}   # A already applied: never run
    row = doc["rows"]["fireflies:B"]["dry_run"]
    assert row["exit"] == 0 and row["home"] == "clients/b.md" and row["rule"] == 2 and row["created"] is None
    assert row["kept"] == {"decisions": 2, "commitments": 1, "open_questions": 0}
    assert row["dropped"] == {"decisions": 0, "commitments": 1, "open_questions": 0}
    assert row["classification"] == "GOOD" and row["cost_usd"] == 0.4 and len(row["capture_sha256"]) == 64
    assert doc["rows"]["fireflies:C"]["dry_run"]["classification"] is None  # no status body → null, never invented
    assert row["elapsed_s"] >= 0 and row["at"]
    cap = vault / "raw/media/transcripts/_state/fireflies-B/dry-run.txt"
    assert cap.exists() and cap.read_text(encoding="utf-8").startswith("home=clients/b.md")
    assert "dry-run: 2 ok, 0 failed" in capsys.readouterr().out


def test_dry_run_is_resumable_and_continues_past_failures(tmp_path, monkeypatch):
    import backfill
    vault, bd = _seed_batch(tmp_path)
    calls = []
    inner = _fake_run_meeting(vault, rc_for={"B": 3})

    def counting(argv):
        calls.append(argv[argv.index("--meeting-id") + 1]); return inner(argv)
    monkeypatch.setattr(backfill, "run_meeting_main", counting)
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]
    assert backfill.main(base) == 0
    assert calls == ["A", "B", "C"]
    assert _bp(bd)["rows"]["fireflies:B"]["dry_run"]["exit"] == 3
    calls.clear()
    assert backfill.main(base) == 0
    assert calls == ["B"]  # only the failed row re-runs; exit-0 rows are skipped


def test_dry_run_stops_only_on_auth_fetch_error(tmp_path, monkeypatch, capsys):
    import backfill
    vault, bd = _seed_batch(tmp_path)
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, fetch_error_for={"A": "rate_limit", "B": "auth"}))
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"])
    assert rc == 2
    rows = _bp(bd)["rows"]
    assert rows["fireflies:A"]["dry_run"]["fetch_error"]["class"] == "rate_limit"   # recorded, batch continued
    assert rows["fireflies:B"]["dry_run"]["fetch_error"]["class"] == "auth"
    assert "fireflies:C" not in rows                                                 # stopped before C
    assert "stopped: auth" in capsys.readouterr().err


def test_dry_run_exit2_without_fetch_error_is_usage_and_continues(tmp_path, monkeypatch):
    import backfill
    vault, bd = _seed_batch(tmp_path)
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, rc_for={"A": 2}))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]) == 0
    rows = _bp(bd)["rows"]
    assert rows["fireflies:A"]["dry_run"]["fetch_error"] == {"class": "usage", "synthesized": True, "message": "exit 2 without fetch-error.json"}
    assert "fireflies:C" in rows  # continued past it


def test_dry_run_budget_exit_12(tmp_path, monkeypatch, capsys):
    import backfill
    vault, bd = _seed_batch(tmp_path)
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, cost=0.6))
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run", "--max-usd", "1.0"])
    assert rc == 12
    rows = _bp(bd)["rows"]
    assert len(rows) == 2 and "budget" in capsys.readouterr().err   # A (0.6) ok, B (1.2 > 1.0) recorded then stop


def test_dry_run_counts_reused_extraction_as_zero_cost(tmp_path, monkeypatch):
    import backfill
    vault, bd = _seed_batch(tmp_path, ids=("A",))
    env = vault / "raw/media/transcripts/fireflies/A"; env.mkdir(parents=True)
    (env / "extraction.json").write_text(json.dumps({"inputSha": "x", "cost_usd": 0.9, "extracted_at": "2020-01-01T00:00:00Z"}), encoding="utf-8")
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, cost=0.9))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run", "--max-usd", "0.1"]) == 0
    row = _bp(bd)["rows"]["fireflies:A"]["dry_run"]
    assert row["cost_usd"] == 0.0 and row["cost_reused"] is True


def test_dry_run_retry_after_late_failure_does_not_charge_twice(tmp_path, monkeypatch):
    import backfill
    vault, bd = _seed_batch(tmp_path, ids=("A",))
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, cost=0.7, fail_after_extract={"A": 1}))
    # --max-usd 0.8: attempt 1 charges 0.7; a resume that re-added 0.7 would read 1.4 and falsely HALT 12 (G0a-6)
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run", "--max-usd", "0.8"]
    assert backfill.main(base) == 0
    first = _bp(bd)["rows"]["fireflies:A"]["dry_run"]
    assert first["exit"] == 6 and first["cost_usd"] == 0.7          # attempt 1 extracted, then failed later: charged once
    assert backfill.main(base) == 0                                  # not 12
    second = _bp(bd)["rows"]["fireflies:A"]["dry_run"]
    # review C1: "retry adds, never replaces" — the ledger keeps the $0.7 already spent on attempt 1;
    # this attempt reused the extraction (adds $0.0), so cumulative cost_usd stays 0.7, not resets to 0.0.
    assert second["exit"] == 0 and second["cost_usd"] == 0.7 and second["cost_reused"] is True


# --- fix round 1 (task-7-review.md: Critical #1/#2, Important #3/#4, #5) --------
def test_dry_run_capture_sha256_matches_written_capture(tmp_path, monkeypatch):
    """review I5(a): sha256 computed independently over the bytes actually written
    to dry-run.txt must equal capture_sha256 — not just len == 64."""
    import backfill
    import hashlib
    vault, bd = _seed_batch(tmp_path, applied=("A",))
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, cost=0.4))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]) == 0
    row = _bp(bd)["rows"]["fireflies:B"]["dry_run"]
    cap_bytes = (vault / "raw/media/transcripts/_state/fireflies-B/dry-run.txt").read_bytes()
    assert row["capture_sha256"] == hashlib.sha256(cap_bytes).hexdigest()


def test_dry_run_writes_stderr_capture(tmp_path, monkeypatch):
    """review I5(b): dry-run.stderr.txt must hold what the runner wrote to stderr."""
    import backfill
    vault, bd = _seed_batch(tmp_path, ids=("A",))
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, cost=0.1))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]) == 0
    stderr_path = vault / "raw/media/transcripts/_state/fireflies-A/dry-run.stderr.txt"
    assert stderr_path.exists() and "note: dry-run for A" in stderr_path.read_text(encoding="utf-8")


def test_dry_run_crash_is_recorded_and_batch_continues(tmp_path, monkeypatch):
    """review I3 + I5(c): a non-SystemExit crash from the runner is not an auth stop —
    the crashing row is recorded (exit 1, traceback in its stderr capture) and the batch
    continues past it, checkpointing the later rows too (mid-batch crash checkpoint)."""
    import backfill
    vault, bd = _seed_batch(tmp_path)
    inner = _fake_run_meeting(vault, cost=0.3)

    def crashing(argv):
        mid = argv[argv.index("--meeting-id") + 1]
        if mid == "B":
            raise RuntimeError("boom")
        return inner(argv)
    monkeypatch.setattr(backfill, "run_meeting_main", crashing)
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"])
    assert rc == 0  # a crash is not an auth stop; the batch runs to completion
    rows = _bp(bd)["rows"]
    assert rows["fireflies:B"]["dry_run"]["exit"] == 1
    b_stderr = (vault / "raw/media/transcripts/_state/fireflies-B/dry-run.stderr.txt").read_text(encoding="utf-8")
    assert "boom" in b_stderr and "RuntimeError" in b_stderr
    assert rows["fireflies:A"]["dry_run"]["exit"] == 0 and rows["fireflies:C"]["dry_run"]["exit"] == 0  # continued past B


def test_dry_run_missing_manifest_returns_64(tmp_path, capsys):
    """review I4: a missing/invalid manifest.json is a refusal (64), never a raised SystemExit."""
    import backfill
    vault = tmp_path / "vault"
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path),
                         "--batch", "fireflies-20260906T000000Z", "dry-run"])
    assert rc == 64
    assert "manifest.json" in capsys.readouterr().err


def test_dry_run_resumed_after_budget_halt_makes_no_calls(tmp_path, monkeypatch, capsys):
    """review C2: once the ledger already exceeds --max-usd, a resumed invocation must
    HALT before launching anything — zero run_meeting_main calls, never a raised cap."""
    import backfill
    vault, bd = _seed_batch(tmp_path)
    calls = []
    inner = _fake_run_meeting(vault, cost=0.6)

    def counting(argv):
        calls.append(argv[argv.index("--meeting-id") + 1])
        return inner(argv)
    monkeypatch.setattr(backfill, "run_meeting_main", counting)
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run", "--max-usd", "1.0"]
    assert backfill.main(base) == 12          # A (0.6) ok, B (1.2 > 1.0) recorded then stop
    assert calls == ["A", "B"]
    calls.clear()
    rc = backfill.main(base)                   # resume: recorded spend is already 1.2 > 1.0
    assert rc == 12
    assert calls == []                          # pre-launch guard fires before any run_meeting_main call
    assert "budget" in capsys.readouterr().err


def test_dry_run_max_usd_zero_still_runs_the_first_unattempted_meeting(tmp_path, monkeypatch):
    """review C2 (--max-usd 0 case): a fresh batch has recorded spend of $0, which is not
    > --max-usd 0, so the pre-launch guard cannot block the very first, never-yet-run
    meeting (its cost is unknowable before it runs). It halts with 12 immediately after
    that one attempt is recorded — exactly one run_meeting_main call, not zero. (Zero
    calls only happens on a *resumed* invocation once spend is already recorded above the
    cap — see test_dry_run_resumed_after_budget_halt_makes_no_calls. An EMPTY manifest,
    by contrast, never enters the loop body at all and exits 0 — see
    test_dry_run_missing_manifest_returns_64 sibling behavior is 64 for a missing
    manifest, not 0/12; an empty-but-valid manifest is out of this fix's required scope.)"""
    import backfill
    vault, bd = _seed_batch(tmp_path)
    calls = []
    inner = _fake_run_meeting(vault, cost=0.1)

    def counting(argv):
        calls.append(argv[argv.index("--meeting-id") + 1])
        return inner(argv)
    monkeypatch.setattr(backfill, "run_meeting_main", counting)
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path),
                         "--batch", bd.name, "dry-run", "--max-usd", "0"])
    assert rc == 12
    assert calls == ["A"]
    rows = _bp(bd)["rows"]
    assert len(rows) == 1 and rows["fireflies:A"]["dry_run"]["cost_usd"] == 0.1
