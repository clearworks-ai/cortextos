# Spec 01 — pull_cxportal.py + cxportal-pull-nightly cron (P1.4, cortextos repo)

Buildable directly by codexer. Context: `../01-research.md`, `../02-master-plan.md`.
Binding scope (MASTER-BUILD-PLAN.md line 100): *Ingest wire from `~/code/cxportal` data layer
into mmrag. cxportal becomes an importer, not a peer store.*

## Files to create (all in `clearworks-ai/cortextos`, feature branch + PR, Josh merges)

| File | Purpose |
|---|---|
| `orgs/clearworksai/skills/cxportal-import/pull_cxportal.py` | The importer — stdlib-only Python 3 (urllib, json, argparse; match outputs-router precedent, no new deps) |
| `orgs/clearworksai/skills/cxportal-import/orgmap.json` | Org UUID → client slug map + explicit exclusions (content below) |
| `orgs/clearworksai/skills/cxportal-import/SKILL.md` | Skill doc: purpose, CLI, entity table, ledger format, done-condition |
| `orgs/clearworksai/skills/cxportal-import/tests/test_pull_cxportal.py` | Unit tests (below), stdlib `unittest` or pytest |
| `orgs/clearworksai/agents/larry/config.json` | ONE cron object appended to `crons` (below) |

Created at runtime, NOT committed to cortextos:
- `orgs/clearworksai/agents/larry/state/cxportal-pull-ledger.jsonl`
- snapshot files under `~/code/knowledge-sync/raw/areas/clearworks/clients/<slug>/cxportal/`
  (knowledge-sync repo commits them via its own `auto: sync` cadence)

Do NOT touch: `knowledge-base/scripts/mmrag.py` (**ingest-root registration change = NONE** —
all targets are under the existing `raw/` reconcile root; `git diff` on mmrag.py must be clean),
`bin/kb-reconcile-nightly.sh`, anything under `src/`.

## MCP endpoint contract (verified live 2026-07-31)

- URL: `https://lifecycle-killer-production.up.railway.app/mcp`
- One HTTP POST per call, body = JSON-RPC 2.0
  `{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}`
- Headers: `Content-Type: application/json`,
  `Accept: application/json, text/event-stream`,
  `Authorization: Bearer $CXPORTAL_MCP_TOKEN`
- Server is stateless Streamable HTTP (`sessionIdGenerator: undefined` in cxportal
  `server/mcp/transport.ts`) — no `initialize` session dance required for `tools/call`.
- **Response parsing (both cases mandatory):** body may be SSE-framed
  (`event: message\ndata: {json}` — the live behavior) or plain JSON. Parse: if body starts
  with `event:`/contains `\ndata: `, extract the LAST `data:` line, else parse whole body.
  Then the tool payload is **double-encoded**: `parsed["result"]["content"][0]["text"]` is a
  JSON *string* → `json.loads()` it again. `result.isError` truthy or JSON-RPC `error` key →
  tool failure.
- Token: read `CXPORTAL_MCP_TOKEN` from the process environment; if unset, try parsing
  `orgs/clearworksai/agents/larry/.env` (simple `KEY=value` lines). Still missing → exit 2 +
  red ledger row `"error": "CXPORTAL_MCP_TOKEN missing"`. NEVER hardcode the token in any
  committed file.
- Per-call: 30 s timeout, 2 retries with 5 s backoff on network/5xx errors. 401 → no retry,
  red row (token problem, retrying is noise).

## orgmap.json (ship exactly this; UUIDs verified via live `list_organizations` 2026-07-31)

```json
{
  "map": {
    "6f7bdf8c-486e-46ae-8bf7-8e91abde6d47": "alloi",
    "fe4dadf0-1b9a-4d86-90d0-160f61ae01ac": "ocg-properties",
    "2c618f5c-7e30-482d-8c1d-1633930036d9": "rrk",
    "189b89b4-578d-43b9-8856-1ef54e2b9702": "studio-pch"
  },
  "exclude": {
    "7bbe86c2-3ae2-4f3f-bc9e-daf8921e3920": "clearworks-home: internal sandbox org, no KB home",
    "94b50d89-01d3-4077-b555-05e25d8e0b89": "aerolab-industries: seed/demo data",
    "ddb015cf-19cf-46d1-b174-2438dbe0e542": "meridian-tech-group: seed/demo data",
    "d7adaa99-e042-4f66-9b06-82ef11654be8": "larry-verify-co: test org"
  }
}
```

