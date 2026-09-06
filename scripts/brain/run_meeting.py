#!/usr/bin/env python3
"""FR-012: orchestrate fetch → extract → resolve → adapt → dry-run writeback/recap."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import preview
import progress
from adapt_meeting import main as adapt_main
from atomic import atomic_write
from extract_meeting import main as extract_main
from fetch_fireflies import main as fetch_main
from paths import DEFAULT_REPO_ROOT, DEFAULT_VAULT, envelope_dir, safe_meeting_id
from resolve_meeting import main as resolve_main
from sign_dry_run import marker_path as sign_marker_path
from writeback_render import meeting_note_rel

HERE = Path(__file__).resolve().parent
CODE_ROOT = HERE.parent.parent
WRITEBACK = CODE_ROOT / "orgs/clearworksai/agents/pa/scripts/meeting_writeback.py"
RECAP = CODE_ROOT / "orgs/clearworksai/agents/pa/scripts/meeting_recap_draft.py"
# R2-F-1 (fold, rev3): CRM/fanout *code* is fixed at CODE_ROOT exactly like
# WRITEBACK/RECAP (the shared checkout's copies are pre-R2 and lack
# --full-file/--strict/...); only the CRM *data* paths move to --repo-root,
# via progress.crm_env in _apply_writes.
CRM_SYNC = CODE_ROOT / "orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py"
FANOUT_SCRIPT = CODE_ROOT / "orgs/clearworksai/agents/crm/crm/meeting-fanout.py"

# G2-P1-1: FR-012 line ~332's acceptance minimums (>=1 decision, >=1 OURS
# task, >=5 CRM contacts, 1 draft) are the ACCEPTANCE MEETING's own gate
# (G-54, D-11) — not a general per-meeting production block. An ordinary
# meeting with, say, 2 external attendees would legitimately (and
# permanently) fail "contacts >= 5" and could never commit. Only the listed
# meeting id(s) enforce (exit 9 on shortfall, before the commit); every
# other meeting still computes minimums into the receipt for visibility
# (`enforced: false`) but always proceeds to commit.
ACCEPTANCE_MEETING_IDS = {"01M1MW2GAZ1DQ0C6PG3KJ557JA"}

# S-5: bound every subprocess this orchestrator shells out to, so a hung
# `git`/writeback/CRM/fanout/recap child (or the bus calls they make
# internally) can never hang --apply indefinitely with no daemon watchdog to
# recover it (FR-012: "cortextos daemon not running THE SYSTEM SHALL
# complete --apply").
GIT_TIMEOUT_S = 60
CHILD_TIMEOUT_S = 600


def _acceptance_meeting_ids() -> set[str]:
    override = os.environ.get("BRAIN_ACCEPTANCE_MEETING_IDS")
    if override:
        return {x.strip() for x in override.split(",") if x.strip()}
    return set(ACCEPTANCE_MEETING_IDS)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--meeting-id", required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--force", action="store_true")
    p.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    args = p.parse_args(argv)

    meeting_id = safe_meeting_id(args.meeting_id)
    if not meeting_id:
        print("need --meeting-id", file=sys.stderr)
        return 64
    if not args.dry_run and not args.apply:
        print("need --dry-run or --apply", file=sys.stderr)
        return 64

    vault = Path(args.vault)
    repo = Path(args.repo_root)
    source_dir = envelope_dir(vault, "fireflies", meeting_id)

    if args.apply:
        return _run_apply(meeting_id, vault, repo, source_dir, force=args.force)
    return _run_dry(meeting_id, vault, repo, source_dir)


def _run_dry(meeting_id: str, vault: Path, repo: Path, source_dir: Path) -> int:
    fetch_rc = fetch_main(
        ["--meeting-id", meeting_id, "--vault", str(vault), "--repo-root", str(repo)]
    )
    if fetch_rc != 0:
        return 2 if fetch_rc != 64 else 64

    extract_rc = extract_main(["--source", str(source_dir), "--vault", str(vault)])
    if extract_rc != 0:
        return 3 if extract_rc == 3 else extract_rc

    resolve_rc = resolve_main(
        ["--source", str(source_dir), "--vault", str(vault), "--repo-root", str(repo)]
    )
    if resolve_rc != 0:
        return resolve_rc

    adapt_rc = adapt_main(["--source", str(source_dir)])
    if adapt_rc != 0:
        return adapt_rc

    validated_path = source_dir / "validated.json"
    dropped = {}
    kept_d = 0
    kept_c = 0
    if validated_path.is_file():
        validated = json.loads(validated_path.read_text(encoding="utf-8"))
        dropped = validated.get("dropped") or {}
        kept_d = len(validated.get("decisions") or [])
        kept_c = len(validated.get("commitments") or [])
    print(
        f"quotes kept decisions={kept_d} commitments={kept_c} "
        f"dropped={json.dumps(dropped, sort_keys=True)}"
    )
    from preview import bus_task_preview, crm_interaction_preview

    event_path = source_dir / "event.json"
    resolution_path = source_dir / "resolution.json"
    event = json.loads(event_path.read_text(encoding="utf-8")) if event_path.is_file() else {}
    resolution = json.loads(resolution_path.read_text(encoding="utf-8")) if resolution_path.is_file() else {}
    validated_doc = validated if validated_path.is_file() else {}

    print("crm interaction rows:")
    crm_rows = crm_interaction_preview(event, validated_doc, resolution)
    if crm_rows:
        for row in crm_rows:
            print(json.dumps(row, sort_keys=True))
    else:
        print("(none)")

    print("tasks:")
    fan_path = source_dir / "fanout-meeting.json"
    fan = json.loads(fan_path.read_text(encoding="utf-8")) if fan_path.is_file() else {}
    task_rows = bus_task_preview(fan, set(), meeting_id=meeting_id)
    if task_rows:
        for row in task_rows:
            # FR-012 line ~324 names this noun by shape: "the task list
            # (title · owner · due)" — the R1-signed capture has this exact
            # line (G0a F-12); keep it, then add the full payload beneath it.
            print(f"{row['title']} · {row['owner_label']} · due {row['due'] or 'none'}")
        print("task payloads:")
        for row in task_rows:
            print(json.dumps(row, sort_keys=True))
    else:
        print("(none)")

    with tempfile.TemporaryDirectory() as tmp:
        ledger = Path(tmp) / "ledger.txt"
        ledger.write_text("", encoding="utf-8")
        voice = Path(tmp) / "voice.md"
        vip = Path(tmp) / "vip.txt"
        voice.write_text("", encoding="utf-8")
        vip.write_text("", encoding="utf-8")
        env = os.environ.copy()
        env["ORG_ROOT"] = str(vault)
        env["LEDGER_FILE"] = str(ledger)
        env["CTX_TMP"] = tmp
        wb_payload = source_dir / "writeback-payload.json"
        recap_payload = source_dir / "recap-payload.json"
        wb = subprocess.run(
            [sys.executable, str(WRITEBACK), "--payload", str(wb_payload), "--dry-run"],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        sys.stdout.write(wb.stdout)
        if wb.returncode != 0:
            sys.stderr.write(wb.stderr)
            return wb.returncode
        rec = subprocess.run(
            [
                sys.executable,
                str(RECAP),
                "--payload",
                str(recap_payload),
                "--ledger",
                str(ledger),
                "--voice",
                str(voice),
                "--vip-list",
                str(vip),
                "--dry-run",
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        sys.stdout.write(rec.stdout)
        if rec.returncode != 0:
            sys.stderr.write(rec.stderr)
            return rec.returncode
        if ledger.read_text(encoding="utf-8").strip():
            print("ledger mutated in dry-run", file=sys.stderr)
            return 3
    return 0


def _worker_guard(meeting_id: str) -> int:
    """FR-012: timeout 5 cortextos list-workers. Non-zero/timeout/missing
    binary -> daemon down (G-60), not a failure. Implemented via subprocess's
    own timeout kwarg rather than shelling the external `timeout` binary,
    which is not present by default on macOS."""
    try:
        proc = subprocess.run(["cortextos", "list-workers"], capture_output=True, text=True, timeout=5)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        print("workers: daemon down, skipped")
        return 0
    if proc.returncode != 0:
        print("workers: daemon down, skipped")
        return 0
    for line in proc.stdout.splitlines():
        if f"meeting-writeback-{meeting_id}" in line and "running" in line:
            return 13
    return 0


def _check_crm_scripts_support_full_file() -> int:
    """R2-F-1 mechanical precondition: fail fast (exit 11), before any
    write, if the CODE_ROOT copies of meeting-crm-sync.py/meeting-fanout.py
    predate R2 (no --full-file) — rather than discovering it deep inside
    _apply_writes as an opaque `rc=2 unrecognized arguments`."""
    for script in (CRM_SYNC, FANOUT_SCRIPT):
        try:
            proc = subprocess.run(
                [sys.executable, str(script), "--help"], capture_output=True, text=True, timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            print(f"FAILED at crm: scripts predate R2 ({script}: {exc})", file=sys.stderr)
            return 11
        if "--full-file" not in (proc.stdout or ""):
            print(f"FAILED at crm: scripts predate R2 ({script} lacks --full-file)", file=sys.stderr)
            return 11
    return 0


def _run_apply(meeting_id, vault, repo, source_dir, *, force) -> int:
    # G0b C2-3: unconditional — no --skip-sign-check bypass exists.
    # CH-1/S-2: existence alone is not proof of a real sign-off — validate
    # signed_by/signed_at/capture_sha256 (progress.validate_sign_marker).
    marker = sign_marker_path(vault, "fireflies", meeting_id)
    sign_failure = progress.validate_sign_marker(marker)
    if sign_failure:
        print(f"FAILED at sign-check: {sign_failure}", file=sys.stderr)
        return 15

    guard_rc = _worker_guard(meeting_id)
    if guard_rc != 0:
        print(f"FAILED at worker-guard: meeting-writeback-{meeting_id} running", file=sys.stderr)
        return guard_rc

    # R2-F-4: read-only FR-014 line ~359 precondition — never mutates
    # .gitignore itself (Task 9 Step 0 lands it by hand, once).
    if progress.check_vault_gitignore(vault):
        print("FAILED at commit: vault .gitignore missing _state/ or *.md.lock", file=sys.stderr)
        return 10

    # R2-F-1: fail fast if CODE_ROOT's CRM/fanout scripts predate R2.
    scripts_rc = _check_crm_scripts_support_full_file()
    if scripts_rc != 0:
        return scripts_rc

    prog_path = progress.progress_path(vault, "fireflies", meeting_id)
    receipt_p = progress.receipt_path(vault, "fireflies", meeting_id)
    prior_receipt = json.loads(receipt_p.read_text(encoding="utf-8")) if receipt_p.exists() else None
    if prior_receipt and prior_receipt.get("vault_sha") and not force:
        print(f"already applied: {prior_receipt['vault_sha']}")
        return 0

    fetch_rc = fetch_main(["--meeting-id", meeting_id, "--vault", str(vault), "--repo-root", str(repo)])
    if fetch_rc != 0:
        print(f"FAILED at fetch: rc={fetch_rc}", file=sys.stderr)
        return 2

    # D-09 review finding 1: the pre-fetch sign_failure check above only
    # proves a human reviewed SOME capture — it says nothing about whether
    # the source that capture described is still what's on disk now. fetch
    # on an already-fetched envelope is a no-op (fetch_fireflies.py never
    # refetches unless --refetch is passed, and this orchestrator never
    # passes --refetch — there is no --refetch flag on this CLI at all), so
    # this second check, run immediately after fetch and before
    # extract/resolve/adapt regenerate anything, catches the envelope
    # having changed since sign-off (a manual --refetch, a hand-edited
    # source.json, or a re-extraction) before any production write happens.
    post_fetch_sign_failure = progress.validate_sign_marker(marker, envelope=source_dir)
    if post_fetch_sign_failure:
        print(f"FAILED at sign-check: {post_fetch_sign_failure}", file=sys.stderr)
        return 15

    extract_rc = extract_main(["--source", str(source_dir), "--vault", str(vault)])
    if extract_rc != 0:
        print(f"FAILED at extract: rc={extract_rc}", file=sys.stderr)
        return 3
    resolve_rc = resolve_main(["--source", str(source_dir), "--vault", str(vault), "--repo-root", str(repo)])
    if resolve_rc != 0:
        print(f"FAILED at resolve: rc={resolve_rc}", file=sys.stderr)
        return resolve_rc
    adapt_rc = adapt_main(["--source", str(source_dir)])
    if adapt_rc != 0:
        print(f"FAILED at adapt: rc={adapt_rc}", file=sys.stderr)
        return 12

    return _apply_writes(meeting_id, vault, repo, source_dir, prior_receipt=prior_receipt)


def _writeback_env(vault: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["ORG_ROOT"] = str(vault)
    env["LEDGER_FILE"] = str(vault / "raw/media/transcripts/_writeback-ledger.txt")
    env["CTX_TMP"] = str(vault / "raw/media/transcripts/_state" / "tmp")
    return env


def _home_slug(resolution: dict) -> str:
    home = str(resolution.get("home_path") or "")
    slug = Path(home).stem or "unknown"
    node = resolution.get("node")
    return f"{slug}/{node}" if node and node != "none" else slug


def _apply_writes(
    meeting_id: str, vault: Path, repo: Path, source_dir: Path, *, prior_receipt: dict | None
) -> int:
    # R2-F-1 (fold, rev3): CRM_SYNC/FANOUT_SCRIPT are fixed CODE_ROOT
    # constants (defined alongside WRITEBACK/RECAP) — the shared checkout's
    # copies of meeting-crm-sync.py/meeting-fanout.py are pre-R2 (no
    # --full-file/--strict/...), so pointing the *script* at --repo-root
    # (round 1's resolve_crm_scripts) made every CRM/fanout subprocess exit
    # 2. Only the *data* — contacts.json/interactions.jsonl/pipeline.json —
    # moves to --repo-root, via progress.crm_env below.
    source = json.loads((source_dir / "source.json").read_text(encoding="utf-8"))
    validated = json.loads((source_dir / "validated.json").read_text(encoding="utf-8"))
    resolution = json.loads((source_dir / "resolution.json").read_text(encoding="utf-8"))
    event = json.loads((source_dir / "event.json").read_text(encoding="utf-8"))
    fanout_doc = json.loads((source_dir / "fanout-meeting.json").read_text(encoding="utf-8"))
    wb_payload_doc = json.loads((source_dir / "writeback-payload.json").read_text(encoding="utf-8"))
    key = f"fireflies:{meeting_id}"

    prog_path = progress.progress_path(vault, "fireflies", meeting_id)
    receipt_p = progress.receipt_path(vault, "fireflies", meeting_id)
    pending_path = progress.fanout_pending_path(vault, "fireflies", meeting_id)
    doc = progress.load_progress(prog_path)

    # CH-9: `progress.writeback.done: true` alone is not proof the write
    # actually happened — verify the home page carries meeting_writeback's
    # own `[source: <kind>:<id>]` marker before trusting a resume; a bogus
    # or hand-edited checkpoint gets the step reset and redone.
    if progress.step_done(doc, "writeback"):
        wb_state = doc.get("writeback") or {}
        home_rel_check = str(wb_state.get("home_path") or "")
        if not progress.writeback_marker_present(vault, home_rel_check, key):
            print("resume: writeback marker missing, redoing", file=sys.stderr)
            doc = progress.merge_progress(prog_path, "writeback", {"done": False})

    if not progress.step_done(doc, "writeback"):
        env = _writeback_env(vault)
        try:
            wb = subprocess.run(
                [sys.executable, str(WRITEBACK), "--payload", str(source_dir / "writeback-payload.json"), "--apply"],
                env=env, capture_output=True, text=True, timeout=CHILD_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            print("FAILED at writeback: timeout", file=sys.stderr)
            return 7
        sys.stdout.write(wb.stdout)
        if wb.returncode != 0:
            sys.stderr.write(wb.stderr)
            # CH-8/S-1: FR-012's exit-code table assigns every FR-005
            # failure exit 7, regardless of the subprocess's own return code
            # (meeting_writeback.py can itself return 1 or 64) — `or 7`
            # never fires for those truthy codes and leaked the raw code.
            tail = (wb.stderr or wb.stdout or "").strip().splitlines()
            print(f"FAILED at writeback: rc={wb.returncode} {tail[-1] if tail else ''}", file=sys.stderr)
            return 7
        doc = progress.merge_progress(prog_path, "writeback", {
            "done": True, "home_path": resolution.get("home_path"), "node": resolution.get("node"),
            "rule": resolution.get("rule"), "history_added": True, "open_items_added": True,
            "promotion_applied": bool(validated.get("proposed_delivery_state")),
        })

    crm_preview = preview.crm_interaction_preview(event, validated, resolution)
    print("applying crm rows:")
    for row in crm_preview:
        print(json.dumps(row, sort_keys=True))
    created_ids = set((doc.get("tasks") or {}).get("created_ids") or [])
    task_preview = preview.bus_task_preview(fanout_doc, created_ids, meeting_id=meeting_id)
    print("applying tasks:")
    for row in task_preview:
        print(json.dumps(row, sort_keys=True))

    if not progress.step_done(doc, "crm"):
        try:
            crm_res = subprocess.run(
                [sys.executable, str(CRM_SYNC), "--event-file", str(source_dir / "event.json"),
                 "--full-file", str(source_dir / "fanout-meeting.json")],
                env=progress.crm_env(os.environ, repo), capture_output=True, text=True,
                timeout=CHILD_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            print("FAILED at crm: timeout", file=sys.stderr)
            return 11
        sys.stdout.write(crm_res.stdout)
        if crm_res.returncode != 0:
            sys.stderr.write(crm_res.stderr)
            print(f"FAILED at crm: rc={crm_res.returncode}", file=sys.stderr)
            return 11
        crm_out = progress.parse_subprocess_json(crm_res.stdout)
        doc = progress.merge_progress(prog_path, "crm", {
            "done": True, "contacts": crm_out.get("contacts") or [],
            "interactions": len(crm_out.get("interactions") or []),
        })

    if not progress.step_done(doc, "tasks"):
        existing_created = list((doc.get("tasks") or {}).get("created") or [])
        pending_ids = progress.read_fanout_pending(pending_path)
        fanout_cmd = [
            sys.executable, str(FANOUT_SCRIPT), "--meeting-id", meeting_id,
            "--event-file", str(source_dir / "event.json"),
            "--full-file", str(source_dir / "fanout-meeting.json"),
            "--no-telegram", "--no-followups", "--strict",
        ]
        for pid in pending_ids:
            fanout_cmd += ["--retry-commitment", pid]
        # G0a F-3: neither orchestrator obligation FR-010 requires
        # (FANOUT_TRIAGE_OWNER=pa-codex, unset BRIEFS_INGEST_URL) was wired
        # anywhere — the inherited environment would leave TRIAGE_OWNER at
        # its code default "pa" (a disabled agent) and fire a real external
        # briefs POST if BRIEFS_INGEST_URL happened to be exported. R2-F-1:
        # fanout also needs the repo-scoped CRM data env (it upserts
        # nothing itself, but shares the same --repo-root convention) — the
        # two env helpers compose left-to-right.
        try:
            fan_res = subprocess.run(
                fanout_cmd, capture_output=True, text=True,
                env=progress.crm_env(progress.fanout_env(os.environ), repo),
                timeout=CHILD_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            print("FAILED at tasks: timeout", file=sys.stderr)
            return 8
        sys.stdout.write(fan_res.stdout)
        fan_out = progress.parse_subprocess_json(fan_res.stdout)
        if fan_res.returncode == 8:
            failed_ids = [str(x) for x in (fan_out.get("failed") or [])]
            progress.write_fanout_pending(pending_path, failed_ids)
            # G2-P1-3: dict-union with what a prior partial run already
            # recorded — a retry's task_map must never REPLACE earlier
            # successful commitmentId->taskId mappings.
            created_pairs = progress.merge_task_map(existing_created, fan_out.get("task_map") or [])
            progress.merge_progress(prog_path, "tasks", {
                "done": False, "created": created_pairs,
                "created_ids": [p.get("commitmentId") for p in created_pairs], "pending": failed_ids,
            })
            print(f"FAILED at tasks: {len(failed_ids)} pending", file=sys.stderr)
            return 8
        if fan_res.returncode != 0:
            sys.stderr.write(fan_res.stderr)
            print(f"FAILED at tasks: rc={fan_res.returncode}", file=sys.stderr)
            return 8
        created_pairs = progress.merge_task_map(existing_created, fan_out.get("task_map") or [])
        # CH-5: reconstruction previously only ran when the ENTIRE merged
        # map was empty — a partial crash (e.g. c1's mapping already
        # persisted, c2's fanout succeeded but the parent died before
        # merge_progress recorded it) left created_pairs non-empty (c1
        # alone) and skipped recovery entirely, permanently losing c2. Check
        # every dedup-SKIPped commitment individually: any one that still
        # has no entry in created_pairs gets reconstructed from the bus, not
        # just the case where nothing at all is mapped.
        skipped_ids = [str(x) for x in (fan_out.get("skipped") or [])]
        if skipped_ids:
            mapped_ids = {p.get("commitmentId") for p in created_pairs}
            unmapped_skipped = [cid for cid in skipped_ids if cid not in mapped_ids]
            if unmapped_skipped:
                next_steps = ((fanout_doc.get("meetings") or [{}])[0] or {}).get("next_steps") or []
                commitment_texts = {
                    str(step.get("commitmentId")): str(step.get("text") or "")
                    for step in next_steps
                    if isinstance(step, dict) and step.get("commitmentId")
                }
                recovered = progress.reconstruct_task_map_from_bus(
                    meeting_id, {cid: commitment_texts.get(cid, "") for cid in unmapped_skipped}
                )
                created_pairs = progress.merge_task_map(created_pairs, recovered)
                mapped_ids = {p.get("commitmentId") for p in created_pairs}
                still_unmapped = [cid for cid in unmapped_skipped if cid not in mapped_ids]
                if still_unmapped:
                    print(
                        "FAILED at tasks: dedup skipped but no created task recorded for "
                        + ", ".join(still_unmapped),
                        file=sys.stderr,
                    )
                    return 8
        progress.clear_fanout_pending(pending_path)
        doc = progress.merge_progress(prog_path, "tasks", {
            "done": True, "created": created_pairs,
            "created_ids": [p.get("commitmentId") for p in created_pairs], "pending": [],
        })

    if not progress.step_done(doc, "draft"):
        env = _writeback_env(vault)
        ledger_path = vault / "raw/media/transcripts/_recap-ledger.txt"
        try:
            rec = subprocess.run(
                [sys.executable, str(RECAP), "--payload", str(source_dir / "recap-payload.json"),
                 "--ledger", str(ledger_path)],
                env=env, capture_output=True, text=True, timeout=CHILD_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            print("FAILED at recap: timeout", file=sys.stderr)
            return 9
        sys.stdout.write(rec.stdout)
        if rec.returncode != 0:
            sys.stderr.write(rec.stderr)
            print(f"FAILED at recap: rc={rec.returncode}", file=sys.stderr)
            return 9
        rec_out = progress.parse_subprocess_json(rec.stdout)
        if rec_out.get("draft_failures"):
            print(f"FAILED at recap: {rec_out['draft_failures'][0]}", file=sys.stderr)
            return 9
        # G0a F-9: FR-008 can silently no-op (a suppressed meeting, or the
        # L2 auto-file tier) while still reporting rc=0 and `done: True` — if
        # it neither created a draft nor explicitly skipped via the ledger,
        # something upstream is wrong and the acceptance minimum ("1 draft
        # created", FR-012 line 332) would fail invisibly. Treat that as the
        # same failure class as an explicit draft_failures entry (exit 9).
        if not rec_out.get("drafts_created") and not rec_out.get("skipped_ledger"):
            print("FAILED at recap: zero drafts created and zero ledger-skips", file=sys.stderr)
            return 9
        planned = (rec_out.get("planned") or [{}])[0]
        subject = planned.get("subject")
        skipped_ledger = bool(rec_out.get("skipped_ledger"))
        if not subject and skipped_ledger:
            # CH-6: kill the parent after the real Gmail draft + ledger
            # append but before this merge — the NEXT run ledger-skips (key
            # already recorded) with no `planned` entry (process_meetings'
            # already-seen branch never appends to `planned`), so `subject`
            # would otherwise be recorded as None forever and repeatedly
            # fail acceptance even though the draft already exists. Recover
            # it from meeting_recap_draft.append_ledger's own `<key>\t
            # <subject>` row; fall back to a placeholder (never a null
            # draft) when the row predates that format or carries none.
            try:
                if str(RECAP.parent) not in sys.path:
                    sys.path.insert(0, str(RECAP.parent))
                from meeting_recap_draft import load_ledger_subjects as _load_ledger_subjects
                subject = _load_ledger_subjects(ledger_path).get(key) or None
            except Exception:
                subject = None
            if not subject:
                subject = "(ledger-skipped)"
        doc = progress.merge_progress(prog_path, "draft", {
            "done": True, "subject": subject,
            "created": bool(rec_out.get("drafts_created")), "skipped_ledger": skipped_ledger,
        })

    # C2-4 (fold, rev3): FR-012 line ~332's acceptance minimums (>=1
    # decision, >=1 OURS task, >=5 CRM contacts, 1 draft) must be enforced by
    # the production --apply path itself, not only by a test helper calling
    # progress.acceptance_minimums() in isolation — and it must run AFTER
    # the receipt is composed but BEFORE the vault commit, so a shortfall
    # never gets git-committed. Compose a receipt against whatever vault_sha
    # is already on record (None on a first run — the commit hasn't
    # happened yet), check it, and if it falls short: write that receipt
    # WITH `minimums: {ok: false, missing: [...]}` embedded (so the failure
    # is visible in receipt.json, not just on stderr) and exit 9 — the
    # commit step below never runs.
    decisions_kept = len(validated.get("decisions") or [])
    pre_commit_sha = (doc.get("commit") or {}).get("vault_sha") or (prior_receipt or {}).get("vault_sha")
    receipt = progress.compose_receipt(
        doc, meeting_id=meeting_id, source=key, vault_sha=pre_commit_sha, prior=prior_receipt,
    )
    shortfalls = progress.acceptance_minimums(receipt, decisions_kept=decisions_kept)
    # G2-P1-1: only the acceptance meeting id(s) actually gate on shortfalls
    # (exit 9, no commit); every other meeting still gets minimums computed
    # into the receipt for visibility but is never blocked by them.
    enforced = meeting_id in _acceptance_meeting_ids()
    if enforced and shortfalls:
        receipt["minimums"] = {"ok": False, "missing": shortfalls, "enforced": True}
        atomic_write(receipt_p, (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode("utf-8"))
        print(f"FAILED at minimums: {'; '.join(shortfalls)}", file=sys.stderr)
        return 9

    # G0a F-4: composing/writing receipt.json only inside this `if` meant a
    # `--apply --force` re-run — where every step's progress key is already
    # `done: true`, so this branch's `else` used to run instead — rewrote
    # nothing, and `last_run_at` never changed, violating FR-012 line 328
    # ("receipt.json SHALL differ only in last_run_at") and Task 10's own G4
    # assertion. Always recompose and write the receipt; only the commit
    # itself is gated by `progress.step_done`.
    if not progress.step_done(doc, "commit"):
        adapted_meeting = (wb_payload_doc.get("meetings") or [{}])[0]
        home_rel = str(resolution.get("home_path") or "")
        pathspec = progress.fr014_pathspec(meeting_id, home_rel, meeting_note_rel(adapted_meeting))
        message = f"brain: {_home_slug(resolution)} {str(source.get('occurred_at') or '')[:10]} from {key}"
        sha, committed_now = progress.vault_commit(vault, pathspec, message)
        final_sha = sha if committed_now else (prior_receipt or {}).get("vault_sha")
        if not final_sha:
            # CH-7: a crash between `git commit` succeeding and this merge
            # being written leaves no prior receipt to fall back on, even
            # though the commit genuinely IS on the vault's history —
            # resolve the true SHA rather than ever recording `vault_sha:
            # null` when the pathspec plainly has history.
            final_sha = progress.resolve_vault_sha_from_history(vault, pathspec)
        doc = progress.merge_progress(prog_path, "commit", {"done": True, "vault_sha": final_sha})
    else:
        committed_now = False
        final_sha = (doc.get("commit") or {}).get("vault_sha") or (prior_receipt or {}).get("vault_sha")

    receipt = progress.compose_receipt(
        doc, meeting_id=meeting_id, source=key, vault_sha=final_sha, prior=prior_receipt,
    )
    final_shortfalls = progress.acceptance_minimums(receipt, decisions_kept=decisions_kept)
    receipt["minimums"] = {"ok": not final_shortfalls, "missing": final_shortfalls, "enforced": enforced}
    atomic_write(receipt_p, (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode("utf-8"))
    print(f"receipt: {final_sha}" + ("" if committed_now else " (unchanged)"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
