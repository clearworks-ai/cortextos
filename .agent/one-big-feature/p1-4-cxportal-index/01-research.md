# P1.4 — CX Portal → index — Research

Source of truth (binding): `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md`
line 100 (P1.4 row), lines 108–113 (P1 done-condition block), line 87 (P1 end state:
knowledge-sync = THE files home · mmrag = THE index · everything else = symlink or importer).

## Binding scope (verbatim, MASTER-BUILD-PLAN.md line 100)

> Ingest wire from `~/code/cxportal` data layer into mmrag. cxportal becomes an importer,
> not a peer store.

## 1. What cxportal actually is (verified 2026-07-31)

- Repo: `~/code/cxportal` → `git@github.com:clearworks-ai/cxportal.git`. Formerly
  **lifecycle-killer / "Lifecycle X"** (confirmed: `replit.md` still titles it Lifecycle X;
  auditmaster MEMORY.md:48 "cxportal = formerly lifecycle-killer").
- Deployed on Railway at **`https://lifecycle-killer-production.up.railway.app`**
  (`railway.toml` → `npm run start`; auditmaster `.mcp.json` points its `cxportal-audit` MCP
  entry at `<that host>/mcp`).
- Stack per Clearworks conventions: Express + TS, **PostgreSQL + Drizzle** (`shared/schema.ts`),
  pgvector, React client. DB lives on Railway; there is **no local `.env`** (only
  `.env.example`) — no local `DATABASE_URL`, so direct-psycopg2 access from this machine is
  not a working path today.
- `DATA_LAYER_MANIFEST.md` at repo root (dated 2026-02-20) documents 45 tables — **stale**:
  `shared/schema.ts` now defines **71 `pgTable`s** (engagements, interviews, intakes, surveys,
  meeting-* family, shareable links, etc. added since). Use it as orientation only, never as
  the current inventory.

## 2. What in the data layer is KB-worthy

KB-worthy (client/engagement intelligence — the stuff kb-query should be able to answer):

| Domain | Tables | Notes |
|---|---|---|
| Intelligence layer | `painPoints`, `clientGoals`, `recommendations`, `clientDesires`, `budgetSignals`, `clientWins` | The core advisory intelligence, with sourceQuote/attribution fields |
| Assessment engine | `assessmentEvents` (+ answers, deliverable) | Scored maturity assessments per client |
| Engagement layer | `engagements`, `interviews` (incl. transcripts), `surveys` + `surveyResponses` | Audit-process evidence |
| Reviews | `businessReviews` (+ decisions, action items, follow-ups) | Meeting outcomes/commitments |
| Systems | `systemsInventory` | Client tech-stack facts |

NOT KB-worthy (excluded by design): users/auth/sessions/magic-link tokens, dashboard/report
widget configs, notifications, `auditLogs`, `intelligenceEmbeddings` (peer index, see §4),
CSV-import staging fields. **`meetings` + meeting-* tables are deliberately excluded**: cxportal
meetings are sourced from Fireflies (`source = 'fireflies'` — see
`scripts/sync_commitments_from_cxportal.py:190`), and P1.7 makes the transcripts store the
canonical home for Fireflies transcript text. Importing them here would create the exact
double-source P1.4 exists to prevent. Review-level outcomes (decisions/action items) come in
via `businessReviews` instead.

## 3. Existing read paths — do NOT build an exporter from scratch

**The read contract already exists and is live**: a read-only MCP server inside cxportal.

- `server/mcp/server.ts` — `cxportal-audit-mcp-server` v1.0.0, `READ_ONLY_AUDIT_TOOL_NAMES` =
  20 org-scoped read tools: `list_organizations`, `list_engagements`/`get_engagement`,
  `list_surveys`/`get_survey`/`get_survey_responses`, `list_interviews`/`get_interview`,
  `list_assessment_events`/`get_assessment_event`/`get_assessment_deliverable`/
  `list_assessment_templates`, `list_pain_points`/`get_pain_point`,
  `list_client_goals`/`get_client_goal`, `list_recommendations`/`get_recommendation`,
  `list_business_reviews`, `list_systems_inventory`. Every call is audit-logged
  (`action: "mcp_read"`).
- `server/mcp/auth.ts` — bearer auth via `CXPORTAL_MCP_TOKEN` env var (timing-safe compare).
- `server/mcp/transport.ts` — **stateless** Streamable HTTP (`sessionIdGenerator: undefined`),
  so a bare single-shot JSON-RPC POST per call works — no session dance.
- **Verified live 2026-07-31**: `tools/call list_organizations` against
  `https://lifecycle-killer-production.up.railway.app/mcp` returned 8 orgs. Response is
  SSE-framed (`event: message\ndata: {...}`) and the tool payload is double-encoded JSON
  (`result.content[0].text` is a JSON string) — both matter for the importer parser.
- An existing consumer proves the pattern: auditmaster `.mcp.json` (`cxportal-audit` entry) +
  its MEMORY.md recipe (endpoint, `Authorization: Bearer …`, `Accept: application/json,
  text/event-stream`, "call list_organizations FIRST").

Other paths considered and rejected:
- `scripts/sync_commitments_from_cxportal.py` (in cxportal) — direct psycopg2 needing
  `DATABASE_URL`; not available locally, and it's a write-back-to-CRM script, not an exporter.
- REST `/api/*` routes — auth is session/passport-shaped, org scoping by query param, no
  service-token story; the MCP endpoint IS the sanctioned server-to-server read surface.
