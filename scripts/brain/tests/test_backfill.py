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
    # F15: occurred_at must be zero-padded so rows stay canonically sorted by
    # (occurred_at, id) for batches larger than 9 rows (e.g. the 14-row digest
    # test) -- "2025-09-9" would otherwise lexically outrank "2025-09-10".
    rows = [{"kind": "fireflies", "id": i, "title": f"T{i}", "occurred_at": f"2025-09-{n+1:02d}T00:00:00+00:00",
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


# --- digest + sample --------------------------------------------------------------
def test_dry_run_writes_digest_sha_and_deterministic_sample(tmp_path, monkeypatch, capsys):
    import backfill, hashlib, os, random
    ids = tuple(f"M{n:02d}" for n in range(14))
    vault, bd = _seed_batch(tmp_path, ids=ids)
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, rc_for={"M03": 6}))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]) == 0
    digest = (bd / "digest.md").read_bytes()
    assert (bd / "digest.sha256").read_text(encoding="utf-8").strip() == hashlib.sha256(digest).hexdigest()
    text = digest.decode("utf-8")
    assert "| M03 |" in text and "| 6 |" in text and "| M00 |" in text and "clients/m00.md (rule 2)" in text
    sample = sorted(p.stem for p in (bd / "sample").glob("*.txt"))
    assert (bd / "sample").is_symlink() and os.readlink(bd / "sample") == f"sample-{hashlib.sha256(digest).hexdigest()[:12]}"
    assert len(sample) == 10 and "M03" not in sample            # exit-0 meetings only
    expected = sorted(random.Random(bd.name).sample([i for i in ids if i != "M03"], 10))
    assert sample == expected                                    # seeded by batch_id → reproducible
    out = capsys.readouterr().out
    assert f"digest: {bd / 'digest.md'} sha256 {hashlib.sha256(digest).hexdigest()} sample 10" in out


def test_digest_sample_takes_all_when_fewer_than_ten(tmp_path, monkeypatch):
    import backfill
    vault, bd = _seed_batch(tmp_path, ids=("A", "B"))
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]) == 0
    assert sorted(p.stem for p in (bd / "sample").glob("*.txt")) == ["A", "B"]


# --- task-8 review fix round 1 (Important #1/#2/#3) ------------------------------
def test_dry_run_budget_halt_no_phantom_row_and_resume_digest_is_idempotent(tmp_path, monkeypatch):
    """Important #1: the pre-launch budget guard must not persist a {} placeholder
    entry for the NEXT (never-attempted) meeting into batch-progress.json, and a
    resume that makes zero new calls must reproduce a byte-identical digest."""
    import backfill
    vault, bd = _seed_batch(tmp_path)
    calls = []
    inner = _fake_run_meeting(vault, cost=0.6)

    def counting(argv):
        calls.append(argv[argv.index("--meeting-id") + 1])
        return inner(argv)
    monkeypatch.setattr(backfill, "run_meeting_main", counting)
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run", "--max-usd", "1.0"]
    assert backfill.main(base) == 12
    rows = _bp(bd)["rows"]
    assert set(rows) == {"fireflies:A", "fireflies:B"}            # no phantom fireflies:C entry
    assert all(isinstance(v.get("dry_run"), dict) for v in rows.values())
    sha1 = (bd / "digest.sha256").read_text(encoding="utf-8").strip()
    calls.clear()
    assert backfill.main(base) == 12                              # resume: halts before C
    assert calls == []                                             # zero new run_meeting_main calls
    rows2 = _bp(bd)["rows"]
    assert set(rows2) == {"fireflies:A", "fireflies:B"}            # still no phantom entry after resume
    sha2 = (bd / "digest.sha256").read_text(encoding="utf-8").strip()
    assert sha1 == sha2


