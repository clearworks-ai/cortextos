# cxportal-pull — Import cxportal data into knowledge-sync

Purpose: Pull entities from cxportal MCP endpoint into knowledge-sync client directories as markdown snapshot files. Runs nightly via cron, feeds kb-reconcile-nightly.

## CLI

```bash
python3 orgs/clearworksai/skills/cxportal-import/pull_cxportal.py run \
  [--orgmap <path>] [--ledger <path>] [--dry-run] [--org <slug>] [--source-task <bus-task-id>]
```

- Defaults: orgmap = sibling `orgmap.json`; ledger = `orgs/clearworksai/agents/larry/state/cxportal-pull-ledger.jsonl`
- `--dry-run`: Full pull + render + compare, prints would-be statuses, writes no files/ledger, exit 0
- `--org <slug>`: Restrict to one mapped org (debugging)
- Exit codes: 0 = green; 1 = red (failure/unmapped org); 2 = config error (token/orgmap missing)

## Entity table

| Entity | Tool | Enabled | Parent | Notes |
|--------|------|---------|--------|-------|
| pain-points | list_pain_points | true | — | |
| goals | list_client_goals | true | — | |
| recommendations | list_recommendations | true | — | |
| business-reviews | list_business_reviews | true | — | |
| assessments | list_assessment_events | true | — | Follows up with get_assessment_deliverable per event |
| engagements | list_engagements | true | — | |
| interviews | — | true | engagements | Pulled per engagement via list_interviews |
| surveys | — | true | engagements | Pulled per engagement via list_surveys + get_survey_responses |
| systems-inventory | list_systems_inventory | true | — | |
| desires | list_client_desires | false | — | Disabled by spec |
| budget-signals | list_budget_signals | false | — | Disabled by spec |
| wins | list_client_wins | false | — | Disabled by spec |

## Ledger row format

```json
{
  "ts": "<UTC ISO>",
  "job": "cxportal-pull",
  "source_task": "<bus-task-id or null>",
  "green": true,
  "orgs": {
    "alloi": {
      "pain-points": {"records": 34, "status": "updated"},
      "goals": {"records": 12, "status": "unchanged"}
    }
  },
  "files_created": 0,
  "files_updated": 2,
  "files_unchanged": 34,
  "tool_errors": [],
  "unmapped_orgs": [],
  "duration_s": 41.2
}
```

- `green`: true iff zero tool_errors AND zero unmapped_orgs AND normal exit
- `tool_errors`: Array of `{"org": "<slug>", "entity": "<name>", "tool": "<tool>", "error": "<msg>"}`
- `unmapped_orgs`: Array of `{"id": "<uuid>", "name": "<name>"}` for orgs in neither map nor exclude

## File format

Snapshot files written to `~/code/knowledge-sync/raw/areas/clearworks/clients/<slug>/cxportal/<entity>.md`

Frontmatter:
```yaml
---
agent: larry
job: cxportal-pull
source: cxportal-mcp
cxportal-org-id: <uuid>
entity-type: <entity>
date: <UTC ISO>
---
```

Body: One section per record, sorted by numeric id
```markdown
# <Org name> — cxportal <entity>

## <title|name|description[:80]|id <id>>
- id: 17
- status: open
- description: ...
- metadata: {"key": "value"}  # nested objects/arrays as sorted JSON
```

## MCP endpoint

- URL: `https://lifecycle-killer-production.up.railway.app/mcp`
- Auth: Bearer `$CXPORTAL_MCP_TOKEN` (from env or larry/.env)
- Protocol: JSON-RPC 2.0 via HTTP POST, double-encoded response
- Response parsing: Handles both SSE-framed (`event: message\ndata: {...}`) and plain JSON

## Done-condition

```bash
# At least 4 snapshot files exist
ls ~/code/knowledge-sync/raw/areas/clearworks/clients/*/cxportal/*.md | wc -l  # ≥ 4

# Last 3 ledger rows are green (steady state)
tail -3 orgs/clearworksai/agents/larry/state/cxportal-pull-ledger.jsonl | jq -r '.green'  # true\ntrue\ntrue

# No mmrag.py changes (root registration is a no-op)
git diff --stat knowledge-base/scripts/mmrag.py  # empty

# All tests green
cd orgs/clearworksai/skills/cxportal-import && python3 -m pytest tests/ -v  # 19/19 passed

# kb-query returns cxportal citation (after next reconcile)
kb-query "alloi pain points"  # path contains /clients/alloi/cxportal/
```