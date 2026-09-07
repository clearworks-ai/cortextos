#!/usr/bin/env python3
"""FR-016 batch D-09 sign-off (D-20). One human signature over a batch digest
authorizes `run_meeting.py --apply --backfill` for every exit-0 meeting in the
batch by stamping each meeting's own d09-signed.json through the shared
sign_marker writer — so `--apply`'s per-meeting binding is unchanged.

Refuses BEFORE writing anything, checked in this order: bad --batch (64);
signer outside BRAIN_SIGNERS (spec G-112: sign_dry_run.py itself never
checked, validate_sign_marker did at apply time — a batch must not fan out an
invalid signature); digest sha mismatch; the `sample` symlink not resolving to
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
import sys
from datetime import datetime, timezone
from pathlib import Path

import progress
from atomic import atomic_write
from backfill import BATCH_ID_RE, batch_dir
from paths import DEFAULT_VAULT
from sign_marker import check_capture, write_marker


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Sign a backfill batch digest (D-20) and stamp per-meeting D-09 markers")
    p.add_argument("--batch", required=True)
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    p.add_argument("--signed-by", required=True)
    p.add_argument("--signed-at", required=True)
    p.add_argument("--digest", required=True, help="path to the reviewed digest.md")
    args = p.parse_args(argv)

    if not BATCH_ID_RE.match(args.batch):
        print(f"invalid --batch {args.batch!r} (expected <kind>-YYYYMMDDTHHMMSSZ)", file=sys.stderr)
        return 64

    vault = Path(args.vault)
    bd = batch_dir(vault, args.batch)

    # Load files (read-only; nothing decided yet).
    try:
        manifest = json.loads((bd / "manifest.json").read_text(encoding="utf-8"))
        prog = json.loads((bd / "batch-progress.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"batch files unreadable: {exc}", file=sys.stderr)
        return 1
    kind = str(manifest.get("kind") or "fireflies")

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
        dr = entry.get("dry_run")
        if not isinstance(dr, dict) or dr.get("exit") != 0:
            continue
        mid = key.split(":", 1)[1]
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
    signed = {
        "batch_id": args.batch,
        "digest_sha256": actual,
        "manifest_sha256": hashlib.sha256((bd / "manifest.json").read_bytes()).hexdigest(),
        "signed_ids": [mid for mid, _ in candidates],
        "sample_ids": listing_ids,  # CARRY-B: the directory listing, not prog.sample_ids
        "meeting_count": len(candidates),
        "signed_by": args.signed_by,
        "signed_at": args.signed_at,
        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    atomic_write(bd / "batch-signed.json", (json.dumps(signed, sort_keys=True, indent=2) + "\n").encode("utf-8"))
    written = 0
    for mid, capture in candidates:
        rc, _marker, message = write_marker(
            vault, kind, mid, capture, signed_by=args.signed_by, signed_at=args.signed_at,
            extra={"batch_id": args.batch, "digest_sha256": actual},
        )
        if rc != 0:  # cannot happen after the checks above; keep the contract honest
            print(f"marker write failed for {kind}:{mid}: {message}", file=sys.stderr)
            return 1
        written += 1
    print(f"signed: {written} markers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
