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
import fcntl
import hashlib
import io
import json
import math
import os
import random
import re
import shutil
import stat
import subprocess
import sys
import time
import traceback
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import brain_rollup
import progress
import run_meeting
import sign_marker
from atomic import atomic_write
from fetch_fireflies import FirefliesListError
from fetch_fireflies import _load_api_key as load_api_key
from fetch_fireflies import fetch_error_path
from fetch_fireflies import list_transcripts  # module attribute: test seam
from paths import DEFAULT_REPO_ROOT, DEFAULT_VAULT, envelope_dir, safe_meeting_id
from run_meeting import main as run_meeting_main  # module attribute: test seam

SOURCES = ("fireflies",)  # R5 (FR-017) generalizes to fetch_<kind>.py dispatch
# Batch ids are produced by _batch_id(); anything else is refused before it touches a path (G0b-11).
BATCH_ID_RE = re.compile(r"^[a-z][a-z0-9]{0,15}-\d{8}T\d{6}Z$")
DEFAULT_MAX_USD = 150.0
# CH-3 (G2b r1, Critical): the ONE measured extraction cost sample in the
# spec (G-97/A-12: `cost_usd 0.3603328`, model sonnet, acceptance meeting's
# extraction.json meta) — used as a conservative nominal charge when a paid
# `claude -p` extraction attempt is billed but exits before writing
# extraction.json (wrapper failure / invalid JSON / schema failure), so
# repeated failures can never silently cost $0 in the ledger. Per-attempt
# cost receipts from extract_meeting.py itself are out of scope this
# release (carried A-13).
FAILED_EXTRACTION_NOMINAL_USD = 0.3603328


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
    # M1 (Spec M-1) + A5 (G2a r3 P2-2): a Fireflies API failure (bad key,
    # network, transport, or a malformed JSON response body — ValueError
    # covers json.JSONDecodeError) must refuse cleanly — never an uncaught
    # traceback, never a half-written batch.
    try:
        rows = list_transcripts(api_key, throttle_s=args.rate)
    except (FirefliesListError, urllib.error.URLError, OSError, ValueError) as exc:
        print(f"list failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    manifest_rows = build_manifest(rows, vault=vault, kind=args.source, since=args.since, until=args.until)
    batch_id = _batch_id(args.source)
    bd = batch_dir(vault, batch_id)
    # F19 (CH-18): create the batch dir EXCLUSIVELY — two `list` invocations in the
    # same UTC second must never let the second silently clobber the first's manifest.
    try:
        bd.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        print(f"batch {batch_id} already exists; retry in 1 s", file=sys.stderr)
        return 64
    doc = {"batch_id": batch_id, "kind": args.source, "created_at": _now(),
           "since": args.since, "until": args.until, "rows": manifest_rows}
    _write_json(bd / "manifest.json", doc)
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


def _max_usd_arg(value: str) -> float:
    """argparse `type=` for --max-usd (F13/CH-7): NaN/inf/negative must never
    reach the budget ledger — NaN comparisons are always False and a negative
    cap would corrupt the `spent > args.max_usd` guard."""
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid --max-usd {value!r} (expected a finite number >= 0)") from exc
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError(f"invalid --max-usd {value!r} (expected a finite number >= 0)")
    return parsed


def _rate_arg(value: str) -> float:
    """argparse `type=` for --rate (G2 r2 P2-2): same finite/non-negative
    contract as --max-usd — a NaN/inf/negative throttle must never reach
    list_transcripts."""
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid --rate {value!r} (expected a finite number >= 0)") from exc
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError(f"invalid --rate {value!r} (expected a finite number >= 0)")
    return parsed


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="FR-015 backfill lister + batch runner")
    p.add_argument("--source", default="fireflies")
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    p.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))
    p.add_argument("--batch")
    p.add_argument("--rate", type=_rate_arg, default=2.0, help="seconds between list pages (A-08)")
    sub = p.add_subparsers(dest="command", required=True)
    s_list = sub.add_parser("list")
    s_list.add_argument("--since", type=_date_arg)
    s_list.add_argument("--until", type=_date_arg)
    s_dry = sub.add_parser("dry-run")
    s_dry.add_argument("--max-usd", type=_max_usd_arg, default=DEFAULT_MAX_USD)
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


