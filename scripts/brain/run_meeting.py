#!/usr/bin/env python3
"""FR-012: orchestrate fetch → extract → resolve → adapt → dry-run writeback/recap."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from adapt_meeting import main as adapt_main
from extract_meeting import main as extract_main
from fetch_fireflies import main as fetch_main
from paths import DEFAULT_REPO_ROOT, DEFAULT_VAULT, envelope_dir
from resolve_meeting import main as resolve_main

HERE = Path(__file__).resolve().parent
CODE_ROOT = HERE.parent.parent
WRITEBACK = CODE_ROOT / "orgs/clearworksai/agents/pa/scripts/meeting_writeback.py"
RECAP = CODE_ROOT / "orgs/clearworksai/agents/pa/scripts/meeting_recap_draft.py"


SAFE_MEETING_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def _strip_id(meeting_id: str) -> str:
    mid = meeting_id.strip()
    if mid.startswith("fireflies:"):
        mid = mid.split(":", 1)[1]
    if not SAFE_MEETING_ID.match(mid):
        return ""
    return mid


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

    meeting_id = _strip_id(args.meeting_id)
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
    print("tasks:")
    fan_path = source_dir / "fanout-meeting.json"
    printed = False
    if fan_path.is_file():
        fan = json.loads(fan_path.read_text(encoding="utf-8"))
        for meet in fan.get("meetings") or []:
            if not isinstance(meet, dict):
                continue
            for step in meet.get("next_steps") or []:
                if not isinstance(step, dict):
                    continue
                title = str(step.get("text") or "").strip()
                if not title:
                    continue
                owner = str(step.get("owner_label") or step.get("owner_identity") or "")
                due = step.get("deadline") or "none"
                print(f"{title} · {owner} · due {due}")
                printed = True
    if not printed:
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
