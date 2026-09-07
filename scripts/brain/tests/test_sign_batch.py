# scripts/brain/tests/test_sign_batch.py
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

GOOD = ("home=clients/a.md node=none rule=2\n--- a/x\nquotes kept decisions=1 commitments=1 open_questions=0\n"
        "tasks:\nsubject: Recap\nphase3-preview: v1\nwould-touch: STATE.md\nwould-write: skip: no-engagement\nwould-file: X\n")


@contextlib.contextmanager
def _external_flock_holder(lock_path: Path):
    """B2 (G2b r2 CH2-3): same pattern as test_backfill.py's helper of the
    same name (Agent A, fold round 3, A9) — spawns a real helper SUBPROCESS
    that opens `lock_path` (O_CREAT|O_RDWR) and takes a genuine
    `fcntl.flock(LOCK_EX)` on it, prints 'locked' once held, then blocks
    reading a line from stdin before releasing (on process exit). No
    in-process fake can substitute: `_acquire_batch_lock`'s contention path
    is a kernel-level advisory lock tied to a SEPARATE process's open file
    description, which only a genuinely separate process can hold."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    code = (
        "import fcntl, os, sys\n"
        f"fd = os.open({str(lock_path)!r}, os.O_CREAT | os.O_RDWR, 0o644)\n"
        "fcntl.flock(fd, fcntl.LOCK_EX)\n"
        "os.write(fd, str(os.getpid()).encode())\n"
        "print('locked', flush=True)\n"
        "sys.stdin.readline()\n"
    )
    proc = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        line = proc.stdout.readline()
        assert line.strip() == "locked", f"helper failed to lock: {line!r}"
        yield proc.pid
    finally:
        try:
            proc.stdin.write("go\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        proc.wait(timeout=5)


def _digest_bytes(attempted_ids=("A", "B", "C"), status: str = "complete", unattempted_n: int = 0) -> bytes:
    # G2 r3 CH3-1/CH3-7/fold-3 minors: a real digest.md (backfill.write_digest)
    # always carries BOTH a real markdown table (id is the first column of
    # every data row, B1) AND a compound stats line with `unattempted: N`
    # embedded in it (B6) alongside its own `status:` line — the fixture's
    # own digest must carry all three, in the real shapes, or the new
    # cross-checks (which are correctness checks, never weakened to fit a
    # fixture) refuse every test that doesn't genuinely match.
    header = (
        "# digest\n\n"
        f"kind: fireflies · manifest: {len(attempted_ids) + unattempted_n} · applied: 0 · "
        f"meetings: {len(attempted_ids)} · ok: {len(attempted_ids)} · failed: 0 · "
        f"unattempted: {unattempted_n} · cost_usd: 0.00\n"
        f"status: {status}\n\n"
        "| id | date | title | home | created org | kept/dropped | classification | exit |\n"
        "|---|---|---|---|---|---|---|---|\n"
    )
    rows = "".join(f"| {mid} | 2026-09-01 | t | h |  |  |  | 0 |\n" for mid in attempted_ids)
    return (header + rows + "\n").encode("utf-8")


def _occurred_at_for(mid: str) -> str:
    # B4 (G2b r2 CH2-6): every manifest row needs a real, RFC3339-parseable
    # occurred_at. Single-uppercase-letter test ids map onto an ordinal day
    # in September 2026 so alphabetical id order == chronological order ==
    # canonical (occurred_at, id) order, exactly like every fixture in this
    # file already assumes.
    day = ord(mid[0].upper()) - ord("A") + 1
    return f"2026-09-{day:02d}T00:00:00Z"


def _seed(tmp_path: Path, ids=("A", "B", "C"), bad=(), failed=(), extra_progress_ids=(), unattempted=(),
          digest_status="complete", digest_unattempted_n=None):
    import backfill, progress
    vault = tmp_path / "vault"
    bid = "fireflies-20260906T000000Z"
    bd = backfill.batch_dir(vault, bid); bd.mkdir(parents=True)
    rows = {f"fireflies:{i}": {"dry_run": {"exit": 0 if i not in failed else 3}} for i in (*ids, *extra_progress_ids)}
    # `unattempted`: manifest ids with NO progress row at all — simulates a
    # dry-run halted early (budget/auth) before ever reaching them (G2 r2 P1).
    manifest_rows = [{"id": i, "kind": "fireflies", "occurred_at": _occurred_at_for(i)} for i in (*ids, *unattempted)]
    (bd / "manifest.json").write_text(json.dumps({"batch_id": bid, "kind": "fireflies", "rows": manifest_rows}), encoding="utf-8")
    (bd / "batch-progress.json").write_text(json.dumps({"batch_id": bid, "kind": "fireflies", "rows": rows, "sample_ids": [i for i in ids if i not in failed]}), encoding="utf-8")
    # B1: the digest table must name EXACTLY the ids with a real dry_run
    # dict in `rows` above — every id in (*ids, *extra_progress_ids), since
    # `rows` gives every one of them a real int `exit`. B6:
    # `digest_unattempted_n` lets one adversarial test (the disagreement
    # case) override the count without touching the real `unattempted`
    # param above; every other caller gets the true `len(unattempted)`.
    attempted_ids = (*ids, *extra_progress_ids)
    unattempted_n = len(unattempted) if digest_unattempted_n is None else digest_unattempted_n
    digest_bytes = _digest_bytes(attempted_ids, digest_status, unattempted_n)
    (bd / "digest.md").write_bytes(digest_bytes)
    sha = hashlib.sha256(digest_bytes).hexdigest()
    (bd / "digest.sha256").write_text(sha + "\n", encoding="utf-8")
    versioned = bd / f"sample-{sha[:12]}"; versioned.mkdir()
    os.symlink(versioned.name, bd / "sample")
    for i in (*ids, *extra_progress_ids):
        state = progress._state_dir(vault, "fireflies", i); state.mkdir(parents=True)
        (state / "dry-run.txt").write_text("home=x\n" if i in bad else GOOD, encoding="utf-8")
        if i in ids and i not in failed:
            (versioned / f"{i}.txt").write_text("home=x\n" if i in bad else GOOD, encoding="utf-8")
        env = vault / "raw/media/transcripts/fireflies" / i; env.mkdir(parents=True)
        (env / "source.sha256").write_text("a" * 64 + "\n", encoding="utf-8")
        (env / "extraction.json").write_text(json.dumps({"inputSha": "b" * 64}), encoding="utf-8")
    return vault, bd, bid


def _args(vault, bd, bid, signer="Josh"):
    return ["--batch", bid, "--vault", str(vault), "--signed-by", signer, "--signed-at", "2026-09-06T20:00:00Z", "--digest", str(bd / "digest.md")]


def test_sign_batch_writes_signed_json_and_markers_for_exit0_rows(tmp_path, capsys):
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path, failed=("C",))
    assert sign_batch.main(_args(vault, bd, bid)) == 0
    signed = json.loads((bd / "batch-signed.json").read_text(encoding="utf-8"))
    assert signed["batch_id"] == bid and signed["digest_sha256"] == hashlib.sha256(_digest_bytes()).hexdigest()
    assert signed["meeting_count"] == 2 and signed["sample_ids"] == ["A", "B"] and signed["signed_by"] == "Josh"  # C failed → not sampled
    assert signed["signed_ids"] == ["A", "B"] and signed["manifest_sha256"] == hashlib.sha256((bd / "manifest.json").read_bytes()).hexdigest()
    good_sha256 = hashlib.sha256(GOOD.encode("utf-8")).hexdigest()
    for i in ("A", "B"):
        doc = json.loads(marker_path(vault, "fireflies", i).read_text(encoding="utf-8"))
        assert doc["batch_id"] == bid and doc["digest_sha256"] == signed["digest_sha256"]
        assert doc["signed_by"] == "Josh" and doc["source_sha256"] == "a" * 64
        assert doc["phase3_capture_sha256"] == good_sha256 and doc["capture_sha256"] == good_sha256
    assert not marker_path(vault, "fireflies", "C").exists()
    assert "signed: 2 markers" in capsys.readouterr().out


def test_sign_batch_ignores_progress_rows_outside_manifest(tmp_path):
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path, extra_progress_ids=("ZZ",))
    assert sign_batch.main(_args(vault, bd, bid)) == 0
    assert not marker_path(vault, "fireflies", "ZZ").exists()
    assert json.loads((bd / "batch-signed.json").read_text(encoding="utf-8"))["meeting_count"] == 3


def test_sign_batch_refuses_stale_missing_or_unlisted_sample(tmp_path, capsys):
    """Coordinator adjudication 2026-09-07: seed with failed=("C",) so C is a
    genuine non-candidate (sample_ids = [A, B]; sample dir holds A, B) — the
    original brief test assumed `_seed(tmp_path)` (no `failed`) put only A, B
    in sample/, but `_seed` writes a sample file for every non-failed id, so
    the unqualified default seeds A, B, C (all candidates) and the "unlisted
    extra file" step below could never actually be unlisted. This is the
    fixture-usage correction, not a change to `_seed` or the gate."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path, failed=("C",))
    (bd / "sample" / "A.txt").write_text(GOOD + "\ntampered\n", encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "sample" in capsys.readouterr().err and not (bd / "batch-signed.json").exists()
    (bd / "sample" / "A.txt").write_text(GOOD, encoding="utf-8")
    (bd / "sample" / "C.txt").write_text(GOOD, encoding="utf-8")          # unlisted extra file (C failed, not a candidate) ≠ sample_ids
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    (bd / "sample" / "C.txt").unlink(); (bd / "sample" / "A.txt").unlink()  # missing listed file
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_shrunken_sample_set(tmp_path, capsys):
    """Coordinator adjudication 2026-09-07: _seed(tmp_path) wrote 3 sample
    files (A, B, C — not 2, per the stale comment in the original brief
    draft); shrink to 2 explicitly (unlink C.txt on disk AND shrink the
    recorded sample_ids) so listing == sample_ids (2 == 2) while
    expected_n = min(10, len(candidates)=3) = 3, forcing the count check."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)          # 3 candidates → sample must hold min(10, 3) = 3; _seed wrote 3; shrink to 2
    (bd / "sample" / "C.txt").unlink()
    prog = json.loads((bd / "batch-progress.json").read_text(encoding="utf-8")); prog["sample_ids"] = ["A", "B"]
    (bd / "batch-progress.json").write_text(json.dumps(prog), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "exactly 3" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_sample_dir_not_bound_to_digest(tmp_path, capsys):
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    (bd / "sample").unlink(); os.symlink("sample-000000000000", bd / "sample")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "does not match the digest" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_bad_batch_id_before_any_read(tmp_path):
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    assert sign_batch.main(_args(vault, bd, "../etc")) == 64
    assert sign_batch.main(_args(vault, bd, bid + "/x")) == 64
    assert not (bd / "batch-signed.json").exists()


def test_sign_batch_refuses_unknown_signer_before_any_write(tmp_path, capsys):
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    assert sign_batch.main(_args(vault, bd, bid, signer="Mallory")) == 1
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))
    assert "signer not in allowlist" in capsys.readouterr().err


def test_sign_batch_refuses_stale_digest(tmp_path, capsys):
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    (bd / "digest.md").write_text("# edited after review\n", encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert not (bd / "batch-signed.json").exists()
    assert "digest sha256 mismatch" in capsys.readouterr().err


def test_sign_batch_refuses_non_rfc3339_signed_at_before_any_write(tmp_path, capsys):
    """review Important #1: signed_at must pass the SAME acceptance rule
    validate_sign_marker uses at apply time (progress.py's
    `datetime.fromisoformat(signed_at.replace("Z", "+00:00"))` in a try/except
    ValueError) — mirrored exactly, so sign_batch never accepts what the R3
    gate would later reject. "not-a-time" is the discriminating case:
    Python's `datetime.fromisoformat` genuinely raises ValueError on it (a
    bare date like "2026-09-06" does NOT raise — it parses to midnight,
    under the identical rule validate_sign_marker itself uses — so it is
    not usable as a must-reject example without contradicting the very rule
    being mirrored)."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    args = _args(vault, bd, bid)
    args[args.index("--signed-at") + 1] = "not-a-time"
    assert sign_batch.main(args) == 1
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))
    assert "signed_at is not RFC3339" in capsys.readouterr().err