def test_digest_header_discloses_partial_batch_on_budget_halt(tmp_path, monkeypatch):
    """Important #2: a halted batch's digest header must disclose it is partial and
    how many manifest rows were never attempted."""
    import backfill
    vault, bd = _seed_batch(tmp_path)
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault, cost=0.6))
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run", "--max-usd", "1.0"])
    assert rc == 12
    text = (bd / "digest.md").read_text(encoding="utf-8")
    assert "status: partial (budget)" in text
    assert "unattempted: 1" in text           # 3 manifest rows, 2 attempted (A, B)


def test_digest_header_status_complete_on_full_run(tmp_path, monkeypatch):
    """Important #2: a fully-completed batch's digest header must read complete /
    unattempted: 0, never mistakable for a partial one."""
    import backfill
    vault, bd = _seed_batch(tmp_path, ids=("A", "B"))
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]) == 0
    text = (bd / "digest.md").read_text(encoding="utf-8")
    assert "status: complete" in text and "unattempted: 0" in text


def test_digest_header_applied_count_excluded_from_unattempted(tmp_path, monkeypatch):
    """task-8-review carry (CARRY-A): an already-applied manifest row must be
    counted in a dedicated `applied:` header field, and `unattempted` must
    subtract it — so a batch with one already-applied row plus a fully
    attempted remainder still reads `status: complete · unattempted: 0`,
    never a false `unattempted: 1` for the applied row it never needed to
    re-run."""
    import backfill
    vault, bd = _seed_batch(tmp_path, applied=("A",))
    monkeypatch.setattr(backfill, "run_meeting_main", _fake_run_meeting(vault))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]) == 0
    text = (bd / "digest.md").read_text(encoding="utf-8")
    assert "applied: 1" in text and "unattempted: 0" in text and "status: complete" in text


def test_dry_run_sample_excludes_exit0_row_missing_dry_run_txt(tmp_path, monkeypatch, capsys):
    """Important #3: sample_ids / stdout `sample <n>` must never overstate the on-disk
    sample — an exit-0 row with no captured dry-run.txt is excluded from the seeded
    pick before sampling, with a stderr diagnostic, so picked always matches the files."""
    import backfill, json
    vault, bd = _seed_batch(tmp_path, ids=("A", "B"))
    inner = _fake_run_meeting(vault)

    def fake(argv):
        mid = argv[argv.index("--meeting-id") + 1]
        if mid == "A":  # succeeds (rc 0) but prints nothing -> no dry-run.txt is ever written
            env = vault / "raw/media/transcripts/fireflies" / mid
            env.mkdir(parents=True, exist_ok=True)
            (env / "resolution.json").write_text(json.dumps({"home_path": None, "rule": None, "node": "none", "counterparty_slug": None, "created": None}), encoding="utf-8")
            (env / "validated.json").write_text(json.dumps({"decisions": [], "commitments": [], "open_questions": [], "dropped": {"decisions": 0, "commitments": 0, "open_questions": 0}}), encoding="utf-8")
            (env / "extraction.json").write_text(json.dumps({"inputSha": "x", "cost_usd": 0.1, "extracted_at": "2099-01-01T00:00:01Z"}), encoding="utf-8")
            return 0
        return inner(argv)
    monkeypatch.setattr(backfill, "run_meeting_main", fake)
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"])
    assert rc == 0
    cap_a = vault / "raw/media/transcripts/_state/fireflies-A/dry-run.txt"
    assert not cap_a.exists()
    prog = _bp(bd)
    assert prog["sample_ids"] == ["B"]
    on_disk = sorted(p.stem for p in (bd / "sample").glob("*.txt"))
    assert on_disk == ["B"]
    out = capsys.readouterr()
    assert "digest: " in out.out and "sample 1" in out.out
    assert "sample: skipped A (no dry-run.txt)" in out.err


