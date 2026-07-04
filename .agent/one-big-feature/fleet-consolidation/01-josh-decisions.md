# Josh's decisions on the Fable plan (2026-07-03)

1. **Rate limits → OpenRouter, broadly.** Not just failover. Incorporate OpenRouter generally and push as much work as possible onto cheap open-weight models. Design a model-routing tier (cheap open models for mechanical/triage/bulk; Claude/Fable reserved for real reasoning). Expands WS8 from "failover only" into a general model-routing layer. "Let's think about this."

2. **Clearpath → real export + bring the extraction in-house.** Do a real export of intel + audits into the internal system, AND replicate Clearpath's deep intel-extraction capability inside our own stack (MMRAG/knowledge-sync), so we keep doing that deep structured extraction natively. Expands WS5 beyond archive-only: port the extraction pipeline, not just the data.

3. **Maintenance window: whenever.** Instance cutover (WS7) timing is flexible/approved; still staging-first with a pre-snapshot.

4. **CRM = a real consolidation (NEW).** CRM-type data is currently scattered across ~9 surfaces. Push ALL of it into the one crm/Connect agent = the single canonical place for ENTITY identity (contacts/deals/orgs). This is distinct from agent-persona identity (IDENTITY.md). New workstream WS9. Surfaces to be enumerated by grounding scan before designing the push.

6. **WS8 = Option B (confirmed).** Wire the existing OpencodePTY adapter (#699) into the worker-spawn path (worker-process.ts:62 + spawn-worker CLI, ~20 lines) so any agent spawns cheap OpenRouter-backed subagents fleet-wide. Opencode agent stays as a full agent for degraded-mode failover. Verify OpenCode-runtime workers have tool parity for bus/skill tools before routing heavy jobs.

7. **Embeddings live in the ONE index, entity-tagged — NOT a second store in the CRM.** MMRAG (768d) holds vectors; every extraction is tagged with the CRM's canonical entity id; Connect retrieves per-entity intel via filtered query (Clearpath's get_contact_intelligence pattern without a separate DB). CRM owns identity + structured fields.

8. **Stoss/identity finding:** pipeline.json keys on a field named `clearpath_id` that is often SYNTHETIC (Stoss=30 is a local id minted Jun 30 via intake_id, NOT a Clearpath FK). WS9: Connect mints its own canonical entity id; `clearpath_id` becomes an optional external-link field (null unless truly from Clearpath).

9. **Audits: DROPPED from scope entirely** (Josh: "audits have nothing to do with this").

10. **Kill Supabase eventually.** After the worthwhile Clearpath slice is extracted in-house, decommission Clearpath's DB (Supabase/Railway — TBD which) for most of this. Clearpath port scope = HIGH-VALUE SLICE ONLY, pending a content/freshness review (do NOT port 51k wholesale).

5. **Instances: confirm cortextos1 as the one.** Clarify naming (cortext vs cortextos1) — no separate "cortext" root exists; the two real roots are cortextos1 (live) and default (dead, but the code default = the trap). WS7 stands.

## Completeness against the 12-tab brief — gaps Fable's plan under-covered
- **Tab 5 CRM Deep Dive** → was demoted (my earlier "CRM is one of many" steer); Josh corrected — now WS9.
- **Tab 8 Knowledge Graph** → graphify runs once, never re-indexes; add a re-index cron (small).
- **R6 observability (what agent DID vs CLAIMED)** → partly covered by WS4 receipts; a correlated activity ledger is still thin.
- **R8 memory-correctness test harness** → not explicitly covered; needed to make the rest falsifiable.
- **Identity has TWO layers:** agent persona → IDENTITY.md (WS6); entity/contact/deal → Connect CRM (WS9). Both are "one place," different things.