def test_sign_batch_names_first_incomplete_capture_and_writes_nothing(tmp_path, capsys):
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path, bad=("B",))
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    err = capsys.readouterr().err
    assert "fireflies-B/dry-run.txt" in err and "missing" in err
    assert not (bd / "batch-signed.json").exists() and not marker_path(vault, "fireflies", "A").exists()


def test_sign_batch_ignores_phantom_progress_rows(tmp_path):
    """CARRY-C, made discriminating per review Important #2: the original
    version of this test put `fireflies:Z` only in batch-progress.json, not
    in manifest.rows — so the manifest-∩ filter alone excluded it and the
    test passed whether or not the `isinstance(dry_run, dict)` guard
    existed. Both phantoms are now real manifest ids: `Z` -> `{}` (no
    `dry_run` key at all — exactly what real pre-fix ledgers had) and
    `Y` -> `{"dry_run": None}` (an explicit null). Without the isinstance
    guard, `None.get("exit")` on the `Y` row would raise `AttributeError`
    (proved via a standalone repro against the identical candidate-loop
    logic — see the fix report) — that crash, not just a wrong count, is
    the discriminating RED this test now proves is guarded against."""
    import sign_batch
    from sign_marker import marker_path
    # G2 r2 P1 / B6: Y/Z below have no real dry_run dict, so this batch is
    # genuinely partial — the digest's unattempted:2 header must match that
    # (Y, Z) or the new count cross-check refuses before ever reaching the
    # phantom-row guard under test.
    vault, bd, bid = _seed(tmp_path, digest_status="partial (budget)", digest_unattempted_n=2)
    # F15 (CH-9): appended in (occurred_at, id) canonical order — Y before Z
    # — so this fixture's own manifest stays canonical; only the base ids
    # (A, B, C) plus these two phantoms are under test here, not ordering.
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"].append({"id": "Y", "kind": "fireflies", "occurred_at": _occurred_at_for("Y")})
    manifest["rows"].append({"id": "Z", "kind": "fireflies", "occurred_at": _occurred_at_for("Z")})
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    prog = json.loads((bd / "batch-progress.json").read_text(encoding="utf-8"))
    prog["rows"]["fireflies:Z"] = {}
    prog["rows"]["fireflies:Y"] = {"dry_run": None}
    (bd / "batch-progress.json").write_text(json.dumps(prog), encoding="utf-8")
    # G2 r2 P1: Y and Z carry no real `dry_run` dict — they are now genuinely
    # "unattempted" rows under the new partial-batch gate, so this needs
    # --allow-partial (the phantom-row guard under test here is orthogonal:
    # they must still never receive markers or count toward signed_ids).
    assert sign_batch.main(_args(vault, bd, bid) + ["--allow-partial"]) == 0
    signed = json.loads((bd / "batch-signed.json").read_text(encoding="utf-8"))
    assert "Z" not in signed["signed_ids"] and "Y" not in signed["signed_ids"]
    assert signed["meeting_count"] == 3
    assert signed["partial"] is True
    assert signed["unattempted_ids"] == ["Y", "Z"]
    assert not marker_path(vault, "fireflies", "Z").exists()
    assert not marker_path(vault, "fireflies", "Y").exists()