# --- apply ------------------------------------------------------------------------
def _seed_signed(tmp_path: Path, ids=("A", "B", "C"), dry_exit=None, nodes=None):
    import backfill, hashlib
    dry_exit = dry_exit or {}
    vault, bd = _seed_batch(tmp_path, ids=ids)
    rows = {f"fireflies:{i}": {"dry_run": {"exit": dry_exit.get(i, 0)}} for i in ids}
    (bd / "batch-progress.json").write_text(json.dumps({"batch_id": bd.name, "kind": "fireflies", "rows": rows}), encoding="utf-8")
    (bd / "digest.md").write_text("# d\n", encoding="utf-8")
    sha = hashlib.sha256(b"# d\n").hexdigest()
    (bd / "digest.sha256").write_text(sha + "\n", encoding="utf-8")
    ok_ids = [i for i in ids if dry_exit.get(i, 0) == 0]
    (bd / "batch-signed.json").write_text(json.dumps({"batch_id": bd.name, "digest_sha256": sha,
        "manifest_sha256": hashlib.sha256((bd / "manifest.json").read_bytes()).hexdigest(), "signed_ids": ok_ids}), encoding="utf-8")
    brain = vault / "raw/areas/clearworks/org-brain/projects"; brain.mkdir(parents=True)
    for i in ids:
        env = vault / "raw/media/transcripts/fireflies" / i; env.mkdir(parents=True, exist_ok=True)
        (env / "resolution.json").write_text(json.dumps({"counterparty_slug": "acme", "node": (nodes or {}).get(i, "none"), "home_path": "clients/acme.md"}), encoding="utf-8")
    (brain / "acme-01.md").write_text("# E\n\n## Node\nid: acme-01\nkind: engagement\nclient: acme\ntitle: E\n", encoding="utf-8")
    (brain / "acme-03.md").write_text("# P\n\n## Node\nid: acme-03\nkind: project\nclient: acme\nparent: acme-01\ntitle: P\n", encoding="utf-8")
    return vault, bd


def test_apply_refuses_without_matching_signature(tmp_path, monkeypatch, capsys):
    import backfill
    vault, bd = _seed_signed(tmp_path)
    calls: list[str] = []
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: (calls.append(mid), 0)[1])
    (bd / "digest.md").write_text("# changed\n", encoding="utf-8")
    import hashlib
    (bd / "digest.sha256").write_text(hashlib.sha256(b"# changed\n").hexdigest() + "\n", encoding="utf-8")
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]) == 15
    assert "batch-signed.json" in capsys.readouterr().err
    (bd / "batch-signed.json").unlink()
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]) == 15
    # M2 (task-10-review): refuse-15 must make zero apply attempts and write nothing.
    assert calls == []
    prog = _bp(bd)
    assert "apply_started_at" not in prog
    assert all("apply" not in row for row in prog["rows"].values())


def test_apply_runs_exit0_rows_in_order_then_rollup_all_and_status_per_pair(tmp_path, monkeypatch, capsys):
    import backfill
    vault, bd = _seed_signed(tmp_path, dry_exit={"B": 3}, nodes={"A": "acme-03", "C": "acme-01"})
    applied, rollups, statuses = [], [], []

    def fake_apply(mid, v, repo):
        applied.append(mid)
        _receipt(vault, mid, f"sha-{mid}")
        return 0
    monkeypatch.setattr(backfill, "run_apply_subprocess", fake_apply)
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: (rollups.append(today), 0)[1])
    monkeypatch.setattr(backfill, "run_status_plan", lambda client, eng, today, v: (statuses.append((client, eng, today)), (0, "raw/areas/clearworks/clients/acme/status-update-2026-09-07.md"))[1])
    commits = []
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, pathspec, msg: (commits.append((pathspec, msg)), ("abc123", True))[1])
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"])
    assert rc == 0
    assert applied == ["A", "C"]                       # B skipped: dry_run.exit != 0
    assert len(rollups) == 1
    today = rollups[0]
    assert statuses == [("acme", "acme-01", today)]    # A→parent acme-01, C→acme-01: ONE pair
    assert len(commits) == 1
    spec, msg = commits[0]
    assert "raw/areas/clearworks/org-brain/STATE.md" in spec and "raw/areas/clearworks/org-brain/projects/acme-01.md" in spec
    assert "raw/areas/clearworks/clients/acme/status-update-2026-09-07.md" in spec and bd.name in msg
    assert _bp(bd)["post_batch"]["commit"] == {"pathspec": spec, "vault_sha": "abc123", "committed": True}
    doc = _bp(bd)
    assert doc["rows"]["fireflies:A"]["apply"]["exit"] == 0 and doc["rows"]["fireflies:A"]["apply"]["vault_sha"] == "sha-A"
    assert "apply" not in doc["rows"]["fireflies:B"]
    assert doc["apply_started_at"][:10] == today
    assert doc["post_batch"]["rollup_all"] == 0 and doc["post_batch"]["status_pairs"][0]["engagement"] == "acme-01"
    assert "applied: 2 ok, 0 failed, 1 skipped" in capsys.readouterr().out