- No export/dump endpoints exist anywhere in `server/routes.ts` (manifest §5: "Export: Not
  Implemented") — confirmed by grep.

### MCP surface gap (small, fixable)

`clientDesires`, `budgetSignals`, `clientWins` are in the DB intelligence layer but **not**
exposed by the 20 MCP tools. The storage methods already exist
(`server/storage.ts:563/569/575` — `getDesiresByOrg`, `getBudgetSignalsByOrg`,
`getWinsByOrg`). Closing this is a ~30-line cxportal PR (spec 02).

## 4. How cxportal is isolated from mmrag today — and why "importer, not peer store"

- **Zero cxportal rows in mmrag.** `DEFAULT_RECONCILE_ROOTS` (mmrag.py:135-138, post-P1.3) =
  knowledge-sync `wiki/` + `raw/` only. Nothing under either root contains cxportal DB content
  (only 3 stale files in auditmaster's deliverables mirror mention cxportal).
- cxportal runs its **own peer index**: `intelligenceEmbeddings` (pgvector, 1536-dim,
  text-embedding-3-small) + `/api/search` + `/api/rag-context`. So today it is both a peer
  STORE (client intelligence that exists nowhere in the files home) and a peer INDEX (a second
  semantic-search surface answering the same class of questions from a different corpus).
- Why that must end (C4): two indexes with different corpora give divergent answers to "what
  are Alloi's pain points" depending on which one an agent asks — the exact certainty failure
  the consolidation exists to kill. The fix is one-directional: cxportal stays the operational
  APP (its DB remains the system of record for the app's own workflows, its pgvector stays an
  app-internal feature), but **KB truth flows one way**: cxportal → markdown snapshots in
  knowledge-sync → mmrag on nightly reconcile. Agents answer KB questions from mmrag only;
  nothing in this wire writes back into cxportal, and no agent should be pointed at
  cxportal `/api/search` for knowledge questions.

## 5. Live orgs (from the verified list_organizations call) → org map

| cxportal org (UUID verified) | Kind | knowledge-sync client home |
|---|---|---|
| Alloi (`6f7bdf8c-…`) | real client | `raw/areas/clearworks/clients/alloi/` (exists) |
| OCG Properties (`fe4dadf0-…`) | real client | `raw/areas/clearworks/clients/ocg-properties/` (exists) |
| Russian Riverkeeper (`2c618f5c-…`) | real client | `raw/areas/clearworks/clients/rrk/` (exists) |
| Studio PCH (`189b89b4-…`) | real client | `raw/areas/clearworks/clients/studio-pch/` (exists) |
| Clearworks Home (`7bbe86c2-…`) | internal sandbox | EXCLUDE v1 (not a client; no taxonomy home — revisit if it accrues real data) |
| Aerolab Industries, Meridian Tech Group | seed/demo (both created 2026-03-28 02:29:41, same second) | EXCLUDE — demo data must never enter the KB |
| Larry Verify Co (`d7adaa99-…`, created 2026-07-29 by larry's write-smoke test) | test org | EXCLUDE |

Rule (P1.2 precedent — "fail loudly, no silent defaults"): every org must be explicitly
mapped OR explicitly excluded in a checked-in `orgmap.json`; an org that is neither → red
ledger row naming it (forces a one-line map update when a new client org appears — that is the
desired behavior, not a bug).

## 6. Ingest roots + path-identity check

- All import targets land under `~/code/knowledge-sync/raw/` → **already inside
  `DEFAULT_RECONCILE_ROOTS`. Ingest-root registration change = NONE** (same no-op finding as
  P1.2 research §4; state it explicitly because the P1.4 task text asks for it).
- `_normalize_source_path` (mmrag.py:1105-1108) canonicalizes by `Path.resolve()`. Targets are
  ordinary regular files inside exactly one root — no symlinks, no root-overlap, so none of the
  P1.3 double-cover/identity hazards apply here.
- Snapshot files are `.md` → in mmrag `SUPPORTED_EXTS`, not in `IGNORE_FILE_EXTS`; target dirs
  contain no `IGNORE_DIR_PARTS` names. All imported files will index.
- Churn control: mmrag reconcile re-ingests on `content_hash` change (mmrag.py:1592-1595). The
  importer must be **write-if-changed** (byte-compare rendered body before writing, volatile
  timestamp excluded from the comparison) so an unchanged night costs the reconcile nothing.

## 7. Risks / constraints

- **Token secrecy**: `CXPORTAL_MCP_TOKEN` must come from env at runtime, never be committed in
  the new script/config. (Pre-existing exposure: the literal token sits in auditmaster's
  committed `.mcp.json` — out of P1.4 scope, flagged for a separate rotation task.)
- **cxportal downtime ≠ KB failure**: the pull cron must be separate from P1.1's
  kb-reconcile-nightly so a Railway blip reddens the *pull* ledger, not the KB ledger.
- **Schema drift**: render generic key/value markdown from whatever JSON the tools return —
  do not hardcode per-field schemas that break when cxportal adds columns.
- **Deletes**: a record deleted in cxportal disappears from the next rendered snapshot (the
  per-entity file is regenerated whole each run) — no tombstone logic needed; mmrag reconcile
  picks up the changed file hash.

## 8. Explicitly OUT of P1.4 scope

- Meetings/transcripts import (P1.7 owns transcript truth; Fireflies is the source).
- Retiring cxportal's internal pgvector search (app-internal feature; not a store of KB files).
- Clearpath drain (P1.9), agent-memory (P1.5), claude-mem (P1.6).
- Token rotation for the exposed auditmaster `.mcp.json` bearer token (flagged, separate task).
- Any write path into cxportal (the commitments write-back script exists and is unrelated).
