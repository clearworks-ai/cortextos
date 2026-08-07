# Master Plan Amendment — Finance Controls

**Status:** APPROVED by Larry

This amendment supersedes any conflicting Calasia remediation scope. Its controlling source is `orgs/clearworksai/agents/auditmaster-codex/outputs/solutions-engineer/2026-08-05-1619-callasia.md`.

## Locked outcome

The Cedar Grove command center must add a bounded, clearly illustrative Finance Controls view. It makes a job's financial state and controlled accounting handoffs legible without replacing accounting or giving PMs write access to accounting-owned values.

## Scope

1. Add a reachable Finance Controls surface for Cedar Grove with clearly labeled sample figures: contract plus approved client change orders, subcontract commitments, Division 1/overhead/other expenses, unallocated amount, forecast profit/loss, client receivables, subcontractor payables, and reconciliation exceptions.
2. Trace each relevant subcontractor commitment through contract amount, proposed and approved subcontractor change orders, linked client change-order decision, invoice/payment state, and missing release/supporting-record exceptions.
3. Keep protected Accounting explicitly distinct from PM Accounting. Accounting-owned values are read-only to project managers; reconciliation appears only as a controlled exception/handoff, never editable spreadsheet simulation.
4. Add Finance Controls to Cedar Grove navigation and add functional local-detail interactions for Budget, Billing, PM Accounting, and Accounting records. Replace inert record/checklist `href="#"` actions with local navigation or a modal/detail surface.
5. Preserve the current approved delivery scope: phase, owner, start-window, and attention filters; owner action-pressure without headcount/utilization/workload claims; and one-click local navigation for record/checklist sources.
6. Preserve boundaries: illustrative data only, no platform recommendation, no IT/cybersecurity workflow, no merge, deployment, publication, or real client/accounting data.

## Validation

- Finance Controls is reachable from the Cedar Grove command center and uses illustrative-data labeling.
- Each required job-finance metric and reconciliation exception is visible.
- A subcontractor detail visibly carries contract/PCO/approved-CO/client-CO/invoice-payment/release linkage.
- PM Accounting and protected Accounting are distinct; protected Accounting visibly says read-only to PMs.
- Budget, Billing, PM Accounting, Accounting, and affected checklist/record actions resolve to functional local details without dead links.
- Existing Calasia remediation requirements still work.

## Gate

This is planning material only. A fresh research → plan → specs provenance chain bound to this amendment is required before any `GATE: build` dispatch.