def test_apply_continues_past_failure_and_exits_1(tmp_path, monkeypatch, capsys):
    import backfill
    vault, bd = _seed_signed(tmp_path)
    # B's capture was edited after signing → run_meeting exits 15 (existing validate_sign_marker,
    # pinned by test_apply_rejects_when_source_changed_after_signoff); the batch records it and continues.
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: 15 if mid == "B" else (_receipt(vault, mid, "s"), 0)[1])
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: 0)
    monkeypatch.setattr(backfill, "run_status_plan", lambda *a: (0, None))
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, ps, m: (None, False))
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"])
    assert rc == 1
    assert _bp(bd)["rows"]["fireflies:B"]["apply"]["exit"] == 15
    out = capsys.readouterr()
    assert "applied: 2 ok, 1 failed, 0 skipped" in out.out
    post = _bp(bd)["post_batch"]                                        # every authorized row attempted → post-batch ran (FR-015)
    assert post["failed_ids"] == ["B"] and post["rollup_all"] == 0 and "commit" in post


def test_apply_post_batch_is_deferred_until_every_row_is_attempted_then_runs_once(tmp_path, monkeypatch):
    import backfill
    vault, bd = _seed_signed(tmp_path)
    rollups = []
    # Simulate a mid-batch stop: the runner records A, then raises before B/C are attempted.
    def fake_apply(mid, v, repo):
        if mid == "B":
            raise KeyboardInterrupt
        _receipt(vault, mid, f"s-{mid}"); return 0
    monkeypatch.setattr(backfill, "run_apply_subprocess", fake_apply)
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: (rollups.append(today), 0)[1])
    monkeypatch.setattr(backfill, "run_status_plan", lambda *a: (0, None))
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, ps, m: (None, False))
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]
    import pytest
    with pytest.raises(KeyboardInterrupt):
        backfill.main(base)
    assert rollups == [] and "post_batch" not in _bp(bd)              # un-attempted rows → no post-batch
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: (_receipt(vault, mid, f"s-{mid}"), 0)[1])
    assert backfill.main(base) == 0 and len(rollups) == 1              # all attempted → once
    assert backfill.main(base) == 0 and len(rollups) == 1              # repeat: still once


def test_apply_post_batch_resumes_from_its_progressive_checkpoint(tmp_path, monkeypatch):
    import backfill
    vault, bd = _seed_signed(tmp_path, nodes={"A": "acme-01"})
    rollups, statuses = [], []
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: (_receipt(vault, mid, f"s-{mid}"), 0)[1])
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: (rollups.append(today), 0)[1])
    def crash_status(*a):
        statuses.append(a)
        raise RuntimeError("crash after rollup, before commit")
    monkeypatch.setattr(backfill, "run_status_plan", crash_status)
    commits = []
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, ps, m: (commits.append(ps), ("sha", True))[1])
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]
    import pytest
    with pytest.raises(RuntimeError):
        backfill.main(base)
    post = _bp(bd)["post_batch"]
    assert post["rollup_all"] == 0 and "commit" not in post            # checkpoint survived the crash
    monkeypatch.setattr(backfill, "run_status_plan", lambda *a: (statuses.append(a), (0, "raw/areas/x.md"))[1])
    assert backfill.main(base) == 0
    assert len(rollups) == 1 and len(commits) == 1                     # rollup NOT repeated; commit ran once
    assert _bp(bd)["post_batch"]["commit"]["vault_sha"] == "sha"