def test_sign_batch_refuses_partial_batch_without_allow_partial(tmp_path, capsys):
    """G2 r2 P1 (a): manifest rows D, E have no progress entry at all (a
    dry-run halted early on budget/auth before reaching them) — without
    --allow-partial this must refuse, writing nothing."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path, unattempted=("D", "E"), digest_status="partial (budget)")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    err = capsys.readouterr().err
    assert "batch is partial: 2 unattempted rows" in err
    assert "--allow-partial" in err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C", "D", "E"))


def test_sign_batch_allow_partial_signs_reviewed_rows_only(tmp_path):
    """G2 r2 P1 (b): --allow-partial proceeds, records partial: true and the
    unattempted ids, and stamps markers only for the actually-reviewed
    candidates (A, B, C) — D and E get nothing."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path, unattempted=("D", "E"), digest_status="partial (budget)")
    result = sign_batch.main(_args(vault, bd, bid) + ["--allow-partial"])
    assert result == 0
    signed = json.loads((bd / "batch-signed.json").read_text(encoding="utf-8"))
    assert signed["partial"] is True
    assert signed["unattempted_count"] == 2
    assert signed["unattempted_ids"] == ["D", "E"]
    assert signed["signed_ids"] == ["A", "B", "C"]
    for i in ("A", "B", "C"):
        assert marker_path(vault, "fireflies", i).exists()
    for i in ("D", "E"):
        assert not marker_path(vault, "fireflies", i).exists()


