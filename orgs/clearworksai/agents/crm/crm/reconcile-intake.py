#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Any, Callable

from crm_connect_common import (
    CONTACTS_PATH,
    INTAKE_QUEUE_PATH,
    INTERACTIONS_PATH,
    ORG_ALIASES_PATH,
    PIPELINE_PATH,
    REJECTED_INTAKE_QUEUE_PATH,
    FOLLOWUPS_PATH,
    QUALIFIED_OR_BEYOND,
    append_jsonl,
    coerce_positive_value,
    emit_crm_event,
    engagement_company_slugs,
    load_aliases,
    load_contacts,
    load_jsonl,
    load_known_stages,
    load_pipeline,
    next_clearpath_id,
    now_iso,
    status_for_stage,
    write_company_timeline_feed,
    write_json_object_atomic,
    write_jsonl_atomic,
    contacts_index,
    load_jsonl as read_jsonl_rows,
)


LOGGER = logging.getLogger(__name__)
TimelineWriter = Callable[[str], None]


def normalized_intent_key(intent: dict[str, Any], aliases: dict[str, str]) -> tuple[str, str] | None:
    intake_id = intent.get("intake_id")
    company = intent.get("company")
    if not isinstance(intake_id, str) or not intake_id.strip():
        return None
    from crm_connect_common import company_slug

    slug = company_slug(company, aliases)
    if not slug:
        return None
    return (intake_id.strip(), slug)


def existing_intent_keys(
    engagements: list[dict[str, Any]],
    aliases: dict[str, str],
    contact_index: dict[str, dict[str, Any]],
) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    for engagement in engagements:
        intake_id = engagement.get("intake_id")
        if not isinstance(intake_id, str) or not intake_id.strip():
            continue
        slugs = engagement_company_slugs(engagement, contact_index, aliases)
        for slug in slugs:
            keys.add((intake_id.strip(), slug))
    return keys


def rejected_record(intent: dict[str, Any], *, reason: str, rejected_at: str, company_slug: str | None) -> dict[str, Any]:
    payload = dict(intent)
    payload["rejected_at"] = rejected_at
    payload["reason"] = reason
    if company_slug:
        payload["company_slug"] = company_slug
    return payload


def emit_deal_created_event(event: dict[str, Any]) -> None:
    """DESIGN-B-crm.md E1: self inbox on each consumed intent. Best-effort, never blocks the run."""
    emit_crm_event("crm.deal.created", json.dumps(event))


def build_engagement(
    *,
    intent: dict[str, Any],
    clearpath_id: int,
    aliases: dict[str, str],
    timestamp: str,
) -> dict[str, Any]:
    from crm_connect_common import canonical_company_name

    primary_contact = str(intent["primary_contact"]).strip()
    stage = str(intent["stage"]).strip()
    company = canonical_company_name(intent["company"], aliases)
    value_total = coerce_positive_value(intent.get("value"))

    engagement: dict[str, Any] = {
        "billing": None,
        "clearpath_id": clearpath_id,
        "client_industry": None,
        "client_org": company,
        "contact_ids": [primary_contact],
        "intake_id": str(intent["intake_id"]).strip(),
        "last_signal_at": timestamp,
        "merged_from_clearpath_ids": [],
        "name": str(intent["name"]).strip(),
        "primary_contact_id": primary_contact,
        "service_type": "custom",
        "stage": stage,
        "stage_changed_at": timestamp,
        "status": status_for_stage(stage),
        "value_monthly": None,
        "value_total": value_total,
    }
    return engagement