def _manifest_is_canonical(rows: list[Any], manifest_kind: Any) -> str | None:
    """F15 (CH-9) + N2/A8 (fold-1/2 re-review, F14 backfill half) + A5 (CH2-6):
    every manifest row must be a dict with a non-empty, unique string `id`
    that round-trips through `safe_meeting_id` (never a traversal-shaped or
    otherwise unsafe id, including the empty string — `not rid` is checked
    explicitly because `safe_meeting_id("") == "" == rid` would otherwise
    slip past the round-trip check by coincidence — the same rule
    sign_batch.py enforces on its own side, checked here BEFORE any
    `_state`/envelope path is ever built from one of these ids); every row's
    `occurred_at` must be a non-empty string that parses as a real ISO-8601
    timestamp via `datetime.fromisoformat(v.replace("Z","+00:00"))` — never
    coerced from `null`/missing (superseding the M5 `str(... or "")`
    workaround, which only avoided a `TypeError` but let a missing/garbage
    date slip through as a bare empty-string sort key); and every row's own
    `kind` must equal `manifest_kind` (a mixed-kind manifest is corruption,
    not something the digest/apply loops — which resolve a single `kind`'s
    envelopes — can process). The rows must already be sorted by
    (occurred_at, id) — the same order `build_manifest` produces and the
    digest/apply loops assume. Returns None when canonical, or a diagnostic
    string to print otherwise."""
    keys: list[tuple[datetime, str]] = []
    seen: set[str] = set()
    for r in rows:
        if not isinstance(r, dict):
            return "manifest not canonical; re-run list"
        rid = r.get("id")
        if not isinstance(rid, str) or rid in seen:
            return "manifest not canonical; re-run list"
        if not rid or safe_meeting_id(rid) != rid:
            return f"manifest not canonical (unsafe id {rid!r}); re-run list"
        seen.add(rid)
        occurred_raw = r.get("occurred_at")
        if not isinstance(occurred_raw, str) or not occurred_raw:
            return f"manifest not canonical (missing occurred_at for id {rid!r}); re-run list"
        try:
            occurred_dt = datetime.fromisoformat(occurred_raw.replace("Z", "+00:00"))
        except ValueError:
            return f"manifest not canonical (unparseable occurred_at {occurred_raw!r} for id {rid!r}); re-run list"
        # A4 (CH3-6 backfill half): a naive value (no Z, no explicit offset)
        # is refused — the batch cannot safely order rows whose instant is
        # ambiguous; canonical order below is computed from the UTC instant,
        # not the original text, so two rows written with different offsets
        # compare by real time rather than lexical string.
        if occurred_dt.tzinfo is None:
            return f"manifest not canonical (occurred_at {occurred_raw!r} has no UTC offset for id {rid!r}); re-run list"
        if r.get("kind") != manifest_kind:
            return f"manifest not canonical (row kind {r.get('kind')!r} != manifest kind {manifest_kind!r} for id {rid!r}); re-run list"
        keys.append((occurred_dt.astimezone(timezone.utc), rid))
    if keys != sorted(keys):
        return "manifest not canonical; re-run list"
    return None


def _load_batch(vault: Path, batch_id: str) -> tuple[Path, dict[str, Any], dict[str, Any]] | None:
    """Returns None (never raises) when manifest.json is missing/invalid — callers
    print + return 64, consistent with every other refusal in this module (review I4)."""
    bd = batch_dir(vault, batch_id)
    manifest = _read_json(bd / "manifest.json", None)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("rows"), list):
        return None
    canonical_error = _manifest_is_canonical(manifest["rows"], manifest.get("kind"))
    if canonical_error:
        print(f"{canonical_error} ({bd / 'manifest.json'})", file=sys.stderr)
        return None
    prog = _read_json(_progress_path(bd), {})
    if not isinstance(prog, dict):
        prog = {}
    prog.setdefault("batch_id", batch_id)
    prog.setdefault("kind", manifest.get("kind"))
    prog.setdefault("rows", {})
    # A4 (CH2-5 backfill side): the --batch id's own kind prefix (before the
    # first '-') must agree with both manifest.kind and batch-progress.kind —
    # a hand-edited or mismatched batch id/progress file must never be
    # silently trusted (the caller's own manifest.kind != --source check
    # closes the remaining leg of the chain).
    prefix = batch_id.split("-", 1)[0]
    for label, k in (("manifest.kind", manifest.get("kind")), ("batch-progress.kind", prog.get("kind"))):
        if prefix != k:
            print(f"batch id kind prefix {prefix!r} != kind {k!r} ({label})", file=sys.stderr)
            return None
    # A3 (CH2-4): every persisted ledger cost must be finite & non-negative —
    # fail closed rather than ever incorporate a corrupt/negative value into
    # a budget decision.
    for key, row in prog["rows"].items():
        if not isinstance(row, dict):
            continue
        dr = row.get("dry_run")
        if not isinstance(dr, dict) or "cost_usd" not in dr:
            continue
        v = dr.get("cost_usd")
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
            print(f"batch-progress.json ledger invalid (row {key} cost_usd={v!r})", file=sys.stderr)
            return None
    return bd, manifest, prog


def _save_batch(bd: Path, prog: dict[str, Any]) -> None:
    _write_json(_progress_path(bd), prog)


_LOCK_FDS: dict[str, int] = {}  # str(bd) -> open fd holding this process's flock, until released


