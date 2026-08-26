---
name: audit-solution-portfolio
description: "PHASE 7 of the audit chain (solutions come AFTER the full analysis layer — see the HARD GATE below; do NOT jump here from pain points). Turn the analysis into an AI/automation Solution Portfolio — the '02' deliverable — framed in the OS style, with each cluster run through the automator 8-phase agile flow. Use only after the analysis layer is complete + locked. Read audit-foundation first."
triggers: ["solution portfolio", "ai solutions", "map pains to solutions", "phase 7 audit", "02 portfolio", "automation portfolio"]
---

## ⛔ HARD GATE — solutions are LAST; do NOT start until the ANALYSIS LAYER is complete
**(Hard rule, Josh 2026-07-14 — programmed, not a memory suggestion. Solutions = phase 7, NOT phase 3.)**
Before writing a single solution, verify these client deliverables exist under `deliverables/<client>/`:
`01` pain-point atlas · `03` systems inventory · `04` integration gaps · `04a` AI operating environment and adoption · `05` workflow maps · `13` architecture diagram (current + future).
If ANY is missing → **STOP and build it first.** Never jump from pain points straight to solutions.
```bash
python3 "$CTX_AGENT_DIR/plugins/cortextos-agent-skills/skills/audit-solution-portfolio/scripts/analysis_gate.py" "deliverables/<client>"
```
Master chain + order: `plugins/cortextos-agent-skills/skills/audit-pipeline/SKILL.md` (orchestrator table). Analysis layer = phases 2–6; this is 7.

## 🔗 REQUIRED CHAINS for this phase (BOTH, every time — Josh 2026-07-14)
The solution portfolio is not a flat list. It MUST chain two things:
1. **The automator 8-phase agile flow**, in order, per automation cluster: **workflow-designer → task-automator → automation-architect → requirements-analyst → bot-builder → monitoring-engineer → estimation-guide → agile-coach** (skill dirs under `auditmaster/plugins/cortextos-agent-skills/skills/`). Output = spec + sprint plan per build.
2. **The Bones "OS" style** — frame the portfolio as an operating system, not scattered automations: **named Employee Agents** (one job each) + **one board** they run on + an **"Ask <Client> OS"** front door + a **what-ships / what-retires** rollout, with **live-vs-coming-next** honesty. Reference exemplar: `deliverables/ocg/ocg-os-deck-changes.md`.
---

## Client-facing output discipline (EVERY client — OCG, Logic TCG, MSIA, all)
This deliverable goes to the client. Apply `audit-foundation` › CLIENT-FACING VOICE before writing a word:
- **Objective only.** State facts the client cannot argue with. No editorializing, no superlatives or ranking, no descriptive adjective added for effect. Walking one back means DELETING it, not softening it ("#1" → "most time-consuming" is the same error).
- **Titles/headers = one plain statement.** No second clause, no `—`/`→`/`;` tail, no cost/cause/quote/parenthetical/adjective in a title; detail goes in the body fields.
- **Deduplicate.** One problem = one entry across all instances ("source attribution not tracked" is ONE item covering every channel, not one per channel). Don't split into per-instance copies; don't merge unrelated facts into one entry because you decided they relate.
- **No internal/process language.** The client never sees how we found it: no "re-scan," "re-attributed," "supersedes," our internal cluster/grouping names, or notes to Josh. Reframe natively under the client's own categories and names.
- **Facts in fields; quote only when genuinely necessary; "Not quantified" beats an invented figure or characterization.**
- **Josh ≠ the client.** Josh directs the work; the deliverable is FOR the client. Never address Josh as the client or write "your" meaning the client's.


# Phase 7 — AI Solution Portfolio (OS-style, automator-8-chained)

**Goal:** `deliverables/<client>/02-ai-solution-portfolio.md`. **Reference:** `~/code/auditos/reports/ocg-deliverable/02-ai-solution-portfolio.md` (OCG = 8 clusters / 52 automations, each mapped to VTO goals) + OS-style exemplar `deliverables/ocg/ocg-os-deck-changes.md`. Read `audit-foundation`. **Do not start until the HARD GATE at the top of this file passes.**

## Inputs
- The locked **VTO anchor** (`00`) — every solution must advance a stated goal/rock.
- The **pain-point atlas** (`01`/`pain-point-atlas.md`) — the PPs each solution resolves.

## Steps
1. **Cluster** the PPs into ~6–10 solution themes (by system/workflow, not by person). Each cluster groups the PPs one initiative would address.
2. For each cluster define: **the automations** (concrete, specific), **PPs resolved** (cite PP-###), **VTO goal(s) served**, **effort/sequencing** (does it depend on Acumatica? quick win vs phased?), and **the human-in-the-loop guardrail** (MSIA non-negotiable — never propose removing the human touch).
3. **Respect the both/and + honesty rules:** don't oversell (e.g. Acumatica caveats from the atlas); mark assumptions; where ROI needs hours/$ not yet available, say so (link the rate-hierarchy gap).
4. **Map every cluster → at least one VTO goal AND the PPs it closes.** A solution that maps to no VTO goal is out of scope — flag it.
5. **Quick-wins vs phased:** call out what's doable now (the AI tools already adopted bottom-up) vs what waits on Acumatica/integration.
6. **Lock format with Josh** before scaling to the full portfolio.

## Output → handoff
- `02-ai-solution-portfolio.md` → feeds Phase 7 (ROI workbook) + Phase 8 (roadmap). Carry forward: which automations need $ quantification.

## Done when
Every cluster has concrete automations, cited PPs resolved, VTO mapping, sequencing, and a human-in-the-loop guardrail; nothing oversold; Josh has blessed the format.
