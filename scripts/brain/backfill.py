#!/usr/bin/env python3
"""FR-015 backfill lister + batch runner (spec v1.13, D-19/D-20/D-22).

  backfill.py --source fireflies list [--since YYYY-MM-DD] [--until YYYY-MM-DD]
  backfill.py --source fireflies --batch <batch_id> dry-run [--max-usd 150]
  backfill.py --source fireflies --batch <batch_id> apply

Writes only under <vault>/raw/media/transcripts/_backfill/<batch_id>/ and the
per-meeting envelope/_state dirs; every org-brain write flows through
run_meeting.py. Batch state is batch-progress.json keyed "<kind>:<id>" with
separate `dry_run` / `apply` objects (G-110); per-meeting progress.json is
never written here."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import brain_rollup
import progress
import run_meeting
from atomic import atomic_write
from fetch_fireflies import _load_api_key as load_api_key
from fetch_fireflies import fetch_error_path
from fetch_fireflies import list_transcripts  # module attribute: test seam
from paths import DEFAULT_REPO_ROOT, DEFAULT_VAULT, envelope_dir, safe_meeting_id
from run_meeting import main as run_meeting_main  # module attribute: test seam

SOURCES = ("fireflies",)  # R5 (FR-017) generalizes to fetch_<kind>.py dispatch
# Batch ids are produced by _batch_id(); anything else is refused before it touches a path (G0b-11).
BATCH_ID_RE = re.compile(r"^[a-z][a-z0-9]{0,15}-\d{8}T\d{6}Z$")
DEFAULT_MAX_USD = 150.0


def batch_root(vault: Path) -> Path:
    return Path(vault) / "raw/media/transcripts/_backfill"


def batch_dir(vault: Path, batch_id: str) -> Path:
    return batch_root(vault) / batch_id


def _batch_id(kind: str) -> str:
    return f"{kind}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_from_epoch_ms(value: Any) -> str | None:
    try:
        ms = int(value)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")


def _applied(vault: Path, kind: str, meeting_id: str) -> bool:
    path = progress.receipt_path(vault, kind, meeting_id)
    if not path.is_file():
        return False
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(doc, dict) and bool(doc.get("vault_sha"))


def build_manifest(rows: list[dict[str, Any]], *, vault: Path, kind: str, since: str | None, until: str | None) -> list[dict[str, Any]]:
    """API rows → manifest rows. An id that fails `safe_meeting_id` (traversal-shaped
    or otherwise unsafe) is dropped and counted in `build_manifest.invalid` — it must
    never reach a `_state`/envelope/sample path (G0b r2 N2). A row with a missing or
    unparseable `date` is dropped and counted in `build_manifest.skipped_no_date`
    (task-6 review finding 1) rather than vanishing silently. A repeated id (skip/limit
    paging can return the same transcript twice across pages) keeps only the first
    occurrence and is counted in `build_manifest.duplicates` (finding 3)."""
    out: list[dict[str, Any]] = []
    invalid = 0
    skipped_no_date = 0
    duplicates = 0
    seen: set[str] = set()
    for r in rows:
        mid = safe_meeting_id(str(r.get("id") or ""))
        if not mid or mid != str(r.get("id")):
            invalid += 1
            continue
        row_id = str(r["id"])
        if row_id in seen:
            duplicates += 1
            continue
        seen.add(row_id)
        occurred_at = _iso_from_epoch_ms(r.get("date"))
        if occurred_at is None:
            skipped_no_date += 1
            continue
        day = occurred_at[:10]
        if since and day < since:
            continue
        if until and day > until:
            continue
        duration = r.get("duration")
        participants = r.get("participants") or []
        out.append({
            "kind": kind,
            "id": row_id,
            "title": str(r.get("title") or ""),
            "occurred_at": occurred_at,
            "duration_s": int(round(float(duration) * 60)) if isinstance(duration, (int, float)) else None,
            "participant_count": len(participants) if isinstance(participants, list) else 0,
            "already_applied": _applied(vault, kind, row_id),
        })
    out.sort(key=lambda row: (row["occurred_at"], row["id"]))
    build_manifest.invalid = invalid  # type: ignore[attr-defined]
    build_manifest.skipped_no_date = skipped_no_date  # type: ignore[attr-defined]
    build_manifest.duplicates = duplicates  # type: ignore[attr-defined]
    return out


def _write_json(path: Path, doc: Any) -> None:
    atomic_write(path, (json.dumps(doc, sort_keys=True, indent=2) + "\n").encode("utf-8"))


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def cmd_list(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    api_key = load_api_key(Path(args.repo_root))
    if not api_key:
        print("missing FIREFLIES_API_KEY", file=sys.stderr)
        return 2
    rows = list_transcripts(api_key, throttle_s=args.rate)
    manifest_rows = build_manifest(rows, vault=vault, kind=args.source, since=args.since, until=args.until)
    batch_id = _batch_id(args.source)
    doc = {"batch_id": batch_id, "kind": args.source, "created_at": _now(),
           "since": args.since, "until": args.until, "rows": manifest_rows}
    _write_json(batch_dir(vault, batch_id) / "manifest.json", doc)
    applied = sum(1 for r in manifest_rows if r["already_applied"])
    print(f"manifest: {len(manifest_rows)} total, {applied} already applied, {len(manifest_rows) - applied} pending")
    if getattr(build_manifest, "invalid", 0):
        print(f"invalid ids skipped: {build_manifest.invalid}", file=sys.stderr)
    if getattr(build_manifest, "skipped_no_date", 0):
        print(f"rows skipped (no date): {build_manifest.skipped_no_date}", file=sys.stderr)
    if getattr(build_manifest, "duplicates", 0):
        print(f"duplicate ids skipped: {build_manifest.duplicates}", file=sys.stderr)
    print(f"batch: {batch_id}")
    return 0


_DATE_ARG_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _date_arg(value: str) -> str:
    """argparse `type=` for --since/--until (task-6 review finding 2): reject anything
    that is not a real, strictly zero-padded YYYY-MM-DD date before it reaches the
    lexical day-string compare in `build_manifest`, or before it is recorded verbatim
    in the manifest. `datetime.strptime` alone accepts non-zero-padded values like
    "2025-9-2" (`%m`/`%d` are lenient), which would corrupt the lexical compare, so the
    regex enforces the exact shape and strptime enforces a real calendar date.
    Argparse turns `ArgumentTypeError` into a usage message on stderr and
    `SystemExit(2)`."""
    if not _DATE_ARG_RE.match(value):
        raise argparse.ArgumentTypeError(f"invalid date {value!r} (expected YYYY-MM-DD)")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid date {value!r} (expected YYYY-MM-DD)") from exc
    return value


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="FR-015 backfill lister + batch runner")
    p.add_argument("--source", default="fireflies")
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    p.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))
    p.add_argument("--batch")
    p.add_argument("--rate", type=float, default=2.0, help="seconds between list pages (A-08)")
    sub = p.add_subparsers(dest="command", required=True)
    s_list = sub.add_parser("list")
    s_list.add_argument("--since", type=_date_arg)
    s_list.add_argument("--until", type=_date_arg)
    s_dry = sub.add_parser("dry-run")
    s_dry.add_argument("--max-usd", type=float, default=DEFAULT_MAX_USD)
    sub.add_parser("apply")
    args = p.parse_args(argv)

    if args.source not in SOURCES:
        print(f"unsupported --source {args.source!r} (R4 supports: {', '.join(SOURCES)})", file=sys.stderr)
        return 64
    if args.command == "list":
        return cmd_list(args)
    if not args.batch:
        print(f"{args.command} requires --batch <batch_id>", file=sys.stderr)
        return 64
    if not BATCH_ID_RE.match(args.batch):
        print(f"invalid --batch {args.batch!r} (expected <kind>-YYYYMMDDTHHMMSSZ)", file=sys.stderr)
        return 64
    if args.command == "dry-run":
        return cmd_dry_run(args)
    return cmd_apply(args)


# The status preview body carries `**Classification:** GOOD|MIXED|BAD` (status_plan.ts
# via would-write-body); a capture with no status writer (skip: no-engagement) has none → null.
CLASSIFICATION_RE = re.compile(r"\*\*Classification:\*\*\s*([A-Za-z]+)")


def _progress_path(bd: Path) -> Path:
    return bd / "batch-progress.json"


def _load_batch(vault: Path, batch_id: str) -> tuple[Path, dict[str, Any], dict[str, Any]] | None:
    """Returns None (never raises) when manifest.json is missing/invalid — callers
    print + return 64, consistent with every other refusal in this module (review I4)."""
    bd = batch_dir(vault, batch_id)
    manifest = _read_json(bd / "manifest.json", None)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("rows"), list):
        return None
    prog = _read_json(_progress_path(bd), {})
    if not isinstance(prog, dict):
        prog = {}
    prog.setdefault("batch_id", batch_id)
    prog.setdefault("kind", manifest.get("kind"))
    prog.setdefault("rows", {})
    return bd, manifest, prog


def _save_batch(bd: Path, prog: dict[str, Any]) -> None:
    _write_json(_progress_path(bd), prog)


def _row(prog: dict[str, Any], kind: str, meeting_id: str) -> dict[str, Any]:
    return prog["rows"].setdefault(f"{kind}:{meeting_id}", {})


def _run_dry_capture(meeting_id: str, vault: Path, repo: Path) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            rc = int(run_meeting_main(["--meeting-id", meeting_id, "--dry-run", "--vault", str(vault), "--repo-root", str(repo)]))
        except SystemExit as exc:  # argparse or explicit SystemExit inside the loop
            rc = int(exc.code or 0) if isinstance(exc.code, int) or exc.code is None else 1
        except Exception:  # review I3: a crash is not an auth stop — record the row (with its
            err.write(traceback.format_exc())  # spend intact) and let the batch continue past it
            rc = 1
    return rc, out.getvalue(), err.getvalue()


def _extraction_stamp(vault: Path, kind: str, meeting_id: str) -> str:
    doc = _read_json(envelope_dir(vault, kind, meeting_id) / "extraction.json", {})
    return str(doc.get("extracted_at") or "") if isinstance(doc, dict) else ""


def _dry_run_record(vault: Path, kind: str, meeting_id: str, rc: int, capture: str, stamp_before: str,
                     elapsed: float, *, prior_cost: float = 0.0, attempts: int = 1) -> dict[str, Any]:
    env = envelope_dir(vault, kind, meeting_id)
    resolution = _read_json(env / "resolution.json", {}) if rc == 0 else {}
    validated = _read_json(env / "validated.json", {}) if rc == 0 else {}
    extraction = _read_json(env / "extraction.json", {})
    kept = {k: len(validated.get(k) or []) for k in ("decisions", "commitments", "open_questions")}
    cost = float(extraction.get("cost_usd") or 0.0) if isinstance(extraction, dict) else 0.0
    extracted_at = str(extraction.get("extracted_at") or "") if isinstance(extraction, dict) else ""
    # Charge only when THIS attempt produced the extraction (G0b-5): a retry after a
    # later-stage failure finds extract_meeting's inputSha short-circuit — no new spend.
    reused = bool(extracted_at) and extracted_at == stamp_before
    m = CLASSIFICATION_RE.search(capture or "")
    rec: dict[str, Any] = {
        "exit": rc,
        "home": resolution.get("home_path") if isinstance(resolution, dict) else None,
        "rule": resolution.get("rule") if isinstance(resolution, dict) else None,
        "created": resolution.get("created") if isinstance(resolution, dict) else None,
        "kept": kept,
        "dropped": validated.get("dropped") if isinstance(validated, dict) else None,
        "classification": m.group(1) if m else None,
        "capture_sha256": hashlib.sha256(capture.encode("utf-8")).hexdigest() if capture else None,
        # review C1: "retry adds, never replaces" — this attempt's ledger contribution
        # accumulates onto whatever was already recorded for this row, it never resets.
        "cost_usd": prior_cost + (0.0 if reused else cost),
        "cost_reused": reused,
        "attempts": attempts,
        "elapsed_s": round(elapsed, 3),
        "at": _now(),
    }
    fe = _read_json(fetch_error_path(vault, kind, meeting_id), None)
    if rc != 0 and isinstance(fe, dict):
        rec["fetch_error"] = fe
    elif rc == 2:
        # FR-017 (G-125): argparse/usage exits are 2 with no file — never auth, never a batch stop.
        rec["fetch_error"] = {"class": "usage", "synthesized": True, "message": "exit 2 without fetch-error.json"}
    return rec


SAMPLE_SIZE = 10


def _md_cell(value: Any) -> str:
    return str("" if value is None else value).replace("|", "\\|").replace("\n", " ")


def write_digest(vault: Path, bd: Path, manifest: dict[str, Any], prog: dict[str, Any],
                  status: str = "complete") -> tuple[Path, str, list[str]]:
    """D-20 human review surface: `digest.md` (one row per meeting), `digest.sha256`
    (hex sha256 of digest.md bytes), and a seeded `sample/` of up to SAMPLE_SIZE
    exit-0 dry-run captures for spot-checking before sign-off. `vault` is passed
    explicitly rather than derived from `bd` (`bd.parents[1]` would land in
    `<vault>/raw/media/transcripts`, not the vault root). `status` (task-8-review
    Important #2) is caller-supplied — "complete" on the normal end-of-loop exit,
    "partial (budget)" / "partial (auth)" on the two halt paths — so a partial
    digest can never be mistaken for a finished batch on the D-20 signed surface."""
    kind = str(manifest.get("kind") or prog.get("kind") or "fireflies")
    by_id = {str(r["id"]): r for r in manifest["rows"]}
    lines = [f"# Backfill digest — {prog['batch_id']}", ""]
    rows_out: list[str] = []
    ok = failed = 0
    spent = 0.0
    for key in sorted(prog["rows"], key=lambda k: (by_id.get(k.split(":", 1)[1], {}).get("occurred_at") or "", k)):
        dr_raw = prog["rows"][key].get("dry_run")
        if not isinstance(dr_raw, dict):
            # _row() (cmd_dry_run) setdefaults an empty {} entry for the NEXT meeting as a
            # side effect before the pre-launch budget check can halt the loop — a halted/
            # resumed batch must not render that untouched placeholder as a fake "failed" row.
            continue
        mid = key.split(":", 1)[1]
        dr = dr_raw
        m = by_id.get(mid, {})
        kept = dr.get("kept") or {}
        dropped = dr.get("dropped") or {}
        created = dr.get("created")
        created_cell = created.get("slug") if isinstance(created, dict) else (created or "")
        home_cell = f"{dr.get('home')} (rule {dr.get('rule')})" if dr.get("home") else ""
        kd = f"kept d{kept.get('decisions', 0)}/c{kept.get('commitments', 0)}/q{kept.get('open_questions', 0)} · dropped d{(dropped or {}).get('decisions', 0)}/c{(dropped or {}).get('commitments', 0)}/q{(dropped or {}).get('open_questions', 0)}"
        rows_out.append("| " + " | ".join(_md_cell(v) for v in (
            mid, (m.get("occurred_at") or "")[:10], m.get("title"), home_cell, created_cell, kd,
            dr.get("classification"), dr.get("exit"))) + " |")
        spent += float(dr.get("cost_usd") or 0.0)
        if dr.get("exit") == 0:
            ok += 1
        else:
            failed += 1
    # task-8-review Important #2: a partial batch (halted on budget/auth) must not read
    # like a finished one — manifest is the batch's full row count regardless of how many
    # were actually attempted; unattempted is derived, never independently tracked, so it
    # can't drift from ok/failed; status is caller-supplied, never inferred here.
    # task-8-review carry (CARRY-A): already-applied rows are never attempted this run
    # (cmd_dry_run skips them outright) — count them separately as `applied` and subtract
    # from `unattempted`, so an all-attempted batch with live-applied rows still reads
    # `status: complete · unattempted: 0` instead of a false-partial-looking count.
    manifest_n = len(manifest.get("rows") or [])
    applied = sum(1 for r in manifest.get("rows") or [] if r.get("already_applied"))
    lines += [f"kind: {kind} · manifest: {manifest_n} · applied: {applied} · meetings: {ok + failed} · ok: {ok} · "
              f"failed: {failed} · unattempted: {manifest_n - applied - (ok + failed)} · cost_usd: {spent:.2f}",
              f"status: {status}", "",
              "| id | date | title | home | created org | kept/dropped | classification | exit |",
              "|---|---|---|---|---|---|---|---|", *rows_out, ""]
    digest_path = bd / "digest.md"
    data = "\n".join(lines).encode("utf-8")
    sha = hashlib.sha256(data).hexdigest()

    # task-8-review Important #3: an exit-0 row whose dry-run.txt is missing (never
    # written, or lost after the fact) must be dropped BEFORE the seeded pick, not after —
    # otherwise `picked`/`sample_ids`/the stdout count can name a file that was never
    # written, and Task 9's sign-off would validate against a sample it doesn't have.
    exit0_ids = sorted(k.split(":", 1)[1] for k, v in prog["rows"].items() if (v.get("dry_run") or {}).get("exit") == 0)
    eligible: list[str] = []
    for mid in exit0_ids:
        if (progress._state_dir(vault, kind, mid) / "dry-run.txt").is_file():
            eligible.append(mid)
        else:
            print(f"sample: skipped {mid} (no dry-run.txt)", file=sys.stderr)
    picked = sorted(random.Random(prog["batch_id"]).sample(eligible, min(SAMPLE_SIZE, len(eligible)))) if eligible else []
    # Review surface = a fully written, digest-versioned directory `sample-<sha12>/`
    # made visible by ONE atomic rename of a symlink `sample -> sample-<sha12>`
    # (G0b-12/15, G0a-9): there is never a moment with a digest but no complete
    # sample/, and sign_batch binds the symlink target to the digest sha.
    versioned = bd / f"sample-{sha[:12]}"
    link = bd / "sample"
    # Build in a temp sibling and rename INTO place; never delete a directory the
    # published symlink may point at (G0b r3): an unchanged digest reuses its dir.
    if not versioned.exists():
        build = bd / f"sample-{sha[:12]}.tmp-{os.getpid()}"
        if build.exists():
            shutil.rmtree(build)
        build.mkdir(parents=True)
        for mid in picked:
            src = progress._state_dir(vault, kind, mid) / "dry-run.txt"
            if src.is_file():
                atomic_write(build / f"{mid}.txt", src.read_bytes())
        os.replace(build, versioned)
    if link.exists() and not link.is_symlink():  # pre-versioning layout: move it aside, then remove
        legacy = bd / f"sample.legacy-{os.getpid()}"
        os.replace(link, legacy)
        shutil.rmtree(legacy)
    tmp_link = bd / f"sample.link-{os.getpid()}"
    if tmp_link.is_symlink() or tmp_link.exists():
        tmp_link.unlink()
    os.symlink(versioned.name, tmp_link)
    os.replace(tmp_link, link)  # atomic symlink swap
    # digest.md + digest.sha256 are written LAST: a matching sidecar implies the versioned sample dir it names is complete.
    atomic_write(digest_path, data)
    atomic_write(bd / "digest.sha256", (sha + "\n").encode("utf-8"))
    # task-8-review Minor #2/#3: prune AFTER the sidecar is published, not before — pruning
    # first left a crash window where digest.sha256 could point at an already-deleted dir.
    # Also sweep orphaned `sample-*.tmp-*` build dirs here (crash-left, any pid): once the
    # current versioned dir + sidecar exist, nothing else under `sample-*` can still be needed.
    for old in bd.glob("sample-*"):
        if old.is_dir() and old.name != versioned.name:
            shutil.rmtree(old)
    return digest_path, sha, picked


def _finish_digest(vault: Path, bd: Path, manifest: dict[str, Any], prog: dict[str, Any],
                    status: str = "complete") -> tuple[Path, str, list[str]]:
    """Called on every cmd_dry_run exit path (0, 2, 12) so a partial batch — halted
    on an auth error or a budget cap — still leaves a reviewable digest + sample
    behind, not just a batch-progress.json. `status` is forwarded to write_digest
    verbatim (task-8-review Important #2)."""
    digest_path, sha, picked = write_digest(vault, bd, manifest, prog, status=status)
    prog["digest_sha256"] = sha
    prog["sample_ids"] = picked
    _save_batch(bd, prog)
    print(f"digest: {digest_path} sha256 {sha} sample {len(picked)}")
    return digest_path, sha, picked


def cmd_dry_run(args: argparse.Namespace) -> int:
    vault, repo, kind = Path(args.vault), Path(args.repo_root), args.source
    loaded = _load_batch(vault, args.batch)
    if loaded is None:  # review I4: refuse like every other bad-input path, never raise
        print(f"manifest.json missing or invalid for batch {args.batch}", file=sys.stderr)
        return 64
    bd, manifest, prog = loaded
    if manifest.get("kind") != kind:  # review M8: never dry-run one kind's ids against another's batch
        print(f"batch {args.batch} kind {manifest.get('kind')!r} != --source {kind!r}", file=sys.stderr)
        return 64
    started_at = prog.get("dry_run_started_at") or _now()
    prog["dry_run_started_at"] = started_at

    def _spent() -> float:  # always derived from the rows on disk — a resume must not re-add a re-run row (G0a-6)
        return sum(float((r.get("dry_run") or {}).get("cost_usd") or 0.0) for r in prog["rows"].values())

    spent = _spent()
    ok = failed = 0
    for row in manifest["rows"]:
        if row.get("already_applied"):
            continue
        mid = str(row["id"])
        key = f"{kind}:{mid}"
        # task-8-review Important #1: read-only lookup — never mutate prog["rows"] until we
        # are actually committed to attempting this meeting, so a halt below (budget guard)
        # leaves no phantom {} entry in batch-progress.json for a meeting never run.
        prior_entry = prog["rows"].get(key) or {}
        if (prior_entry.get("dry_run") or {}).get("exit") == 0:
            ok += 1
            continue
        # review C2: HALT before launching when the ledger already exceeds the cap — a resume
        # after a 12 (or a --max-usd already below recorded spend) must make zero new attempts.
        if spent > args.max_usd:
            print(f"budget: spent ${spent:.2f} > --max-usd {args.max_usd:.2f} before {kind}:{mid}", file=sys.stderr)
            _finish_digest(vault, bd, manifest, prog, status="partial (budget)")
            return 12
        entry = _row(prog, kind, mid)  # only mutate the ledger once we're committed to attempting it
        prior_dry = prior_entry.get("dry_run") or {}
        prior_cost = float(prior_dry.get("cost_usd") or 0.0)
        prior_attempts = int(prior_dry.get("attempts") or 0)
        stamp_before = _extraction_stamp(vault, kind, mid)
        t0 = time.monotonic()
        rc, capture, stderr = _run_dry_capture(mid, vault, repo)
        elapsed = time.monotonic() - t0
        state = progress._state_dir(vault, kind, mid)
        if capture:
            atomic_write(state / "dry-run.txt", capture.encode("utf-8"))
        if stderr:
            atomic_write(state / "dry-run.stderr.txt", stderr.encode("utf-8"))
        rec = _dry_run_record(vault, kind, mid, rc, capture, stamp_before, elapsed,
                               prior_cost=prior_cost, attempts=prior_attempts + 1)
        entry["dry_run"] = rec
        spent = _spent()
        _save_batch(bd, prog)  # checkpoint after every meeting (resumable)
        if rc == 0:
            ok += 1
        else:
            failed += 1
            if (rec.get("fetch_error") or {}).get("class") == "auth":
                print(f"stopped: auth ({kind}:{mid}) — fix credentials and re-run --batch {args.batch} dry-run", file=sys.stderr)
                _finish_digest(vault, bd, manifest, prog, status="partial (auth)")
                return 2
        if spent > args.max_usd:
            print(f"budget: spent ${spent:.2f} > --max-usd {args.max_usd:.2f} after {kind}:{mid}", file=sys.stderr)
            _finish_digest(vault, bd, manifest, prog, status="partial (budget)")
            return 12
    # review M7's checkpoint (empty/all-skipped batch still persists) is now subsumed by
    # _finish_digest's own _save_batch call below (task-8-review Minor #4) — no separate
    # save needed here; every exit path from this function calls _finish_digest.
    _finish_digest(vault, bd, manifest, prog, status="complete")
    print(f"dry-run: {ok} ok, {failed} failed, ${spent:.2f} spent")
    return 0


APPLY_TIMEOUT_S = 6 * run_meeting.CHILD_TIMEOUT_S  # one meeting = up to six child steps (G0a-7)


def run_apply_subprocess(meeting_id: str, vault: Path, repo: Path) -> int:
    """One meeting through the unchanged per-meeting loop with D-19 policy.
    A subprocess (not in-process): --apply spawns its own children and the
    batch must survive one meeting's failure or hang (exit 124 on timeout)."""
    try:
        res = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("run_meeting.py")), "--meeting-id", meeting_id,
             "--vault", str(vault), "--repo-root", str(repo), "--apply", "--backfill"],
            capture_output=True, text=True, timeout=APPLY_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        print(f"FAILED at apply ({meeting_id}): timeout after {APPLY_TIMEOUT_S}s", file=sys.stderr)
        return 124
    sys.stdout.write(res.stdout)
    if res.returncode != 0:
        sys.stderr.write(res.stderr)
    return res.returncode