def test_sign_batch_complete_batch_records_partial_false(tmp_path):
    """G2 r2 P1 (c): a fully-attempted batch (the default fixture) records
    partial: false / unattempted_count: 0 on batch-signed.json."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    assert sign_batch.main(_args(vault, bd, bid)) == 0
    signed = json.loads((bd / "batch-signed.json").read_text(encoding="utf-8"))
    assert signed["partial"] is False
    assert signed["unattempted_count"] == 0
    assert signed["unattempted_ids"] == []


def test_sign_batch_refuses_digest_status_disagreeing_with_progress(tmp_path, capsys):
    """G2 r2 P1 (3) / B6 (fold-3 minors, the header count supersedes the
    status word): the digest's `unattempted: 2` header claims 2 unattempted
    rows, but every manifest row actually has a real dry_run entry
    (computed unattempted is empty) — a hand-edited digest or a
    batch-progress.json that drifted from what was reviewed must refuse,
    not sign against a stale claim. `digest_unattempted_n` overrides only
    the header text, independent of the real `unattempted=()` (so the
    table/row-id check, B1, still agrees with progress — isolating B6)."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path, digest_status="partial (budget)", digest_unattempted_n=2)
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "digest status disagrees with progress; re-run dry-run" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_digest_missing_status_or_unattempted_header(tmp_path, capsys):
    """B6 (fold-3 minors): a digest with no `status:` line and/or no
    `unattempted: N` embedded in its stats line must refuse outright, not
    treat the absence as vacuously agreeing."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    bad_digest = b"# digest\n\n| id | date | title | home | created org | kept/dropped | classification | exit |\n|---|---|---|---|---|---|---|---|\n| A | 2026-09-01 | t | h |  |  |  | 0 |\n| B | 2026-09-01 | t | h |  |  |  | 0 |\n| C | 2026-09-01 | t | h |  |  |  | 0 |\n\n"
    (bd / "digest.md").write_bytes(bad_digest)
    (bd / "digest.sha256").write_text(hashlib.sha256(bad_digest).hexdigest() + "\n", encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "digest missing status/unattempted header; re-run dry-run" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()


def test_sign_batch_refuses_digest_row_ids_differ_from_progress(tmp_path, capsys):
    """B1 (G2 r3 CH3-1, Critical): an exit-0 progress row (D) not named in
    the digest's own table must refuse — the digest being reviewed is not
    the same set of meetings as the batch about to be signed."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    prog = json.loads((bd / "batch-progress.json").read_text(encoding="utf-8"))
    prog["rows"]["fireflies:D"] = {"dry_run": {"exit": 0}}
    (bd / "batch-progress.json").write_text(json.dumps(prog), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "digest rows differ from progress (re-run dry-run to republish the digest)" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()


def test_sign_batch_writes_fanout_complete_true_after_last_marker(tmp_path):
    """F2 addendum (CH-5/CH-6): the initial batch-signed.json write (before
    any marker lands) carries fanout_complete: false; only after every
    candidate marker is written does sign_batch atomically flip it to true
    and record markers_written — apply's preflight (backfill.py) trusts
    this file alone rather than re-deriving completeness from disk."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path, failed=("C",))
    assert sign_batch.main(_args(vault, bd, bid)) == 0
    signed = json.loads((bd / "batch-signed.json").read_text(encoding="utf-8"))
    assert signed["fanout_complete"] is True
    assert signed["markers_written"] == 2


def test_sign_batch_refuses_manifest_row_missing_id(tmp_path, capsys):
    """M4 (Std 11): a corrupt manifest.rows[i] (missing 'id') must refuse
    with a clean message, never an uncaught traceback (KeyError/AttributeError)."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"][1] = {"kind": "fireflies"}  # no "id" key
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    err = capsys.readouterr().err
    assert "corrupt" in err and "traceback" not in err.lower()
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_non_dict_progress_row(tmp_path, capsys):
    """M4 (Std 11): a batch-progress.json row that is not a JSON object
    (e.g. a bare string, from hand-editing or ledger corruption) must
    refuse cleanly instead of AttributeError'ing on entry.get(...)."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    prog = json.loads((bd / "batch-progress.json").read_text(encoding="utf-8"))
    prog["rows"]["fireflies:A"] = "not-an-object"
    (bd / "batch-progress.json").write_text(json.dumps(prog), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    err = capsys.readouterr().err
    assert "not an object" in err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_manifest_id_not_filesystem_safe(tmp_path, capsys):
    """F14 (CH-8): a manifest id that fails to round-trip through
    safe_meeting_id (path-traversal-shaped, or a 'fireflies:'-prefixed id
    that safe_meeting_id would strip) must be refused BEFORE any per-meeting
    path (progress._state_dir, marker_path) is built from it."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"][0]["id"] = "../../etc"
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "not filesystem-safe" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_unknown_kind(tmp_path, capsys):
    """F14 (CH-8): a manifest kind outside backfill.SOURCES must be refused
    before any per-meeting path is built."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["kind"] = "carrier-pigeon"
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "unknown kind" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()


def test_sign_batch_refuses_non_canonical_manifest_order(tmp_path, capsys):
    """F15 (CH-9): manifest rows out of (occurred_at, id) order must be
    refused with 'manifest not canonical; re-run list' — a reordered
    manifest hides drift from the human digest review."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"] = list(reversed(manifest["rows"]))  # C, B, A — not canonical
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "manifest not canonical; re-run list" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_duplicate_manifest_ids(tmp_path, capsys):
    """F15 (CH-9): duplicate ids in the manifest must be refused the same
    way as a reordered manifest — both mean 'manifest not canonical'."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"].append({"id": "C", "kind": "fireflies", "occurred_at": _occurred_at_for("C")})  # duplicate of the existing C row
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "manifest not canonical; re-run list" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()


def test_sign_batch_refuses_batch_id_mismatch(tmp_path, capsys):
    """review Minor #5: a signing tool must not silently trust a batch dir
    whose own manifest.json disagrees with --batch — refuse rather than
    sign against the wrong batch's manifest."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["batch_id"] = "fireflies-19700101T000000Z"
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_manifest_kind_outside_sources_via_prefix_check(tmp_path, capsys):
    """B3 (G2b r2 CH2-5) / F14 interaction: manifest.kind disagreeing with
    the batch id's own prefix is caught by the earlier F14 SOURCES check
    when the bogus kind isn't a real source at all — proves manifest.kind
    is actually read before B3's prefix comparison ever runs."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["kind"] = "slack"
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "unknown kind" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()


def test_sign_batch_refuses_batch_id_kind_prefix_mismatch(tmp_path, capsys):
    """B3 (G2b r2 CH2-5): a kind that IS a real source (backfill.SOURCES)
    but disagrees with the --batch id's own prefix must still refuse —
    matching batch_id alone (checked earlier) does not prove the id was
    ever minted for this kind."""
    import shutil
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    # Rename the batch dir + rewrite batch_id fields so --batch's prefix
    # ("otherkind") disagrees with the real kind ("fireflies") while every
    # earlier check (BATCH_ID_RE, manifest/progress batch_id equality,
    # F14 kind-in-SOURCES) still passes — isolating B3 as the one that fires.
    bad_bid = "otherkind-20260906T000000Z"
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["batch_id"] = bad_bid
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    prog = json.loads((bd / "batch-progress.json").read_text(encoding="utf-8"))
    prog["batch_id"] = bad_bid
    (bd / "batch-progress.json").write_text(json.dumps(prog), encoding="utf-8")
    new_bd = bd.parent / bad_bid
    shutil.move(str(bd), str(new_bd))
    assert sign_batch.main(_args(vault, new_bd, bad_bid)) == 1
    assert "kind prefix" in capsys.readouterr().err
    assert not (new_bd / "batch-signed.json").exists()


def test_sign_batch_refuses_row_missing_occurred_at(tmp_path, capsys):
    """B4 (G2b r2 CH2-6): a row missing (or with an empty) occurred_at must
    refuse before the canonical-order check would otherwise silently treat
    it as sorting first."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    del manifest["rows"][0]["occurred_at"]
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "occurred_at missing or empty" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_row_occurred_at_not_rfc3339(tmp_path, capsys):
    """B4 (G2b r2 CH2-6): an occurred_at that datetime.fromisoformat can't
    parse must refuse — the same acceptance rule progress.validate_sign_marker
    mirrors elsewhere in this codebase for signed_at."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"][0]["occurred_at"] = "not-a-time"
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "occurred_at is not RFC3339" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()


def test_sign_batch_refuses_naive_or_date_only_occurred_at(tmp_path, capsys):
    """B4 (G2 r3 CH3-6, mirrors backfill.py's A4): a naive or date-only
    occurred_at (no 'Z', no UTC offset) is exactly the string
    datetime.fromisoformat WOULD happily parse (as local midnight) — the
    old check let it through; it must now be refused the same way a
    genuinely malformed string is."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"][0]["occurred_at"] = "2026-09-01T00:00:00"  # naive: no zone
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "occurred_at is not RFC3339" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()

    manifest["rows"][0]["occurred_at"] = "2026-09-01"  # date-only: also naive
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "occurred_at is not RFC3339" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()