def test_run_apply_subprocess_returns_124_on_timeout(tmp_path, monkeypatch):
    import backfill, subprocess as sp

    def boom(*a, **kw):
        raise sp.TimeoutExpired(cmd="run_meeting.py", timeout=kw.get("timeout", 0))
    monkeypatch.setattr(backfill.subprocess, "run", boom)
    assert backfill.run_apply_subprocess("X", tmp_path, tmp_path) == 124


def test_apply_repeat_is_a_pure_noop(tmp_path, monkeypatch, capsys):
    import backfill
    vault, bd = _seed_signed(tmp_path)
    calls, rollups = [], []
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: (calls.append(mid), _receipt(vault, mid, "s"), 0)[2])
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: (rollups.append(today), 0)[1])
    monkeypatch.setattr(backfill, "run_status_plan", lambda *a: (0, None))
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, ps, m: (None, False))
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]
    assert backfill.main(base) == 0 and calls == ["A", "B", "C"] and len(rollups) == 1
    calls.clear(); capsys.readouterr()
    assert backfill.main(base) == 0
    assert calls == [] and len(rollups) == 1 and "commit" in _bp(bd)["post_batch"]   # no re-apply, no second rollup/status (D-19 once-after-batch)
    assert "applied: 0 ok, 0 failed, 3 skipped" in capsys.readouterr().out   # goal G4 evidence 7 wording


def test_post_batch_pathspec_and_real_commit_seam(tmp_path):
    import backfill, subprocess as sp
    vault = tmp_path / "vault"
    brain = vault / "raw/areas/clearworks/org-brain"
    (brain / "clients").mkdir(parents=True); (brain / "projects").mkdir()
    (brain / "STATE.md").write_text("# S\n", encoding="utf-8")
    (brain / "clients" / "acme.md").write_text("# C\n", encoding="utf-8")
    (brain / "clients" / "_template.md").write_text("# T\n", encoding="utf-8")
    (brain / "projects" / "acme-01.md").write_text("# E\n", encoding="utf-8")
    spec = backfill.post_batch_pathspec(vault, [("acme", "acme-01")], ["raw/areas/clearworks/clients/acme/status-update-2026-09-07.md", None])
    assert spec == sorted(["raw/areas/clearworks/org-brain/STATE.md", "raw/areas/clearworks/org-brain/clients/acme.md",
                           "raw/areas/clearworks/org-brain/projects/acme-01.md", "raw/areas/clearworks/clients/acme/status-update-2026-09-07.md"])
    sp.run(["git", "-C", str(vault), "init", "-q"], check=True)
    sp.run(["git", "-C", str(vault), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], check=True)
    sha, committed = backfill.commit_post_batch(vault, spec, "brain: test post-batch")
    assert committed and sha and len(sha) == 40
    assert sp.run(["git", "-C", str(vault), "status", "--porcelain", "--", *spec], capture_output=True, text=True).stdout.strip() == ""
    assert "_template.md" in sp.run(["git", "-C", str(vault), "status", "--porcelain", "--", "raw/areas"], capture_output=True, text=True).stdout  # deliberately excluded, still untracked
    sha2, committed2 = backfill.commit_post_batch(vault, spec, "brain: test post-batch again")
    assert (sha2, committed2) == (None, False)   # nothing to commit = success (D-14)


