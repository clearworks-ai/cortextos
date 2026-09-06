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

import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from atomic import atomic_write
from writeback_render import _split_sections


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
    probes = {
        "raw/media/transcripts/_state/": "raw/media/transcripts/_state/probe/progress.json",
        "*.md.lock": "raw/areas/probe.md.lock",
    }
    for pattern, probe_path in probes.items():
        res = subprocess.run(["git", "-C", str(vault), "check-ignore", "-q", probe_path], timeout=60)
        if res.returncode == 1:
            missing.append(pattern)
    return missing


def _signer_allowlist() -> set[str]:
    """Finding 4b: `signed_by` alone was a free-text field — anyone (or
    anything) able to write d09-signed.json could name itself as the
    signer. `BRAIN_SIGNERS` (comma list) overrides the default {"Josh"}."""
    override = os.environ.get("BRAIN_SIGNERS")
    if override:
        return {s.strip() for s in override.split(",") if s.strip()}
    return {"Josh"}


def _read_current_source_sha256(envelope: Path) -> str | None:
    """The CURRENT content of `<envelope>/source.sha256` (fetch_fireflies.py's
    output), stripped. None when the file is absent."""
    path = Path(envelope) / "source.sha256"
    if not path.is_file():
        return None
    value = path.read_text(encoding="utf-8").strip()
    return value or None


def _read_current_extraction_input_sha(envelope: Path) -> str | None:
    """The CURRENT `<envelope>/extraction.json`'s `inputSha` field. None when
    the file is absent, unparseable, or the field is missing/empty."""
    path = Path(envelope) / "extraction.json"
    if not path.is_file():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    value = doc.get("inputSha")
    return value if isinstance(value, str) and value.strip() else None


def validate_sign_marker(path: Path, envelope: Path | None = None) -> str | None:
    """CH-1/S-2: `marker.exists()` alone let `{}` (or a marker missing
    `signed_at`, exactly what the pre-fix test fixture wrote) satisfy D-09's
    human sign-off gate for the org's only production-write path. Returns
    None when the marker is valid, else the reason `--apply` should fail
    with (exit 15). Requires non-empty `signed_by` (from an allowlist —
    default {"Josh"}, override via `BRAIN_SIGNERS`), an RFC3339 `signed_at`,
    and a `capture_sha256` that matches the sha256 of the file named by
    `capture_path` — sign_dry_run.py writes both of the latter fields.

    Finding 4a: `capture_path` must additionally resolve to a file INSIDE
    this marker's own envelope directory (`_state/<kind>-<meeting_id>/`) —
    sign_dry_run.py copies any externally-supplied capture into
    `<envelope>/dry-run.txt` so this is always satisfiable for a genuine
    sign-off.

    D-09 review finding 1: the checks above only prove a human reviewed
    SOME capture — they say nothing about whether the source `--apply` is
    about to fetch/resolve/adapt is still the one that capture described.
    When `envelope` (the data envelope run_meeting.py calls `source_dir`,
    i.e. `raw/media/transcripts/<kind>/<meeting_id>/`, NOT this marker's own
    `_state/` directory) is given, the marker's `source_sha256` and
    `extraction_input_sha` fields (sign_dry_run.py records both at sign
    time, from that same envelope) must equal the envelope's CURRENT
    `source.sha256` and `extraction.json.inputSha`. Missing either field on
    the marker (an older/legacy marker signed before this fix) is a
    distinct failure from a genuine post-signing change, so it gets its own
    reason string; run_meeting.py calls this a second time, right after its
    fetch step (a no-op when the envelope already exists) and before
    extract/resolve/adapt would otherwise regenerate everything from
    whatever is on disk by then.

    Threat model: this gate proves the signing STEP ran (a human invoked
    sign_dry_run.py against a real, unmodified dry-run capture) after
    review — it is NOT an authenticity proof against a hostile *local*
    user. Anyone with local write access to this machine could hand-craft
    a marker, a capture file, and a matching hash. That threat is out of
    scope: local write access to this checkout already implies write
    access to the vault it gates, so forging the marker buys an attacker
    nothing they couldn't already do directly."""
    if not path.exists():
        return "d09-signed.json missing"
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "d09-signed.json is not valid JSON"
    if not isinstance(doc, dict):
        return "d09-signed.json is not a JSON object"
    signed_by = doc.get("signed_by")
    if not isinstance(signed_by, str) or not signed_by.strip():
        return "signed_by missing or empty"
    if signed_by not in _signer_allowlist():
        return f"signed_by not in allowlist: {signed_by}"
    signed_at = doc.get("signed_at")
    if not isinstance(signed_at, str) or not signed_at.strip():
        return "signed_at missing or empty"
    try:
        datetime.fromisoformat(signed_at.replace("Z", "+00:00"))
    except ValueError:
        return "signed_at is not RFC3339"
    capture_sha256 = doc.get("capture_sha256")
    if not isinstance(capture_sha256, str) or not capture_sha256.strip():
        return "capture_sha256 missing or empty"
    capture_path = doc.get("capture_path")
    if not isinstance(capture_path, str) or not capture_path.strip():
        return "capture_path missing or empty"
    capture_file = Path(capture_path)
    if not capture_file.is_file():
        return f"capture_path not found: {capture_path}"
    envelope_dir = path.resolve().parent
    try:
        capture_file.resolve().relative_to(envelope_dir)
    except ValueError:
        return "capture outside envelope"
    actual = hashlib.sha256(capture_file.read_bytes()).hexdigest()
    if actual != capture_sha256:
        return "capture_sha256 mismatch"

    if envelope is not None:
        marker_source_sha = doc.get("source_sha256")
        marker_extraction_sha = doc.get("extraction_input_sha")
        if (
            not isinstance(marker_source_sha, str) or not marker_source_sha.strip()
            or not isinstance(marker_extraction_sha, str) or not marker_extraction_sha.strip()
        ):
            return "source_sha256/extraction_input_sha missing from sign marker (re-sign after dry-run)"
        current_source_sha = _read_current_source_sha256(envelope)
        current_extraction_sha = _read_current_extraction_input_sha(envelope)
        if current_source_sha != marker_source_sha or current_extraction_sha != marker_extraction_sha:
            return "source changed since sign-off"
    return None