def run_rollup_all(vault: Path, today: str) -> int:
    try:
        res = subprocess.run([sys.executable, str(run_meeting.BRAIN_ROLLUP), "--vault", str(vault), "--all", "--today", today],
                             capture_output=True, text=True, timeout=run_meeting.CHILD_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        print("FAILED at rollup: timeout", file=sys.stderr)
        return 6
    sys.stdout.write(res.stdout)
    if res.returncode != 0:
        sys.stderr.write(res.stderr)
    return res.returncode


def run_status_plan(client: str, engagement: str, today: str, vault: Path) -> tuple[int, str | None]:
    """Returns (rc, relPath of the written status artifact or None) — the relPath joins
    the post-batch commit pathspec (G0a2-2)."""
    try:
        res = subprocess.run(
            [*run_meeting._status_plan_argv(), str(run_meeting.STATUS_PLAN), "--client", client, "--node", engagement,
             "--today", today, "--write", "--vault", str(vault)],
            capture_output=True, text=True, cwd=str(run_meeting.CODE_ROOT), env=run_meeting._status_env(os.environ),
            timeout=run_meeting.CHILD_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        print(f"FAILED at status_update ({client}/{engagement}): timeout", file=sys.stderr)
        return 14, None
    sys.stdout.write(res.stdout)
    if res.returncode != 0:
        sys.stderr.write(res.stderr)
        return res.returncode, None
    out = progress.parse_subprocess_json(res.stdout)
    rel = out.get("relPath") if isinstance(out, dict) else None
    return 0, (str(rel) if rel else None)


def commit_post_batch(vault: Path, pathspec: list[str], message: str) -> tuple[str | None, bool]:
    """Seam over progress.vault_commit (FR-014 semantics: pathspec-scoped add+commit,
    'nothing to commit' = (None, False)). Post-batch rollup/status writes happen AFTER
    every per-meeting FR-014 commit, so they need their own commit (G0a2-2) — never
    left to the vault auto-sync cron.

    Pre-checks the pathspec's own `git status` before delegating: on a real vault
    (untracked scratch/notes elsewhere are the norm, not the exception), a clean,
    already-committed pathspec makes `git commit -- <pathspec>` print "nothing added
    to commit but untracked files present" rather than "nothing to commit" —
    progress.vault_commit's substring match doesn't recognize that wording and would
    SystemExit(10) on a true no-op. Filed here, not in progress.py (Task 9, out of
    scope): when the pathspec itself has nothing to add, return (None, False)
    directly; any real change still goes through progress.vault_commit unchanged."""
    existing = [p for p in pathspec if (Path(vault) / p).exists()]
    if existing:
        status = subprocess.run(["git", "-C", str(vault), "status", "--porcelain", "--", *existing],
                                 capture_output=True, text=True, timeout=60)
        if status.returncode == 0 and not status.stdout.strip():
            return None, False
    return progress.vault_commit(vault, pathspec, message)


def post_batch_pathspec(vault: Path, pairs: list[tuple[str, str]], status_rels: list[str]) -> list[str]:
    brain = "raw/areas/clearworks/org-brain"
    spec = {f"{brain}/STATE.md"}
    clients_dir = vault / brain / "clients"
    if clients_dir.is_dir():  # --all rewrites every client's engagements-rollup region
        spec.update(f"{brain}/clients/{p.name}" for p in clients_dir.glob("*.md") if not p.name.startswith("_"))
    for _client, eng in pairs:
        spec.add(f"{brain}/projects/{eng}.md")
    spec.update(r for r in status_rels if r)
    return sorted(spec)


def derive_pairs(vault: Path, kind: str, meeting_ids: list[str]) -> list[tuple[str, str]]:
    """Distinct (client, engagement) pairs exactly as run_meeting's status step
    derives them (G-120/G-124): resolution.json node → engagement itself, or a
    project's parent only when that parent exists and is an engagement."""
    nodes = brain_rollup.load_nodes(vault)
    pairs: set[tuple[str, str]] = set()
    for mid in meeting_ids:
        resolution = _read_json(envelope_dir(vault, kind, mid) / "resolution.json", {})
        if not isinstance(resolution, dict):
            continue
        eng_id, skip = run_meeting.resolve_engagement(resolution, nodes)
        client = str(resolution.get("counterparty_slug") or "")
        if eng_id and client and not skip:
            pairs.add((client, eng_id))
    return sorted(pairs)


def cmd_apply(args: argparse.Namespace) -> int:
    vault, repo, kind = Path(args.vault), Path(args.repo_root), args.source
    loaded = _load_batch(vault, args.batch)
    if loaded is None:  # review I4: refuse like every other bad-input path, never raise
        print(f"manifest.json missing or invalid for batch {args.batch}", file=sys.stderr)
        return 64
    bd, manifest, prog = loaded
    if manifest.get("kind") != kind:  # never apply one kind's ids against another's batch
        print(f"batch {args.batch} kind {manifest.get('kind')!r} != --source {kind!r}", file=sys.stderr)
        return 64
    signed = _read_json(bd / "batch-signed.json", None)
    sidecar = (bd / "digest.sha256").read_text(encoding="utf-8").strip() if (bd / "digest.sha256").is_file() else ""
    actual = hashlib.sha256((bd / "digest.md").read_bytes()).hexdigest() if (bd / "digest.md").is_file() else ""
    # G0b-7: recompute digest.md's hash — the sidecar alone can be edited alongside the digest.
    if not isinstance(signed, dict) or not actual or actual != sidecar or signed.get("digest_sha256") != actual:
        print(f"refuse apply: batch-signed.json missing or digest changed since signing (digest.md={actual or 'missing'} sidecar={sidecar or 'missing'} signed={(signed or {}).get('digest_sha256') if isinstance(signed, dict) else 'missing'}) — re-run dry-run + sign_batch.py", file=sys.stderr)
        return 15
    # G0b r2 N6: the signature also binds the manifest and the exact set of meetings it authorizes.
    manifest_sha = hashlib.sha256((bd / "manifest.json").read_bytes()).hexdigest()
    # CARRY-1 (Josh): the authorized set is EXACTLY the intersection of real exit-0
    # dry_run rows and batch-signed.json's own signed_ids — never prog["rows"].keys()
    # unfiltered. Reconciled with the brief's own derivation (manifest non-applied
    # rows with dry_run.exit == 0): the check just below already forces the two to be
    # equal before any row is processed, so `authorized` computed either way is
    # identical whenever apply is allowed to proceed at all; any drift between them
    # (a row silently added/removed from signed_ids, or a dry_run re-run after
    # signing) is caught HERE and refuses the WHOLE batch (15, nothing written) —
    # stricter than a per-row skip, per CARRY-2's fail-closed contract.
    authorized = sorted(
        mid for mid in (str(r["id"]) for r in manifest["rows"] if not r.get("already_applied"))
        if ((prog["rows"].get(f"{kind}:{mid}") or {}).get("dry_run") or {}).get("exit") == 0
    )
    if signed.get("manifest_sha256") != manifest_sha or sorted(signed.get("signed_ids") or []) != authorized:
        print(f"refuse apply: manifest or the exit-0 set changed since signing (signed {len(signed.get('signed_ids') or [])} ids, now {len(authorized)}) — re-run dry-run + sign_batch.py", file=sys.stderr)
        return 15
    started_at = prog.get("apply_started_at") or _now()
    prog["apply_started_at"] = started_at
    today = started_at[:10]
    _save_batch(bd, prog)

    ok = failed = skipped = 0
    for row in manifest["rows"]:
        if row.get("already_applied"):
            continue
        mid = str(row["id"])
        entry = _row(prog, kind, mid)
        if (entry.get("dry_run") or {}).get("exit") != 0:
            skipped += 1
            continue
        if (entry.get("apply") or {}).get("exit") == 0:
            skipped += 1  # already applied by an earlier run: a repeat is a no-op
            continue
        t0 = time.monotonic()
        rc = run_apply_subprocess(mid, vault, repo)
        receipt = _read_json(progress.receipt_path(vault, kind, mid), {})
        entry["apply"] = {"exit": rc, "vault_sha": (receipt or {}).get("vault_sha") if isinstance(receipt, dict) else None,
                          "elapsed_s": round(time.monotonic() - t0, 3), "at": _now()}
        _save_batch(bd, prog)
        if rc == 0:
            ok += 1
        else:
            failed += 1

    # FR-015 / D-19: FR-007 once (state + every client region, G-114) and FR-011 once
    # per distinct (client, engagement) — EXACTLY once per batch, after the LAST meeting:
    # only when every authorized meeting has applied (this run may be the retry that
    # completes it) and never twice (G0b r2 N5). A partially failed batch defers it.
    # FR-015 sequence: "continue past per-meeting failures, and after the LAST meeting run FR-007
    # once … and FR-011 once per pair derived from each APPLIED meeting … then print … exit 0/1".
    # So the gate is "every authorized meeting has been ATTEMPTED" (G0a3-1), never "all green";
    # pairs come from the meetings that did apply; failed ids are recorded for evidence 5/6.
    # Exactly-once is a PROGRESSIVE checkpoint (G0b r3 N5): post_batch is saved before the first
    # effect and after each one, and a resume performs only the steps not yet recorded.
    apply_of = lambda mid: ((prog["rows"].get(f"{kind}:{mid}") or {}).get("apply") or {})
    all_ok_ids = [mid for mid in authorized if apply_of(mid).get("exit") == 0]
    attempted = sorted(mid for mid in authorized if apply_of(mid).get("exit") is not None)
    if attempted == authorized and not (prog.get("post_batch") or {}).get("commit"):
        post: dict[str, Any] = prog.get("post_batch") or {"today": today, "started_at": _now(), "status_pairs": []}
        post["failed_ids"] = sorted(set(authorized) - set(all_ok_ids))
        prog["post_batch"] = post
        _save_batch(bd, prog)                                   # checkpoint: started
        if "rollup_all" not in post:
            post["rollup_all"] = run_rollup_all(vault, today)
            _save_batch(bd, prog)                               # checkpoint: rollup done
        pairs = derive_pairs(vault, kind, all_ok_ids)
        done_pairs = {(p["client"], p["engagement"]) for p in post["status_pairs"] if p.get("exit") is not None}
        for client, eng in pairs:
            if (client, eng) in done_pairs:
                continue
            rc, rel = run_status_plan(client, eng, today, vault)
            post["status_pairs"].append({"client": client, "engagement": eng, "exit": rc, "relPath": rel})
            _save_batch(bd, prog)                               # checkpoint: each pair
        # G0a2-2: commit the post-batch writes (STATE.md, every client region, touched
        # projects/<eng>.md last_update, each status artifact) — their own FR-014-style commit.
        pathspec = post_batch_pathspec(vault, pairs, [p["relPath"] for p in post["status_pairs"] if p.get("relPath")])
        sha, committed = commit_post_batch(vault, pathspec, f"brain: backfill {args.batch} post-batch rollup + status ({len(pairs)} pairs)")
        post["commit"] = {"pathspec": pathspec, "vault_sha": sha, "committed": committed}
        _save_batch(bd, prog)                                   # checkpoint: complete
    elif attempted != authorized:
        print(f"post-batch: deferred ({len(authorized) - len(attempted)} authorized meetings not yet attempted) — re-run apply; rollup/status run once after the last meeting", file=sys.stderr)
    print(f"applied: {ok} ok, {failed} failed, {skipped} skipped")
    # FR-015 exit contract: 0 when failed = 0, else 1. Post-batch rollup/status outcomes are
    # recorded in prog["post_batch"] and gated separately by G4 (6_rollup_all_ran_exactly_once_ok / 6_status_pairs_ok).
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
