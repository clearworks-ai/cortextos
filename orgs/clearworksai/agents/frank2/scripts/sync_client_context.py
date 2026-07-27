#!/usr/bin/env python3
"""Rebuild knowledge/clients/*.md from CRM data."""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
AGENT_DIR = SCRIPT_PATH.parent.parent
AGENTS_DIR = AGENT_DIR.parent
ORG_DIR = AGENTS_DIR.parent
CRM_DIR = AGENTS_DIR / "crm" / "crm"
CLIENTS_DIR = ORG_DIR / "knowledge" / "clients"
TEMPLATE_NAME = "_template.md"
ACTIVE_STAGES = {"won", "qualified", "proposal", "proposal_sent", "live"}
INACTIVE_STAGES = {"lost", "closed_lost"}
OPEN_FOLLOWUP_STATUSES = {"open", "parked"}
SECTION_RE = re.compile(r"^##\s+(.+)$")
SUMMARY_LIMIT = 220
DISPLAY_NAME_OVERRIDES = {
    "Movement of Spiritual Awareness": "MSIA",
    "OCG Properties": "OCG",
    "alloi.us": "Alloi",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def normalize_space(value: str) -> str:
    return " ".join(value.split()).strip()


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized or "client"


def display_name(raw_name: str, aliases: dict[str, str]) -> str:
    canonical = aliases.get(raw_name, raw_name).strip()
    return DISPLAY_NAME_OVERRIDES.get(canonical, canonical)


def format_money(total: Any, monthly: Any) -> str:
    if total:
        return f"${int(total):,} total"
    if monthly:
        return f"${int(monthly):,}/month"
    return "Unknown"


def parse_date(value: str) -> datetime:
    cleaned = value.replace("Z", "+00:00")
    return datetime.fromisoformat(cleaned)


def summarize(text: str) -> str:
    one_line = normalize_space(text.replace("\n", " "))
    if len(one_line) <= SUMMARY_LIMIT:
        return one_line
    return one_line[: SUMMARY_LIMIT - 1].rstrip() + "…"


def service_label(raw: Any) -> str:
    if not raw:
        return "Unknown"
    return str(raw).replace("_", " ")


def load_meeting_records(meetings_dir: Path) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for path in sorted(meetings_dir.glob("*.md")):
        lines = path.read_text(encoding="utf-8").splitlines()
        title = normalize_space(lines[0].lstrip("#").strip()) if lines else path.stem
        sections: dict[str, list[str]] = defaultdict(list)
        current: str | None = None
        for line in lines[1:]:
            match = SECTION_RE.match(line)
            if match:
                current = match.group(1).strip().lower()
                continue
            if current is not None:
                sections[current].append(line)
        context = summarize(" ".join(sections.get("context", [])))
        body = "\n".join(lines)
        records.append(
            {
                "date": path.name[:10],
                "title": title,
                "summary": context or title,
                "body": body,
                "source": path.name,
            }
        )
    return records


def engagement_is_active(engagement: dict[str, Any]) -> bool:
    if engagement.get("archived"):
        return False
    stage = str(engagement.get("stage") or "").lower()
    if stage in INACTIVE_STAGES:
        return False
    return stage in ACTIVE_STAGES


def latest_contact_signal(contact_ids: list[str], interactions: list[dict[str, Any]]) -> str:
    latest: str = ""
    for row in interactions:
        if row.get("contact_id") not in contact_ids:
            continue
        ts = str(row.get("ts") or "")
        if ts and ts > latest:
            latest = ts
    return latest


def contact_phone_or_email(contact: dict[str, Any]) -> str:
    emails = contact.get("emails") or []
    phones = contact.get("phones") or []
    if emails:
        return str(emails[0])
    if phones:
        return str(phones[0])
    return "No direct contact on file"


def contact_signal_tags(contacts: list[dict[str, Any]]) -> list[str]:
    signal_tags: set[str] = set()
    for contact in contacts:
        for tag in contact.get("tags") or []:
            if tag in {"active-client", "recurring-client", "engagement-bearing"} or tag.startswith("active-delivery:"):
                signal_tags.add(tag)
    return sorted(signal_tags)


def history_rows(
    engagement: dict[str, Any],
    contacts: list[dict[str, Any]],
    interactions: list[dict[str, Any]],
    meeting_records: list[dict[str, str]],
) -> list[str]:
    contact_ids = {contact.get("id") for contact in contacts}
    name_markers = {
        normalize_space(str(contact.get("name") or "")).lower()
        for contact in contacts
        if contact.get("name")
    }
    company_markers = {
        normalize_space(str(engagement.get("client_org") or "")).lower(),
        normalize_space(DISPLAY_NAME_OVERRIDES.get(str(engagement.get("client_org") or ""), "")).lower(),
    }
    rows: list[tuple[str, str, str]] = []
    seen_sources: set[str] = set()

    for row in interactions:
        if row.get("contact_id") not in contact_ids:
            continue
        ts = str(row.get("ts") or "")
        if not ts:
            continue
        source = str(row.get("source_ref") or f"interaction:{row.get('contact_id')}:{ts}")
        if source in seen_sources:
            continue
        seen_sources.add(source)
        rows.append((ts[:10], summarize(str(row.get("summary") or "")), source))

    for record in meeting_records:
        haystack = record["body"].lower()
        if not any(marker and marker in haystack for marker in company_markers | name_markers):
            continue
        source = record["source"]
        if source in seen_sources:
            continue
        seen_sources.add(source)
        rows.append((record["date"], summarize(record["summary"]), source))

    rows.sort(key=lambda item: item[0], reverse=True)
    return [f"- {date_value} — {summary}" for date_value, summary, _ in rows[:8]]


def open_item_rows(
    engagement: dict[str, Any],
    contacts: list[dict[str, Any]],
    followups: list[dict[str, Any]],
) -> list[str]:
    contact_ids = {contact.get("id") for contact in contacts}
    rows: list[tuple[str, str, str, str, str]] = []
    seen: set[tuple[str, str]] = set()

    for row in followups:
        if row.get("contact_id") not in contact_ids:
            continue
        status = str(row.get("status") or "").lower()
        if status not in OPEN_FOLLOWUP_STATUSES:
            continue
        action = normalize_space(str(row.get("reason") or row.get("note") or ""))
        if not action:
            continue
        key = (action.lower(), str(row.get("due_date") or row.get("due") or ""))
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            (
                action.replace("|", "/"),
                "Josh",
                str(row.get("due_date") or row.get("due") or "").replace("|", "/"),
                str(row.get("source_ref") or "followups.jsonl").replace("|", "/"),
                str(row.get("status") or "open").replace("|", "/"),
            )
        )

    open_commitments = engagement.get("_open_commitments") or {}
    if isinstance(open_commitments, dict):
        for owner, items in open_commitments.items():
            if not isinstance(items, list):
                continue
            for item in items:
                action = normalize_space(str(item))
                if not action:
                    continue
                key = (action.lower(), "")
                if key in seen:
                    continue
                seen.add(key)
                rows.append((action.replace("|", "/"), owner.title(), "", "pipeline.json", "open"))

    next_action = normalize_space(str(engagement.get("next_action") or ""))
    if next_action:
        key = (next_action.lower(), "")
        if key not in seen:
            rows.append((next_action.replace("|", "/"), "Josh", "", "pipeline.json", "open"))

    rows.sort(key=lambda row: (row[2] == "", row[2], row[0].lower()))
    if not rows:
        return ["| | | | | |"]
    return [f"| {item} | {owner} | {deadline} | {source} | {status} |" for item, owner, deadline, source, status in rows]