def test_sign_batch_canonical_order_by_utc_instant_not_local_text(tmp_path, capsys):
    """B4 (G2 r3 CH3-6, mirrors backfill.py's A4): two rows whose raw text
    would sort one way but whose real UTC instants sort the OPPOSITE way
    must be ordered — and refused as non-canonical — by the real instant,
    never the offset-naive text. Row A: 2026-09-01T23:00:00-05:00 = UTC
    2026-09-02T04:00:00. Row B: 2026-09-02T00:00:00Z = UTC
    2026-09-02T00:00:00 — earlier than A by instant despite A's text
    sorting first."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path, ids=("A", "B"))
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    by_id = {r["id"]: r for r in manifest["rows"]}
    by_id["A"]["occurred_at"] = "2026-09-01T23:00:00-05:00"
    by_id["B"]["occurred_at"] = "2026-09-02T00:00:00Z"
    # Text-sorted (A, B) order is what's on disk here — this must refuse as
    # non-canonical, since by UTC instant B (00:00) precedes A (04:00).
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "manifest not canonical; re-run list" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()

    # Reordered to true UTC-instant order (B, then A) — now canonical, and
    # nothing else in the fixture was disturbed, so signing succeeds fully.
    manifest["rows"] = [by_id["B"], by_id["A"]]
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 0, capsys.readouterr().err
    assert (bd / "batch-signed.json").exists()


def test_sign_batch_refuses_row_kind_mismatch(tmp_path, capsys):
    """B4 (G2b r2 CH2-6): a row whose own kind disagrees with manifest.kind
    must refuse — a mixed-kind manifest is ledger corruption."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"][0]["kind"] = "slack"
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "kind" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()