def _acquire_batch_lock(bd: Path) -> int:
    """A9 (fold-2 re-review): a real, kernel-enforced advisory lock on
    `bd/.lock` via `fcntl.flock(LOCK_EX | LOCK_NB)`, held for the duration of
    cmd_dry_run and cmd_apply — two concurrent invocations against the same
    batch must never both load-process-checkpoint the same whole-file
    batch-progress.json. This is NOT a pid-file convention: lock ownership is
    tied to the open file description itself, so the kernel releases it
    automatically the instant the holding process exits or dies for any
    reason (crash, SIGKILL, ...) — there is no stale-lock detection or
    breaking logic at all, because there is nothing that can go stale. The
    pid written into the file is a diagnostic hint ONLY (surfaced in the
    refusal message for a human to `ps`), never consulted to decide
    ownership.

    A1 (CH3-5): opened with O_NOFOLLOW — `.lock` replaced by a symlink (to
    escalate a write elsewhere via the pid-diagnostic write) is refused
    before that write ever happens, and `os.fstat` additionally requires a
    REGULAR file with exactly one hard link, so a hardlinked `.lock` (which
    would let the pid write land on a second path too) is refused the same
    way. Both checks happen BEFORE any truncate/write — a rejected fd is
    closed untouched. A2 (CH3-3): the fd is marked inheritable so
    `run_apply_subprocess` can pass it into each per-meeting child via
    `pass_fds`, keeping the flock held for that child's lifetime even if
    this parent process were to die mid-batch.

    Returns 0 once the lock is held (release with `_release_batch_lock`, or
    look the fd up via `_batch_lock_fd`), or 64 when the lock file is not a
    plain regular file, or another live process already holds it."""
    bd.mkdir(parents=True, exist_ok=True)
    lock_path = bd / ".lock"
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o644)
    except OSError as exc:
        print(f"batch {bd.name}: batch lock is not a regular file: {exc}", file=sys.stderr)
        return 64
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        os.close(fd)
        print(f"batch {bd.name}: batch lock is not a regular file", file=sys.stderr)
        return 64
    os.set_inheritable(fd, True)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        try:
            held_pid = lock_path.read_text(encoding="utf-8").strip() or "?"
        except OSError:
            held_pid = "?"
        print(f"batch {bd.name} locked (pid {held_pid} per file)", file=sys.stderr)
        os.close(fd)
        return 64
    os.ftruncate(fd, 0)
    os.write(fd, str(os.getpid()).encode("utf-8"))
    _LOCK_FDS[str(bd)] = fd
    return 0


def _batch_lock_fd(bd: Path) -> int | None:
    """A2 (CH3-3): the fd this process currently holds the batch flock on for
    `bd`, or None if not held — exposed so `run_apply_subprocess` can
    inherit it into each per-meeting child (`pass_fds`)."""
    return _LOCK_FDS.get(str(bd))