def build_client_markdown(
    *,
    engagement: dict[str, Any],
    contacts: list[dict[str, Any]],
    interactions: list[dict[str, Any]],
    followups: list[dict[str, Any]],
    meeting_records: list[dict[str, str]],
    aliases: dict[str, str],
) -> tuple[str, str]:
    raw_org_name = str(engagement.get("client_org") or "").strip()
    pretty_name = display_name(raw_org_name, aliases)
    latest_signal = latest_contact_signal([str(contact.get("id")) for contact in contacts], interactions)
    primary_contact = next((contact for contact in contacts if contact.get("id") == engagement.get("primary_contact_id")), None)
    signal_tags = contact_signal_tags(contacts)
    current_state_lines = [
        f"- CRM org name: {raw_org_name or 'Unknown'}",
        f"- Deal stage: {engagement.get('stage') or 'Unknown'}",
        f"- CRM status: {engagement.get('status') or 'Unknown'}",
        f"- Primary contact: {primary_contact.get('name') if primary_contact else 'Unknown'}",
        f"- Last signal: {latest_signal or str(engagement.get('last_signal_at') or 'Unknown')}",
    ]
    if signal_tags:
        current_state_lines.append(f"- Contact signals: {', '.join(signal_tags)}")
    if engagement.get("next_action"):
        current_state_lines.append(f"- Next action: {engagement['next_action']}")

    delivery_lines = [
        f"- Engagement: {engagement.get('name') or 'Unknown'}",
        f"- Service type: {service_label(engagement.get('service_type'))}",
        f"- Industry: {engagement.get('client_industry') or 'Unknown'}",
    ]
    if primary_contact and primary_contact.get("context"):
        delivery_lines.append(f"- Relationship context: {summarize(str(primary_contact['context']))}")

    financial_lines = [
        f"- Deal value: {format_money(engagement.get('value_total'), engagement.get('value_monthly'))}",
        f"- Status: stage={engagement.get('stage') or 'Unknown'} / crm={engagement.get('status') or 'Unknown'}",
    ]

    history_lines = history_rows(engagement, contacts, interactions, meeting_records) or ["- No dated CRM history surfaced yet"]
    item_lines = open_item_rows(engagement, contacts, followups)

    contact_lines = [
        f"- {contact.get('name') or 'Unknown'} — {contact.get('role') or 'Role unknown'} — {contact_phone_or_email(contact)}"
        for contact in contacts
    ] or ["- No CRM contacts surfaced"]

    body = "\n".join(
        [
            f"# Client: {pretty_name}",
            "",
            "## Contacts",
            "",
            *contact_lines,
            "",
            "## Current state",
            "",
            *current_state_lines,
            "",
            "## What we're delivering",
            "",
            *delivery_lines,
            "",
            "## Financials",
            "",
            *financial_lines,
            "",
            "## History (dated, newest first)",
            "",
            *history_lines,
            "",
            "## Open Items",
            "",
            "| Item | Owner | Deadline | Source | Status |",
            "|---|---|---|---|---|",
            *item_lines,
            "",
        ]
    )
    return pretty_name, body


