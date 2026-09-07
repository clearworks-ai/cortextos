# scripts/brain/tests/test_sign_batch.py
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

BRAIN = Path(__file__).resolve().parents[1]
if str(BRAIN) not in sys.path:
    sys.path.insert(0, str(BRAIN))

GOOD = ("home=clients/a.md node=none rule=2\n--- a/x\nquotes kept decisions=1 commitments=1 open_questions=0\n"
        "tasks:\nsubject: Recap\nphase3-preview: v1\nwould-touch: STATE.md\nwould-write: skip: no-engagement\nwould-file: X\n")


def _seed(tmp_path: Path, ids=("A", "B", "C"), bad=(), failed=(), extra_progress_ids=()):
    import backfill, progress
    vault = tmp_path / "vault"
    bid = "fireflies-20260906T000000Z"
    bd = backfill.batch_dir(vault, bid); bd.mkdir(parents=True)
    rows = {f"fireflies:{i}": {"dry_run": {"exit": 0 if i not in failed else 3}} for i in (*ids, *extra_progress_ids)}
    (bd / "manifest.json").write_text(json.dumps({"batch_id": bid, "kind": "fireflies", "rows": [{"id": i, "kind": "fireflies"} for i in ids]}), encoding="utf-8")
    (bd / "batch-progress.json").write_text(json.dumps({"batch_id": bid, "kind": "fireflies", "rows": rows, "sample_ids": [i for i in ids if i not in failed]}), encoding="utf-8")
    (bd / "digest.md").write_text("# digest\n", encoding="utf-8")
    sha = hashlib.sha256(b"# digest\n").hexdigest()
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
    assert signed["batch_id"] == bid and signed["digest_sha256"] == hashlib.sha256(b"# digest\n").hexdigest()
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
    vault, bd, bid = _seed(tmp_path)
    # F15 (CH-9): appended in (occurred_at, id) canonical order — Y before Z
    # — so this fixture's own manifest stays canonical; only the base ids
    # (A, B, C) plus these two phantoms are under test here, not ordering.
    manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
    manifest["rows"].append({"id": "Y", "kind": "fireflies"})
    manifest["rows"].append({"id": "Z", "kind": "fireflies"})
    (bd / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    prog = json.loads((bd / "batch-progress.json").read_text(encoding="utf-8"))
    prog["rows"]["fireflies:Z"] = {}
    prog["rows"]["fireflies:Y"] = {"dry_run": None}
    (bd / "batch-progress.json").write_text(json.dumps(prog), encoding="utf-8")
    assert sign_batch.main(_args(vault, bd, bid)) == 0
    signed = json.loads((bd / "batch-signed.json").read_text(encoding="utf-8"))
    assert "Z" not in signed["signed_ids"] and "Y" not in signed["signed_ids"]
    assert signed["meeting_count"] == 3
    assert not marker_path(vault, "fireflies", "Z").exists()
    assert not marker_path(vault, "fireflies", "Y").exists()


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
    manifest["rows"].append({"id": "C", "kind": "fireflies"})  # duplicate of the existing C row
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
