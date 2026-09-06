"""FR-014 checkpoint protocol: progress.json, fanout-pending.json, receipt.json,
and the one vault commit --apply makes. No I/O side effect here reaches Gmail,
CRM, or bus — those live in the agent scripts this module's caller shells out
to.

Deviation (Task 8/9 sequencing): the plan's Task 8 file list does not
mention progress.py at all (it is nominally a Task 9 deliverable), but
Task 8's own _run_apply guard chain calls progress.progress_path,
progress.receipt_path, and progress.check_vault_gitignore (its
R2-F-4 vault-gitignore-missing test, exit 10, must pass by Task 8 Step 4).
This module is therefore created here with just the pieces Task 8 needs;
Task 9 below extends it with the remaining FR-014 machinery
(merge_progress, vault_commit, compose_receipt, crm_env, fanout_env,
parse_subprocess_json, fr014_pathspec, acceptance_minimums,
write_fanout_pending/read_fanout_pending/clear_fanout_pending)."""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from atomic import atomic_write


def _state_dir(vault: Path, kind: str, meeting_id: str) -> Path:
    return Path(vault) / "raw/media/transcripts/_state" / f"{kind}-{meeting_id}"


def progress_path(vault: Path, kind: str, meeting_id: str) -> Path:
    return _state_dir(vault, kind, meeting_id) / "progress.json"


def receipt_path(vault: Path, kind: str, meeting_id: str) -> Path:
    return _state_dir(vault, kind, meeting_id) / "receipt.json"


def fanout_pending_path(vault: Path, kind: str, meeting_id: str) -> Path:
    return _state_dir(vault, kind, meeting_id) / "fanout-pending.json"