def test_apply_exit_is_zero_when_no_meeting_failed_even_if_post_batch_rollup_failed(tmp_path, monkeypatch):
    import backfill
    vault, bd = _seed_signed(tmp_path)
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: (_receipt(vault, mid, "s"), 0)[1])
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: 6)
    monkeypatch.setattr(backfill, "run_status_plan", lambda *a: (0, None))
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, ps, m: (None, False))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]) == 0
    assert _bp(bd)["post_batch"]["rollup_all"] == 6   # recorded for G4, not folded into the FR-015 exit


def test_apply_refuses_when_manifest_or_exit0_set_changed_after_signing(tmp_path, monkeypatch):
    import backfill
    vault, bd = _seed_signed(tmp_path)
    calls: list[str] = []
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: (calls.append(mid), 0)[1])
    m = json.loads((bd / "manifest.json").read_text(encoding="utf-8")); m["rows"] = m["rows"][:2]
    (bd / "manifest.json").write_text(json.dumps(m), encoding="utf-8")   # a row removed after signing
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]) == 15
    # M2 (task-10-review): refuse-15 must make zero apply attempts and write nothing.
    assert calls == []
    prog = _bp(bd)
    assert "apply_started_at" not in prog
    assert all("apply" not in row for row in prog["rows"].values())

    vault, bd = _seed_signed(tmp_path / "second", dry_exit={"C": 3})
    calls2: list[str] = []
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: (calls2.append(mid), 0)[1])
    p = _bp(bd); p["rows"]["fireflies:C"]["dry_run"]["exit"] = 0          # C passed a later dry-run but was never signed
    (bd / "batch-progress.json").write_text(json.dumps(p), encoding="utf-8")
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]) == 15
    assert calls2 == []
    prog2 = _bp(bd)
    assert "apply_started_at" not in prog2
    assert all("apply" not in row for row in prog2["rows"].values())


def test_apply_refuses_when_digest_md_edited_even_if_sidecar_updated(tmp_path, monkeypatch):
    import backfill, hashlib
    vault, bd = _seed_signed(tmp_path)
    (bd / "digest.md").write_text("# edited\n", encoding="utf-8")
    (bd / "digest.sha256").write_text(hashlib.sha256(b"# edited\n").hexdigest() + "\n", encoding="utf-8")   # sidecar "fixed" too
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda *a: 0)
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]) == 15


# --- task-10-review fix round 1 ----------------------------------------------------
def test_apply_closes_failed_rows_after_post_batch_instead_of_silently_retrying(tmp_path, monkeypatch, capsys):
    # I1: a row that failed (e.g. exit 124) before post-batch closed the batch must
    # NOT be re-run on a later invocation — it would only get run_meeting's per-meeting
    # state-only rollup and never its client-region rebuild or (client, engagement)
    # status update, since those only happen once, in the post-batch block that has
    # already run. It stays un-applied (a future batch's `list` will re-include it).
    import backfill
    vault, bd = _seed_signed(tmp_path)
    calls: list[str] = []

    def fake_apply(mid, v, repo):
        calls.append(mid)
        if mid == "B":
            return 124
        _receipt(vault, mid, f"s-{mid}")
        return 0
    monkeypatch.setattr(backfill, "run_apply_subprocess", fake_apply)
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: 0)
    monkeypatch.setattr(backfill, "run_status_plan", lambda *a: (0, None))
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, ps, m: ("sha1", True))
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]
    rc = backfill.main(base)
    assert rc == 1
    assert calls == ["A", "B", "C"]
    assert "commit" in _bp(bd)["post_batch"]
    capsys.readouterr()

    calls.clear()
    rc2 = backfill.main(base)
    assert rc2 == 0
    assert calls == []  # B was never re-run
    out = capsys.readouterr()
    assert "applied: 0 ok, 0 failed, 3 skipped" in out.out
    assert "need a new batch" in out.err and "B" in out.err
    assert _bp(bd)["rows"]["fireflies:B"]["apply"]["exit"] == 124  # unchanged


