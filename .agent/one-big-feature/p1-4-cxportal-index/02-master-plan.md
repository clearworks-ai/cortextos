# P1.4 — CX Portal → index — Master Plan (OBF-lite, exempt)

Source of truth: MASTER-BUILD-PLAN.md line 100 (binding), lines 108–113 (done-condition style).
Research: `01-research.md`. Specs: `03-specs/01-cxportal-pull-spec.md` (cortextos),
`03-specs/02-mcp-read-surface-spec.md` (cxportal).

## Scope (why OBF-lite exempt, not full M2C1)

No schema migration, no net-new subsystem, no `src/` changes in cortextos. The read contract
(cxportal's read-only MCP at `/mcp`) already exists and is verified live; mmrag reconcile
machinery already exists (P1.1). This item is: one stdlib-Python puller + one org map + one
larry cron (cortextos repo), plus one ~30-line read-surface extension PR in the cxportal repo.
Two repos, but the cxportal change is additive tool registration on an existing MCP server —
not a new subsystem.

## The wire

```
cxportal Postgres (Railway — stays the app's operational store)
        │  read-only MCP tools/call (bearer CXPORTAL_MCP_TOKEN, stateless JSON-RPC POST)
        ▼
pull_cxportal.py  (nightly, larry cron `cxportal-pull-nightly`, 02:57 PT)
        │  renders deterministic per-org / per-entity markdown snapshots,
        │  provenance in frontmatter, write-only-if-content-changed
        ▼
~/code/knowledge-sync/raw/areas/clearworks/clients/<slug>/cxportal/<entity>.md
        │  already inside DEFAULT_RECONCILE_ROOTS (raw/) — NO mmrag root change
        ▼
kb-reconcile-nightly (03:37 PT, P1.1) → mmrag re-ingests changed snapshots → kb-query cites them
```

cxportal becomes an importer feed, not a peer store: KB truth flows one way into
knowledge-sync/mmrag; nothing writes back; agents answer KB questions from mmrag only.

## Target paths (P1.0 routing convention — content-type based, provenance in frontmatter)

- Content type = **client** → client home. Per the P1.2 decided dirmap value
  (`client_home: raw/areas/clearworks/clients` — the existing taxonomy's client home, chosen
  over the router's raw top-level `<client>/` mapping at the P1.2 review gate), snapshots land at:
  `~/code/knowledge-sync/raw/areas/clearworks/clients/<slug>/cxportal/<entity>.md`
  with `<slug>` ∈ {alloi, ocg-properties, rrk, studio-pch} (all four dirs already exist) and
  `<entity>` ∈ {pain-points, goals, recommendations, business-reviews, assessments,
  engagements, interviews, surveys, systems-inventory} (+ desires, budget-signals, wins after
  spec-02 lands).
- Provenance lives in FRONTMATTER, never the path (P1.0 rule): `agent: larry`,
  `job: cxportal-pull`, `source: cxportal-mcp`, `cxportal-org-id: <uuid>`,
  `entity-type: <entity>`, `date: <ISO of last content change>`. No `--source-task` per row —
  the nightly cron's bus task id goes in the ledger row instead.
- Orgs excluded in v1 (explicit in `orgmap.json`): Clearworks Home (internal sandbox),
  Aerolab Industries + Meridian Tech Group (seed/demo), Larry Verify Co (test). Unmapped AND
  unexcluded org → red ledger row naming it.

## Phases

### Phase 1 — importer (cortextos, spec 01)
- New skill dir `orgs/clearworksai/skills/cxportal-import/`: `pull_cxportal.py` (stdlib-only),
  `orgmap.json`, `SKILL.md`, `tests/test_pull_cxportal.py`. Divergence budget: `orgs/`, never
  `src/` — no fork-delta ledger row.
- Deterministic rendering (sorted by id), write-if-changed (volatile `date` excluded from the
  comparison), SSE + double-encoded-JSON response parsing, per-tool retry, red/green JSONL
  ledger at `orgs/clearworksai/agents/larry/state/cxportal-pull-ledger.jsonl`.

### Phase 2 — cron (cortextos, spec 01)
- One cron object in larry's `config.json`: `cxportal-pull-nightly`, `52 2 * * *` PT —
  BEFORE kb-reconcile-nightly (03:37) so the same night's reconcile ingests fresh snapshots;
  offset from pipeline-bypass-audit (02:30) and weekly-security-audit (Wed 03:07). Separate
  cron by design: a cxportal/Railway blip reddens the pull ledger, never the KB ledger.
- Prompt mirrors the kb-reconcile-nightly pattern (bus task → update-cron-fire → check
  previous row, Telegram on red/missing → run script → complete task). Pulls are small
  (hundreds of rows over ~40 MCP calls) — run in the foreground with a 10-min timeout, no
  background launch needed.

### Phase 3 — cxportal MCP read-surface extension (cxportal repo, spec 02)
- Add `list_client_desires`, `list_budget_signals`, `list_client_wins` to
  `READ_ONLY_AUDIT_TOOL_NAMES` + `buildAuditToolDefinitions` (storage methods already exist).
  Separate PR to `clearworks-ai/cxportal`; Railway auto-deploys on merge to main.
- Then flip the three pre-registered entities in `pull_cxportal.py`'s ENTITY table from
  `"enabled": false` to `true` (a data-only edit; spec 01 builds the mechanism).
- Phase 3 is NOT a blocker for phases 1–4 going live — the v1 entity set already covers the
  core intelligence (pain points, goals, recommendations, reviews, assessments, engagements,
  interviews, surveys, systems).

### Phase 4 — first run + proof
- Run the puller once manually; verify snapshot files + green ledger row.
- knowledge-sync side commits via that repo's normal `auto: sync` cadence (P1.3 precedent —
  not gated by the cortextos PR rule).
- After the next kb-reconcile-nightly row: raw distinct-file count rose by ≈ snapshot count,
  and a kb-query for a known cxportal fact (e.g. an Alloi pain-point title) cites a
  `…/clients/alloi/cxportal/…` path.

## Done-condition (machine-checkable, P1 block style)

- `ls ~/code/knowledge-sync/raw/areas/clearworks/clients/*/cxportal/*.md | wc -l` ≥ 1 per
  mapped org that has data (≥ 4 files total expected on day one).
- `tail -1 orgs/clearworksai/agents/larry/state/cxportal-pull-ledger.jsonl` → `"green": true`
  with per-org/per-entity record counts; **3 consecutive green rows** (matches P1.1's bar).
- Next kb-reconcile ledger row after the first pull shows raw distinct-file count increased by
  ≈ the new snapshot-file count; a `kb-query` hit cites a path containing
  `/clients/<slug>/cxportal/` (new-path citation proof, P1.3 step-f style).
- Ingest-root registration diff = **empty by design** (`git diff` clean on
  `knowledge-base/scripts/mmrag.py`) — targets already resolve inside the `raw/` root.

## Risks

- **Token handling** — `CXPORTAL_MCP_TOKEN` read from env (larry `.env`) at runtime; never
  committed. Missing token → red row, loud, no silent skip.
- **New client org appears in cxportal** — puller goes red naming the org until `orgmap.json`
  gains one line (deliberate: no silent defaults, P1.2 rule).
- **Schema drift in cxportal** — generic key/value rendering of tool JSON; no per-field
  hardcoding to break on added columns.
- **Double-source with P1.7** — avoided by design: meetings/transcripts excluded from the
  entity set (research §2).
- **Snapshot churn re-embedding cost** — write-if-changed keeps unchanged nights at zero
  reconcile delta.

## File ownership

Codexer owns (cortextos PR): everything under `orgs/clearworksai/skills/cxportal-import/`,
one cron object in `orgs/clearworksai/agents/larry/config.json`.
Codexer owns (cxportal PR, spec 02): `server/mcp/server.ts` (+ its test file if one exists).
Created at runtime, not committed: the ledger JSONL, the snapshot files (knowledge-sync repo,
committed there by its own sync cadence).
NOT touched: `knowledge-base/scripts/mmrag.py`, `kb-reconcile-nightly.sh`, frank2/pa configs,
anything under cortextos `src/`, cxportal DB schema/routes/auth.
