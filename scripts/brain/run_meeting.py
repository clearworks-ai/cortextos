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

from adapt_meeting import main as adapt_main
from extract_meeting import main as extract_main
from fetch_fireflies import main as fetch_main
from paths import DEFAULT_REPO_ROOT, DEFAULT_VAULT, envelope_dir, safe_meeting_id
from resolve_meeting import main as resolve_main

HERE = Path(__file__).resolve().parent
CODE_ROOT = HERE.parent.parent
WRITEBACK = CODE_ROOT / "orgs/clearworksai/agents/pa/scripts/meeting_writeback.py"
RECAP = CODE_ROOT / "orgs/clearworksai/agents/pa/scripts/meeting_recap_draft.py"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--meeting-id", required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--force", action="store_true")
    p.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))
    p.add_argument("--vault", default=str(DEFAULT_VAULT))
    args = p.parse_args(argv)
    if args.apply:
        print("R1: --apply refused until goal-brain-source-to-state-r2-apply", file=sys.stderr)
        return 64
    if not args.dry_run:
        print("need --dry-run or --apply", file=sys.stderr)
        return 64

    meeting_id = safe_meeting_id(args.meeting_id)
    if not meeting_id:
        print("need --meeting-id", file=sys.stderr)
        return 64

    vault = Path(args.vault)
    repo = Path(args.repo_root)
    source_dir = envelope_dir(vault, "fireflies", meeting_id)

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


if __name__ == "__main__":
    raise SystemExit(main())
