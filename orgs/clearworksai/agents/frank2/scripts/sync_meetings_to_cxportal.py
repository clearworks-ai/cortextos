#!/usr/bin/env python3
"""Push CRM meeting data to cxportal ingest endpoint."""

from __future__ import annotations

import argparse
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
AGENT_DIR = SCRIPT_PATH.parent.parent
ORG_DIR = AGENT_DIR.parent
CRM_DIR = AGENT_DIR / "crm" / "crm"
MEETINGS_DIR = CRM_DIR / "meetings"
ORG_ID = os.environ.get("CXPORTAL_ORG_ID", "")
INGEST_URL = os.environ.get("CXPORTAL_INGEST_URL", "")
INGEST_SECRET = os.environ.get("CXPORTAL_INGEST_SECRET", "")
SECTION_RE = re.compile(r"^##\s+(.+)$")
COMMITMENT_RE = re.compile(r"^- \[(x| )\]\s+(.+?)(?:\s+by:\s*([^\n]+))?(?:\s+due:\s*([^\n]+))?", re.IGNORECASE)
INLINE_ATTENDEES_RE = re.compile(r"\*\*Attendees:\*\*\s*(.+?)\s*$")
PROSE_COMMITMENT_RE = re.compile(r"^- \*\*([^*:]+):\*\*\s+(.+)$")


def load_meeting_records(meetings_dir: Path) -> list[dict[str, Any]]:
    """Load meeting records from CRM meetings/*.md files."""
    records: list[dict[str, Any]] = []
    
    if not meetings_dir.exists():
        return records
    
    for path in sorted(meetings_dir.glob("*.md")):
        lines = path.read_text(encoding="utf-8").splitlines()
        if not lines:
            continue
            
        meeting: dict[str, Any] = {
            "title": lines[0].lstrip("#").strip(),
            "source": "crm",
            "sourceId": path.stem,
            "attendees": [],
            "commitments": [],
        }
        
        current_section: str | None = None
        current_commitments: list[dict[str, str]] = []
        
        for line in lines[1:]:
            section_match = SECTION_RE.match(line)
            if section_match:
                current_section = section_match.group(1).strip().lower()
                if "action item" in current_section or "commitment" in current_section or "follow-up" in current_section:
                    current_commitments = []
                continue
            
            if not current_section:
                # Check for inline attendees before any section
                inline_attendees_match = INLINE_ATTENDEES_RE.search(line)
                if inline_attendees_match:
                    attendees_text = inline_attendees_match.group(1).strip()
                    if attendees_text:
                        # Split on semicolon first (primary delimiter), fall back to comma
                        if ";" in attendees_text:
                            delimiter = ";"
                        else:
                            delimiter = ","
                        for attendee in attendees_text.split(delimiter):
                            attendee = attendee.strip()
                            if attendee and attendee not in meeting["attendees"]:
                                meeting["attendees"].append(attendee)
                continue
                
            if current_section == "attendees":
                if line.strip() and not line.strip().startswith("#"):
                    attendee = line.strip().lstrip("-").strip()
                    if attendee and attendee not in meeting["attendees"]:
                        meeting["attendees"].append(attendee)
            
            elif "action item" in current_section or "commitment" in current_section or "follow-up" in current_section:
                # Try checkbox pattern first
                commitment_match = COMMITMENT_RE.match(line)
                if commitment_match:
                    status, text, owner, due = commitment_match.groups()
                    current_commitments.append({
                        "description": text.strip(),
                        "status": "done" if status.lower() == "x" else "open",
                        "ownerName": owner.strip() if owner else None,
                        "dueDate": due.strip() if due else None,
                        "origin": "crm",
                    })
                else:
                    # Try prose-style pattern
                    prose_match = PROSE_COMMITMENT_RE.match(line)
                    if prose_match:
                        owner, description = prose_match.groups()
                        current_commitments.append({
                            "description": description.strip(),
                            "status": "open",
                            "ownerName": owner.strip(),
                            "dueDate": None,
                            "origin": "crm",
                        })
            elif current_commitments and line.strip():
                # Multi-line commitment description
                if current_commitments:
                    current_commitments[-1]["description"] += " " + line.strip()
        
        meeting["commitments"] = current_commitments
        records.append(meeting)
    
    return records


def post_to_cxportal(meeting: dict[str, Any], org_id: str, ingest_url: str, ingest_secret: str) -> dict[str, Any] | None:
    """Post meeting data to cxportal ingest endpoint."""
    if not org_id or not ingest_url or not ingest_secret:
        return None
    
    try:
        payload = {
            "orgId": org_id,
            "meeting": {
                "title": meeting["title"],
                "status": "completed",
                "source": meeting["source"],
                "sourceId": meeting["sourceId"],
                "extract": {
                    "attendees": meeting.get("attendees", []),
                },
            },
            "actionItems": [
                {
                    "description": item["description"],
                    "ownerName": item.get("ownerName"),
                    "dueDate": item.get("dueDate"),
                    "status": item["status"],
                    "origin": item.get("origin", "crm"),
                }
                for item in meeting.get("commitments", [])
            ],
        }
        
        request = urllib.request.Request(
            ingest_url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
        )
        request.add_header("Content-Type", "application/json")
        request.add_header("x-meeting-ingest-secret", ingest_secret)
        
        with urllib.request.urlopen(request, timeout=30) as response:
            status = getattr(response, "status", 200)
            response_data = json.loads(response.read().decode("utf-8"))
        
        if status not in (200, 201):
            print(f"ERROR: cxportal returned {status}: {response_data}")
            return None
        
        return response_data
        
    except Exception as exc:
        print(f"ERROR: Failed to post meeting {meeting['sourceId']}: {exc}")
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Push CRM meetings to cxportal")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be posted without POSTing")
    parser.add_argument("--meetings-dir", default=str(MEETINGS_DIR), help="Path to CRM meetings directory")
    
    args = parser.parse_args(argv)
    
    if not ORG_ID:
        print("ERROR: CXPORTAL_ORG_ID environment variable is required")
        return 1
    
    if not INGEST_URL:
        print("ERROR: CXPORTAL_INGEST_URL environment variable is required")
        return 1
    
    if not INGEST_SECRET:
        print("ERROR: CXPORTAL_INGEST_SECRET environment variable is required")
        return 1
    
    meetings_dir = Path(args.meetings_dir)
    meetings = load_meeting_records(meetings_dir)
    
    if not meetings:
        print("No meeting records found in CRM")
        return 0
    
    print(f"Found {len(meetings)} meeting records in CRM")
    
    if args.dry_run:
        print("Dry run - would post the following:")
        for meeting in meetings:
            print(f"  - {meeting['title']} ({meeting['sourceId']})")
            print(f"    Attendees: {meeting.get('attendees', [])}")
            print(f"    Commitments: {len(meeting.get('commitments', []))}")
        return 0
    
    posted = 0
    failed = 0
    
    for meeting in meetings:
        result = post_to_cxportal(
            meeting=meeting,
            org_id=ORG_ID,
            ingest_url=INGEST_URL,
            ingest_secret=INGEST_SECRET,
        )
        
        if result:
            posted += 1
            print(f"✓ Posted meeting: {meeting['title']} ({meeting['sourceId']})")
        else:
            failed += 1
    
    print(f"\nResults: {posted} posted, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
