# Research — Calasia Finance Controls Amendment

**Scope:** Bounded local prototype amendment for Cedar Grove Finance Controls and functional local record details.

## Authoritative inputs

- Controlling brief: `orgs/clearworksai/agents/auditmaster-codex/outputs/solutions-engineer/2026-08-05-1619-callasia.md`.
- Evidence source named by the brief: Rob walkthrough Google Doc `1yoJAya_xsYYGA-1Ldlbkk1n8jWG-osfhvlOmmqZhkzI`; required sequence is billing → PM accounting → subcontractor COs → profit/loss → reconciliation.
- Current local source: `/Users/joshweiss/code/Clients/calasia-construction-command-center/index.html` at `d8db715`.

## Current-state findings

- The prototype has Portfolio, Cedar Grove Command Center, Master Checklist, Project Records, and Work Queues; it has no Finance Controls view.
- The existing record data has Budget and Billing but lacks separate PM Accounting and protected Accounting records.
- Existing record and checklist links use inert `href="#"` plus `event.preventDefault()`, so they do not satisfy functional local-detail behavior.
- The local prototype is a single static `index.html` with vanilla JS. A bounded local detail/modal implementation is consistent with that architecture.

## Required outcome

Add illustrative job-finance visibility while retaining a clear boundary: Accounting is accounting-owned and read-only to PMs; reconciliation is a controlled exception/handoff. No real client/accounting values, persistence, integration, merge, deployment, publication, or client sharing are in scope.