def reconcile_intake(
    *,
    queue_path: Path = INTAKE_QUEUE_PATH,
    rejected_path: Path = REJECTED_INTAKE_QUEUE_PATH,
    pipeline_path: Path = PIPELINE_PATH,
    contacts_path: Path = CONTACTS_PATH,
    aliases_path: Path = ORG_ALIASES_PATH,
    interactions_path: Path = INTERACTIONS_PATH,
    followups_path: Path = FOLLOWUPS_PATH,
    timeline_slugs_writer: TimelineWriter | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    intents = load_jsonl(queue_path)
    if not intents:
        LOGGER.info("COMMS_OK reconcile-intake: queue empty")
        return {"created": 0, "rejected": 0, "duplicates": 0, "remaining": 0, "noop": True}

    now = timestamp or now_iso()
    aliases = load_aliases(aliases_path)
    pipeline_payload = load_pipeline(pipeline_path)
    contacts_payload = load_contacts(contacts_path)
    contact_index = contacts_index(contacts_payload)
    known_stages = load_known_stages()
    engagements = pipeline_payload.get("engagements", [])
    if not isinstance(engagements, list):
        raise ValueError("pipeline.json missing engagements list")

    known_intents = existing_intent_keys(engagements, aliases, contact_index)
    next_id = next_clearpath_id(engagements)
    seen_queue_keys: set[tuple[str, str]] = set()
    remaining_intents: list[dict[str, Any]] = []
    rejected_intents: list[dict[str, Any]] = []
    created = 0
    duplicates = 0
    touched_slugs: set[str] = set()
    created_events: list[dict[str, Any]] = []

    for intent in intents:
        if not isinstance(intent, dict):
            rejected_intents.append(
                rejected_record({}, reason="malformed_intent", rejected_at=now, company_slug=None)
            )
            continue

        intent_key = normalized_intent_key(intent, aliases)
        intake_id = intent.get("intake_id")
        company_value = intent.get("company")
        if intent_key is None:
            from crm_connect_common import company_slug

            rejected_intents.append(
                rejected_record(
                    intent,
                    reason="missing_intake_id_or_company",
                    rejected_at=now,
                    company_slug=company_slug(company_value, aliases),
                )
            )
            continue

        normalized_company_slug = intent_key[1]
        if intent_key in known_intents or intent_key in seen_queue_keys:
            duplicates += 1
            continue

        name = intent.get("name")
        stage = intent.get("stage")
        primary_contact = intent.get("primary_contact")
        if not isinstance(name, str) or not name.strip():
            rejected_intents.append(
                rejected_record(
                    intent,
                    reason="missing_name",
                    rejected_at=now,
                    company_slug=normalized_company_slug,
                )
            )
            continue
        if not isinstance(stage, str) or not stage.strip():
            rejected_intents.append(
                rejected_record(
                    intent,
                    reason="missing_stage",
                    rejected_at=now,
                    company_slug=normalized_company_slug,
                )
            )
            continue
        stage_name = stage.strip()
        if stage_name not in known_stages:
            rejected_intents.append(
                rejected_record(
                    intent,
                    reason="invalid_stage",
                    rejected_at=now,
                    company_slug=normalized_company_slug,
                )
            )
            continue
        if not isinstance(primary_contact, str) or not primary_contact.strip():
            rejected_intents.append(
                rejected_record(
                    intent,
                    reason="missing_primary_contact",
                    rejected_at=now,
                    company_slug=normalized_company_slug,
                )
            )
            continue

        parsed_value = coerce_positive_value(intent.get("value"))
        if stage_name in QUALIFIED_OR_BEYOND and parsed_value is None:
            rejected_intents.append(
                rejected_record(
                    intent,
                    reason="missing_value_for_stage",
                    rejected_at=now,
                    company_slug=normalized_company_slug,
                )
            )
            continue

        seen_queue_keys.add(intent_key)
        known_intents.add(intent_key)
        engagement = build_engagement(
            intent={
                **intent,
                "intake_id": str(intake_id).strip(),
                "stage": stage_name,
                "value": parsed_value,
            },
            clearpath_id=next_id,
            aliases=aliases,
            timestamp=now,
        )
        engagements.append(engagement)
        created += 1
        next_id += 1
        touched_slugs.add(normalized_company_slug)
        created_events.append(
            {"clearpath_id": engagement["clearpath_id"], "name": engagement["name"], "company": engagement["client_org"]}
        )

    if created:
        pipeline_payload["engagements"] = engagements
        pipeline_payload["updated_at"] = now
        write_json_object_atomic(pipeline_path, pipeline_payload)

    write_jsonl_atomic(queue_path, remaining_intents)
    for rejected in rejected_intents:
        append_jsonl(rejected_path, rejected)

    for event in created_events:
        emit_deal_created_event(event)

    if touched_slugs:
        interactions = read_jsonl_rows(interactions_path)
        followups = read_jsonl_rows(followups_path)
        for slug in sorted(touched_slugs):
            if timeline_slugs_writer is not None:
                timeline_slugs_writer(slug)
            else:
                write_company_timeline_feed(
                    slug=slug,
                    pipeline_payload=pipeline_payload,
                    contacts_payload=contacts_payload,
                    interactions=interactions,
                    followups=followups,
                    aliases=aliases,
                )

    if created == 0 and not rejected_intents and duplicates > 0:
        LOGGER.info("COMMS_OK reconcile-intake: duplicates only")
    elif created == 0 and duplicates == 0 and rejected_intents:
        LOGGER.info("reconcile-intake rejected %s intents", len(rejected_intents))

    return {
        "created": created,
        "rejected": len(rejected_intents),
        "duplicates": duplicates,
        "remaining": len(remaining_intents),
        "noop": created == 0 and len(rejected_intents) == 0,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Drain CRM deal intents into pipeline.json")
    parser.add_argument("--queue-path", default=str(INTAKE_QUEUE_PATH))
    parser.add_argument("--rejected-path", default=str(REJECTED_INTAKE_QUEUE_PATH))
    parser.add_argument("--pipeline-path", default=str(PIPELINE_PATH))
    parser.add_argument("--contacts-path", default=str(CONTACTS_PATH))
    parser.add_argument("--aliases-path", default=str(ORG_ALIASES_PATH))
    parser.add_argument("--interactions-path", default=str(INTERACTIONS_PATH))
    parser.add_argument("--followups-path", default=str(FOLLOWUPS_PATH))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = parse_args(argv)
    reconcile_intake(
        queue_path=Path(args.queue_path),
        rejected_path=Path(args.rejected_path),
        pipeline_path=Path(args.pipeline_path),
        contacts_path=Path(args.contacts_path),
        aliases_path=Path(args.aliases_path),
        interactions_path=Path(args.interactions_path),
        followups_path=Path(args.followups_path),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