def _release_batch_lock(bd: Path) -> None:
    """Closes the fd THIS process opened in `_acquire_batch_lock` (which also
    releases its flock) — never unlinks `.lock` itself, so a lock file left
    behind between runs is inert (no flock held on it) and simply reused by
    the next `_acquire_batch_lock` call; it is never mistaken for another
    holder's lock."""
    fd = _LOCK_FDS.pop(str(bd), None)
    if fd is not None:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


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
    cost_raw = extraction.get("cost_usd") if isinstance(extraction, dict) else None
    try:
        cost = float(cost_raw) if cost_raw is not None else 0.0
    except (TypeError, ValueError):
        cost = 0.0
    if not math.isfinite(cost) or cost < 0:
        # F13 (CH-7): a corrupt/negative measured cost must never DECREASE the
        # ledger — ignore it (charge 0 for this attempt) rather than let a bad
        # extraction.json weaken or disable the --max-usd budget halt.
        print(f"bad cost_usd ignored: {cost_raw!r} for {kind}:{meeting_id}", file=sys.stderr)
        cost = 0.0
    extracted_at = str(extraction.get("extracted_at") or "") if isinstance(extraction, dict) else ""
    # Charge only when THIS attempt produced the extraction (G0b-5): a retry after a
    # later-stage failure finds extract_meeting's inputSha short-circuit — no new spend.
    reused = bool(extracted_at) and extracted_at == stamp_before
    # CH-3 (G2b r1, Critical): a paid `claude -p` extraction call can be
    # billed by the provider and still exit non-zero BEFORE writing
    # extraction.json (wrapper failure, invalid JSON, schema failure) —
    # `no_new_extraction` (the stamp is unchanged from before this attempt,
    # whether that stamp is a real prior timestamp or the empty string for
    # "never extracted") is true in exactly that case as well as the
    # already-handled `reused` case. Fetch-stage failures (a real
    # fetch-error.json, or a synthesized `usage` exit-2) never reached
    # extraction at all and must NOT be charged — only a failure that got
    # PAST fetch, still failed, and produced no new extraction.json is
    # billed nominally.
    fe = _read_json(fetch_error_path(vault, kind, meeting_id), None)
    has_real_fetch_error = rc != 0 and isinstance(fe, dict)
    is_synthesized_usage = rc == 2 and not has_real_fetch_error
    got_past_fetch = not has_real_fetch_error and not is_synthesized_usage
    no_new_extraction = extracted_at == stamp_before
    cost_nominal = rc != 0 and no_new_extraction and got_past_fetch
    if cost_nominal:
        added_cost = FAILED_EXTRACTION_NOMINAL_USD
    elif reused:
        added_cost = 0.0
    else:
        added_cost = cost
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
        # accumulates onto whatever was already recorded for this row, it never resets;
        # spend only ever increases (measured, reused-zero, or nominal).
        "cost_usd": prior_cost + added_cost,
        "cost_reused": reused,
        "cost_nominal": cost_nominal,
        "attempts": attempts,
        "elapsed_s": round(elapsed, 3),
        "at": _now(),
    }
    if has_real_fetch_error:
        rec["fetch_error"] = fe
    elif is_synthesized_usage:
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
    # N1 (fold-1 re-review, F12 TOCTOU): acquire the lock BEFORE _load_batch —
    # the batch id is already BATCH_ID_RE-validated by main(), so the path is
    # safe to build here. Loading batch-progress.json before the lock let a
    # loser read a stale snapshot and overwrite the holder's final checkpoint
    # at its own first _save_batch.
    bd = batch_dir(vault, args.batch)
    # A10 (fold-2 re-review): refuse BEFORE touching the lock (reads no
    # progress state — just an existence check) when there's no manifest.json
    # at all, so a typo'd --batch never leaves an empty batch dir (or a
    # stray .lock file) behind.
    if not (bd / "manifest.json").is_file():
        print(f"manifest.json missing or invalid for batch {args.batch}", file=sys.stderr)
        return 64
    lock_rc = _acquire_batch_lock(bd)
    if lock_rc:
        return lock_rc
    try:
        loaded = _load_batch(vault, args.batch)
        if loaded is None:  # review I4: refuse like every other bad-input path, never raise
            print(f"manifest.json missing or invalid for batch {args.batch}", file=sys.stderr)
            return 64
        bd, manifest, prog = loaded
        if manifest.get("kind") != kind:  # review M8: never dry-run one kind's ids against another's batch
            print(f"batch {args.batch} kind {manifest.get('kind')!r} != --source {kind!r}", file=sys.stderr)
            return 64
        return _cmd_dry_run_locked(args, vault, repo, kind, bd, manifest, prog)
    finally:
        _release_batch_lock(bd)


def _cmd_dry_run_locked(args: argparse.Namespace, vault: Path, repo: Path, kind: str, bd: Path,
                         manifest: dict[str, Any], prog: dict[str, Any]) -> int:
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
        # F11 (CH-2): a crash between a paid extraction.json write and this row's
        # own checkpoint below must not read as "reused" on resume — persist the
        # pre-attempt stamp BEFORE launching and trust the persisted value (never
        # a freshly re-read extraction.json, which may already reflect the
        # crashed attempt's own paid write) whenever one survived a crash.
        pending = entry.get("dry_run_pending")
        if isinstance(pending, dict) and "stamp_before" in pending:
            stamp_before = pending.get("stamp_before") or ""
        else:
            stamp_before = _extraction_stamp(vault, kind, mid)
            entry["dry_run_pending"] = {"stamp_before": stamp_before, "attempt": prior_attempts + 1, "at": _now()}
            _save_batch(bd, prog)
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
        entry.pop("dry_run_pending", None)
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


# A2/A3 (CH3-3/CH3-4 backfill halves): set by cmd_apply for the duration of
# its (locked) run, read by run_apply_subprocess below. A module-level
# variable rather than an extra parameter — run_apply_subprocess's 3-arg
# call signature (meeting_id, vault, repo) is depended on verbatim by every
# existing `monkeypatch.setattr(backfill, "run_apply_subprocess", lambda mid,
# v, repo: ...)` test fixture in this file; changing its arity would break
# every one of them for a concern (the batch id / lock fd) those fakes never
# needed to know about.
_CURRENT_BATCH_ID: str | None = None


