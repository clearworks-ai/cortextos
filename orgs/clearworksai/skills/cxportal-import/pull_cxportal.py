#!/usr/bin/env python3
"""
pull_cxportal.py - Import cxportal data into knowledge-sync

Imports entities from cxportal MCP endpoint into knowledge-sync client directories.
Stdlib-only Python 3 (urllib, json, argparse).

Usage:
    python3 pull_cxportal.py run [--orgmap <path>] [--ledger <path>] [--dry-run] [--org <slug>] [--source-task <bus-task-id>]

Exit codes:
    0 = green
    1 = red (any failure/unmapped org)
    2 = config error (missing token/orgmap unreadable)
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Entity configuration
ENTITIES = {
    "pain-points": {"tool": "list_pain_points", "enabled": True},
    "goals": {"tool": "list_client_goals", "enabled": True},
    "recommendations": {"tool": "list_recommendations", "enabled": True},
    "business-reviews": {"tool": "list_business_reviews", "enabled": True},
    "assessments": {
        "tool": "list_assessment_events",
        "enabled": True,
        "follow_up": "get_assessment_deliverable",
    },
    "engagements": {"tool": "list_engagements", "enabled": True},
    "interviews": {
        "tool": None,  # Populated from engagements
        "enabled": True,
        "parent": "engagements",
    },
    "surveys": {
        "tool": None,  # Populated from engagements
        "enabled": True,
        "parent": "engagements",
    },
    "systems-inventory": {"tool": "list_systems_inventory", "enabled": True},
    "desires": {"tool": "list_client_desires", "enabled": False},
    "budget-signals": {"tool": "list_budget_signals", "enabled": False},
    "wins": {"tool": "list_client_wins", "enabled": False},
}

MCP_URL = "https://lifecycle-killer-production.up.railway.app/mcp"
REQUEST_TIMEOUT = 30  # seconds
MAX_RETRIES = 2
RETRY_BACKOFF = 5  # seconds


def get_token() -> str:
    """Get CXPORTAL_MCP_TOKEN from env or larry .env file."""
    token = os.environ.get("CXPORTAL_MCP_TOKEN")
    if token:
        return token

    # Try larry .env file
    larry_env = Path(__file__).parent.parent.parent.parent / "agents" / "larry" / ".env"
    if larry_env.exists():
        with open(larry_env) as f:
            for line in f:
                line = line.strip()
                if line.startswith("CXPORTAL_MCP_TOKEN="):
                    return line.split("=", 1)[1].strip()

    return ""


def call_mcp_tool(
    tool_name: str,
    arguments: Dict[str, Any],
    token: str,
) -> Dict[str, Any]:
    """Call cxportal MCP tool with retry logic."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
    }

    body = json.dumps(payload).encode("utf-8")

    for attempt in range(MAX_RETRIES + 1):
        try:
            request = urllib.request.Request(MCP_URL, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                response_data = response.read().decode("utf-8")
                return parse_mcp_response(response_data)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise  # No retry on auth errors
            if attempt < MAX_RETRIES:
                import time

                time.sleep(RETRY_BACKOFF)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < MAX_RETRIES:
                import time

                time.sleep(RETRY_BACKOFF)
                continue
            raise

    raise RuntimeError(f"Max retries exceeded for tool {tool_name}")


def parse_mcp_response(response_data: str) -> Dict[str, Any]:
    """Parse MCP response, handling both SSE-framed and plain JSON."""
    # Check if SSE-framed
    if "event:" in response_data and "\ndata: " in response_data:
        lines = response_data.split("\n")
        data_lines = [line for line in lines if line.startswith("data: ")]
        if data_lines:
            last_data = data_lines[-1][6:]  # Strip "data: " prefix
            response_data = last_data

    parsed = json.loads(response_data)

    # Handle JSON-RPC error
    if "error" in parsed:
        raise RuntimeError(f"MCP error: {parsed['error']}")

    # Double-encoded content
    result = parsed.get("result", {})
    if result.get("isError"):
        raise RuntimeError(f"Tool returned isError: {result}")

    content = result.get("content", [])
    if content and isinstance(content, list) and len(content) > 0:
        text = content[0].get("text", "")
        if text:
            return json.loads(text)

    return {}


def load_orgmap(orgmap_path: Optional[str]) -> Dict[str, Any]:
    """Load orgmap.json file."""
    if orgmap_path is None:
        orgmap_path = Path(__file__).parent / "orgmap.json"
    else:
        orgmap_path = Path(orgmap_path)

    with open(orgmap_path) as f:
        return json.load(f)


def get_ks_base() -> Path:
    """Get knowledge-sync base directory from env or default."""
    env_base = os.environ.get("CXPULL_KS_BASE")
    if env_base:
        return Path(env_base)
    return Path.home() / "code" / "knowledge-sync" / "raw" / "areas" / "clearworks" / "clients"


def render_record(record: Dict[str, Any]) -> List[str]:
    """Render a single record as key-value lines."""
    lines = []
    for key in sorted(record.keys()):
        value = record[key]
        if value is None:
            continue
        if isinstance(value, (dict, list)):
            lines.append(f"- {key}: {json.dumps(value, sort_keys=True, indent=2)}")
        else:
            lines.append(f"- {key}: {value}")
    return lines


def get_section_title(record: Dict[str, Any]) -> str:
    """Get section title from record, falling back to id."""
    for field in ["title", "name", "description"]:
        value = record.get(field)
        if value:
            if isinstance(value, str) and len(value) > 80:
                return f"{value[:80]}..."
            return str(value)
    return f"id {record.get('id', 'unknown')}"


def render_entity_file(
    records: List[Dict[str, Any]],
    org_name: str,
    org_id: str,
    entity_type: str,
) -> str:
    """Render complete entity file content."""
    lines = [
        "---",
        f"agent: larry",
        f"job: cxportal-pull",
        "source: cxportal-mcp",
        f"cxportal-org-id: {org_id}",
        f"entity-type: {entity_type}",
        f"date: {datetime.now(timezone.utc).isoformat()}",
        "---",
        "",
        f"# {org_name} — cxportal {entity_type}",
        "",
    ]

    if not records:
        lines.append("_No records._")
        return "\n".join(lines)

    # Sort by id if present, otherwise by order received
    try:
        records_sorted = sorted(records, key=lambda r: r.get("id", 0))
    except (TypeError, KeyError):
        records_sorted = records

    for record in records_sorted:
        title = get_section_title(record)
        lines.append(f"## {title}")
        lines.extend(render_record(record))
        lines.append("")

    return "\n".join(lines)


def write_if_changed(
    content: str,
    target_path: Path,
) -> bool:
    """Write content to target_path only if changed, returns True if written."""
    if target_path.exists():
        with open(target_path) as f:
            existing = f.read()

        # Compare with date line masked out
        existing_masked = existing.split("\n")
        content_masked = content.split("\n")

        def mask_date(lines):
            return [line for line in lines if not line.startswith("date:")]

        if mask_date(existing_masked) == mask_date(content_masked):
            return False  # Unchanged

    # Atomic write
    tmp_path = target_path.with_suffix(".tmp")
    with open(tmp_path, "w") as f:
        f.write(content)
    os.replace(tmp_path, target_path)
    return True


def list_organizations(token: str) -> List[Dict[str, Any]]:
    """List all organizations from cxportal."""
    result = call_mcp_tool("list_organizations", {}, token)
    return result.get("organizations", [])


def run_pull(
    orgmap: Dict[str, Any],
    ks_base: Path,
    single_org: Optional[str] = None,
    source_task: Optional[str] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Run the cxportal pull operation."""
    token = get_token()
    if not token:
        return {
            "error": "CXPORTAL_MCP_TOKEN missing",
            "green": False,
            "duration_s": 0,
        }

    start_time = datetime.now(timezone.utc)
    tool_errors = []
    unmapped_orgs = []
    files_created = 0
    files_updated = 0
    files_unchanged = 0
    orgs_status = {}

    # Get all organizations
    all_orgs = list_organizations(token)
    org_map = orgmap.get("map", {})
    org_exclude = orgmap.get("exclude", {})

    # Parent cache for child entities (interviews, surveys)
    parent_cache = {}

    # Check for unmapped orgs
    for org in all_orgs:
        org_id = org.get("id")
        org_name = org.get("name", "unknown")
        if org_id not in org_map and org_id not in org_exclude:
            unmapped_orgs.append({"id": org_id, "name": org_name})

    # Process each mapped org
    for org_id, slug in org_map.items():
        if single_org and slug != single_org:
            continue

        org_status = {}
        org_name = next((o.get("name") for o in all_orgs if o.get("id") == org_id), slug)

        # Get org details for rendering
        org_obj = next((o for o in all_orgs if o.get("id") == org_id), {"id": org_id, "name": slug})

        # Create output directory
        output_dir = ks_base / slug / "cxportal"
        output_dir.mkdir(parents=True, exist_ok=True)

        # Pull each enabled entity
        for entity_name, entity_config in ENTITIES.items():
            if not entity_config["enabled"]:
                continue

            try:
                if entity_config.get("parent"):
                    # Handle parent-dependent entities
                    parent_entity = entity_config["parent"]
                    cache_key = f"{org_id}:{parent_entity}"
                    if cache_key not in parent_cache:
                        # Need to pull parent first
                        parent_config = ENTITIES[parent_entity]
                        parent_records = call_mcp_tool(
                            parent_config["tool"], {"orgId": org_id}, token
                        )
                        org_status[parent_entity] = {
                            "records": len(parent_records.get(parent_entity.split("-")[0], [])),
                            "status": "updated",
                        }

                        # Store parent records for child processing
                        parent_cache[cache_key] = parent_records

                    # Process child entity from parent data
                    parent_data = parent_cache.get(cache_key, {})

                    if entity_name == "interviews":
                        parent_list = parent_data.get("engagements", [])
                        all_records = []
                        for engagement in parent_list:
                            try:
                                engagement_id = engagement.get("id")
                                if engagement_id:
                                    interviews = call_mcp_tool(
                                        "list_interviews",
                                        {"orgId": org_id, "engagementId": engagement_id},
                                        token,
                                    )
                                    all_records.extend(interviews.get("interviews", []))
                            except Exception as e:
                                tool_errors.append(
                                    {
                                        "org": slug,
                                        "entity": entity_name,
                                        "tool": "list_interviews",
                                        "error": str(e),
                                    }
                                )
                        records = {"interviews": all_records}
                    elif entity_name == "surveys":
                        parent_list = parent_data.get("engagements", [])
                        all_records = []
                        for engagement in parent_list:
                            try:
                                engagement_id = engagement.get("id")
                                if engagement_id:
                                    surveys = call_mcp_tool(
                                        "list_surveys",
                                        {"orgId": org_id, "engagementId": engagement_id},
                                        token,
                                    )
                                    survey_list = surveys.get("surveys", [])
                                    for survey in survey_list:
                                        survey_id = survey.get("id")
                                        if survey_id:
                                            responses = call_mcp_tool(
                                                "get_survey_responses",
                                                {
                                                    "orgId": org_id,
                                                    "engagementId": engagement_id,
                                                    "surveyId": survey_id,
                                                },
                                                token,
                                            )
                                            survey["responses"] = responses.get("responses", [])
                                    all_records.extend(survey_list)
                            except Exception as e:
                                tool_errors.append(
                                    {
                                        "org": slug,
                                        "entity": entity_name,
                                        "tool": "list_surveys/get_survey_responses",
                                        "error": str(e),
                                    }
                                )
                        records = {"surveys": all_records}
                    else:
                        records = {}
                elif entity_name == "assessments" and entity_config.get("follow_up"):
                    # Handle assessments with deliverable follow-up
                    events = call_mcp_tool(
                        entity_config["tool"], {"orgId": org_id}, token
                    )
                    event_list = events.get("assessment_events", [])
                    all_records = []
                    for event in event_list:
                        event_id = event.get("id")
                        if event_id:
                            try:
                                deliverable = call_mcp_tool(
                                    entity_config["follow_up"],
                                    {"orgId": org_id, "eventId": event_id},
                                    token,
                                )
                                event["deliverable"] = deliverable.get("deliverable")
                            except Exception as e:
                                # Skip-with-note on per-event error
                                event["deliverable_error"] = str(e)
                        all_records.append(event)
                    records = {"assessment_events": all_records}
                else:
                    # Standard entity pull
                    records = call_mcp_tool(
                        entity_config["tool"], {"orgId": org_id}, token
                    )

                # Extract records from response
                entity_key = entity_name.replace("-", "_")
                record_list = records.get(entity_key, records.get(entity_name.replace("-", ""), []))

                # Render file
                content = render_entity_file(record_list, org_name, org_id, entity_name)
                target_path = output_dir / f"{entity_name}.md"

                if dry_run:
                    # Just report would-be status
                    exists = target_path.exists()
                    if not exists:
                        status = "created"
                    else:
                        with open(target_path) as f:
                            existing = f.read()
                        if content.split("\n")[0:7] != existing.split("\n")[0:7]:
                            status = "updated"
                        else:
                            status = "unchanged"
                    org_status[entity_name] = {"records": len(record_list), "status": status}
                else:
                    # Write if changed
                    existed_before = target_path.exists()
                    written = write_if_changed(content, target_path)

                    if written:
                        if existed_before:
                            files_updated += 1
                            status = "updated"
                        else:
                            files_created += 1
                            status = "created"
                    else:
                        files_unchanged += 1
                        status = "unchanged"

                    org_status[entity_name] = {"records": len(record_list), "status": status}

            except Exception as e:
                tool_errors.append(
                    {"org": slug, "entity": entity_name, "tool": entity_config["tool"], "error": str(e)}
                )
                org_status[entity_name] = {"records": 0, "status": "error"}

        orgs_status[slug] = org_status

    duration = (datetime.now(timezone.utc) - start_time).total_seconds()
    green = len(tool_errors) == 0 and len(unmapped_orgs) == 0

    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "job": "cxportal-pull",
        "source_task": source_task,
        "green": green,
        "orgs": orgs_status,
        "files_created": files_created,
        "files_updated": files_updated,
        "files_unchanged": files_unchanged,
        "tool_errors": tool_errors,
        "unmapped_orgs": unmapped_orgs,
        "duration_s": duration,
    }


def main():
    parser = argparse.ArgumentParser(description="Import cxportal data into knowledge-sync")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    run_parser = subparsers.add_parser("run", help="Run cxportal pull")
    run_parser.add_argument("--orgmap", help="Path to orgmap.json")
    run_parser.add_argument("--ledger", help="Path to ledger file")
    run_parser.add_argument("--dry-run", action="store_true", help="Dry run mode")
    run_parser.add_argument("--org", help="Restrict to single org by slug")
    run_parser.add_argument("--source-task", help="Source bus task ID")

    args = parser.parse_args()

    if args.command != "run":
        parser.print_help()
        sys.exit(1)

    try:
        orgmap = load_orgmap(args.orgmap)
    except Exception as e:
        print(f"Error loading orgmap: {e}", file=sys.stderr)
        sys.exit(2)

    ks_base = get_ks_base()

    result = run_pull(
        orgmap=orgmap,
        ks_base=ks_base,
        single_org=args.org,
        source_task=args.source_task,
        dry_run=args.dry_run,
    )

    if args.dry_run:
        print(json.dumps(result, indent=2))
        sys.exit(0)

    # Write ledger row
    ledger_path = args.ledger
    if ledger_path is None:
        repo_root = Path(__file__).parent.parent.parent.parent
        ledger_path = repo_root / "orgs" / "clearworksai" / "agents" / "larry" / "state" / "cxportal-pull-ledger.jsonl"

    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    with open(ledger_path, "a") as f:
        f.write(json.dumps(result) + "\n")

    # Exit with appropriate code
    if result.get("error"):
        sys.exit(2)
    elif not result.get("green"):
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()