# Spec 02 — cxportal MCP read-surface extension (P1.4, cxportal repo)

Buildable directly by codexer. Context: `../01-research.md` §3 (MCP surface gap).
Repo: `~/code/cxportal` (`clearworks-ai/cxportal`). Separate feature branch + PR to that repo;
Railway auto-deploys `lifecycle-killer-production` on merge to main. NOT a blocker for spec 01
going live (v1 entity set works without it).

## Why

`clientDesires`, `budgetSignals`, `clientWins` are intelligence-layer tables (KB-worthy per
research §2) but absent from the 20 tools in `READ_ONLY_AUDIT_TOOL_NAMES`
(`server/mcp/server.ts`). The storage layer already has org-scoped list methods — this is tool
registration only, no schema/storage/route changes.

## Changes — `server/mcp/server.ts` only

1. Extend the `AuditMcpStorage` `Pick<IStorage, …>` union with the three existing methods
   (verified present in `server/storage.ts`):
   - `getDesiresByOrg` (interface at storage.ts:563, impl :2088)
   - `getBudgetSignalsByOrg` (interface :569, impl :2112)
   - `getWinsByOrg` (interface :575, impl :2136)
2. Append to `READ_ONLY_AUDIT_TOOL_NAMES` (keeps the `AuditToolName` union + audit logging
   working unchanged):
   - `"list_client_desires"`, `"list_budget_signals"`, `"list_client_wins"`
3. In `buildAuditToolDefinitions`, add three `createReadTool` entries following the exact
   pattern of the existing `list_pain_points` definition:
   - `list_client_desires` — inputSchema `orgIdSchema`, load →
     `storage.getDesiresByOrg(args.orgId)`, description: "List client desires for an organization (read-only)."
   - `list_budget_signals` — inputSchema `orgIdSchema`, load →
     `storage.getBudgetSignalsByOrg(args.orgId)`, description: "List budget signals for an organization (read-only)."
   - `list_client_wins` — inputSchema `orgIdSchema`, load →
     `storage.getWinsByOrg(args.orgId)`, description: "List client wins for an organization (read-only)."

No changes to `server/mcp/auth.ts`, `server/mcp/transport.ts`, routes, schema, or storage.
List-only (no `get_*` singles) — the P1.4 importer consumes full lists; add singles only if a
consumer needs them later.

## Tests

- If an existing test file covers the MCP server (search `tests/` for `mcp`), extend it; else
  add a focused unit test that builds the tool definitions with a stubbed storage and asserts:
  (a) the three new names are registered; (b) each returns `createJsonResult` of the stub's
  rows; (c) each rejects a missing `orgId` (zod parse failure); (d) an audit-log row is
  attempted with `entityId` = the tool name.
- `npm run check` (tsc) and `npm test` (vitest) must pass — the repo's stated gate.

## Verification (post-merge, against the live deployment)

```
curl -s -X POST https://lifecycle-killer-production.up.railway.app/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $CXPORTAL_MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_client_desires","arguments":{"orgId":"6f7bdf8c-486e-46ae-8bf7-8e91abde6d47"}}}'
```
→ non-error result (Alloi org). Repeat for the other two tools.

## Follow-up (one-line, back in cortextos — part of P1.4 phase 3)

Flip `"enabled": false → true` for `desires`, `budget-signals`, `wins` in
`pull_cxportal.py`'s `ENTITIES` table (spec 01 pre-registers them). Next nightly pull creates
the three new snapshot files per mapped org; next reconcile ingests them.

## Out of scope

Meetings tools (P1.7 owns transcript truth), any write tools, auth changes, token rotation.