def test_sign_batch_refuses_empty_string_manifest_id(tmp_path, capsys):
    """B4 (fold-2 re-review empty-id sentinel): an explicit id == "" must
    refuse the same way a missing id does — already enforced by the
    existing `not row["id"]` check; this test proves it, since none of the
    other fixtures exercise a present-but-empty id."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"][0]["id"] = ""
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 1
    assert "corrupt (missing id)" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_refuses_when_batch_locked_by_another_process(tmp_path, capsys):
    """B2 (G2b r2 CH2-3): a real external process holding the batch flock
    must make sign_batch refuse before ever reading manifest.json/
    batch-progress.json — nothing gets written, no markers stamped."""
    import sign_batch
    from sign_marker import marker_path
    vault, bd, bid = _seed(tmp_path)
    with _external_flock_holder(bd / ".lock"):
        rc = sign_batch.main(_args(vault, bd, bid))
    assert rc == 1
    assert "locked; retry later" in capsys.readouterr().err
    assert not (bd / "batch-signed.json").exists()
    assert not any(marker_path(vault, "fireflies", i).exists() for i in ("A", "B", "C"))


def test_sign_batch_releases_lock_after_happy_path(tmp_path):
    """B2 (G2b r2 CH2-3): the happy path still signs successfully, and the
    lock is released afterwards — a second _acquire_batch_lock call (a
    stand-in for a subsequent real invocation) succeeds immediately rather
    than finding sign_batch's own process still holding it."""
    import sign_batch
    from backfill import _acquire_batch_lock, _release_batch_lock
    vault, bd, bid = _seed(tmp_path, failed=("C",))
    assert sign_batch.main(_args(vault, bd, bid)) == 0
    assert (bd / "batch-signed.json").exists()
    # A fresh acquire must succeed immediately — sign_batch.py released its
    # own lock in `finally` on the success path, not just on refusal paths.
    assert _acquire_batch_lock(bd) == 0
    _release_batch_lock(bd)


