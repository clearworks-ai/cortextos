from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping


LOGGER = logging.getLogger(__name__)
CRM_DIR = Path(__file__).resolve().parent
PIPELINE_PATH = CRM_DIR / "pipeline.json"
CONTACTS_PATH = CRM_DIR / "contacts.json"
INTERACTIONS_PATH = CRM_DIR / "interactions.jsonl"
FOLLOWUPS_PATH = CRM_DIR / "followups.jsonl"
FEEDS_DIR = CRM_DIR / "feeds"
INTAKE_QUEUE_PATH = CRM_DIR / "_deal_intents.jsonl"
REJECTED_INTAKE_QUEUE_PATH = CRM_DIR / "_deal_intents_rejected.jsonl"
ORG_ALIASES_PATH = CRM_DIR / "org-aliases.json"
UPSERT_ENGAGEMENT_PATH = CRM_DIR / "upsert-engagement.py"
SLUGIFY_RE = re.compile(r"[^a-z0-9]+")
QUALIFIED_OR_BEYOND = {
    "qualified",
    "proposal_sent",
    "negotiation",
    "won",
    "active_client",
    "dormant",
    "closed_won",
    "closed_lost",
    "lost",
}
JsonObject = dict[str, Any]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(text: str) -> str:
    return SLUGIFY_RE.sub("-", (text or "").lower()).strip("-")[:48]


def normalize_source_ref(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    source_ref = value.strip()
    return source_ref or None


def coerce_positive_value(value: Any) -> int | float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        numeric = float(value)
    elif isinstance(value, str):
        stripped = re.sub(r"[^0-9.\\-]", "", value.strip())
        if not stripped:
            return None
        try:
            numeric = float(stripped)
        except ValueError:
            return None
    else:
        return None

    if numeric <= 0:
        return None
    if numeric.is_integer():
        return int(numeric)
    return numeric


def status_for_stage(stage: str) -> str:
    if stage in {"won", "active_client", "dormant", "closed_won"}:
        return "active_client"
    if stage in {"lost", "closed_lost"}:
        return "lost"
    return "prospect"


def ensure_aliases_stub(path: Path = ORG_ALIASES_PATH) -> None:
    if path.exists():
        return
    write_json_object_atomic(path, {})


def load_aliases(path: Path = ORG_ALIASES_PATH) -> dict[str, str]:
    ensure_aliases_stub(path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path.name} did not contain an object")
    aliases: dict[str, str] = {}
    for key, value in payload.items():
        if isinstance(key, str) and isinstance(value, str):
            aliases[key.strip()] = value.strip()
    return aliases


def canonical_company_name(value: Any, aliases: Mapping[str, str]) -> str:
    if not isinstance(value, str):
        return ""
    company = value.strip()
    if not company:
        return ""
    return aliases.get(company, company)


def company_slug(value: Any, aliases: Mapping[str, str]) -> str:
    return slugify(canonical_company_name(value, aliases))


def read_json_object(path: Path) -> JsonObject:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path.name} did not contain an object")
    return payload


