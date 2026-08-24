"""Fixture-safe MMRAG recovery helpers (FR-016 drain, FR-004 snapshot).

These tools refuse hosted ~/.cortextos knowledge-base paths until a later
human L0. They never force-kill a process, never construct PersistentClient,
and never default to the live clearworksai store.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tarfile
import time
from pathlib import Path


LIVE_CORTEXTOS_ROOT = Path.home() / ".cortextos"
HOSTED_KB_MARKER = ("orgs", "knowledge-base")


class LiveEpochBlocked(Exception):
    result = "LIVE_EPOCH_BLOCKED"

    def __init__(self, path):
        self.path = str(path)
        super().__init__(
            f"LIVE_EPOCH_BLOCKED: fixture-only recovery refuses hosted KB path {path}"
        )


class DrainFailed(Exception):
    def __init__(self, receipt):
        self.receipt = receipt
        super().__init__(
            "DRAIN_FAIL: openers remain; backup refused; no process kill"
        )


class BackupRefused(Exception):
    result = "BACKUP_REFUSED"


def hosted_kb_root(path):
    """Return the hosted KB root if path is under ~/.cortextos/<id>/orgs/<org>/knowledge-base."""
    resolved = Path(path).expanduser().resolve()
    try:
        rel = resolved.relative_to(LIVE_CORTEXTOS_ROOT.resolve())
    except ValueError:
        return None
    parts = rel.parts
    if len(parts) >= 4 and parts[1] == "orgs" and parts[3] == "knowledge-base":
        return LIVE_CORTEXTOS_ROOT.resolve().joinpath(*parts[:4])
    return None


def assert_not_live_epoch(path):
    if hosted_kb_root(path) is not None:
        raise LiveEpochBlocked(path)


def _sqlite_family(sqlite_path):
    sqlite = Path(sqlite_path)
    paths = [sqlite]
    for suffix in ("-wal", "-shm"):
        extra = Path(str(sqlite) + suffix)
        if extra.exists():
            paths.append(extra)
    return paths


def _parse_lsof_pc(stdout):
    openers = []
    current_pid = None
    for raw in stdout.splitlines():
        if not raw:
            continue
        code, value = raw[0], raw[1:]
        if code == "p":
            current_pid = value
        elif code == "c" and current_pid is not None:
            openers.append({"pid": int(current_pid), "command": value})
            current_pid = None
    return openers


def list_sqlite_openers(sqlite_path):
    """Return current openers of chroma.sqlite3 plus WAL/SHM if present.

    Fail closed if lsof is missing so we cannot prove an empty opener set.
    """
    assert_not_live_epoch(sqlite_path)
    if shutil.which("lsof") is None:
        raise DrainFailed({
            "result": "DRAIN_FAIL",
            "detail": "lsof not available; cannot prove empty openers",
            "openers": [],
            "checked_paths": [str(Path(sqlite_path))],
        })
    checked = [str(path) for path in _sqlite_family(sqlite_path) if path.exists()]
    if not checked:
        return {"paths": [str(Path(sqlite_path))], "openers": []}
    proc = subprocess.run(
        ["lsof", "-nP", "-F", "pc", "--", *checked],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode not in (0, 1):
        raise DrainFailed({
            "result": "DRAIN_FAIL",
            "detail": f"lsof exited {proc.returncode}: {proc.stderr.strip()}",
            "openers": [],
            "checked_paths": checked,
        })
    return {"paths": checked, "openers": _parse_lsof_pc(proc.stdout)}


def drain_chroma_openers(sqlite_path, *, timeout_s=30, poll_s=0.1):
    """Wait until no process holds the sqlite family. Never force-kill."""
    assert_not_live_epoch(sqlite_path)
    deadline = time.monotonic() + max(0.0, float(timeout_s))
    last = {"paths": [str(Path(sqlite_path))], "openers": []}
    while True:
        last = list_sqlite_openers(sqlite_path)
        if not last["openers"]:
            return {
                "result": "DRAIN_PASS",
                "openers": [],
                "checked_paths": last["paths"],
                "timeout_s": timeout_s,
            }
        if time.monotonic() >= deadline:
            return {
                "result": "DRAIN_FAIL",
                "openers": last["openers"],
                "checked_paths": last["paths"],
                "timeout_s": timeout_s,
            }
        time.sleep(max(0.01, float(poll_s)))


def _fsync_file(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot_kb_surfaces(kb_root, dest_dir, *, drain_timeout_s=30):
    """Immutable snapshot of chromadb/, config.json, and embedding-cache.sqlite.

    Requires a DRAIN_PASS receipt first. Refuses hosted live KB roots.
    """
    kb = Path(kb_root).expanduser().resolve()
    dest = Path(dest_dir).expanduser().resolve()
    assert_not_live_epoch(kb)
    assert_not_live_epoch(dest)

    sqlite = kb / "chromadb" / "chroma.sqlite3"
    config = kb / "config.json"
    cache = kb / "embedding-cache.sqlite"
    missing = [str(path) for path in (sqlite, config, cache) if not path.is_file()]
    if missing:
        raise BackupRefused(f"missing required backup surfaces: {missing}")

    drain = drain_chroma_openers(sqlite, timeout_s=drain_timeout_s)
    if drain["result"] != "DRAIN_PASS":
        raise DrainFailed(drain)

    drain_canonical = json.dumps(drain, sort_keys=True, separators=(",", ":"))
    drain_sha256 = hashlib.sha256(drain_canonical.encode("utf-8")).hexdigest()

    dest.mkdir(parents=True, exist_ok=False)
    archive = dest / "kb-surfaces.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(kb / "chromadb", arcname="chromadb")
        tar.add(config, arcname="config.json")
        tar.add(cache, arcname="embedding-cache.sqlite")
    _fsync_file(archive)
    dir_fd = os.open(dest, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    os.chmod(archive, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)

    receipt = {
        "result": "BACKUP_OK",
        "archive_path": str(archive),
        "archive_sha256": _sha256_file(archive),
        "drain": drain,
        "drain_sha256": drain_sha256,
        "members": ["chromadb/", "config.json", "embedding-cache.sqlite"],
    }
    receipt_path = dest / "backup-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    os.chmod(receipt_path, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    return receipt


def materialize_backup_work_tree(archive_path, work_dir):
    """Copy backup members into a disposable work tree. Never mutate the archive."""
    archive = Path(archive_path).expanduser().resolve()
    work = Path(work_dir).expanduser().resolve()
    assert_not_live_epoch(archive)
    assert_not_live_epoch(work)
    if not archive.is_file():
        raise BackupRefused(f"backup archive missing: {archive}")
    if stat.S_IMODE(archive.stat().st_mode) & 0o222:
        raise BackupRefused(f"backup archive is writable; refuse to treat as immutable: {archive}")
    if work.exists():
        raise BackupRefused(f"work tree already exists: {work}")
    work.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, "r:*") as tar:
        tar.extractall(work)
    return work