Rule: every org returned by `list_organizations` must appear in `map` or `exclude`; any org in
neither → run goes RED with `"unmapped_orgs": [{"id": …, "name": …}]` in the ledger row.
Mapped orgs still pull (partial progress lands; red row escalates via the cron prompt).

## Entity table (module constant `ENTITIES`; per mapped org)

| entity (target file stem) | pull | enabled v1 |
|---|---|---|
| `pain-points` | `list_pain_points {orgId}` | true |
| `goals` | `list_client_goals {orgId}` | true |
| `recommendations` | `list_recommendations {orgId}` | true |
| `business-reviews` | `list_business_reviews {orgId}` | true |
| `assessments` | `list_assessment_events {orgId}`; for each event id also `get_assessment_deliverable {orgId, eventId}` (skip-with-note on per-event error result) | true |
| `engagements` | `list_engagements {orgId}` | true |
| `interviews` | `list_engagements` → per engagement `list_interviews {orgId, engagementId}` | true |
| `surveys` | per engagement `list_surveys {orgId, engagementId}`; per survey `get_survey_responses {orgId, engagementId, surveyId}` | true |
| `systems-inventory` | `list_systems_inventory {orgId}` | true |
| `desires` | `list_client_desires {orgId}` | **false** — flip after spec-02 deploys |
| `budget-signals` | `list_budget_signals {orgId}` | **false** — flip after spec-02 deploys |
| `wins` | `list_client_wins {orgId}` | **false** — flip after spec-02 deploys |

Meetings/meeting-* tools or data: explicitly NOT pulled (P1.7 owns transcript truth — see
research §2). Do not add them.

## Rendering (deterministic — required for write-if-changed)