def test_digest_row_ids_two_pipes_in_title(tmp_path):
    """B1 (fold-4 review, Important): a title with TWO escaped pipes must
    still parse to the right cell count and the correct id — a plain
    `line.split("|")` would inflate the cell count to 10 and drop the row
    entirely (fold-4's bug)."""
    from sign_batch import _digest_row_ids
    text = (
        "| id | date | title | home | created org | kept/dropped | classification | exit |\n"
        "|---|---|---|---|---|---|---|---|\n"
        "| A | 2026-09-01 | a \\| b \\| c | h |  |  |  | 0 |\n"
    )
    assert _digest_row_ids(text) == {"A"}


def test_sign_batch_round_trip_with_write_digest_pipe_and_newline_titles(tmp_path):
    """B1 (fold-4 review, Important): a REAL backfill.write_digest round
    trip — one title containing a pipe ("Clearworks | Kadre sync") and one
    containing a newline — must still let sign_batch.main sign the real
    digest it produces. Before the pipe-safe fix, `_digest_row_ids`' plain
    `line.split("|")` would inflate the pipe-titled row's cell count past 8
    (the escaped `\\|` `_md_cell` writes for a literal pipe splits just
    like a real column separator) and silently drop id "A" from the
    parsed set, refusing "digest rows differ from progress" against a
    perfectly good, real digest.md."""
    import backfill
    import progress
    import sign_batch

    vault = tmp_path / "vault"
    bid = "fireflies-20260910T000000Z"
    bd = backfill.batch_dir(vault, bid)
    bd.mkdir(parents=True)

    manifest = {
        "batch_id": bid, "kind": "fireflies",
        "rows": [
            {"id": "A", "kind": "fireflies", "occurred_at": "2026-09-01T00:00:00Z",
             "title": "Clearworks | Kadre sync", "already_applied": False},
            {"id": "B", "kind": "fireflies", "occurred_at": "2026-09-02T00:00:00Z",
             "title": "Line one\nLine two", "already_applied": False},
        ],
    }
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    dry_run_row = {"exit": 0, "home": "clients/a.md", "rule": 2, "created": None,
                   "kept": {"decisions": 1, "commitments": 1, "open_questions": 0},
                   "dropped": {}, "classification": None, "cost_usd": 0.1}
    prog = {
        "batch_id": bid, "kind": "fireflies",
        "rows": {"fireflies:A": {"dry_run": dict(dry_run_row)}, "fireflies:B": {"dry_run": dict(dry_run_row)}},
    }

    for i in ("A", "B"):
        state = progress._state_dir(vault, "fireflies", i); state.mkdir(parents=True)
        (state / "dry-run.txt").write_text(GOOD, encoding="utf-8")
        env = vault / "raw/media/transcripts/fireflies" / i; env.mkdir(parents=True)
        (env / "source.sha256").write_text("a" * 64 + "\n", encoding="utf-8")
        (env / "extraction.json").write_text(json.dumps({"inputSha": "b" * 64}), encoding="utf-8")

    # The REAL production writer — builds digest.md/digest.sha256/sample/
    # for real, with _md_cell's real pipe/newline escaping.
    digest_path, sha, picked = backfill.write_digest(vault, bd, manifest, prog, status="complete")
    assert "\\|" in digest_path.read_text(encoding="utf-8")  # confirms the escaped-pipe row is actually on disk
    prog["sample_ids"] = picked
    (bd / "batch-progress.json").write_text(json.dumps(prog), encoding="utf-8")

    result = sign_batch.main(_args(vault, bd, bid))
    assert result == 0, result
    signed = json.loads((bd / "batch-signed.json").read_text(encoding="utf-8"))
    assert signed["signed_ids"] == ["A", "B"]


def test_sign_batch_empty_dry_run_dict_counts_as_unattempted(tmp_path, capsys):
    """B2 (fold-4 review, pinning B5): a progress row `"dry_run": {}`
    (present but empty — no `exit` key at all, exactly `backfill._row`'s
    pre-launch placeholder) is NOT attempted and must require
    --allow-partial the same way a row with no dry_run key at all does."""
    import sign_batch
    vault, bd, bid = _seed(tmp_path, ids=("A", "B"), unattempted=("C",))
    prog = json.loads((bd / "batch-progress.json").read_text(encoding="utf-8"))
    prog["rows"]["fireflies:C"] = {}  # present but empty, not absent
    (bd / "batch-progress.json").write_text(json.dumps(prog), encoding="utf-8")

    rc = sign_batch.main(_args(vault, bd, bid))
    assert rc == 1
    err = capsys.readouterr().err
    assert "batch is partial" in err and "--allow-partial" in err
    assert not (bd / "batch-signed.json").exists()

    rc2 = sign_batch.main(_args(vault, bd, bid) + ["--allow-partial"])
    assert rc2 == 0
    signed = json.loads((bd / "batch-signed.json").read_text(encoding="utf-8"))
    assert "C" in signed["unattempted_ids"]