def sync_clients(*, clients_dir: Path, crm_dir: Path) -> list[Path]:
    contacts_payload = load_json(crm_dir / "contacts.json")
    contacts_by_id = {str(contact.get("id")): contact for contact in contacts_payload.get("contacts", [])}
    interactions = load_jsonl(crm_dir / "interactions.jsonl")
    followups = load_jsonl(crm_dir / "followups.jsonl")
    pipeline = load_json(crm_dir / "pipeline.json")
    aliases = load_json(crm_dir / "org-aliases.json")
    meeting_records = load_meeting_records(crm_dir / "meetings")

    clients_dir.mkdir(parents=True, exist_ok=True)
    for path in clients_dir.glob("*.md"):
        if path.name != TEMPLATE_NAME:
            path.unlink()

    written: list[Path] = []
    for engagement in pipeline.get("engagements", []):
        if not engagement_is_active(engagement):
            continue
        raw_org_name = str(engagement.get("client_org") or "").strip()
        if not raw_org_name:
            continue
        contacts = [
            contacts_by_id[contact_id]
            for contact_id in engagement.get("contact_ids", [])
            if contact_id in contacts_by_id
        ]
        pretty_name, markdown = build_client_markdown(
            engagement=engagement,
            contacts=contacts,
            interactions=interactions,
            followups=followups,
            meeting_records=meeting_records,
            aliases=aliases,
        )
        path = clients_dir / f"{slugify(pretty_name)}.md"
        path.write_text(markdown, encoding="utf-8")
        written.append(path)

    return sorted(written)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild knowledge/clients/*.md from CRM data")
    parser.add_argument("--clients-dir", default=str(CLIENTS_DIR))
    parser.add_argument("--crm-dir", default=str(CRM_DIR))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    written = sync_clients(clients_dir=Path(args.clients_dir), crm_dir=Path(args.crm_dir))
    print(json.dumps({"written": [str(path) for path in written], "count": len(written)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
