# Altari Skill Wiring — Re-scoped by Josh (2026-08-09)

> Supersedes the workstream grouping in PHASE-1-WIRING-PLAN.md where they differ. Josh verbatim
> re-scope 2026-08-09 (after Multica cut). Clusters = how each skill fires.

## Cluster 1 · MEETING SUITE — autonomous, fires on the meeting chain
Meeting event drives these; no manual trigger.
- **meeting-intelligence-engineer** — Call Capture + Transcript Processing (chain core; files to KB)
- **call-prep-researcher** — Pre-Call Briefing (fires BEFORE meeting, off calendar)
- **deal-debrief-analyst** — Post-Call Debrief + Follow-Up Drafting (fires AFTER)
- **followup-coordinator** — Meeting Follow-Ups (fires AFTER)
Output fans out per the P3.4 rule: KB + bus human tasks/approval cards + Telegram + BRIEFS + CRM.

## Cluster 2 · SOLUTION DESIGN / QUOTING — the 5-skill stack (ON-DEMAND, Josh-driven)
NOT the meeting suite. The assemble-a-solution-and-quote flow. **Trigger = on-demand; Josh drives it
himself right now.** GOAL: harden the 5-stack until it's good enough to **delegate to someone else**
(a human running the process). NOT an autonomous event lane — do not wire to the meeting chain.
The 5 stack:
- **integration-engineer** — the assembler (moved OUT of meeting suite; belongs here)
- **proposal-writer** — "put things together" with integration-engineer
- **pricing-analyst** — same
- **deal-room-producer** — on-demand producer in the stack
- **solutions-engineer** — on-demand producer in the stack
Tie-in: auditmaster's project-scoping plan. Deliverable = a coherent on-demand pipeline (one invoke
chains the 5), quality/consistency high enough to hand to a delegate. Separate track from the
autonomous meeting/event finish; lower time-urgency than the meeting chain, but high strategic value.

## Cluster 3 · CRM — autonomous, runs with the `crm` agent
- **data-enrichment-specialist** — account/contact enrichment + email verify
- **records-administrator** — CRM sync / compliance / doc filing, unattended
- **pipeline-operations-manager** — CRM Hygiene + Pipeline Reporting + Forecasting (NOW autonomous with crm)

## Cluster 4 · PROACTIVE EA — agent `pa`, event-based
- **inbox-manager** + **executive-assistant** + **meeting-booking-coordinator** (comms-check routes booking asks)

## Cluster 5 · PROACTIVE KB maintenance
- **knowledge-base** — corpus-wide dedupe/reconcile/freshness loop

## AD HOC — skills, invoked on demand (NOT wired autonomous)
- **company-research-analyst** (+ vertical-analyst) — ad hoc
- **playbook-writer** — ad hoc

## ON HOLD (not wiring now)
- **client-portal-manager**
- **customer-success-manager**

## DROPPED
- **billing-manager** — Josh: don't need it.

## SKIP (native coverage — evaluated 2026-08-03)
- **qa-engineer** — redundant (verify + true-verify + red-team-reviewer + sage)
- **reliability-engineer** — mostly redundant (sre + codeburn + nightly-fleet-analysis); maybe graft an incident-response runbook onto sre

---

## Live status (all clusters)
Every skill has its file + I/O contract, but **0 are wired to a live autonomous trigger**. Only the
meeting chain is partially live (delivers, doesn't durably file — Track A). So the wiring work is:
per cluster, connect the skill(s) to their deterministic trigger + fan-out sinks + a liveness check.

## Trigger map (what fires each cluster)
| Cluster | Trigger | Notes |
|---|---|---|
| Meeting suite | fireflies `meeting.completed` (+ calendar for call-prep) | deterministic daemon spawn (Track A backbone) |
| Solution/quoting | ON-DEMAND, Josh-driven | 5-stack; harden to delegatable quality; NOT autonomous |
| CRM | crm events + schedule | autonomous under crm agent |
| Proactive EA | Gmail push (GSUITE) → comms-check triage | GSUITE is the PRIORITY surface — activate first (Track E 1st); then Slack, then omi/pr |
| Proactive KB | nightly schedule | the reconcile loop (revive in Track B) |