Target: `~/code/knowledge-sync/raw/areas/clearworks/clients/<slug>/cxportal/<entity>.md`
(`os.makedirs(..., exist_ok=True)`; honor env var `CXPULL_KS_BASE` overriding
`~/code/knowledge-sync` — tests need it, same pattern as P1.2's `MIRROR_KS_BASE`).

```
---
agent: larry
job: cxportal-pull
source: cxportal-mcp
cxportal-org-id: <uuid>
entity-type: <entity>
date: <ISO date of last content change>
---
# <Org name> — cxportal <entity>

## <title-ish field or `id <id>`>          ← one section per record, sorted by numeric id
- id: 17
- status: open
- description: …                            ← every non-null field as `- key: value`,
- …                                            keys in sorted order; nested objects/arrays
                                               rendered as indented JSON (json.dumps sort_keys)
```

- Generic key/value rendering — NO per-field schema (survives cxportal column additions).
  Section heading = first present of `title`/`name`/`description[:80]`, else `id <id>`.
- **Write-if-changed:** render the full file; compare against the existing file with the
  `date:` frontmatter line masked out on both sides; identical → do not write (statuses
  `unchanged`); different or absent → write atomically (tmp + `os.replace`), `date:` = today
  (status `updated`/`created`). Empty result set → still write the file with a
  `_No records._` body line (proves the pull ran; stable thereafter).
- A record deleted in cxportal simply vanishes from the regenerated file — no tombstones.

## CLI

```
python3 orgs/clearworksai/skills/cxportal-import/pull_cxportal.py run \
  [--orgmap <path>] [--ledger <path>] [--dry-run] [--org <slug>] [--source-task <bus-task-id>]
```

- Defaults: orgmap = sibling `orgmap.json`; ledger =
  `orgs/clearworksai/agents/larry/state/cxportal-pull-ledger.jsonl` (resolve the repo root
  from `__file__`, 3 dirs up — NOT a hardcoded `~/code/cortextos`).
- `--dry-run`: full pull + render + compare, prints per-file would-be statuses, writes no
  snapshot files and no ledger row, exit 0.
- `--org <slug>`: restrict to one mapped org (manual debugging).
- Exit codes: 0 = green; 1 = red (any failure/unmapped org); 2 = config error (missing token/
  orgmap unreadable).

## Ledger row (append one JSON line per non-dry run; atomic append)

```json
{"ts": "<UTC ISO>", "job": "cxportal-pull", "source_task": "<id or null>", "green": true,
 "orgs": {"alloi": {"pain-points": {"records": 34, "status": "updated"}, "...": {}}},
 "files_created": 0, "files_updated": 2, "files_unchanged": 34,
 "tool_errors": [], "unmapped_orgs": [], "duration_s": 41.2}
```

`green` ⇔ zero `tool_errors` AND zero `unmapped_orgs` AND exit path normal. Any per-tool
failure lands in `tool_errors` as `{"org": …, "entity": …, "tool": …, "error": …}` and forces
`"green": false` (successfully pulled files still get written first).

## Cron entry (append to `crons` in `orgs/clearworksai/agents/larry/config.json`)

Match the existing kb-reconcile-nightly object shape exactly (`name`/`type`/`cron`/`prompt`):
- `name`: `cxportal-pull-nightly`, `type`: `recurring`, `cron`: `"52 2 * * *"`
  (before kb-reconcile-nightly 03:37 so the same night's reconcile ingests fresh snapshots;
  offset from pipeline-bypass-audit 02:30 and weekly-security-audit Wed 03:07).
- `prompt`, mirroring the kb-reconcile-nightly pattern: create bus task → `update-cron-fire
  cxportal-pull-nightly --interval 24h` → (1) check the PREVIOUS ledger row (`tail -1
  $CTX_AGENT_DIR/state/cxportal-pull-ledger.jsonl`); missing or `"green": false` → Telegram
  6690120787 with the row (silent failure not acceptable) → (2) run
  `python3 <repo>/orgs/clearworksai/skills/cxportal-import/pull_cxportal.py run --source-task
  $TASK_ID` in the FOREGROUND (timeout 600000 — ~40 small calls, minutes not hours) → (3)
  complete the bus task with the summary line; SILENT-OK when previous row green + tonight's
  run green.

## Tests (fixtures only — never hit the live endpoint; serve canned responses from a local `http.server` thread or by injecting a fake `urlopen`)

| # | Case | Assert |
|---|---|---|
| t1 | SSE-framed response (`event: message\ndata: {...}`) | parsed; double-encoded `content[0].text` decoded to records |
| t2 | plain-JSON response | same records as t1 |
| t3 | deterministic render | two renders of shuffled record lists are byte-identical |
| t4 | write-if-changed | 2nd run with same data → status `unchanged`, file mtime unchanged, `date:` frontmatter not bumped |
| t5 | changed record | status `updated`, `date:` bumped, body reflects change |
| t6 | org in neither map nor exclude | `"green": false`, `unmapped_orgs` names it, exit 1, mapped orgs still written |
| t7 | tool returns `isError` | `tool_errors` row, `"green": false`, other entities still written |
| t8 | missing `CXPORTAL_MCP_TOKEN` | exit 2, red ledger row, no snapshot writes |
| t9 | `--dry-run` | no file writes, no ledger row, exit 0 |
| t10 | empty result set | `_No records._` file written once, `unchanged` thereafter |
| t11 | disabled entity (`desires`) | not called, absent from ledger org block |
| t12 | nested/jsonb field | rendered as sorted-key indented JSON, stable across runs |

All tests write only under a tmp dir via `CXPULL_KS_BASE` + `--ledger`/`--orgmap` overrides.

## Done-condition (machine-checkable — matches Master Build Plan P1 block style)

```
ls ~/code/knowledge-sync/raw/areas/clearworks/clients/*/cxportal/*.md | wc -l   # ≥ 4
tail -1 orgs/clearworksai/agents/larry/state/cxportal-pull-ledger.jsonl         # "green": true; 3 consecutive green rows = steady state
git diff --stat knowledge-base/scripts/mmrag.py                                 # empty — root registration is a no-op by design
```

Plus, after the next kb-reconcile-nightly row: raw distinct-file count increased by ≈ the new
snapshot count, and one `kb-query` for a known cxportal fact returns a citation whose path
contains `/clients/<slug>/cxportal/` (run and capture as evidence, P1.3 step-f style).
Plus: all tests green; no modification to `mmrag.py`/`kb-reconcile-nightly.sh` (git diff clean).

## Out of scope (do not build)

Meetings/transcript pull (P1.7), any cxportal-side change (spec 02, separate PR), write-backs
into cxportal, token rotation for the exposed auditmaster `.mcp.json` bearer token (flagged in
research §7 — separate task), retiring cxportal's internal pgvector search.