def run_apply_subprocess(meeting_id: str, vault: Path, repo: Path) -> int:
    """One meeting through the unchanged per-meeting loop with D-19 policy.
    A subprocess (not in-process): --apply spawns its own children and the
    batch must survive one meeting's failure or hang (exit 124 on timeout).

    A3 (CH3-4 backfill half): passes --batch <batch_id> (from
    _CURRENT_BATCH_ID) so run_meeting can bind its marker validation to the
    exact batch that authorized it (agent B wires --batch/expected_batch_id
    on the receiving end). A2 (CH3-3): if this process currently holds that
    batch's flock, inherits the fd into the child via pass_fds so the lock
    survives parent death for the child's own lifetime."""
    argv = [sys.executable, str(Path(__file__).with_name("run_meeting.py")), "--meeting-id", meeting_id,
            "--vault", str(vault), "--repo-root", str(repo), "--apply", "--backfill"]
    kwargs: dict[str, Any] = {}
    if _CURRENT_BATCH_ID:
        argv += ["--batch", _CURRENT_BATCH_ID]
        lock_fd = _batch_lock_fd(batch_dir(vault, _CURRENT_BATCH_ID))
        if lock_fd is not None:
            kwargs["pass_fds"] = [lock_fd]
    try:
        res = subprocess.run(argv, capture_output=True, text=True, timeout=APPLY_TIMEOUT_S, **kwargs)
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
    # A7 (CH-12 PARTIAL): rc == 0 is only trustworthy alongside a real JSON
    # payload that actually carries a `relPath` key (`parse_subprocess_json`
    # itself never raises — garbage/empty stdout silently becomes `{}`, which
    # must NOT be read as "nothing to write"). Downgrade to (14, None) so the
    # pair is recorded failed and retried, never counted done, on garbage
    # stdout — the FR-015 exit contract itself is untouched (still gated on
    # per-meeting apply failures, not this pair's rc).
    if not isinstance(out, dict) or "relPath" not in out:
        print(f"FAILED at status_update ({client}/{engagement}): rc 0 with no relPath in stdout JSON", file=sys.stderr)
        return 14, None
    rel = out.get("relPath")
    if rel is None:
        return 0, None  # a real, well-formed "nothing needed writing" outcome
    rel = str(rel)
    # A7: relPath must resolve to a real file INSIDE the vault — absent or
    # traversal-shaped values are never trusted as a completed write.
    try:
        target = (Path(vault) / rel).resolve()
        target.relative_to(Path(vault).resolve())
    except ValueError:
        print(f"FAILED at status_update ({client}/{engagement}): relPath {rel!r} escapes the vault", file=sys.stderr)
        return 14, None
    if not target.is_file():
        print(f"FAILED at status_update ({client}/{engagement}): relPath {rel!r} not found on disk", file=sys.stderr)
        return 14, None
    return 0, rel


def commit_post_batch(vault: Path, pathspec: list[str], message: str) -> tuple[str | None, bool]:
    """Seam over progress.vault_commit (FR-014 semantics: pathspec-scoped add+commit,
    'nothing to commit' = (None, False)). Post-batch rollup/status writes happen AFTER
    every per-meeting FR-014 commit, so they need their own commit (G0a2-2) — never
    left to the vault auto-sync cron.

    F5 (CARRY-5): delegates straight to progress.vault_commit with no separate
    pathspec_dirty pre-check — progress.vault_commit itself (F4) now recognizes
    every real git no-op wording ("nothing to commit", "nothing added to commit",
    "no changes added to commit"), so the hand-rolled pre-check here is redundant
    and only duplicated logic that already lives in one place. A real git failure
    still raises SystemExit(10) for the caller's commit_error containment."""
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


def _pair_ok_ids(vault: Path, kind: str, meeting_ids: list[str]) -> dict[tuple[str, str], list[str]]:
    """A1 (G2a r2 P2-1): per-(client, engagement)-pair contributing id set —
    the exact same derivation `derive_pairs` uses (resolution.json node →
    engagement itself, or a project's parent only when that parent exists
    and is an engagement, G-120/G-124), but also records WHICH of
    `meeting_ids` produced each pair. A re-entry can then tell whether a
    previously-recorded pair's authorship has grown (a meeting that failed
    apply run 1 now also contributes to it) even when the pair's own exit
    was already 0 — coverage growing must still re-run it."""
    nodes = brain_rollup.load_nodes(vault)
    out: dict[tuple[str, str], list[str]] = {}
    for mid in meeting_ids:
        resolution = _read_json(envelope_dir(vault, kind, mid) / "resolution.json", {})
        if not isinstance(resolution, dict):
            continue
        eng_id, skip = run_meeting.resolve_engagement(resolution, nodes)
        client = str(resolution.get("counterparty_slug") or "")
        if eng_id and client and not skip:
            out.setdefault((client, eng_id), []).append(mid)
    return {pair: sorted(ids) for pair, ids in out.items()}


def derive_pairs(vault: Path, kind: str, meeting_ids: list[str]) -> list[tuple[str, str]]:
    """Distinct (client, engagement) pairs exactly as run_meeting's status step
    derives them (G-120/G-124): resolution.json node → engagement itself, or a
    project's parent only when that parent exists and is an engagement."""
    return sorted(_pair_ok_ids(vault, kind, meeting_ids))


