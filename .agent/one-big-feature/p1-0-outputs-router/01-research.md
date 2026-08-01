# P1.0 — Research

Source of truth (binding): ~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md,
DECISIONS-FOR-JOSH.md (D4 — store consolidation + outputs convention, ACCEPTED).

## Problem

Agent outputs today have no consistent home or provenance convention. D4 (accepted) says:
file BY CONTENT TYPE into the EXISTING knowledge-sync taxonomy, NOT a generic
`agent-outputs/<agent>/` dump. Provenance goes in frontmatter, never in the path. This is P1.0 —
ships first because P1.2 (deliverables mirror) and P2 (job I/O contract) both depend on this
convention existing.

## Existing knowledge-sync taxonomy (verified live, `ls ~/code/knowledge-sync/raw`)

`archives, areas, coordination, daily, drafts, graphify-out, HEARTBEAT.md, inbox, Index.md,
media, resources, sessions, ...` — `raw/areas/clearworks/<client>/` and
`raw/resources/{people,organizations,reference}/` already exist as the working taxonomy other
agents write into by hand today (per CLAUDE.md global file-organization table).

## Constraint: divergence budget

C6/C7 (binding, all phases): custom code lives in `orgs/`, `community/`, config — NOT `src/`.
Any `src/` change requires a fork-delta ledger row. This rules out adding a new bus subcommand
under `src/bus/`; the helper must live as a skill/script under `orgs/clearworksai/`.

## Existing precedent

`orgs/clearworksai/skills/` already holds per-purpose skills (knowledge-base, proof-editor,
the-humanizer, followup-coordinator, skilltree-audit, meeting-intelligence-engineer) — this is
the established pattern for new shared agent tooling, not `src/`. No prior "file by content type"
helper exists in this tree (checked `orgs/clearworksai/skills/` and `knowledge-base/scripts/` —
knowledge-base/scripts only holds mmrag.py, the indexer, not an outputs router).

## Frontmatter contract (binding, verbatim from MASTER-BUILD-PLAN.md P1.0)

`agent:`, `job:`, `date:`, `source-task:` — required fields, provenance never in the path.

## Routing table (binding, verbatim from MASTER-BUILD-PLAN.md P1.0)

- client deliverables -> `raw/areas/clearworks/<client>/`
- people/org intel -> `raw/resources/people/` or `raw/resources/organizations/`
- SOPs/playbooks -> `raw/resources/reference/clearworks/`
- diagrams -> `raw/areas/clearworks/diagrams/`
- session/build artifacts -> `raw/sessions/`
- media -> `raw/media/`
