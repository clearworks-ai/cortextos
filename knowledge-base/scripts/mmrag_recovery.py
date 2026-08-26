"""MMRAG recovery helpers.

Native Chroma work runs only in an isolated subprocess after a supported
runtime preflight. This module never constructs a Chroma client itself,
never force-kills drain openers, and never defaults to the live store.
Hosted ~/.cortextos knowledge-base paths stay blocked unless
MMRAG_RECOVERY_ALLOW_LIVE=1 and CTX_INSTANCE_ID=cortextos1.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import stat
import subprocess
import tarfile
import time
from pathlib import Path


LIVE_CORTEXTOS_ROOT = Path.home() / ".cortextos"
HOSTED_KB_MARKER = ("orgs", "knowledge-base")
PINNED_INSTANCE_ID = "cortextos1"
PINNED_ORG = "clearworksai"
LIVE_EPOCH_ENV = "MMRAG_RECOVERY_ALLOW_LIVE"
NATIVE_HOLD_FILENAME = "NATIVE_HOLD"
RECONCILE_AGENTS = ("larry", "larry-codex")
RECONCILE_JOB_NAME = "kb-reconcile-nightly"
FRANK2_JOB_NAME = "weekly-synthesis"

# Crash-guard proved a fresh 3072-d control on this tuple. That is not proof
# the live store is healthy. Fleet 3.14.7 + Chroma 1.5.7 is unsupported.
SUPPORTED_NATIVE_TUPLES = {("3.13.12", "1.5.9")}
HOOK_QUERY_TIMEOUT_MS = 12000
BUS_QUERY_TIMEOUT_MS = 30000
ISOLATED_QUERY_TIMEOUT_S = 10.0
# Isolated ingest is supervised in batches. A 6h corpus wall caused WORKER_TIMEOUT
# while Gemini recaptioned meeting-frame JPEGs; do not wrap the full corpus.
ISOLATED_INGEST_BATCH_TIMEOUT_S = 45 * 60
ISOLATED_INGEST_BATCH_MAX_FILES = 80
ISOLATED_INGEST_TIMEOUT_S = ISOLATED_INGEST_BATCH_TIMEOUT_S
# Single long videos blew the 45-minute mixed batch; keep each video in its
# own batch under a still-sub-6h wall.
ISOLATED_VIDEO_BATCH_TIMEOUT_S = 3 * 3600
VIDEO_BATCH_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
# v3 timed out on a 7.16 MB JSON inside an 80-file / 2700s default batch.
# Isolate oversized JSON as a singleton under the same sub-6h wall as video.
LARGE_JSON_EXTS = {".json"}
LARGE_JSON_MIN_BYTES = 5_000_000
ISOLATED_LARGE_JSON_BATCH_TIMEOUT_S = 3 * 3600
# Josh 2026-08-26: small recoverable chunks; do not restart from scratch.
ISOLATED_CHUNK_MAX_FILES = 8
ISOLATED_CHUNK_TIMEOUT_S = 15 * 60
# Low-risk default units: tighter cap than the generic chunk.
ISOLATED_LOW_RISK_CHUNK_MAX_FILES = 2
ISOLATED_LOW_RISK_CHUNK_TIMEOUT_S = 10 * 60
STALE_SIDE_WORK_DIRNAME = "recovery-side"
SIDE_WORK_DIRNAME = "recovery-side"
RECOVERY_SIDE_V2_DIRNAME = "recovery-side-2"
RECOVERY_SIDE_V3_DIRNAME = "recovery-side-3"
RECOVERY_SIDE_V4_DIRNAME = "recovery-side-4"
STALE_RECOVERY_SIDE_DIRNAMES = (
    STALE_SIDE_WORK_DIRNAME,
    RECOVERY_SIDE_V2_DIRNAME,
    RECOVERY_SIDE_V3_DIRNAME,
)
ISOLATED_WORKER_ENV = "MMRAG_ISOLATED_CHROMA_WORKER"
WORKER_TERM_GRACE_S = 2.0

_RUNTIME_PROBE = r"""
import hashlib, json, sys
from pathlib import Path
identity = {
    "python_executable": sys.executable,
    "python_version": ".".join(str(part) for part in sys.version_info[:3]),
    "chromadb_version": None,
    "bindings_path": None,
    "bindings_sha256": None,
}
try:
    import chromadb
    identity["chromadb_version"] = chromadb.__version__
    import chromadb_rust_bindings
    path = Path(chromadb_rust_bindings.__file__)
    identity["bindings_path"] = str(path)
    identity["bindings_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
except Exception as exc:
    identity["probe_error"] = f"{type(exc).__name__}: {exc}"
print(json.dumps(identity, separators=(",", ":")))
"""


class LiveEpochBlocked(Exception):
    result = "LIVE_EPOCH_BLOCKED"

    def __init__(self, path):
        self.path = str(path)
        super().__init__(
            f"LIVE_EPOCH_BLOCKED: recovery refuses hosted KB path {path}"
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


def pinned_live_kb():
    return (
        LIVE_CORTEXTOS_ROOT / PINNED_INSTANCE_ID / "orgs" / PINNED_ORG / "knowledge-base"
    ).resolve()


def live_epoch_authorized():
    return (
        os.environ.get(LIVE_EPOCH_ENV, "").strip() == "1"
        and os.environ.get("CTX_INSTANCE_ID", "").strip() == PINNED_INSTANCE_ID
    )


def assert_never_hosted_kb(path):
    """Corpus inventory and similar walks never use the hosted KB, even in live epoch."""
    if hosted_kb_root(path) is not None:
        raise LiveEpochBlocked(path)


def assert_not_live_epoch(path):
    hosted = hosted_kb_root(path)
    if hosted is None:
        return
    if live_epoch_authorized() and hosted == pinned_live_kb():
        return
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


def assert_recovery_archive_sufficient(archive_path):
    """Refuse fleet-hot-state-style archives that omit embedding-cache or chromadb."""
    archive = Path(archive_path).expanduser().resolve()
    assert_not_live_epoch(archive)
    if not archive.is_file():
        raise BackupRefused(f"backup archive missing: {archive}")
    with tarfile.open(archive, "r:*") as tar:
        names = set(tar.getnames())
    missing = []
    if not any(name == "chromadb" or name.startswith("chromadb/") for name in names):
        missing.append("chromadb/")
    for member in ("config.json", "embedding-cache.sqlite"):
        if member not in names:
            missing.append(member)
    if missing:
        raise BackupRefused(
            "recovery archive insufficient (fleet-hot-state-style omissions): "
            f"missing {missing}"
        )


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
    assert_recovery_archive_sufficient(archive)

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


class InventoryRefused(Exception):
    result = "INVENTORY_REFUSED"


def _is_chroma_persist_root(path):
    root = Path(path).resolve()
    return root.name == "chromadb" or (root / "chroma.sqlite3").is_file()


def _ignore_like_ingest(path):
    import mmrag
    return mmrag._is_ignored(Path(path))


def inventory_corpus_roots(roots, *, ignore_fn=None):
    """Oracle A: canonical ingest-root file list. Never opens Chroma."""
    if not roots:
        raise InventoryRefused(
            "corpus inventory requires explicit roots; refusing implicit live reconcile roots"
        )
    ignore = ignore_fn or _ignore_like_ingest
    files = []
    seen = set()
    resolved_roots = []
    for raw_root in roots:
        root = Path(raw_root).expanduser().resolve()
        assert_never_hosted_kb(root)
        if _is_chroma_persist_root(root):
            raise InventoryRefused(f"refuse chroma persist dir as corpus root: {root}")
        if not root.is_dir():
            raise InventoryRefused(f"corpus root missing: {root}")
        resolved_roots.append(str(root))
        for dirpath, dirnames, filenames in os.walk(root):
            current = Path(dirpath)
            dirnames[:] = sorted(
                name for name in dirnames
                if not ignore(current / name)
            )
            for name in sorted(filenames):
                if name.startswith("."):
                    continue
                path = current / name
                if ignore(path) or not path.is_file():
                    continue
                resolved = str(path.resolve())
                if resolved in seen:
                    continue
                seen.add(resolved)
                info = path.stat()
                files.append({
                    "path": resolved,
                    "size": info.st_size,
                    "mtime_ns": info.st_mtime_ns,
                    "sha256": _sha256_file(path),
                })
    files.sort(key=lambda row: row["path"])
    return {
        "result": "INVENTORY_OK",
        "files": files,
        "count": len(files),
        "roots": resolved_roots,
    }


class RebuildRefused(Exception):
    result = "REBUILD_REFUSED"


SIDE_WORK_DIRNAME = "recovery-side"


def assert_side_rebuild_target(live_chromadb, target):
    """Refuse live persist and live rebuild-temp names as recovery targets."""
    live = Path(live_chromadb).expanduser().resolve()
    dest = Path(target).expanduser().resolve()
    assert_not_live_epoch(live)
    assert_not_live_epoch(dest)
    if dest == live:
        raise RebuildRefused("recovery refuses native client construction against live chromadb")
    if dest.name.startswith("chromadb.rebuild-"):
        raise RebuildRefused("recovery refuses live rebuild temp persist names")


def prepare_side_rebuild_scaffold(
    kb_root,
    *,
    copy_live_cache=False,
    work_dirname=None,
    refuse_work_dirnames=None,
):
    """Create an empty sibling persist plus FR-015 side cache. Does not ingest."""
    kb = Path(kb_root).expanduser().resolve()
    assert_not_live_epoch(kb)
    name = work_dirname or SIDE_WORK_DIRNAME
    refused = set(refuse_work_dirnames or ())
    if name in refused:
        raise RebuildRefused(f"refuse reuse of timed-out side work dir {name}")
    live_chromadb = (kb / "chromadb").resolve()
    work_dir = (kb / name).resolve()
    persist_dir = (work_dir / "chromadb").resolve()
    if persist_dir.exists() and any(persist_dir.iterdir()):
        raise RebuildRefused(f"side persist already populated: {persist_dir}")
    work_dir.mkdir(parents=True, exist_ok=True)
    persist_dir.mkdir(parents=True, exist_ok=True)
    if any(path.is_file() for path in persist_dir.rglob("*")):
        raise RebuildRefused(f"side persist is not empty: {persist_dir}")
    assert_side_rebuild_target(live_chromadb, persist_dir)

    import mmrag
    previous_dir = mmrag.MMRAG_DIR
    previous_chroma = mmrag.CHROMADB_DIR
    previous_cache = os.environ.get("MMRAG_EMBED_CACHE_PATH")
    previous_side = os.environ.get("MMRAG_SIDE_CHROMADB_DIR")
    try:
        mmrag.MMRAG_DIR = kb
        mmrag.CHROMADB_DIR = live_chromadb
        os.environ.pop("MMRAG_EMBED_CACHE_PATH", None)
        os.environ.pop("MMRAG_SIDE_CHROMADB_DIR", None)
        cache_path = mmrag.prepare_side_embed_cache(
            work_dir,
            copy_from_live=copy_live_cache,
        )
    finally:
        mmrag.MMRAG_DIR = previous_dir
        mmrag.CHROMADB_DIR = previous_chroma
        if previous_cache is None:
            os.environ.pop("MMRAG_EMBED_CACHE_PATH", None)
        else:
            os.environ["MMRAG_EMBED_CACHE_PATH"] = previous_cache
        if previous_side is None:
            os.environ.pop("MMRAG_SIDE_CHROMADB_DIR", None)
        else:
            os.environ["MMRAG_SIDE_CHROMADB_DIR"] = previous_side

    return {
        "result": "SIDE_SCAFFOLD_OK",
        "work_dir": str(work_dir),
        "persist_dir": str(persist_dir),
        "embed_cache_path": str(cache_path),
        "live_chromadb": str(live_chromadb),
        "env": {
            "MMRAG_DIR": str(kb),
            "MMRAG_CHROMADB_DIR": str(persist_dir),
            "MMRAG_SIDE_CHROMADB_DIR": str(persist_dir),
            "MMRAG_EMBED_CACHE_PATH": str(cache_path),
        },
    }


class FreezeRefused(Exception):
    result = "FREEZE_REFUSED"


class ConservationFailed(Exception):
    result = "CONSERVATION_FAIL"


class PromoteRefused(Exception):
    result = "PROMOTE_REFUSED"


def _atomic_write_bytes(path, data, *, mode):
    dest = Path(path)
    tmp = dest.with_name(dest.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    os.chmod(dest, mode)
    return dest


def agent_crons_path(instance_id, agent):
    return (
        LIVE_CORTEXTOS_ROOT / instance_id / ".cortextOS" / "state" / "agents"
        / agent / "crons.json"
    )


def _freeze_reconcile_job(data):
    """Set enabled=false on kb-reconcile-nightly only. Leave prompt/schedule."""
    jobs = data.get("crons")
    if not isinstance(jobs, list):
        raise FreezeRefused("crons.json missing crons list")
    matched = 0
    for job in jobs:
        if not isinstance(job, dict) or job.get("name") != RECONCILE_JOB_NAME:
            continue
        job["enabled"] = False
        matched += 1
    if matched != 1:
        raise FreezeRefused(
            f"expected exactly one {RECONCILE_JOB_NAME} job, found {matched}"
        )
    return data


def freeze_writers(instance_id, evidence_dir, *, kb_root, cron_files=None):
    """FR-003 + exclusive NATIVE_HOLD. Does not open Chroma."""
    if instance_id != PINNED_INSTANCE_ID:
        raise FreezeRefused(f"refuse freeze for instance {instance_id}")
    kb = Path(kb_root).expanduser().resolve()
    assert_not_live_epoch(kb)
    evidence = Path(evidence_dir).expanduser().resolve()
    if hosted_kb_root(evidence) is not None:
        raise FreezeRefused(f"evidence dir must not sit inside the hosted KB: {evidence}")
    evidence.mkdir(parents=True, exist_ok=True)
    originals = evidence / "cron-originals"
    originals.mkdir(parents=True, exist_ok=True)

    cron_receipts = []
    for agent in RECONCILE_AGENTS:
        if cron_files is not None:
            if agent not in cron_files:
                raise FreezeRefused(f"missing cron file mapping for {agent}")
            cron_path = Path(cron_files[agent]).expanduser().resolve()
        else:
            cron_path = agent_crons_path(instance_id, agent)
        if not cron_path.is_file():
            raise FreezeRefused(f"missing cron file: {cron_path}")
        original = cron_path.read_bytes()
        digest = hashlib.sha256(original).hexdigest()
        saved = originals / f"{agent}-crons.json"
        if saved.exists():
            if hashlib.sha256(saved.read_bytes()).hexdigest() != digest:
                raise FreezeRefused(f"cron original already saved and differs: {saved}")
        else:
            saved.write_bytes(original)
            os.chmod(saved, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        data = json.loads(original.decode("utf-8"))
        prompt_before = {
            job["name"]: job.get("prompt")
            for job in data.get("crons", [])
            if isinstance(job, dict) and "name" in job
        }
        schedule_before = {
            job["name"]: job.get("schedule")
            for job in data.get("crons", [])
            if isinstance(job, dict) and "name" in job
        }
        _freeze_reconcile_job(data)
        for job in data["crons"]:
            if job.get("name") == RECONCILE_JOB_NAME:
                if job.get("prompt") != prompt_before.get(RECONCILE_JOB_NAME):
                    raise FreezeRefused("refuse cron prompt rewrite")
                if job.get("schedule") != schedule_before.get(RECONCILE_JOB_NAME):
                    raise FreezeRefused("refuse cron schedule rewrite")
                if job.get("enabled") is not False:
                    raise FreezeRefused("reconcile job was not disabled")
            elif job.get("name") == FRANK2_JOB_NAME and job.get("enabled") is False:
                raise FreezeRefused("refuse disabling frank2 weekly-synthesis")
        _atomic_write_bytes(
            cron_path,
            (json.dumps(data, indent=2) + "\n").encode("utf-8"),
            mode=stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH,
        )
        cron_receipts.append({
            "agent": agent,
            "path": str(cron_path.resolve()),
            "original_sha256": digest,
            "original_copy": str(saved),
        })

    hold_path = kb / NATIVE_HOLD_FILENAME
    _atomic_write_bytes(
        hold_path,
        (json.dumps({"mode": "exclusive"}) + "\n").encode("utf-8"),
        mode=0o600,
    )
    return {
        "result": "FREEZE_OK",
        "hold_path": str(hold_path),
        "hold_mode": "exclusive",
        "instance_id": instance_id,
        "crons": cron_receipts,
    }


def restore_writer_crons(freeze_receipt):
    """Byte-restore cron files saved during freeze. Does not lift NATIVE_HOLD."""
    restored = []
    for item in freeze_receipt.get("crons", []):
        original = Path(item["original_copy"])
        dest = Path(item["path"])
        data = original.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != item["original_sha256"]:
            raise FreezeRefused(f"original cron copy hash mismatch: {original}")
        _atomic_write_bytes(
            dest,
            data,
            mode=stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH,
        )
        restored.append({"path": str(dest), "sha256": digest})
    return {"result": "CRON_RESTORE_OK", "restored": restored}


def probe_runtime_identity(python_executable):
    """Record interpreter and native binding identity in a child process."""
    python = Path(python_executable).expanduser()
    if not python.is_file():
        return {
            "result": "UNSUPPORTED_RUNTIME",
            "detail": f"python executable missing: {python}",
            "python_executable": str(python),
            "live_health_proven": False,
        }
    proc = subprocess.run(
        [str(python), "-c", _RUNTIME_PROBE],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if proc.returncode != 0:
        return {
            "result": "UNSUPPORTED_RUNTIME",
            "detail": f"runtime probe exited {proc.returncode}: {proc.stderr.strip()}",
            "python_executable": str(python),
            "live_health_proven": False,
        }
    try:
        identity = json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        return {
            "result": "UNSUPPORTED_RUNTIME",
            "detail": f"runtime probe output not parseable: {exc}",
            "python_executable": str(python),
            "live_health_proven": False,
        }
    identity["result"] = "IDENTITY_OK"
    identity["live_health_proven"] = False
    return identity


def preflight_native_runtime(python_executable):
    identity = probe_runtime_identity(python_executable)
    if identity.get("result") != "IDENTITY_OK":
        return identity
    tuple_key = (identity.get("python_version"), identity.get("chromadb_version"))
    if tuple_key not in SUPPORTED_NATIVE_TUPLES:
        return {
            "result": "UNSUPPORTED_RUNTIME",
            "python_version": identity.get("python_version"),
            "chromadb_version": identity.get("chromadb_version"),
            "python_executable": identity.get("python_executable"),
            "bindings_path": identity.get("bindings_path"),
            "bindings_sha256": identity.get("bindings_sha256"),
            "supported_tuples": sorted(
                f"{py}+{chroma}" for py, chroma in SUPPORTED_NATIVE_TUPLES
            ),
            "live_health_proven": False,
            "detail": (
                f"unsupported native tuple {tuple_key[0]}+{tuple_key[1]}; "
                "a supported tuple is not proof the live store is healthy"
            ),
        }
    return {
        "result": "RUNTIME_OK",
        "python_version": identity.get("python_version"),
        "chromadb_version": identity.get("chromadb_version"),
        "python_executable": identity.get("python_executable"),
        "bindings_path": identity.get("bindings_path"),
        "bindings_sha256": identity.get("bindings_sha256"),
        "live_health_proven": False,
        "detail": "supported tuple recorded; not proof the live store is healthy",
    }


def _reap_worker(proc):
    """Stop a worker we spawned. Never used against drain openers."""
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=WORKER_TERM_GRACE_S)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=WORKER_TERM_GRACE_S)


def run_isolated_chroma_worker(
    argv,
    *,
    python_executable,
    timeout_s,
    env=None,
    cwd=None,
    require_supported=True,
    log_path=None,
    log_mode="w",
):
    """Run native work in a child. Timeout/signal are typed. No retry."""
    if require_supported:
        preflight = preflight_native_runtime(python_executable)
        if preflight["result"] != "RUNTIME_OK":
            return preflight
    else:
        preflight = {
            "result": "RUNTIME_OK",
            "python_executable": str(python_executable),
            "live_health_proven": False,
            "detail": "preflight skipped for fixture isolation tests",
        }
    worker_env = os.environ.copy()
    if env:
        worker_env.update({key: str(value) for key, value in env.items()})
    worker_env[ISOLATED_WORKER_ENV] = "1"
    worker_env["PYTHONUNBUFFERED"] = "1"
    worker_env["CTX_INSTANCE_ID"] = worker_env.get("CTX_INSTANCE_ID", PINNED_INSTANCE_ID)
    cmd = [str(python_executable), "-X", "faulthandler", *[str(part) for part in argv]]
    log_handle = None
    if log_path is not None:
        log = Path(log_path)
        log.parent.mkdir(parents=True, exist_ok=True)
        mode = "a" if log_mode == "a" else "w"
        log_handle = open(log, mode, encoding="utf-8", buffering=1)
        stdout_handle = log_handle
        stderr_handle = log_handle
    else:
        stdout_handle = subprocess.PIPE
        stderr_handle = subprocess.PIPE
    try:
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=stdout_handle,
                stderr=stderr_handle,
                text=True,
                env=worker_env,
                cwd=cwd,
                start_new_session=True,
            )
        except OSError as exc:
            return {
                "result": "UNSUPPORTED_RUNTIME",
                "detail": f"failed to spawn isolated worker: {exc}",
                "live_health_proven": False,
                "preflight": preflight,
            }
        try:
            stdout, stderr = proc.communicate(timeout=float(timeout_s))
        except subprocess.TimeoutExpired:
            _reap_worker(proc)
            stdout, stderr = proc.communicate()
            return {
                "result": "WORKER_TIMEOUT",
                "timeout_s": timeout_s,
                "hook_query_timeout_ms": HOOK_QUERY_TIMEOUT_MS,
                "bus_query_timeout_ms": BUS_QUERY_TIMEOUT_MS,
                "retry": False,
                "stdout": stdout or "",
                "stderr": stderr or "",
                "log_path": str(log_path) if log_path else None,
                "preflight": preflight,
                "live_health_proven": False,
            }
        if proc.returncode < 0:
            return {
                "result": "WORKER_SIGNALED",
                "signal": -proc.returncode,
                "retry": False,
                "stdout": stdout or "",
                "stderr": stderr or "",
                "log_path": str(log_path) if log_path else None,
                "preflight": preflight,
                "live_health_proven": False,
            }
        return {
            "result": "WORKER_OK" if proc.returncode == 0 else "WORKER_EXIT",
            "returncode": proc.returncode,
            "retry": False,
            "stdout": stdout or "",
            "stderr": stderr or "",
            "log_path": str(log_path) if log_path else None,
            "preflight": preflight,
            "live_health_proven": False,
        }
    finally:
        if log_handle is not None:
            log_handle.close()


def classify_supervised_file(path, *, batch_timeout_s):
    """Return (kind, timeout_s) for one ingest path. Path must exist."""
    resolved = Path(path)
    suffix = resolved.suffix.lower()
    if suffix in VIDEO_BATCH_EXTS:
        return "video", ISOLATED_VIDEO_BATCH_TIMEOUT_S
    if suffix in LARGE_JSON_EXTS and resolved.stat().st_size >= LARGE_JSON_MIN_BYTES:
        return "large_json", ISOLATED_LARGE_JSON_BATCH_TIMEOUT_S
    return "default", batch_timeout_s


def plan_supervised_batches(paths, *, batch_size, batch_timeout_s):
    """Split explicit files into isolated batches. No worker spawn."""
    batches = []
    current = []
    for path in paths:
        kind, timeout = classify_supervised_file(path, batch_timeout_s=batch_timeout_s)
        if kind != "default":
            if current:
                batches.append(("default", current, batch_timeout_s))
                current = []
            batches.append((kind, [path], timeout))
        else:
            current.append(path)
            if len(current) >= batch_size:
                batches.append(("default", current, batch_timeout_s))
                current = []
    if current:
        batches.append(("default", current, batch_timeout_s))
    return batches


def clone_confirmed_generation(src_work_dir, dest_work_dir):
    """Filesystem clone of a confirmed side generation. Never writes the source."""
    src = Path(src_work_dir).expanduser().resolve()
    dest = Path(dest_work_dir).expanduser().resolve()
    assert_not_live_epoch(src)
    assert_not_live_epoch(dest)
    if dest == src:
        raise RebuildRefused("refuse snapshot onto the source generation")
    if src.name == RECOVERY_SIDE_V3_DIRNAME and dest.name == RECOVERY_SIDE_V3_DIRNAME:
        raise RebuildRefused("refuse mutation of recovery-side-3")
    if dest.name == RECOVERY_SIDE_V3_DIRNAME:
        raise RebuildRefused("refuse writing recovery-side-3")
    src_persist = src / "chromadb"
    src_sqlite = src_persist / "chroma.sqlite3"
    if not src_sqlite.is_file():
        raise RebuildRefused(f"source persist missing: {src_sqlite}")
    if dest.exists() and any(dest.iterdir()):
        raise RebuildRefused(f"destination generation is not empty: {dest}")
    before = (src_sqlite.stat().st_size, src_sqlite.stat().st_mtime_ns, src_sqlite.read_bytes()[:64])
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src_persist, dest / "chromadb")
    src_cache = src / "embedding-cache.sqlite"
    dest_cache = dest / "embedding-cache.sqlite"
    if src_cache.is_file():
        shutil.copy2(src_cache, dest_cache)
    progress_src = src / "supervised-ingest-progress.json"
    completed = []
    collection = "shared-clearworksai"
    if progress_src.is_file():
        loaded = json.loads(progress_src.read_text(encoding="utf-8"))
        completed = list(loaded.get("completed") or [])
        collection = loaded.get("collection") or collection
    dest_persist = str((dest / "chromadb").resolve())
    _write_supervised_progress(dest / "supervised-ingest-progress.json", {
        "persist": dest_persist,
        "completed": completed,
        "collection": collection,
        "cloned_from": str(src),
    })
    after = (src_sqlite.stat().st_size, src_sqlite.stat().st_mtime_ns, src_sqlite.read_bytes()[:64])
    if after != before:
        raise RebuildRefused("source generation mutated during clone")
    return {
        "result": "CLONE_OK",
        "src_work_dir": str(src),
        "dest_work_dir": str(dest),
        "persist_dir": dest_persist,
        "embed_cache_path": str(dest_cache) if dest_cache.is_file() else None,
        "completed_count": len(completed),
        "src_sqlite_bytes": before[0],
        "src_sqlite_mtime_ns": before[1],
        "source_unchanged": True,
        "env": {
            "MMRAG_CHROMADB_DIR": dest_persist,
            "MMRAG_SIDE_CHROMADB_DIR": dest_persist,
            "MMRAG_EMBED_CACHE_PATH": str(dest_cache) if dest_cache.is_file() else "",
        },
    }


def _refuse_live_or_v3_persist(path):
    resolved = Path(path).expanduser().resolve()
    live = (pinned_live_kb() / "chromadb").resolve()
    if resolved == live:
        raise RebuildRefused("refuse writing live persist")
    if RECOVERY_SIDE_V3_DIRNAME in resolved.parts:
        raise RebuildRefused("refuse writing recovery-side-3")
    return resolved


def snapshot_side_persist(persist_dir, snapshot_dir):
    """Copy a side persist for chunk retry. Never writes recovery-side-3 or live."""
    src = Path(persist_dir).expanduser().resolve()
    dest = Path(snapshot_dir).expanduser().resolve()
    assert_not_live_epoch(src)
    assert_not_live_epoch(dest)
    if dest == src:
        raise RebuildRefused("refuse snapshot onto the source persist")
    _refuse_live_or_v3_persist(dest)
    sqlite = src / "chroma.sqlite3"
    if not sqlite.is_file():
        raise RebuildRefused(f"persist missing: {sqlite}")
    if dest.exists():
        raise RebuildRefused(f"snapshot dest already exists: {dest}")
    tmp = dest.with_name(dest.name + ".tmp")
    if tmp.exists():
        shutil.rmtree(tmp)
    before = (sqlite.stat().st_size, sqlite.stat().st_mtime_ns)
    shutil.copytree(src, tmp)
    after = (sqlite.stat().st_size, sqlite.stat().st_mtime_ns)
    if after != before:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RebuildRefused("source persist mutated during snapshot")
    os.rename(tmp, dest)
    return {
        "result": "SNAPSHOT_OK",
        "src_persist": str(src),
        "snapshot_dir": str(dest),
        "src_sqlite_bytes": before[0],
        "source_unchanged": True,
        "atomic": True,
    }


def restore_side_persist_from_snapshot(persist_dir, snapshot_dir):
    """Replace a side persist with its pre-chunk snapshot. Never writes v3 or live."""
    src = Path(snapshot_dir).expanduser().resolve()
    dest = Path(persist_dir).expanduser().resolve()
    assert_not_live_epoch(src)
    assert_not_live_epoch(dest)
    if dest == src:
        raise RebuildRefused("refuse restore onto the snapshot itself")
    _refuse_live_or_v3_persist(dest)
    sqlite = src / "chroma.sqlite3"
    if not sqlite.is_file():
        raise RebuildRefused(f"snapshot persist missing: {sqlite}")
    tmp = dest.with_name(dest.name + ".restore-tmp")
    failed = dest.with_name(dest.name + ".failed-tmp")
    if tmp.exists():
        shutil.rmtree(tmp)
    if failed.exists():
        shutil.rmtree(failed)
    shutil.copytree(src, tmp)
    if dest.exists():
        os.rename(dest, failed)
    os.rename(tmp, dest)
    if failed.exists():
        shutil.rmtree(failed)
    return {
        "result": "RESTORE_OK",
        "src_snapshot": str(src),
        "persist_dir": str(dest),
        "src_sqlite_bytes": sqlite.stat().st_size,
    }


def verify_confirmed_source_ids(completed_paths, present_source_files):
    completed = [str(path) for path in (completed_paths or []) if path]
    present = {str(path) for path in (present_source_files or []) if path}
    missing = sorted(set(completed) - present)
    extra = sorted(present - set(completed))
    if missing:
        raise ConservationFailed(
            f"CONFIRMED_IDS_FAIL missing={len(missing)} extra={len(extra)}"
        )
    return {
        "result": "CONFIRMED_IDS_OK",
        "confirmed_count": len(completed),
        "store_unique_sources": len(present),
        "missing_confirmed": [],
        "extra_in_store": extra,
    }


def verify_store_ids_survived(before_source_files, after_source_files):
    """Cloned chroma source IDs must remain after a later chunk. New IDs are allowed."""
    before = {str(path) for path in (before_source_files or []) if path}
    after = {str(path) for path in (after_source_files or []) if path}
    missing = sorted(before - after)
    added = sorted(after - before)
    if missing:
        raise ConservationFailed(
            f"STORE_IDS_FAIL missing={len(missing)} added={len(added)}"
        )
    return {
        "result": "STORE_IDS_SURVIVED",
        "before_count": len(before),
        "after_count": len(after),
        "added_count": len(added),
        "added": added,
        "missing": [],
    }


def remaining_file_manifest(inventory, present_source_files, completed_paths=None):
    """Unfinished IDs only: inventory minus store IDs minus confirmed progress attempts."""
    present = {str(path) for path in (present_source_files or []) if path}
    attempted = {str(path) for path in (completed_paths or []) if path}
    files = [row["path"] for row in (inventory or {}).get("files") or [] if row.get("path")]
    remaining = [
        path for path in files if path not in present and path not in attempted
    ]
    return {
        "result": "REMAINING_MANIFEST_OK",
        "inventory_count": len(files),
        "present_count": len(present),
        "attempted_count": len(attempted),
        "remaining_count": len(remaining),
        "remaining": remaining,
        "zero_chunk_attempts": sorted(attempted - present),
    }


def next_atomic_chunk(remaining_paths, *, batch_size=None, batch_timeout_s=None):
    paths = [str(path) for path in (remaining_paths or [])]
    if not paths:
        return {"kind": "empty", "files": [], "timeout_s": 0}
    size = ISOLATED_CHUNK_MAX_FILES if batch_size is None else int(batch_size)
    timeout_s = ISOLATED_CHUNK_TIMEOUT_S if batch_timeout_s is None else int(batch_timeout_s)
    batches = plan_supervised_batches(
        paths,
        batch_size=size,
        batch_timeout_s=timeout_s,
    )
    kind, files, timeout = batches[0]
    if timeout >= 6 * 3600:
        raise RebuildRefused("chunk timeout refuses a 6h-or-longer wall")
    return {"kind": kind, "files": files, "timeout_s": timeout}


def run_one_recovery_chunk(
    remaining_paths,
    *,
    confirmed_paths,
    python_executable,
    mmrag_py,
    env,
    progress_path,
    log_path,
    chunk_receipt_path,
    collection="shared-clearworksai",
    batch_size=None,
    batch_timeout_s=None,
):
    """Ingest one small chunk. Confirmed IDs never replay. Failed chunk may retry alone."""
    confirmed = {str(path) for path in (confirmed_paths or [])}
    remaining = [str(path) for path in (remaining_paths or [])]
    overlap = [path for path in remaining if path in confirmed]
    if overlap:
        raise RebuildRefused(f"refuse replay of {len(overlap)} confirmed IDs")
    chunk = next_atomic_chunk(
        remaining,
        batch_size=batch_size,
        batch_timeout_s=batch_timeout_s,
    )
    if chunk["kind"] == "empty":
        return {"result": "NO_REMAINING", "retry_chunk": False, "replay_confirmed": False}
    persist = str(Path(env.get("MMRAG_SIDE_CHROMADB_DIR", "")).expanduser().resolve()) if env.get("MMRAG_SIDE_CHROMADB_DIR") else ""
    progress_file = Path(progress_path)
    progress_completed = set()
    loaded_progress = None
    if progress_file.is_file():
        loaded_progress = json.loads(progress_file.read_text(encoding="utf-8"))
        if loaded_progress.get("persist") and persist and loaded_progress.get("persist") != persist:
            raise RebuildRefused("progress persist mismatch; refuse mixing generations")
        progress_completed = set(loaded_progress.get("completed") or [])
    replay_progress = [path for path in chunk["files"] if path in progress_completed]
    if replay_progress:
        raise RebuildRefused(
            f"refuse replay of {len(replay_progress)} confirmed progress IDs"
        )
    receipt = run_isolated_chroma_worker(
        [str(mmrag_py), "ingest", *chunk["files"], "-c", collection, "--json"],
        python_executable=python_executable,
        timeout_s=chunk["timeout_s"],
        env=env,
        require_supported=True,
        log_path=log_path,
        log_mode="a",
    )
    out = dict(receipt)
    out["retry"] = False
    out["replay_confirmed"] = False
    out["batch_kind"] = chunk["kind"]
    out["chunk_files"] = chunk["files"]
    out["persist"] = persist
    if receipt.get("result") != "WORKER_OK":
        out["retry_chunk"] = True
        _write_supervised_progress(chunk_receipt_path, out)
        return out
    out["retry_chunk"] = False
    completed = list(loaded_progress.get("completed") or confirmed_paths or []) if loaded_progress else list(confirmed_paths or [])
    if set(chunk["files"]) & set(completed):
        raise RebuildRefused("chunk files already in confirmed progress")
    completed.extend(chunk["files"])
    _write_supervised_progress(progress_file, {
        "persist": persist,
        "completed": completed,
        "collection": collection,
    })
    out["completed_count"] = len(completed)
    _write_supervised_progress(chunk_receipt_path, out)
    return out


def _write_supervised_progress(progress_path, payload):
    dest = Path(progress_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, dest)


def supervised_side_ingest(
    files,
    *,
    python_executable,
    mmrag_py,
    env,
    progress_path,
    log_path,
    collection="shared-clearworksai",
    batch_size=ISOLATED_INGEST_BATCH_MAX_FILES,
    batch_timeout_s=ISOLATED_INGEST_BATCH_TIMEOUT_S,
):
    """Ingest explicit files in isolated batches. Never wrap the full corpus in one wall.

    A timed-out batch must not be retried against the same side persist.
    """
    if batch_timeout_s >= 6 * 3600:
        raise RebuildRefused("supervised ingest refuses a 6h-or-longer corpus wall")
    if batch_size > ISOLATED_INGEST_BATCH_MAX_FILES:
        raise RebuildRefused(
            f"batch_size {batch_size} exceeds {ISOLATED_INGEST_BATCH_MAX_FILES}"
        )
    persist = str(Path(env.get("MMRAG_SIDE_CHROMADB_DIR", "")).expanduser().resolve()) if env.get("MMRAG_SIDE_CHROMADB_DIR") else ""
    if not persist:
        raise RebuildRefused("supervised ingest requires MMRAG_SIDE_CHROMADB_DIR")
    paths = []
    for raw in files:
        path = Path(raw).expanduser().resolve()
        if path.is_dir():
            raise RebuildRefused(
                f"supervised ingest refuses directory roots (would recreate the 6h corpus wall): {path}"
            )
        if not path.is_file():
            raise RebuildRefused(f"ingest path missing: {path}")
        paths.append(str(path))
    progress_file = Path(progress_path)
    completed = []
    if progress_file.is_file():
        loaded = json.loads(progress_file.read_text(encoding="utf-8"))
        if loaded.get("persist") != persist:
            raise RebuildRefused("progress persist mismatch; refuse resume on different side bytes")
        completed = list(loaded.get("completed") or [])
    completed_set = set(completed)
    pending = [path for path in paths if path not in completed_set]
    batches = plan_supervised_batches(
        pending,
        batch_size=batch_size,
        batch_timeout_s=batch_timeout_s,
    )
    for batch_index, (kind, batch, timeout) in enumerate(batches):
        if timeout >= 6 * 3600:
            raise RebuildRefused("supervised ingest refuses a 6h-or-longer corpus wall")
        receipt = run_isolated_chroma_worker(
            [str(mmrag_py), "ingest", *batch, "-c", collection, "--json"],
            python_executable=python_executable,
            timeout_s=timeout,
            env=env,
            require_supported=True,
            log_path=log_path,
            log_mode="a",
        )
        if receipt.get("result") != "WORKER_OK":
            receipt = dict(receipt)
            receipt["retry"] = False
            receipt["batch_index"] = batch_index
            receipt["batch_kind"] = kind
            receipt["completed_count"] = len(completed)
            receipt["persist"] = persist
            return receipt
        completed.extend(batch)
        _write_supervised_progress(progress_file, {
            "persist": persist,
            "completed": completed,
            "collection": collection,
        })
    return {
        "result": "SUPERVISED_INGEST_OK",
        "retry": False,
        "completed_count": len(completed),
        "batch_count": len(batches),
        "batch_timeout_s": batch_timeout_s,
        "video_batch_timeout_s": ISOLATED_VIDEO_BATCH_TIMEOUT_S,
        "large_json_batch_timeout_s": ISOLATED_LARGE_JSON_BATCH_TIMEOUT_S,
        "large_json_min_bytes": LARGE_JSON_MIN_BYTES,
        "persist": persist,
    }


def compare_conservation(oracle_a, oracle_b):
    """Comparator C: inventory vs side export. No Chroma import."""
    a_files = list((oracle_a or {}).get("files") or [])
    b_chunks = list((oracle_b or {}).get("chunks") or [])
    a_paths = {row["path"] for row in a_files if row.get("path")}
    b_paths = {row["source_file"] for row in b_chunks if row.get("source_file")}
    missing_in_side = sorted(a_paths - b_paths)
    extra_in_side = sorted(b_paths - a_paths)
    ordinals = {}
    for row in b_chunks:
        source = row.get("source_file")
        if not source:
            continue
        ordinals.setdefault(source, []).append(row.get("chunk_index"))
    ordinal_errors = []
    for source, indexes in sorted(ordinals.items()):
        normalized = [int(idx) for idx in indexes if idx is not None]
        if sorted(normalized) != list(range(len(normalized))):
            ordinal_errors.append(source)
    if missing_in_side or extra_in_side or ordinal_errors:
        raise ConservationFailed(
            "CONSERVATION_FAIL "
            f"missing={len(missing_in_side)} extra={len(extra_in_side)} "
            f"ordinals={len(ordinal_errors)}"
        )
    return {
        "result": "CONSERVATION_PASS",
        "source_count": len(a_paths),
        "chunk_count": len(b_chunks),
        "missing_in_side": [],
        "extra_in_side": [],
        "ordinal_errors": [],
    }


def author_gold_queries(inventory, *, limit=8):
    """Gold queries from corpus files, not live retrieval."""
    files = [
        row for row in (inventory or {}).get("files") or []
        if str(row.get("path", "")).lower().endswith((".md", ".txt"))
    ]
    queries = []
    for row in files[: max(1, int(limit))]:
        path = Path(row["path"])
        stem = path.stem.replace("-", " ").replace("_", " ").strip()
        queries.append({
            "id": f"gold-{len(queries) + 1:02d}",
            "query": stem or path.name,
            "expected_source": str(path),
        })
    payload = {
        "result": "GOLD_AUTHORED",
        "derived_from": "corpus-files",
        "not_from": "live-kb-query",
        "queries": queries,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    payload["sha256"] = hashlib.sha256(canonical).hexdigest()
    return payload


def promote_side_store(
    kb_root,
    *,
    conservation_pass=False,
    gold_pass=False,
    independent_review_pass=False,
    human_l0=False,
    hold_active=False,
):
    """Journaled S/L/R rename. Refuses without conservation, gold, and review."""
    if not (conservation_pass and gold_pass and independent_review_pass and human_l0 and hold_active):
        raise PromoteRefused(
            "promotion requires FR-009 PASS, FR-010 PASS, active hold, and human L0"
        )
    kb = Path(kb_root).expanduser().resolve()
    assert_not_live_epoch(kb)
    live = kb / "chromadb"
    side = kb / SIDE_WORK_DIRNAME / "chromadb"
    rollback = kb / "chromadb.rollback"
    config_path = kb / "config.json"
    if not live.is_dir() or not side.is_dir():
        raise PromoteRefused("live and side persist dirs are required")
    if rollback.exists():
        raise PromoteRefused(f"rollback already exists: {rollback}")
    prior_config = config_path.read_bytes()
    prior_cfg = json.loads(prior_config.decode("utf-8"))
    os.rename(live, rollback)
    try:
        os.rename(side, live)
    except OSError:
        os.rename(rollback, live)
        raise
    new_cfg = dict(prior_cfg)
    new_cfg["default_collection"] = "shared-clearworksai"
    _atomic_write_bytes(
        config_path,
        (json.dumps(new_cfg, indent=2) + "\n").encode("utf-8"),
        mode=stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH,
    )
    receipt = {
        "result": "PROMOTE_OK",
        "live": str(live),
        "rollback": str(rollback),
        "prior_default_collection": prior_cfg.get("default_collection"),
        "default_collection": "shared-clearworksai",
        "hold_survives_rename": True,
    }
    (kb / "promotion-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n",
        encoding="utf-8",
    )
    return receipt


def rollback_promoted_store(kb_root):
    kb = Path(kb_root).expanduser().resolve()
    assert_not_live_epoch(kb)
    live = kb / "chromadb"
    rollback = kb / "chromadb.rollback"
    receipt_path = kb / "promotion-receipt.json"
    if not rollback.is_dir():
        raise PromoteRefused("rollback persist missing")
    if live.exists():
        failed = kb / "chromadb.failed-canary"
        if failed.exists():
            raise PromoteRefused(f"failed-canary dir already exists: {failed}")
        os.rename(live, failed)
    os.rename(rollback, live)
    if receipt_path.is_file():
        prior = json.loads(receipt_path.read_text(encoding="utf-8"))
        previous = prior.get("prior_default_collection")
        if previous is not None:
            config_path = kb / "config.json"
            cfg = json.loads(config_path.read_text(encoding="utf-8"))
            cfg["default_collection"] = previous
            _atomic_write_bytes(
                config_path,
                (json.dumps(cfg, indent=2) + "\n").encode("utf-8"),
                mode=stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH,
            )
    return {"result": "ROLLBACK_OK", "live": str(live)}

