#!/usr/bin/env python3
"""Validate a single-client AI adoption-readiness evidence ledger."""

import argparse
import json
import re
import sys
from pathlib import Path

AREAS = {
    "tools_in_use",
    "admin_ownership",
    "sso_provisioning_offboarding",
    "privacy_retention_training_connectors",
    "company_data_use",
    "approved_use_human_review",
    "role_training",
    "adoption_sticking_points",
    "use_case_intake_ownership",
    "prioritized_fixes",
}
CONFIDENCE = {"confirmed", "reported", "inferred"}
STATES = {"current_state", "gap"}
TIMINGS = {"now", "later"}
AREA_STATUS = {"evidenced", "not_established"}
ID_RE = re.compile(r"^AIR-[0-9]{3}$")
REC_ID_RE = re.compile(r"^AIR-R[0-9]{3}$")


def require_text(value, label, errors):
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{label} must be non-empty text")


def validate_evidence(items, client_slug, label, errors):
    if not isinstance(items, list) or not items:
        errors.append(f"{label}.evidence must contain at least one citation")
        return
    for index, item in enumerate(items):
        where = f"{label}.evidence[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{where} must be an object")
            continue
        if item.get("evidence_client") != client_slug:
            errors.append(f"{where}.evidence_client crosses the client boundary")
        for key in ("source_path", "citation"):
            require_text(item.get(key), f"{where}.{key}", errors)
        if item.get("confidence") not in CONFIDENCE:
            errors.append(f"{where}.confidence must be one of {sorted(CONFIDENCE)}")
        source_path = item.get("source_path", "")
        if isinstance(source_path, str) and (".." in source_path or "secret" in source_path.lower()):
            errors.append(f"{where}.source_path contains a prohibited path segment")


def validate(payload):
    errors = []
    if payload.get("schema_version") != 1:
        errors.append("schema_version must equal 1")
    client_slug = payload.get("client_slug")
    require_text(client_slug, "client_slug", errors)
    require_text(payload.get("project_id"), "project_id", errors)
    require_text(payload.get("generated_on"), "generated_on", errors)
    if not isinstance(client_slug, str):
        client_slug = ""

    areas = payload.get("assessment_areas")
    if not isinstance(areas, list):
        errors.append("assessment_areas must be a list")
        areas = []
    seen_areas = set()
    for index, area in enumerate(areas):
        label = f"assessment_areas[{index}]"
        if not isinstance(area, dict):
            errors.append(f"{label} must be an object")
            continue
        key = area.get("area")
        if key not in AREAS:
            errors.append(f"{label}.area must be an allowed assessment area")
        elif key in seen_areas:
            errors.append(f"{label}.area is duplicated")
        else:
            seen_areas.add(key)
        if area.get("status") not in AREA_STATUS:
            errors.append(f"{label}.status must be one of {sorted(AREA_STATUS)}")
        require_text(area.get("notes"), f"{label}.notes", errors)
        if area.get("status") == "evidenced":
            validate_evidence(area.get("evidence"), client_slug, label, errors)
        elif area.get("evidence") not in (None, []):
            errors.append(f"{label}.evidence must be empty when status is not_established")
    missing_areas = sorted(AREAS - seen_areas)
    if missing_areas:
        errors.append(f"assessment_areas missing: {', '.join(missing_areas)}")

    findings = payload.get("findings")
    if not isinstance(findings, list):
        errors.append("findings must be a list")
        findings = []
    finding_ids = set()
    for index, finding in enumerate(findings):
        label = f"findings[{index}]"
        if not isinstance(finding, dict):
            errors.append(f"{label} must be an object")
            continue
        finding_id = finding.get("id")
        if not isinstance(finding_id, str) or not ID_RE.match(finding_id):
            errors.append(f"{label}.id must match AIR-###")
        elif finding_id in finding_ids:
            errors.append(f"{label}.id is duplicated")
        else:
            finding_ids.add(finding_id)
        if finding.get("area") not in AREAS:
            errors.append(f"{label}.area must be an allowed assessment area")
        if finding.get("state") not in STATES:
            errors.append(f"{label}.state must be one of {sorted(STATES)}")
        for key in ("title", "detail"):
            require_text(finding.get(key), f"{label}.{key}", errors)
        validate_evidence(finding.get("evidence"), client_slug, label, errors)

    recommendations = payload.get("recommendations")
    if not isinstance(recommendations, list):
        errors.append("recommendations must be a list")
        recommendations = []
    recommendation_ids = set()
    for index, recommendation in enumerate(recommendations):
        label = f"recommendations[{index}]"
        if not isinstance(recommendation, dict):
            errors.append(f"{label} must be an object")
            continue
        recommendation_id = recommendation.get("id")
        if not isinstance(recommendation_id, str) or not REC_ID_RE.match(recommendation_id):
            errors.append(f"{label}.id must match AIR-R###")
        elif recommendation_id in recommendation_ids:
            errors.append(f"{label}.id is duplicated")
        else:
            recommendation_ids.add(recommendation_id)
        if recommendation.get("timing") not in TIMINGS:
            errors.append(f"{label}.timing must be one of {sorted(TIMINGS)}")
        for key in ("title", "action", "owner"):
            require_text(recommendation.get(key), f"{label}.{key}", errors)
        dependencies = recommendation.get("dependencies")
        if not isinstance(dependencies, list):
            errors.append(f"{label}.dependencies must be a list")
        addresses = recommendation.get("addresses")
        if not isinstance(addresses, list) or not addresses:
            errors.append(f"{label}.addresses must contain at least one finding id")
        else:
            unknown = sorted(set(addresses) - finding_ids)
            if unknown:
                errors.append(f"{label}.addresses references unknown findings: {', '.join(unknown)}")

    evidence_gaps = payload.get("evidence_gaps")
    if not isinstance(evidence_gaps, list):
        errors.append("evidence_gaps must be a list")
        evidence_gaps = []
    for index, gap in enumerate(evidence_gaps):
        label = f"evidence_gaps[{index}]"
        if not isinstance(gap, dict):
            errors.append(f"{label} must be an object")
            continue
        require_text(gap.get("question"), f"{label}.question", errors)
        require_text(gap.get("owner"), f"{label}.owner", errors)

    not_established = sum(1 for area in areas if isinstance(area, dict) and area.get("status") == "not_established")
    if not_established and not evidence_gaps:
        errors.append("not_established areas require at least one evidence gap question")

    optional_support = payload.get("optional_support")
    if optional_support is not None and (not isinstance(optional_support, str) or not optional_support.strip()):
        errors.append("optional_support must be null or non-empty text")
    return errors


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("ledger")
    args = parser.parse_args()

    try:
        payload = json.loads(Path(args.ledger).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"FAIL: unable to read ledger: {exc}")
        return 2
    errors = validate(payload)
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS: readiness ledger is single-client, complete, cited, and state-valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())