def _post_batch_committed(prog: dict[str, Any]) -> bool:
    """True only when post_batch.commit records a REAL outcome — a successful commit
    (`{"vault_sha": sha, "committed": True}`) or the legitimate no-op
    (`{"vault_sha": None, "committed": False}`) — never `post_batch.commit_error`,
    and never mere key-presence (N1, task-10-review-r1): reserving `commit` for a
    real outcome keeps both the I1 closure gate and the once-per-batch gate from
    reading a transient git failure as a completed commit."""
    commit = (prog.get("post_batch") or {}).get("commit")
    return isinstance(commit, dict) and "committed" in commit


def _post_batch_effects_ok(prog: dict[str, Any]) -> bool:
    """F17 (CH-12): a committed (or legitimately no-op) post_batch must NOT read
    as fully closed while rollup --all or any derived status pair is still
    outstanding — otherwise a real (or no-op) commit of whatever DID succeed
    would permanently close the batch with required FR-007/FR-011 artifacts
    still missing. True only when rollup_all recorded a verified 0 AND every
    status pair recorded a verified 0."""
    post = prog.get("post_batch")
    if not isinstance(post, dict):
        return False
    if post.get("rollup_all") != 0:
        return False
    return all(p.get("exit") == 0 for p in post.get("status_pairs") or [])


def _normalize_post_batch(post: Any, today: str) -> dict[str, Any]:
    """F16 (CH-10): an all-non-exit-0 batch's `{"skipped": ...}` checkpoint (or any
    other incomplete shape) must never survive into a LATER apply once the
    authorized set has grown — rebuild the working shape here rather than let
    `post["status_pairs"]` raise KeyError below. Any real progress already
    recorded (rollup_all/rollup_all_ids/status_pairs/commit/commit_error) is
    preserved verbatim."""
    if isinstance(post, dict) and "status_pairs" in post and "started_at" in post:
        return post
    rebuilt: dict[str, Any] = {"today": today, "started_at": _now(), "status_pairs": []}
    if isinstance(post, dict):
        for key in ("rollup_all", "rollup_all_ids", "rollup_all_last_exit", "status_pairs", "commit", "commit_error"):
            if key in post:
                rebuilt[key] = post[key]
    return rebuilt


def cmd_apply(args: argparse.Namespace) -> int:
    vault, repo, kind = Path(args.vault), Path(args.repo_root), args.source
    # N1 (fold-1 re-review, F12 TOCTOU): acquire the lock BEFORE _load_batch,
    # for the same reason as cmd_dry_run above — every preflight check and the
    # first _save_batch must happen only once the lock is actually held.
    bd = batch_dir(vault, args.batch)
    # A10 (fold-2 re-review): same pre-lock existence check as cmd_dry_run.
    if not (bd / "manifest.json").is_file():
        print(f"manifest.json missing or invalid for batch {args.batch}", file=sys.stderr)
        return 64
    lock_rc = _acquire_batch_lock(bd)
    if lock_rc:
        return lock_rc
    global _CURRENT_BATCH_ID
    _CURRENT_BATCH_ID = args.batch  # A2/A3: available to run_apply_subprocess for the lifetime of this locked run
    try:
        loaded = _load_batch(vault, args.batch)
        if loaded is None:  # review I4: refuse like every other bad-input path, never raise
            print(f"manifest.json missing or invalid for batch {args.batch}", file=sys.stderr)
            return 64
        bd, manifest, prog = loaded
        if manifest.get("kind") != kind:  # never apply one kind's ids against another's batch
            print(f"batch {args.batch} kind {manifest.get('kind')!r} != --source {kind!r}", file=sys.stderr)
            return 64
        return _cmd_apply_locked(args, vault, repo, kind, bd, manifest, prog)
    finally:
        _CURRENT_BATCH_ID = None
        _release_batch_lock(bd)