def writeback_marker_present(vault: Path, home_rel: str, key: str) -> bool:
    """CH-9: `progress.writeback.done` alone is not proof the write actually
    happened — a bogus or hand-edited checkpoint must not silently skip a
    page that was never touched. meeting_writeback.py stamps every write it
    makes with a `[source: <kind>:<id>]` marker (its own `key` variable) as
    a bullet inside the "History (dated, newest first)" section (see
    writeback_render._history_block/render_page).

    Finding 3: checking the marker string anywhere in the page (e.g. in a
    stray paragraph, an old draft note, or a copy/pasted quote) is a false
    positive — it proves the text exists somewhere, not that meeting_
    writeback.py actually ran and appended the History entry. Parse
    sections exactly the way writeback_render does (_split_sections) and
    only trust the marker when it appears on a line inside that specific
    section.

    Coordinator follow-up finding (2026-09-05): checking "the marker string
    appears ANYWHERE on any line inside the History section" is still a
    false positive — ordinary prose inside that section (e.g. a migration
    note that happens to mention `[source: fireflies:m1]` in passing) is
    not a writeback bullet. Require the marker to land on a line shaped
    exactly like the ones writeback_render._history_block emits: `- ` +
    an ISO date + ` — ` + free text, ending with the `[source: <kind>:<id>]`
    marker as the last characters of the line. This is a hand-written regex
    (writeback_render.py exposes no reusable prefix constant to import) but
    it mirrors _history_block's literal f-string shape byte for byte."""
    if not home_rel:
        return False
    page = Path(vault) / "raw/areas/clearworks/org-brain" / home_rel
    if not page.is_file():
        return False
    try:
        text = page.read_text(encoding="utf-8")
    except OSError:
        return False
    bullet = re.compile(r"^- \d{4}-\d{2}-\d{2} — .*\[source: " + re.escape(key) + r"\]$")
    _, sections = _split_sections(text)
    for heading, body in sections:
        if heading == "History (dated, newest first)":
            return any(bullet.match(line) for line in body.splitlines())
    return False


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