def write_json_object_atomic(path: Path, payload: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f"{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def load_jsonl(path: Path) -> list[JsonObject]:
    if not path.exists():
        return []
    rows: list[JsonObject] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        entry = line.strip()
        if not entry:
            continue
        payload = json.loads(entry)
        if isinstance(payload, dict):
            rows.append(payload)
    return rows


def write_jsonl_atomic(path: Path, rows: list[JsonObject]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f"{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True))
            handle.write("\n")
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def append_jsonl(path: Path, row: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True))
        handle.write("\n")


def load_pipeline(path: Path = PIPELINE_PATH) -> JsonObject:
    payload = read_json_object(path)
    engagements = payload.get("engagements")
    if not isinstance(engagements, list):
        raise ValueError("pipeline.json missing engagements list")
    return payload


def load_contacts(path: Path = CONTACTS_PATH) -> JsonObject:
    payload = read_json_object(path)
    contacts = payload.get("contacts")
    if not isinstance(contacts, list):
        raise ValueError("contacts.json missing contacts list")
    return payload


def load_known_stages(module_path: Path = UPSERT_ENGAGEMENT_PATH) -> set[str]:
    spec = importlib.util.spec_from_file_location("crm_upsert_engagement", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load upsert-engagement.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    known_stages = getattr(module, "KNOWN_STAGES", None)
    if not isinstance(known_stages, set):
        raise ValueError("KNOWN_STAGES missing from upsert-engagement.py")
    return {str(stage) for stage in known_stages}


def next_clearpath_id(engagements: list[JsonObject]) -> int:
    max_id = 0
    for engagement in engagements:
        clearpath_id = engagement.get("clearpath_id")
        if isinstance(clearpath_id, int) and clearpath_id > max_id:
            max_id = clearpath_id
    return max_id + 1


def contacts_index(contacts_payload: JsonObject) -> dict[str, JsonObject]:
    contacts = contacts_payload.get("contacts", [])
    index: dict[str, JsonObject] = {}
    for contact in contacts:
        if not isinstance(contact, dict):
            continue
        contact_id = contact.get("id")
        if isinstance(contact_id, str) and contact_id:
            index[contact_id] = contact
    return index


def contact_emails(contact: JsonObject) -> list[str]:
    emails = contact.get("emails")
    if not isinstance(emails, list):
        return []
    values: list[str] = []
    for entry in emails:
        if isinstance(entry, str) and entry.strip():
            values.append(entry.strip().lower())
    return values


def contact_company_slug(contact: JsonObject, aliases: Mapping[str, str]) -> str:
    return company_slug(contact.get("company"), aliases)


def engagement_company_slugs(
    engagement: JsonObject,
    contact_index: Mapping[str, JsonObject],
    aliases: Mapping[str, str],
) -> set[str]:
    slugs: set[str] = set()
    primary_slug = company_slug(engagement.get("client_org"), aliases)
    if primary_slug:
        slugs.add(primary_slug)

    contact_ids = engagement.get("contact_ids")
    if isinstance(contact_ids, list):
        for contact_id in contact_ids:
            if not isinstance(contact_id, str):
                continue
            contact = contact_index.get(contact_id)
            if not isinstance(contact, dict):
                continue
            fallback_slug = contact_company_slug(contact, aliases)
            if fallback_slug:
                slugs.add(fallback_slug)
    return slugs


def collect_company_slugs(
    pipeline_payload: JsonObject,
    contacts_payload: JsonObject,
    aliases: Mapping[str, str],
) -> set[str]:
    contact_index = contacts_index(contacts_payload)
    slugs: set[str] = set()
    for contact in contacts_payload.get("contacts", []):
        if not isinstance(contact, dict):
            continue
        contact_slug = contact_company_slug(contact, aliases)
        if contact_slug:
            slugs.add(contact_slug)
    for engagement in pipeline_payload.get("engagements", []):
        if not isinstance(engagement, dict):
            continue
        slugs.update(engagement_company_slugs(engagement, contact_index, aliases))
    return slugs


def sort_key_for_timestamp(value: Any) -> tuple[int, str]:
    if isinstance(value, str) and value.strip():
        return (0, value.strip())
    return (1, "")


def build_company_timeline_payload(
    *,
    slug: str,
    pipeline_payload: JsonObject,
    contacts_payload: JsonObject,
    interactions: list[JsonObject],
    followups: list[JsonObject],
    aliases: Mapping[str, str],
    generated_at: str | None = None,
) -> JsonObject:
    contact_index = contacts_index(contacts_payload)
    matched_contacts: list[JsonObject] = []
    for contact in contacts_payload.get("contacts", []):
        if isinstance(contact, dict) and contact_company_slug(contact, aliases) == slug:
            matched_contacts.append(dict(contact))
    matched_contacts.sort(key=lambda contact: str(contact.get("name") or contact.get("id") or ""))
    matched_contact_ids = {
        str(contact["id"])
        for contact in matched_contacts
        if isinstance(contact.get("id"), str)
    }

    matched_engagements: list[JsonObject] = []
    for engagement in pipeline_payload.get("engagements", []):
        if not isinstance(engagement, dict):
            continue
        if slug in engagement_company_slugs(engagement, contact_index, aliases):
            matched_engagements.append(dict(engagement))
    matched_engagements.sort(
        key=lambda engagement: sort_key_for_timestamp(
            engagement.get("last_signal_at") or engagement.get("stage_changed_at")
        ),
        reverse=True,
    )

    deduped_interactions: list[JsonObject] = []
    seen_source_refs: set[str] = set()
    for interaction in interactions:
        if not isinstance(interaction, dict):
            continue
        contact_id = interaction.get("contact_id")
        if contact_id not in matched_contact_ids:
            continue
        source_ref = normalize_source_ref(interaction.get("source_ref"))
        if source_ref is not None and source_ref in seen_source_refs:
            continue
        if source_ref is not None:
            seen_source_refs.add(source_ref)
        deduped_interactions.append(dict(interaction))
    deduped_interactions.sort(
        key=lambda interaction: sort_key_for_timestamp(interaction.get("ts")),
        reverse=True,
    )

    matched_followups: list[JsonObject] = []
    for followup in followups:
        if not isinstance(followup, dict):
            continue
        contact_id = followup.get("contact_id")
        if contact_id not in matched_contact_ids:
            continue
        matched_followups.append(dict(followup))
    matched_followups.sort(
        key=lambda followup: sort_key_for_timestamp(
            followup.get("completed_at")
            or followup.get("created_at")
            or followup.get("due_date")
        ),
        reverse=True,
    )

    notes: list[JsonObject] = []
    events: list[JsonObject] = []
    for engagement in matched_engagements:
        clearpath_id = engagement.get("clearpath_id")
        events.append(
            {
                "kind": "engagement",
                "event_at": engagement.get("stage_changed_at") or engagement.get("last_signal_at"),
                "clearpath_id": clearpath_id,
                "name": engagement.get("name"),
                "client_org": engagement.get("client_org"),
                "stage": engagement.get("stage"),
                "status": engagement.get("status"),
                "value_total": engagement.get("value_total"),
                "source_ref": f"engagement:{clearpath_id}",
            }
        )
        note_text = engagement.get("_notes")
        if isinstance(note_text, str) and note_text.strip():
            note = {
                "clearpath_id": clearpath_id,
                "engagement_name": engagement.get("name"),
                "client_org": engagement.get("client_org"),
                "note": note_text.strip(),
                "ts": engagement.get("last_signal_at") or engagement.get("stage_changed_at"),
                "source_ref": f"engagement-note:{clearpath_id}",
            }
            notes.append(note)
            events.append(
                {
                    "kind": "note",
                    "event_at": note["ts"],
                    "clearpath_id": clearpath_id,
                    "engagement_name": engagement.get("name"),
                    "note": note["note"],
                    "source_ref": note["source_ref"],
                }
            )

    for interaction in deduped_interactions:
        events.append(
            {
                "kind": "interaction",
                "event_at": interaction.get("ts"),
                "contact_id": interaction.get("contact_id"),
                "type": interaction.get("type"),
                "summary": interaction.get("summary"),
                "source_ref": interaction.get("source_ref"),
            }
        )

    for followup in matched_followups:
        events.append(
            {
                "kind": "followup",
                "event_at": followup.get("completed_at")
                or followup.get("created_at")
                or followup.get("due_date"),
                "contact_id": followup.get("contact_id"),
                "id": followup.get("id"),
                "reason": followup.get("reason"),
                "status": followup.get("status"),
                "due_date": followup.get("due_date"),
                "source_ref": followup.get("source_ref"),
            }
        )

    notes.sort(key=lambda note: sort_key_for_timestamp(note.get("ts")), reverse=True)
    events.sort(key=lambda event: sort_key_for_timestamp(event.get("event_at")), reverse=True)

    company_name = ""
    if matched_engagements:
        for engagement in matched_engagements:
            if isinstance(engagement.get("client_org"), str) and engagement["client_org"].strip():
                company_name = canonical_company_name(engagement["client_org"], aliases)
                if company_name:
                    break
    if not company_name and matched_contacts:
        company_name = canonical_company_name(matched_contacts[0].get("company"), aliases)
    if not company_name:
        company_name = slug.replace("-", " ").title()

    return {
        "slug": slug,
        "company": company_name,
        "generated_at": generated_at or now_iso(),
        "contact_ids": sorted(matched_contact_ids),
        "contacts": matched_contacts,
        "engagements": matched_engagements,
        "interactions": deduped_interactions,
        "followups": matched_followups,
        "notes": notes,
        "events": events,
    }


def write_company_timeline_feed(
    *,
    slug: str,
    pipeline_payload: JsonObject,
    contacts_payload: JsonObject,
    interactions: list[JsonObject],
    followups: list[JsonObject],
    aliases: Mapping[str, str],
    feeds_dir: Path = FEEDS_DIR,
) -> Path:
    payload = build_company_timeline_payload(
        slug=slug,
        pipeline_payload=pipeline_payload,
        contacts_payload=contacts_payload,
        interactions=interactions,
        followups=followups,
        aliases=aliases,
    )
    path = feeds_dir / f"{slug}.json"
    write_json_object_atomic(path, payload)
    return path


def interaction_source_refs(path: Path = INTERACTIONS_PATH) -> set[str]:
    refs: set[str] = set()
    for row in load_jsonl(path):
        source_ref = normalize_source_ref(row.get("source_ref"))
        if source_ref is not None:
            refs.add(source_ref)
    return refs


def _in_test_mode() -> bool:
    """True under pytest or a plain unittest run, so emits stay off the live bus.
    PYTEST_CURRENT_TEST is set by pytest and inherited by subprocess children via
    os.environ.copy(); the sys.modules checks cover in-process plain-unittest runs. The
    explicit CRM_EVENT_EMIT_LOG seam still takes precedence when a test asserts emit content."""
    return (
        os.environ.get("PYTEST_CURRENT_TEST") is not None
        or "pytest" in sys.modules
        or "unittest" in sys.modules
    )


def emit_crm_event(event_type: str, payload: str) -> None:
    """DESIGN-B-crm.md event lane: self-inbox a structured ``EVENT <type> — <json>`` bus
    message so the fast-checker wakes the crm session and the Records-Admin Event Runbook
    (AGENTS.md) fires. Best-effort by design — it must never block or fail the write that
    already landed (E1 reconcile-intake, E2 sync-board, E3 upsert-contact, E7 comms-backfill).

    Test seam: when ``CRM_EVENT_EMIT_LOG`` is set, append the ``EVENT ...`` line to that file
    instead of shelling out to the bus. Lets tests assert the emit fired without a live daemon.
    """
    line = f"EVENT {event_type} — {payload}"
    log_path = os.environ.get("CRM_EVENT_EMIT_LOG")
    if log_path:
        try:
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass
        return
    if _in_test_mode():
        return
    try:
        subprocess.run(
            ["cortextos", "bus", "send-message", "crm", "normal", line],
            check=False,
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass
