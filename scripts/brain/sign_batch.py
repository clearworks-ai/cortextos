#!/usr/bin/env python3
"""FR-016 batch D-09 sign-off (D-20). One human signature over a batch digest
authorizes `run_meeting.py --apply --backfill` for every exit-0 meeting in the
batch by stamping each meeting's own d09-signed.json through the shared
sign_marker writer — so `--apply`'s per-meeting binding is unchanged.

Refuses BEFORE writing anything, checked in this order: bad --batch (64);
manifest/progress binding to the batch (kind present, manifest+progress
batch_id == --batch, no row's kind prefix disagreeing with the batch's own
kind — task-9-review Minor #5: no silent "fireflies" default in a signing
tool); a halted/partial dry-run's unattempted manifest rows without
--allow-partial (G2 round-2 review P1 — a batch whose dry-run stopped early
on budget/auth is only reviewed on its successful prefix; signing it needs
an explicit opt-in, recorded as `partial`/`unattempted_count`/
`unattempted_ids` on batch-signed.json); signed_at not RFC3339 (task-9-review
Important #1: mirrors progress.validate_sign_marker's own acceptance rule
EXACTLY, so sign_batch never accepts a signature the R3 gate would later
reject at apply time — one typo must not fan out N markers that all get
rejected downstream); signer outside BRAIN_SIGNERS (spec G-112: sign_dry_run.py
never checked, validate_sign_marker did at apply time — a batch must not fan
out an invalid signature); digest sha mismatch; the digest's own `status:`
line disagreeing with the unattempted computation (a hand-edited digest or a
drifted batch-progress.json); the `sample` symlink not resolving to
`sample-<sha12>` for THIS digest; the sample/ directory listing not matching
the recorded sample_ids (CARRY-B: the listing is the authoritative review
surface — fail closed on any drift, including a shrunk or widened prog
sample_ids, rather than trust the recorded value); any sample file's bytes
differing from its meeting's own dry-run.txt (stale review); the sample count
not equal to min(10, candidate count); or any candidate capture missing an
FR-012 noun or phase-3 evidence (names the first failing file). Only after
every one of those passes does batch-signed.json get written, then markers."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import progress
from atomic import atomic_write
from backfill import BATCH_ID_RE, SOURCES, _acquire_batch_lock, _release_batch_lock, batch_dir
from paths import DEFAULT_VAULT, safe_meeting_id
from sign_marker import check_capture, write_marker


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Sign a backfill batch digest (D-20) and stamp per-meeting D-09 markers")
    p.add_argument("--batch", required=True)
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    p.add_argument("--signed-by", required=True)
    p.add_argument("--signed-at", required=True)
    p.add_argument("--digest", required=True, help="path to the reviewed digest.md")
    p.add_argument("--allow-partial", action="store_true",
                    help="sign a batch whose dry-run halted early (budget/auth), authorizing only the reviewed rows")
    args = p.parse_args(argv)

    if not BATCH_ID_RE.match(args.batch):
        print(f"invalid --batch {args.batch!r} (expected <kind>-YYYYMMDDTHHMMSSZ)", file=sys.stderr)
        return 64

    # M7: an absolute vault path so a relative --vault cannot leak a
    # cwd-dependent capture_path into a marker that validate_sign_marker
    # later resolves from a different cwd.
    vault = Path(args.vault).resolve()
    bd = batch_dir(vault, args.batch)

    # B2 (G2b r2 CH2-3) / mirrors backfill.py's A10: check manifest.json
    # exists BEFORE ever calling _acquire_batch_lock, which unconditionally
    # `mkdir(parents=True, exist_ok=True)`s bd — a typo'd --batch must not
    # leave an empty directory (or a stray .lock file) behind.
    if not (bd / "manifest.json").is_file():
        print(f"batch files unreadable: manifest.json not found in {bd}", file=sys.stderr)
        return 1

    # B2: hold the SAME batch flock backfill.py's dry-run/apply hold, for
    # the entire remainder of this run (every read, every check, the
    # batch-signed.json writes, the marker fan-out, the fanout_complete
    # rewrite) — two concurrent sign_batch.py/backfill.py invocations
    # against the same batch must never interleave.
    lock_rc = _acquire_batch_lock(bd)
    if lock_rc != 0:
        print(f"batch {args.batch} locked; retry later", file=sys.stderr)
        return 1
    try:
        return _sign_locked(args, vault, bd)
    finally:
        _release_batch_lock(bd)


def _sign_locked(args: argparse.Namespace, vault: Path, bd: Path) -> int:
    # Load files (read-only; nothing decided yet).
    try:
        manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
        prog = json.loads((bd / "batch-progress.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"batch files unreadable: {exc}", file=sys.stderr)
        return 1
    # M4 (Std 11): a hand-edited or corrupt batch dir must refuse cleanly,
    # never traceback — every dict-shaped access below assumes these two are
    # actually objects.
    if not isinstance(manifest, dict):
        print("manifest.json is not a JSON object", file=sys.stderr)
        return 1
    if not isinstance(prog, dict):
        print("batch-progress.json is not a JSON object", file=sys.stderr)
        return 1

    # M5: a signing tool must not silently default or trust an unbound batch
    # dir — refuse rather than default "kind" to "fireflies" or sign against
    # a manifest/progress ledger meant for a different batch.
    if "kind" not in manifest:
        print("manifest missing 'kind'", file=sys.stderr)
        return 1
    kind = str(manifest["kind"])
    # F14 (CH-8): a kind outside backfill.SOURCES must be refused before any
    # per-meeting path (progress._state_dir, marker_path) is built from it.
    if kind not in SOURCES:
        print(f"unknown kind: {kind!r} (not in {SOURCES})", file=sys.stderr)
        return 1
    if manifest.get("batch_id") != args.batch:
        print(f"manifest batch_id {manifest.get('batch_id')!r} != --batch {args.batch!r}", file=sys.stderr)
        return 1
    if prog.get("batch_id") != args.batch:
        print(f"batch-progress.json batch_id {prog.get('batch_id')!r} != --batch {args.batch!r}", file=sys.stderr)
        return 1

    # B3 (G2b r2 CH2-5): --batch's own id prefix (the kind token before the
    # first '-', e.g. "fireflies" in "fireflies-20260906T000000Z") must
    # match both manifest.kind and batch-progress.json's own "kind" field —
    # matching batch_id alone (checked above) does not prove the batch id
    # was ever actually MINTED for this kind.
    batch_kind_prefix = args.batch.split("-", 1)[0]
    if batch_kind_prefix != kind:
        print(f"--batch {args.batch!r} kind prefix {batch_kind_prefix!r} != manifest kind {kind!r}", file=sys.stderr)
        return 1
    if batch_kind_prefix != str(prog.get("kind") or ""):
        print(f"--batch {args.batch!r} kind prefix {batch_kind_prefix!r} != batch-progress.json kind {prog.get('kind')!r}", file=sys.stderr)
        return 1

    # F14/M4: every manifest row must be a real object with an id that
    # round-trips through safe_meeting_id (path-traversal-shaped ids, or ids
    # carrying a 'fireflies:' prefix, must never reach a path builder) —
    # checked BEFORE the candidates loop below ever builds a per-meeting
    # path from one of these ids.
    raw_rows = manifest.get("rows")
    if not isinstance(raw_rows, list):
        print("manifest.rows is not a list", file=sys.stderr)
        return 1
    for i, row in enumerate(raw_rows):
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            print(f"manifest.rows[{i}] is corrupt (missing id)", file=sys.stderr)
            return 1
        rid = row["id"]
        if safe_meeting_id(rid) != rid:
            print(f"manifest.rows[{i}] id not filesystem-safe: {rid!r}", file=sys.stderr)
            return 1

    # B4 (G2b r2 CH2-6): every row needs a non-empty, RFC3339-parseable
    # occurred_at and a kind matching the manifest's own kind — a row
    # missing either is not safely sortable/attributable, and the
    # canonical-order check right below would silently treat a missing
    # occurred_at as "" (sorts first) rather than refusing outright.
    for i, row in enumerate(raw_rows):
        occurred_at = row.get("occurred_at")
        if not isinstance(occurred_at, str) or not occurred_at.strip():
            print(f"manifest.rows[{i}] occurred_at missing or empty", file=sys.stderr)
            return 1
        try:
            datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
        except ValueError:
            print(f"manifest.rows[{i}] occurred_at is not RFC3339: {occurred_at!r}", file=sys.stderr)
            return 1
        if row.get("kind") != kind:
            print(f"manifest.rows[{i}] kind {row.get('kind')!r} != manifest kind {kind!r}", file=sys.stderr)
            return 1

    # F15 (CH-9): the manifest must be canonical — sorted by (occurred_at,
    # id), no duplicate ids — the same order `apply` walks; a hand-edited or
    # stale manifest that drifted from that order hides the drift from the
    # human digest review sign_batch is meant to authorize.
    canonical_keys = [(str(r.get("occurred_at") or ""), r["id"]) for r in raw_rows]
    if canonical_keys != sorted(canonical_keys) or len(set(k[1] for k in canonical_keys)) != len(canonical_keys):
        print("manifest not canonical; re-run list", file=sys.stderr)
        return 1

    # M4: a progress row that is not an object would otherwise raise
    # AttributeError inside the candidates loop below (`entry.get(...)`).
    raw_prog_rows = prog.get("rows")
    if raw_prog_rows is not None and not isinstance(raw_prog_rows, dict):
        print("batch-progress.json rows is not an object", file=sys.stderr)
        return 1
    for row_key, entry in (raw_prog_rows or {}).items():
        if not isinstance(entry, dict):
            print(f"progress row {row_key!r} is not an object", file=sys.stderr)
            return 1

    # G2 r2 P1 (Codex round-2 review): a dry-run that halted early (exit 12
    # budget, exit 2 auth) leaves manifest rows with no real `dry_run` dict
    # in batch-progress.json at all — signing that batch signs a PARTIALLY
    # reviewed set. This is disclosed on the digest (`status: partial
    # (budget|auth)` + `unattempted: N`, backfill.write_digest) and
    # signed_ids binds exactly the reviewed rows, so it is not silent — but
    # FR-015's letter is "dry-run every pending meeting", so partial sign-off
    # is now an explicit, recorded opt-in rather than a side effect of
    # whatever happened to be in batch-progress.json. Same definition
    # backfill's own digest header uses: every non-already_applied manifest
    # row whose progress row carries no real `dry_run` dict.
    prog_rows_map = raw_prog_rows or {}
    unattempted_ids: list[str] = [
        row["id"] for row in raw_rows
        if not row.get("already_applied")
        and not isinstance((prog_rows_map.get(f"{kind}:{row['id']}") or {}).get("dry_run"), dict)
    ]
    if unattempted_ids and not args.allow_partial:
        preview = ", ".join(unattempted_ids[:3])
        print(
            f"batch is partial: {len(unattempted_ids)} unattempted rows ({preview}...); "
            "re-run dry-run, or pass --allow-partial to sign only the reviewed rows",
            file=sys.stderr,
        )
        return 1

    # I1 (task-9-review Important #1): mirror progress.validate_sign_marker's
    # OWN acceptance rule for signed_at EXACTLY (progress.py ~L180-186) so
    # sign_batch never accepts a value the R3 gate rejects at apply time.
    try:
        datetime.fromisoformat(args.signed_at.replace("Z", "+00:00"))
    except ValueError:
        print(f"signed_at is not RFC3339: {args.signed_at}", file=sys.stderr)
        return 1

    if args.signed_by not in progress._signer_allowlist():
        print(f"signer not in allowlist: {args.signed_by}", file=sys.stderr)
        return 1

    digest = Path(args.digest)
    if not digest.is_file():
        print(f"digest not found: {digest}", file=sys.stderr)
        return 1
    expected = (bd / "digest.sha256").read_text(encoding="utf-8").strip() if (bd / "digest.sha256").is_file() else ""
    actual = hashlib.sha256(digest.read_bytes()).hexdigest()
    if not expected or actual != expected:
        print(f"digest sha256 mismatch: digest.md={actual} digest.sha256={expected or '(missing)'}", file=sys.stderr)
        return 1

    # G2 r2 P1: cross-check the digest's own `status: complete|partial (...)`
    # line (backfill.write_digest) against the unattempted computation
    # above — a hand-edited digest or a batch-progress.json that drifted
    # from what was actually reviewed must not silently sign.
    digest_status_match = re.search(r"^status: (.+)$", digest.read_text(encoding="utf-8"), re.MULTILINE)
    digest_status = digest_status_match.group(1).strip() if digest_status_match else ""
    digest_says_complete = digest_status == "complete"
    digest_says_partial = digest_status.startswith("partial")
    if (digest_says_complete and unattempted_ids) or (digest_says_partial and not unattempted_ids):
        print("digest status disagrees with progress; re-run dry-run", file=sys.stderr)
        return 1

    # sample/ must be the symlink write_digest made, bound to THIS digest.
    link = bd / "sample"
    sha12 = actual[:12]
    if not link.is_symlink() or os.readlink(link) != f"sample-{sha12}":
        target = os.readlink(link) if link.is_symlink() else "not a symlink"
        print(f"sample dir does not match the digest: {link} -> {target} (expected sample-{sha12}); re-run dry-run", file=sys.stderr)
        return 1

    # Candidates = manifest rows (not already applied) ∩ progress rows with a
    # REAL dry_run dict and exit == 0 (CARRY-C: a legacy phantom `{}` row has
    # no `dry_run` key at all and must never be signed) — a stale or injected
    # progress row outside the manifest never receives a marker either.
    manifest_ids = {str(r["id"]) for r in manifest.get("rows") or [] if not r.get("already_applied")}
    candidates: list[tuple[str, Path]] = []
    for key, entry in sorted((prog.get("rows") or {}).items()):
        # M5: a progress row keyed for a different kind than this batch's own
        # kind is ledger corruption, not a row to silently skip — refuse the
        # whole batch rather than sign around it.
        prefix, sep, mid = key.partition(":")
        if not sep or prefix != kind:
            print(f"progress row {key!r} kind prefix != batch kind {kind!r}", file=sys.stderr)
            return 1
        dr = entry.get("dry_run")
        if not isinstance(dr, dict) or dr.get("exit") != 0:
            continue
        if mid not in manifest_ids:
            continue
        candidates.append((mid, progress._state_dir(vault, kind, mid) / "dry-run.txt"))
    by_id = dict(candidates)
    candidate_ids = set(by_id)

    # CARRY-B: the sample/ DIRECTORY LISTING is the authoritative review
    # surface, not the recorded sample_ids — but any drift between them
    # (including prog.sample_ids being a strict subset of the listing, e.g.
    # from Task 8 reuse) still refuses fail-closed; the operator re-runs
    # dry-run rather than have sign_batch silently prefer one over the other.
    files = sorted(link.glob("*.txt"))
    listing_ids = sorted(f.stem for f in files)
    sample_ids = sorted(str(s) for s in (prog.get("sample_ids") or []))

    if candidates and not files:
        print("sample/ is empty although exit-0 meetings exist; re-run dry-run", file=sys.stderr)
        return 1
    if listing_ids != sample_ids:
        print(f"sample/ files {listing_ids} != recorded sample_ids {sample_ids}", file=sys.stderr)
        return 1
    if not set(listing_ids) <= candidate_ids:
        print(f"sample/ contains non-candidate ids: {sorted(set(listing_ids) - candidate_ids)}", file=sys.stderr)
        return 1

    # Stale review: every sampled file's bytes must equal its meeting's own
    # dry-run.txt bytes right now — a sample reviewed once, then re-run, must
    # not be signable against the old capture.
    for sample in files:
        sid = sample.stem
        state_capture = by_id[sid]
        if not state_capture.is_file() or state_capture.read_bytes() != sample.read_bytes():
            print(f"sample stale: {sample} differs from its meeting's dry-run.txt (re-run dry-run)", file=sys.stderr)
            return 1

    # D-20: ten sampled captures (all when fewer) — the size is part of the
    # contract; checked against the RECORDED sample_ids (equal to the listing
    # by this point) so a shrunk-after-the-fact sample_ids still refuses here
    # even when the listing itself was never touched.
    expected_n = min(10, len(candidates))
    if len(sample_ids) != expected_n:
        print(f"sample/ must hold exactly {expected_n} exit-0 captures (found {len(sample_ids)})", file=sys.stderr)
        return 1

    # Every candidate capture (not just the sampled subset) must carry the
    # FR-012 nouns and phase-3 evidence before any write — names the first
    # failing file.
    for mid, capture in candidates:
        if not capture.is_file():
            print(f"capture missing: {capture}", file=sys.stderr)
            return 1
        missing, phase3_missing = check_capture(capture.read_text(encoding="utf-8"))
        if missing or phase3_missing:
            print(f"capture incomplete: {capture} missing {missing + phase3_missing}", file=sys.stderr)
            return 1

    # Every check passed — now write. batch-signed.json first, then markers.
    # F2 addendum (CH-5/CH-6): fanout_complete starts false — apply's
    # preflight (backfill.py, Agent A) must never authorize against a batch
    # whose fan-out is only partially written (a crash mid-loop below would
    # otherwise leave batch-signed.json looking fully signed while some
    # candidate markers are still missing).
    signed = {
        "batch_id": args.batch,
        "digest_sha256": actual,
        "manifest_sha256": hashlib.sha256((bd / "manifest.json").read_bytes()).hexdigest(),
        "signed_ids": [mid for mid, _ in candidates],
        "sample_ids": listing_ids,  # CARRY-B: the directory listing, not prog.sample_ids
        "meeting_count": len(candidates),
        "signed_by": args.signed_by,
        "signed_at": args.signed_at,
        "partial": bool(unattempted_ids),
        "unattempted_count": len(unattempted_ids),
        "unattempted_ids": sorted(unattempted_ids),
        "fanout_complete": False,
        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    atomic_write(bd / "batch-signed.json", (json.dumps(signed, sort_keys=True, indent=2) + "\n").encode("utf-8"))
    written = 0
    for mid, capture in candidates:
        try:
            rc, _marker, message = write_marker(
                vault, kind, mid, capture, signed_by=args.signed_by, signed_at=args.signed_at,
                extra={"batch_id": args.batch, "digest_sha256": actual},
            )
        except OSError as exc:
            # M3: batch-signed.json is already on disk by design (Task 10
            # diffs signed_ids against markers to find exactly what's
            # missing) — report how far the fan-out got before failing.
            print(f"signed: {written}/{len(candidates)} markers written before failure at {kind}-{mid}: {exc}", file=sys.stderr)
            return 1
        if rc != 0:  # cannot happen after the checks above; keep the contract honest
            print(f"signed: {written}/{len(candidates)} markers written before failure at {kind}-{mid}: {message}", file=sys.stderr)
            return 1
        written += 1
    # F2 addendum: every candidate marker landed — atomically flip
    # fanout_complete true and record how many, so apply's preflight can
    # trust this file alone rather than re-deriving completeness from the
    # marker files on disk.
    signed["fanout_complete"] = True
    signed["markers_written"] = written
    atomic_write(bd / "batch-signed.json", (json.dumps(signed, sort_keys=True, indent=2) + "\n").encode("utf-8"))
    print(f"signed: {written} markers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