def merge_task_map(existing: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """G2-P1-3: a retry's `task_map` (from meeting-fanout.py's own JSON
    output) previously REPLACED `progress.tasks.created` wholesale, so a
    checkpoint-retry that only re-covers the still-pending ids silently
    dropped every commitmentId->taskId pair an earlier partial run had
    already recorded successfully. Dict-union keyed on `commitmentId`;
    existing (already-persisted) pairs win on key collision. Returns a list
    sorted by commitmentId for deterministic output."""
    merged: dict[str, dict[str, Any]] = {}
    for pair in new or []:
        cid = pair.get("commitmentId")
        if cid:
            merged[cid] = pair
    for pair in existing or []:
        cid = pair.get("commitmentId")
        if cid:
            merged[cid] = pair
    return [merged[cid] for cid in sorted(merged)]


def reconstruct_task_map_from_bus(meeting_id: str, commitments: dict[str, str]) -> list[dict[str, Any]]:
    """CH-5: a fanout run that dedup-SKIPs a commitment while
    `progress.tasks.created` has no entry for it means an earlier run's
    task_map was lost to a crash between fanout succeeding (the task DID
    land on the bus) and `merge_progress` persisting it — marking
    `tasks.done: true` without that mapping here would permanently lose it
    and fail acceptance forever. `commitments` maps each still-unmapped
    commitmentId to its commitment text (used only as an ambiguity
    tie-break, see below); reconstruct via `cortextos bus list-tasks
    --json`. Best-effort: returns [] entries for ids that stay unfindable
    (never raises) — the caller then refuses to mark the step done for
    those ids rather than fabricate a mapping.

    Finding 2: the pre-fix version matched on `[commitment:<id>]` as a bare
    substring of the description, with no meeting scoping — an unrelated
    task from a different meeting whose id happened to be a substring
    match (or whose description merely mentioned the id) would be silently
    attached. This now requires the exact `[commitment:<meeting_id>/<id>]`
    pair via an anchored regex, mirroring meeting-fanout.py's own
    `prod_find_task_by_commitment` (CH-4) marker and matching rule. When
    more than one bus task carries the same pair (should not happen, but
    the bus is an external system), prefer the one whose title equals the
    commitment text, else the newest (`created_at`), and log the ambiguity
    to stderr rather than silently picking one."""
    try:
        proc = subprocess.run(
            ["cortextos", "bus", "list-tasks", "--json"], capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0 or not (proc.stdout or "").strip():
        return []
    try:
        tasks = json.loads(proc.stdout)
    except ValueError:
        return []
    if not isinstance(tasks, list):
        return []
    recovered: list[dict[str, Any]] = []
    for cid, text in commitments.items():
        pattern = re.compile(r"\[commitment:" + re.escape(meeting_id) + "/" + re.escape(cid) + r"\]")
        candidates = [
            task for task in tasks
            if isinstance(task, dict)
            and pattern.search(str(task.get("desc") or task.get("description") or ""))
        ]
        if not candidates:
            continue
        chosen = candidates[0]
        if len(candidates) > 1:
            exact = [t for t in candidates if str(t.get("title") or "") == text]
            if len(exact) == 1:
                chosen = exact[0]
                print(
                    f"ambiguous commitment lookup for {meeting_id}/{cid}: "
                    f"{len(candidates)} candidates, title match wins",
                    file=sys.stderr,
                )
            else:
                chosen = sorted(
                    candidates, key=lambda t: str(t.get("created_at") or t.get("createdAt") or "")
                )[-1]
                print(
                    f"ambiguous commitment lookup for {meeting_id}/{cid}: "
                    f"{len(candidates)} candidates, using newest",
                    file=sys.stderr,
                )
        task_id = chosen.get("id") or chosen.get("taskId")
        if task_id:
            recovered.append({"commitmentId": cid, "taskId": str(task_id)})
    return recovered


def resolve_vault_sha_from_history(vault: Path, pathspec: list[str]) -> str | None:
    """CH-7: a crash between `git commit` succeeding and `progress.commit` /
    `receipt.json` being written leaves `vault_commit`'s next call correctly
    reporting "nothing to commit" (sha=None) with no `prior_receipt` to fall
    back on (first run) — the commit genuinely IS on the vault's history.
    Look up the true SHA directly rather than ever writing `vault_sha: null`
    when the pathspec plainly has history; returns None only when it truly
    has none."""
    result = subprocess.run(
        ["git", "-C", str(vault), "log", "-1", "--format=%H", "--", *pathspec],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        return None
    sha = result.stdout.strip()
    return sha or None


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
            ["git", "-C", str(vault), "add", "--", *existing], capture_output=True, text=True, timeout=60,
        )
        if add_res.returncode != 0:
            reason = (add_res.stderr or add_res.stdout or "").strip().splitlines()
            print(f"FAILED at commit: {reason[-1] if reason else add_res.returncode}", file=sys.stderr)
            raise SystemExit(10)
    if not existing:
        # CH-2: nothing of ours changed — never call `git commit` with an
        # empty pathspec, which git treats as NO pathspec restriction at all
        # (it would commit the whole index, including anything a concurrent
        # process staged that has nothing to do with this pathspec).
        return None, False
    # CH-2: scope the commit itself to the pathspec, exactly like `add` —
    # an unrestricted `git commit -m <msg>` commits the ENTIRE index, so any
    # file another process had already staged (outside this pathspec) rode
    # along in the same commit while every scoped `git status --porcelain --
    # <pathspec>` assertion still passed.
    result = subprocess.run(
        ["git", "-C", str(vault), "commit", "-m", message, "--", *existing],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        if "nothing to commit" in (result.stdout + result.stderr):
            return None, False
        reason = (result.stderr or result.stdout or "").strip().splitlines()
        print(f"FAILED at commit: {reason[-1] if reason else result.returncode}", file=sys.stderr)
        raise SystemExit(10)
    sha = subprocess.run(
        ["git", "-C", str(vault), "rev-parse", "HEAD"], capture_output=True, text=True, check=True, timeout=60,
    ).stdout.strip()
    return sha, True


def _now_iso() -> str:
    # FR-012 line ~328 ("receipt.json SHALL differ only in last_run_at" on a
    # --force re-run) requires two back-to-back --apply subprocess
    # invocations to produce distinguishable timestamps. Second-precision
    # collided when both ran inside the same wall-clock second (observed in
    # Task 10's restart/--force integration test) — milliseconds is enough
    # resolution for two real subprocess round-trips to always differ.
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


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