def load_progress(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def merge_progress(path: Path, key: str, outcome: dict[str, Any]) -> dict[str, Any]:
    doc = load_progress(path)
    doc[key] = outcome
    atomic_write(path, (json.dumps(doc, sort_keys=True, indent=2) + "\n").encode("utf-8"))
    return doc


def step_done(doc: dict[str, Any], key: str) -> bool:
    step = doc.get(key)
    return bool(isinstance(step, dict) and step.get("done") is True)


def check_vault_gitignore(vault: Path) -> list[str]:
    """R2-F-4: FR-014 line ~359's "SHALL ensure raw/media/transcripts/_state/
    is listed in the vault's .gitignore" is read-only here — --apply never
    mutates .gitignore itself (Task 9 Step 0 lands it by hand, once, G0a
    F-6). Returns the subset of {_state/, *.md.lock} NOT currently ignored
    (empty = both landed). A vault that isn't a git repo at all (git
    check-ignore exits 128, not 0/1) is treated as "nothing to check" rather
    than "everything missing" — several bare test fixtures elsewhere in this
    suite use a non-git vault and never reach the commit step, and this
    precondition must not block them."""
    missing: list[str] = []
    for pattern in ("raw/media/transcripts/_state/", "*.md.lock"):
        res = subprocess.run(["git", "-C", str(vault), "check-ignore", "-q", pattern])
        if res.returncode == 1:
            missing.append(pattern)
    return missing


def crm_env(base_env: dict[str, str], repo: Path) -> dict[str, str]:
    """R2-F-1 (fold, rev3 — replaces round-1's resolve_crm_scripts): the CRM
    *code* (meeting-crm-sync.py, meeting-fanout.py) stays fixed at CODE_ROOT
    — same as WRITEBACK/RECAP — because that's the only copy carrying the R2
    flags (--full-file, --strict, --no-telegram, --no-followups,
    --retry-commitment); the shared checkout's copies are pre-R2 and exit 2
    "unrecognized arguments" the moment any of those flags is passed.
    Only the CRM *data* paths move to --repo-root (D-10):
    upsert-contact.py:18 honours CRM_CONTACTS_PATH, add-interaction.py:28
    honours CRM_INTERACTIONS_PATH, and meeting-crm-sync.py:94 /
    upsert-engagement.py:30 honour CRM_PIPELINE_PATH. meeting-crm-sync's own
    _run(argv, env=os.environ.copy()) calls (:243, :277, :361) propagate
    whatever env dict this function returns down to those two scripts."""
    env = dict(base_env)
    crm_dir = Path(repo) / "orgs/clearworksai/agents/crm/crm"
    env["CRM_CONTACTS_PATH"] = str(crm_dir / "contacts.json")
    env["CRM_INTERACTIONS_PATH"] = str(crm_dir / "interactions.jsonl")
    env["CRM_PIPELINE_PATH"] = str(crm_dir / "pipeline.json")
    return env


def fanout_env(base_env: dict[str, str]) -> dict[str, str]:
    """FR-010: the orchestrator sets FANOUT_TRIAGE_OWNER=pa-codex (G-03) and
    unsets BRIEFS_INGEST_URL (G-33) before invoking meeting-fanout.py — the
    code default (TRIAGE_OWNER = os.environ.get(..., "pa")) stays "pa" (a
    disabled agent) in code by design (out-of-scope change, §11 follow-up),
    and BRIEFS_INGEST_URL firing a real external POST must be prevented on
    the first production write (G0a F-3)."""
    env = dict(base_env)
    env["FANOUT_TRIAGE_OWNER"] = "pa-codex"
    env.pop("BRIEFS_INGEST_URL", None)
    return env


def parse_subprocess_json(stdout: str) -> dict[str, Any]:
    """meeting-crm-sync.py and meeting-fanout.py both print pretty JSON
    (json.dumps(obj, indent=2)), so stdout.splitlines()[-1] is just '}' —
    the earlier _last_json_line implementation returned {} on every real
    invocation (G0a F-1, verified empirically). Parse the whole stripped
    stdout first; if extra non-JSON output surrounds it, fall back to the
    substring from the first '{' to the last '}'."""
    text = stdout.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except ValueError:
            pass
    return {}


def fr014_pathspec(meeting_id: str, home_rel: str, note_rel: str) -> list[str]:
    """FR-014's git-add pathspec (spec line 363) for one meeting: the
    envelope dir, both ledgers, the meeting note, and (when a home page is
    resolved) the home page. Phase-3 artifacts (STATE.md, _filed.log, a
    status relPath, clients/*.md, projects/*.md last_update) are out of
    scope for R2 (FR-007/011/013 land in phase 3) so are never added here.
    A single source of truth for this list — both `_apply_writes`'s commit
    step and Task 10's G4 porcelain assertion call this (G0a F-6)."""
    entries = {
        f"raw/media/transcripts/fireflies/{meeting_id}",
        "raw/media/transcripts/_recap-ledger.txt",
        "raw/media/transcripts/_writeback-ledger.txt",
        f"raw/areas/clearworks/org-brain/{note_rel}",
    }
    if home_rel:
        entries.add(f"raw/areas/clearworks/org-brain/{home_rel}")
    return sorted(entries)


def acceptance_minimums(receipt: dict[str, Any], *, decisions_kept: int) -> list[str]:
    """FR-012 line ~332 / the R2 goal release line / G-54: the ACCEPTANCE
    MEETING's applied receipt must satisfy >=1 quoted decision kept, >=1
    OURS task created, >=5 CRM contacts grounded (6 emailed external
    attendees), and 1 draft. This is not a general per-meeting gate — a
    future meeting may legitimately have fewer contacts or no decisions —
    it is the specific G4 acceptance check (G0a F-9). Returns the list of
    unmet minimums (empty = all satisfied)."""
    problems: list[str] = []
    if decisions_kept < 1:
        problems.append(f"decisions_kept={decisions_kept} < 1")
    tasks = receipt.get("tasks") or []
    if len(tasks) < 1:
        problems.append(f"tasks={len(tasks)} < 1")
    contacts = receipt.get("contacts") or []
    if len(contacts) < 5:
        problems.append(f"contacts={len(contacts)} < 5")
    if (receipt.get("interactions") or 0) < 1:
        problems.append(f"interactions={receipt.get('interactions') or 0} < 1")
    if not receipt.get("draft"):
        problems.append("draft is null")
    return problems


def write_fanout_pending(path: Path, ids: list[str]) -> None:
    atomic_write(path, json.dumps({"pending": ids}, sort_keys=True).encode("utf-8"))


def read_fanout_pending(path: Path) -> list[str]:
    if not path.exists():
        return []
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return list(doc.get("pending") or []) if isinstance(doc, dict) else []


def clear_fanout_pending(path: Path) -> None:
    if path.exists():
        path.unlink()


def vault_commit(vault: Path, pathspec: list[str], message: str) -> tuple[str | None, bool]:
    """git add -- <existing pathspec entries> && git commit -m <message>.

    FR-014 (spec line 363) qualifies part of the pathspec with "when they
    exist" — e.g. _recap-ledger.txt is absent on a run whose draft step
    short-circuited on the ledger, or _writeback-ledger.txt on a resumed
    run. Filter to entries that exist under vault before `git add`, so a
    resumed run never raises a bare CalledProcessError (`fatal: pathspec
    ... did not match any files`, rc 128) instead of FR-014's exit 10
    (G0a F-11). Returns (sha, committed). "nothing to commit" is success
    with committed=False, sha=None — the caller keeps the prior receipt's
    vault_sha. Any other non-zero add/commit exit raises SystemExit(10).
    """
    existing = [p for p in pathspec if (Path(vault) / p).exists()]
    if existing:
        add_res = subprocess.run(
            ["git", "-C", str(vault), "add", "--", *existing], capture_output=True, text=True,
        )
        if add_res.returncode != 0:
            reason = (add_res.stderr or add_res.stdout or "").strip().splitlines()
            print(f"FAILED at commit: {reason[-1] if reason else add_res.returncode}", file=sys.stderr)
            raise SystemExit(10)
    result = subprocess.run(
        ["git", "-C", str(vault), "commit", "-m", message], capture_output=True, text=True,
    )
    if result.returncode != 0:
        if "nothing to commit" in (result.stdout + result.stderr):
            return None, False
        reason = (result.stderr or result.stdout or "").strip().splitlines()
        print(f"FAILED at commit: {reason[-1] if reason else result.returncode}", file=sys.stderr)
        raise SystemExit(10)
    sha = subprocess.run(
        ["git", "-C", str(vault), "rev-parse", "HEAD"], capture_output=True, text=True, check=True,
    ).stdout.strip()
    return sha, True


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def compose_receipt(
    doc: dict[str, Any], *, meeting_id: str, source: str, vault_sha: str | None, prior: dict[str, Any] | None,
) -> dict[str, Any]:
    now = _now_iso()
    prior = prior or {}
    first_applied_at = prior.get("first_applied_at") or now
    writeback = doc.get("writeback") or {}
    crm = doc.get("crm") or {}
    tasks = doc.get("tasks") or {}
    draft = doc.get("draft") or {}
    return {
        "meeting_id": meeting_id,
        "source": source,
        "extraction_sha": doc.get("extraction_sha"),
        "home_path": writeback.get("home_path"),
        "node": writeback.get("node"),
        "rule": writeback.get("rule"),
        "tasks": tasks.get("created") or [],
        "interactions": crm.get("interactions", 0),
        "contacts": crm.get("contacts") or [],
        "draft": draft.get("subject"),
        "status_update": doc.get("status_update") or {"done": False},
        "vault_sha": vault_sha if vault_sha is not None else prior.get("vault_sha"),
        "first_applied_at": first_applied_at,
        "last_run_at": now,
    }
