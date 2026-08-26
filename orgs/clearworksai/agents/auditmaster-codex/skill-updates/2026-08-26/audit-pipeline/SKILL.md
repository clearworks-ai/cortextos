---
name: audit-pipeline
description: "ORCHESTRATOR for the AuditOS audit chain. Use this to know which audit-* skill to run, in what order, and how each phase hands off. Start here for any new audit or to find the next phase. Every OCG deliverable section now has its own skill — the work lives in those."
triggers: ["audit pipeline", "run the audit", "what's next in the audit", "audit chain", "auditos deliverable pipeline", "start an audit", "next audit phase"]
---

# Audit Pipeline — the chain (orchestrator)

A client audit is a **series of chained skills**, one per OCG deliverable section. Read `audit-foundation` first (Rule Zero / read-only DB / citation doctrine). Gold-standard reference: `~/code/auditos/reports/ocg-deliverable/`.

> One client/project at a time. Read-only DB. Cite everything. **Complete the whole ANALYSIS layer before the solution portfolio** (Josh, 2026-06-09 — don't jump to solutions). Lock each section's format with Josh before scaling.

## The chain (logical order — file numbers in parens match OCG)
| # | Skill | Output | Status (MSIA) |
|---|-------|--------|---------------|
| 0 | **audit-foundation** | doctrine (read first) | ✅ |
| 1 | **audit-strategy-lock** | `00` strategy/VTO anchor (EOS-optional) | ✅ |
| 2 | **audit-painpoint-atlas** | `01` atlas — by domain **+ Appendix A (employee voice) + Appendix C (automation themes)** | ✅ ~69 PPs |
| 3 | **audit-systems-inventory** | `03` systems — table **+ per-system narratives + inferred-missing-systems** | ✅ |
| 4 | **audit-integration-gaps** | `04` integration gap map | ✅ |
| 4.5 | **audit-ai-adoption-readiness** | `04a` AI operating environment + adoption readiness | ⬜ |
| 5 | **audit-workflow-maps** | `05` current-state workflows | ✅ |
| 6 | **audit-architecture-diagram** | `13` current + future Mermaid | ✅ |
| — | *(ANALYSIS LAYER COMPLETE — gate before solutions)* | | |
| — | *(⛔ HARD GATE — phases 2–6 must all exist before phase 7; solutions are LATE, never next-after-pain-points)* | | |
| 7 | **audit-solution-portfolio** | `02` solution clusters → PPs + VTO — **OS-style + automator-8-chained** (see its skill) | ✅ Draft 1 |
| 8 | **audit-roi-workbook** | `06` ROI ($/PP, savings) | ⛔ needs rate hierarchy |
| 9 | **audit-roadmap** | `07` phased implementation plan | ✅ Draft 1 |
| 10 | **audit-kpi-index** | `08` exec tiles + KPIs | ✅ Draft 1 |
| 11 | **audit-pricing** | `09` commercial tiers + ROI | ⛔ needs pricing model |
| 12 | **audit-assemble-master** | master report + **client-safe version (strip _SENSITIVE)** | ⬜ final |
| EX | **audit-executive-deck** | `EX` ~15p landscape exec deck (12 devices, deck = view over findings) | ⬜ packaging layer |

**Two exec artifacts, don't confuse them:** `audit-executive-summary` = the report's opening one-page *text* section (`00a`). `audit-executive-deck` = a separate ~15-slide *landscape deck* on top of the whole audit (the exec-scan layer). The deck introduces no new findings — it renders the standard Clearworks diagram set + the Operations Health Score + the 12 devices from the locked deliverables. See `deliverables/_sample-audit/STRUCTURED-AUDIT-DECK-PLAN.md`.

## Handoff rules
- Each phase consumes prior outputs + the locked VTO; it doesn't re-derive them.
- **⛔ HARD GATE (Josh 2026-07-14, extended 2026-08-26): Analysis layer = phases 2–6 plus the bounded 4.5 AI adoption-readiness step. All must exist before phase 7 (solutions). Solutions come LAST — never jump from pain points straight to solutions.** The gate + a file-existence check live at the top of `audit-solution-portfolio`.
- **Phase 7 (solution portfolio) MUST chain BOTH: (1) the automator 8-phase agile flow (workflow-designer → task-automator → automation-architect → requirements-analyst → bot-builder → monitoring-engineer → estimation-guide → agile-coach), and (2) the Bones "OS" style (named Employee Agents + one board + Ask-<Client>-OS + what-ships/what-retires).**
- A phase isn't done until Josh locks its format (first client / first artifact).
- ⛔ phases need a human input (rates, pricing) — park them, don't fabricate.
- Calibrate against `~/code/auditos/server/services/phase-prompts.ts` (field spec) + OCG output — never run the automated pipeline to produce client output.

## When to use which
New audit → `audit-strategy-lock` (after foundation). "next phase" → consult the table by status. Specific section → its named skill.

## Vertical guardrails
Before scoping solutions for an industry-specific client, load the matching vertical reference under `references/` and apply it in `audit-solution-portfolio` + `audit-roadmap`:
- **AEC (architecture / engineering / construction):** `references/aec-ai-lifecycle.md` — work-types model, where AI is risky (engineering calcs, code compliance, contracts, safety, regulatory), and the three HITL patterns every proposed solution must map to.