def test_commit_post_batch_failure_is_contained_and_recorded(tmp_path, monkeypatch, capsys):
    # M5: a real git failure in commit_post_batch (progress.vault_commit raises
    # SystemExit(10)) must not preempt the FR-015 `applied:` line / exit contract.
    # N1 (task-10-review-r1): the failure is recorded under its OWN `commit_error`
    # key — `commit` stays reserved for a real outcome, so a transient git failure
    # never reads as a completed commit.
    import backfill
    vault, bd = _seed_signed(tmp_path)
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: (_receipt(vault, mid, "s"), 0)[1])
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: 0)
    monkeypatch.setattr(backfill, "run_status_plan", lambda *a: (0, None))

    def boom(v, ps, m):
        raise SystemExit(10)
    monkeypatch.setattr(backfill, "commit_post_batch", boom)
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"])
    assert rc == 0  # FR-015 exit contract: failed == 0 → 0, regardless of the commit failure
    out = capsys.readouterr()
    assert "applied: 3 ok, 0 failed, 0 skipped" in out.out
    post_batch = _bp(bd)["post_batch"]
    assert post_batch["commit_error"]["code"] == "10"
    assert "commit" not in post_batch


def test_apply_retries_only_the_commit_after_a_commit_error_then_never_reruns_it(tmp_path, monkeypatch, capsys):
    # N1: a commit error must not permanently close the batch — a re-run must
    # re-enter the post-batch block, retry ONLY the commit (rollup/status stay
    # checkpointed), and once it truly succeeds, never run rollup/status/commit again.
    import backfill
    vault, bd = _seed_signed(tmp_path)
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid, v, repo: (_receipt(vault, mid, "s"), 0)[1])
    rollups, statuses, commits = [], [], []
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: (rollups.append(today), 0)[1])
    monkeypatch.setattr(backfill, "run_status_plan", lambda *a: (statuses.append(a), (0, None))[1])

    def boom(v, ps, m):
        raise SystemExit(10)
    monkeypatch.setattr(backfill, "commit_post_batch", boom)
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]
    assert backfill.main(base) == 0
    assert len(rollups) == 1
    post = _bp(bd)["post_batch"]
    assert "commit_error" in post and "commit" not in post

    commit_calls: list[int] = []
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, ps, m: (commit_calls.append(1), ("sha2", True))[1])
    assert backfill.main(base) == 0
    assert len(commit_calls) == 1                     # run 2: commit retried exactly once
    # rollup already ran (checkpointed); status never had a pair (all nodes "none" in
    # this fixture) — neither is re-run by the commit retry.
    assert len(rollups) == 1 and len(statuses) == 0
    post2 = _bp(bd)["post_batch"]
    assert post2["commit"]["vault_sha"] == "sha2" and post2["commit"]["committed"] is True

    # run 3: fully closed now — a repeat is a pure no-op, nothing re-invoked.
    assert backfill.main(base) == 0
    assert len(commit_calls) == 1 and len(rollups) == 1 and len(statuses) == 0