def _cmd_apply_locked(args: argparse.Namespace, vault: Path, repo: Path, kind: str, bd: Path,
                       manifest: dict[str, Any], prog: dict[str, Any]) -> int:
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
    # F2 addendum (CH-6): the batch_id chain — manifest, batch-progress, batch-signed,
    # and the operator's own --batch — must all agree before any row is touched. A
    # complete signed batch copied into a different batch dir must never be applied
    # and reported/committed under the wrong id.
    chain = {"manifest": manifest.get("batch_id"), "progress": prog.get("batch_id"),
             "signed": signed.get("batch_id"), "--batch": args.batch}
    if len(set(chain.values())) != 1:
        print(f"refuse apply: batch_id mismatch across manifest/progress/signed/--batch: {chain} — re-run dry-run + sign_batch.py", file=sys.stderr)
        return 15
    # F2 addendum (CH-5): sign_batch.py's marker fan-out must have finished — a
    # crash partway through fan-out (batch-signed.json written, some markers
    # missing) must never let apply proceed on the strength of the digest checks
    # above alone.
    if signed.get("fanout_complete") is not True:
        print(f"refuse apply: batch-signed.json fanout_complete is not true (sign_batch.py may have failed partway through marker fan-out) — re-run sign_batch.py", file=sys.stderr)
        return 15
    # F2 (G2a P1-2 / CH-5): every authorized meeting's own D-09 marker must exist
    # and be bound to THIS signed batch before the first subprocess runs — a
    # missing, unreadable, or foreign-batch marker refuses the WHOLE batch (15,
    # nothing written), never a per-row skip discovered mid-run inside a
    # subprocess. Named by the FIRST offending id.
    for mid in authorized:
        marker = sign_marker.marker_path(vault, kind, mid)
        if not marker.is_file():
            print(f"refuse apply: marker missing for {kind}:{mid} ({marker}) — re-run sign_batch.py", file=sys.stderr)
            return 15
        try:
            marker_doc = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"refuse apply: marker unreadable for {kind}:{mid} ({marker}): {exc} — re-run sign_batch.py", file=sys.stderr)
            return 15
        # A6 (CH-5 PARTIAL / CH2-3 apply half): also bind signer identity —
        # signed_by/signed_at — from the SAME marker_doc already loaded above
        # (no extra file read); a marker whose batch_id/digest matches but
        # whose signer doesn't must still refuse.
        if (not isinstance(marker_doc, dict) or marker_doc.get("batch_id") != signed.get("batch_id")
                or marker_doc.get("digest_sha256") != signed.get("digest_sha256")
                or marker_doc.get("signed_by") != signed.get("signed_by")
                or marker_doc.get("signed_at") != signed.get("signed_at")):
            print(f"refuse apply: marker batch binding mismatch for {kind}:{mid} ({marker}) — re-run sign_batch.py", file=sys.stderr)
            return 15
    started_at = prog.get("apply_started_at") or _now()
    prog["apply_started_at"] = started_at
    today = started_at[:10]
    _save_batch(bd, prog)

    # I1 (task-10-review): once post-batch has ACTUALLY committed (a real outcome,
    # never a commit_error — N1, task-10-review-r1), a still-failed row (e.g. exit
    # 124) must NOT be silently re-run — a late success here would get only
    # run_meeting's per-meeting state-only rollup and never its client-region rebuild
    # or its (client, engagement) status update (those happen ONCE, in the post-batch
    # block below). Close it instead: count it as skipped and name it in one stderr
    # line. It stays un-applied, so a future `list`/batch will re-include it. A
    # transient commit failure must NOT close anything — the block below re-enters
    # and retries the commit until it actually succeeds.
    post_closed = _post_batch_committed(prog)
    closed_failed_ids: list[str] = []
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
        if post_closed:
            # F20 (CH-19): a row still un-applied once post-batch has already run
            # is a genuine failure, not a benign skip — it stays permanently
            # un-applied (a new batch is required), so the summary/exit code
            # must say so rather than read as a clean 0-failed repeat.
            closed_failed_ids.append(mid)
            failed += 1
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
    if closed_failed_ids:
        print(f"post-batch already ran for {args.batch}; failed ids {sorted(closed_failed_ids)} need a new batch "
              f"(they are not applied; list will re-include them)", file=sys.stderr)
        print(f"closed (post-batch already ran; new batch required): {sorted(closed_failed_ids)}", file=sys.stderr)

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
    if not authorized:
        # M6 (task-10-review): zero authorized meetings (e.g. every dry-run row
        # non-exit-0) must not still trigger a vault-wide rollup --all + commit with
        # nothing behind it.
        if not (prog.get("post_batch") or {}).get("skipped"):
            print("post-batch: nothing authorized, skipped", file=sys.stderr)
            prog["post_batch"] = {"skipped": "no-authorized-rows"}
            _save_batch(bd, prog)
    else:
        apply_of = lambda mid: ((prog["rows"].get(f"{kind}:{mid}") or {}).get("apply") or {})
        all_ok_ids = [mid for mid in authorized if apply_of(mid).get("exit") == 0]
        attempted = sorted(mid for mid in authorized if apply_of(mid).get("exit") is not None)
        # F17 (CH-12): re-enter whenever the stage isn't BOTH committed and fully
        # effective — a committed (or no-op) commit alongside an outstanding
        # rollup/status failure must still retry those effects, not read as done.
        if attempted == authorized and not (_post_batch_committed(prog) and _post_batch_effects_ok(prog)):
            # F16 (CH-10): normalize BEFORE touching post["status_pairs"] below — an
            # earlier all-non-exit-0 batch's `{"skipped": ...}` checkpoint must never
            # KeyError once the authorized set has grown.
            post = _normalize_post_batch(prog.get("post_batch"), today)
            post["failed_ids"] = sorted(set(authorized) - set(all_ok_ids))
            prog["post_batch"] = post
            _save_batch(bd, prog)                                   # checkpoint: started
            # F17 (CH-12) + F6 (CARRY-6): rollup --all is checkpointed ONLY on a
            # verified rc == 0 — a nonzero exit records `rollup_all_last_exit` and
            # is retried next entry, never treated as done by key presence alone.
            # It is ALSO re-run (even after a prior rc == 0) whenever the ok-id
            # coverage has grown since the last successful rollup — a batch that
            # closes a previously-failed row must still see it reflected.
            if post.get("rollup_all") != 0 or sorted(all_ok_ids) != post.get("rollup_all_ids"):
                rollup_rc = run_rollup_all(vault, today)
                if rollup_rc == 0:
                    post["rollup_all"] = 0
                    post["rollup_all_ids"] = sorted(all_ok_ids)
                    post.pop("rollup_all_last_exit", None)
                else:
                    post["rollup_all_last_exit"] = rollup_rc
                _save_batch(bd, prog)                               # checkpoint: rollup done
            pair_ok_ids = _pair_ok_ids(vault, kind, all_ok_ids)
            pairs = sorted(pair_ok_ids)
            # F17 (CH-12) + A1 (G2a r2 P2-1): a pair is "done" only on a verified
            # exit == 0 AND its recorded `ok_ids` matching the CURRENT contributing
            # set — a failed pair (nonzero exit), or one whose coverage grew since
            # it last ran (a meeting that failed apply run 1 now also contributes
            # to it, even though the pair itself already succeeded once), is
            # retried on the next entry instead of being treated as complete by
            # mere presence in status_pairs. Its stale record moves to
            # status_pairs_history so status_pairs never carries two rows for the
            # same pair. On the fully-successful once-per-batch path, ok_ids never
            # changes between checkpoint and read, so nothing here reruns twice.
            history = post.setdefault("status_pairs_history", [])
            current_by_pair = {(p["client"], p["engagement"]): p for p in post["status_pairs"]}
            for client, eng in pairs:
                prior = current_by_pair.get((client, eng))
                ok_ids_for_pair = pair_ok_ids[(client, eng)]
                if prior is not None and prior.get("exit") == 0 and prior.get("ok_ids") == ok_ids_for_pair:
                    continue
                if prior is not None:
                    history.append(prior)
                    post["status_pairs"] = [p for p in post["status_pairs"] if (p["client"], p["engagement"]) != (client, eng)]
                rc, rel = run_status_plan(client, eng, today, vault)
                post["status_pairs"].append({"client": client, "engagement": eng, "exit": rc, "relPath": rel, "ok_ids": ok_ids_for_pair})
                _save_batch(bd, prog)                               # checkpoint: each pair
            # G0a2-2: commit the post-batch writes (STATE.md, every client region, touched
            # projects/<eng>.md last_update, each status artifact) — their own FR-014-style commit.
            pathspec = post_batch_pathspec(vault, pairs, [p["relPath"] for p in post["status_pairs"] if p.get("relPath")])
            # M5 (task-10-review): a real git failure (progress.vault_commit raises
            # SystemExit(10)) must not preempt the FR-015 exit contract / `applied:` line
            # — contain it, record it, and fall through. N1 (task-10-review-r1): the
            # failure goes to its OWN `commit_error` key, never `commit` — `commit` is
            # reserved for a real outcome (see _post_batch_committed) so a transient
            # failure never closes rows and a re-run retries ONLY the commit (rollup
            # and per-pair status stay checkpointed above and are not repeated).
            try:
                sha, committed = commit_post_batch(vault, pathspec, f"brain: backfill {args.batch} post-batch rollup + status ({len(pairs)} pairs)")
                post["commit"] = {"pathspec": pathspec, "vault_sha": sha, "committed": committed}
            except SystemExit as exc:
                post["commit_error"] = {"code": str(exc.code), "at": _now()}
                print(f"post-batch commit failed: {exc.code}", file=sys.stderr)
            _save_batch(bd, prog)                                   # checkpoint: complete
        elif attempted != authorized:
            print(f"post-batch: deferred ({len(authorized) - len(attempted)} authorized meetings not yet attempted) — re-run apply; rollup/status run once after the last meeting", file=sys.stderr)
    print(f"applied: {ok} ok, {failed} failed, {skipped} skipped")
    # FR-015 exit contract: 0 when failed = 0, else 1. Post-batch rollup/status outcomes are
    # recorded in prog["post_batch"] and gated separately by G4 (6_rollup_all_ran_exactly_once_ok / 6_status_pairs_ok).
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