def test_apply_a_pending_commit_error_does_not_close_still_failing_rows(tmp_path, monkeypatch, capsys):
    # N1: while post_batch.commit_error exists (no real commit yet), a failed row
    # (B, exit 124) must still be RE-RUN on the next invocation, never closed with
    # "post-batch already ran" — that message is reserved for an actually-completed
    # commit. Once B applies clean AND the commit truly succeeds, nothing is left
    # to close and the commit runs exactly once.
    import backfill
    vault, bd = _seed_signed(tmp_path)
    calls: list[str] = []
    b_attempts = {"n": 0}

    def fake_apply(mid, v, repo):
        calls.append(mid)
        if mid == "B":
            b_attempts["n"] += 1
            if b_attempts["n"] < 3:
                return 124
        _receipt(vault, mid, f"s-{mid}")
        return 0
    monkeypatch.setattr(backfill, "run_apply_subprocess", fake_apply)
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: 0)
    monkeypatch.setattr(backfill, "run_status_plan", lambda *a: (0, None))

    def boom(v, ps, m):
        raise SystemExit(10)
    monkeypatch.setattr(backfill, "commit_post_batch", boom)
    base = ["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"]
    assert backfill.main(base) == 1   # run 1: B fails 124 (attempt 1); commit also errors
    post1 = _bp(bd)["post_batch"]
    assert "commit_error" in post1 and "commit" not in post1

    calls.clear()
    rc2 = backfill.main(base)
    assert rc2 == 1                   # run 2: B fails again (attempt 2); commit still errors
    assert calls == ["B"]             # B WAS re-dispatched, not closed
    assert "post-batch already ran" not in capsys.readouterr().err

    calls.clear()
    commit_calls: list[int] = []
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, ps, m: (commit_calls.append(1), ("sha3", True))[1])
    assert backfill.main(base) == 0   # run 3: B succeeds (attempt 3), real commit lands
    assert calls == ["B"]
    assert len(commit_calls) == 1
    post3 = _bp(bd)["post_batch"]
    assert post3["commit"]["vault_sha"] == "sha3" and post3["commit"]["committed"] is True


def test_apply_skips_post_batch_block_when_nothing_authorized(tmp_path, monkeypatch, capsys):
    # M6: an all-non-exit-0 batch has an empty authorized/signed_ids set — post-batch
    # must not run rollup --all / a commit for a batch that applied nothing.
    import backfill
    vault, bd = _seed_signed(tmp_path, dry_exit={"A": 3, "B": 3, "C": 3})
    rollups: list[str] = []
    commits: list[str] = []
    monkeypatch.setattr(backfill, "run_apply_subprocess", lambda *a: 0)
    monkeypatch.setattr(backfill, "run_rollup_all", lambda v, today: (rollups.append(today), 0)[1])
    monkeypatch.setattr(backfill, "commit_post_batch", lambda v, ps, m: (commits.append(ps), (None, False))[1])
    rc = backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "apply"])
    assert rc == 0
    assert rollups == [] and commits == []
    assert _bp(bd)["post_batch"] == {"skipped": "no-authorized-rows"}
    assert "post-batch: nothing authorized, skipped" in capsys.readouterr().err


def test_commit_post_batch_reuses_progress_pathspec_dirty(tmp_path):
    # M1: commit_post_batch delegates its "nothing to add" pre-check to
    # progress.pathspec_dirty rather than a hand-rolled duplicate.
    import backfill, subprocess as sp
    vault = tmp_path / "vault"
    (vault / "sub").mkdir(parents=True)
    (vault / "sub" / "a.md").write_text("# a\n", encoding="utf-8")
    sp.run(["git", "-C", str(vault), "init", "-q"], check=True)
    sp.run(["git", "-C", str(vault), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], check=True)
    sha, committed = backfill.commit_post_batch(vault, ["sub/a.md"], "first")
    assert committed and sha
    sha2, committed2 = backfill.commit_post_batch(vault, ["sub/a.md"], "second")
    assert (sha2, committed2) == (None, False)


# --- CARRY-3 (Task 10): dry-run over an empty/all-already-applied manifest must still
# leave batch-progress.json on disk — apply's guard chain depends on Task 7's M7 contract.
def test_dry_run_empty_manifest_still_persists_batch_progress(tmp_path):
    import backfill
    vault, bd = _seed_batch(tmp_path, ids=())
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]) == 0
    assert (bd / "batch-progress.json").is_file()


def test_dry_run_all_already_applied_still_persists_batch_progress(tmp_path):
    import backfill
    vault, bd = _seed_batch(tmp_path, ids=("A", "B"), applied=("A", "B"))
    assert backfill.main(["--source", "fireflies", "--vault", str(vault), "--repo-root", str(tmp_path), "--batch", bd.name, "dry-run"]) == 0
    assert (bd / "batch-progress.json").is_file()
