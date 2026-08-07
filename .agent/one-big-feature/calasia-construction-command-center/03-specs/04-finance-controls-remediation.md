# Spec 04 — Calasia Finance Controls and Functional Records

**Status:** APPROVED by Larry

**Target repository:** `/Users/joshweiss/code/Clients/calasia-construction-command-center`

## Build

Extend the static local prototype in `index.html`. Keep it a single-page, local-only prototype with vanilla JavaScript; no backend, data persistence, external accounting integration, merge, deploy, or publication.

### Finance Controls

Add a Finance Controls entry in the top navigation and a Cedar Grove command-center action. The view must visibly state: **Illustrative sample figures — not client accounting records**.

Show all of the following in a concise job-finance summary:

- Original contract plus approved client change orders.
- Subcontract commitments.
- Division 1, overhead, and other expenses.
- Unallocated amount.
- Forecast profit or loss.
- Client receivables: billed, paid, outstanding.
- Subcontractor payables: paid, owed.
- Reconciliation exceptions, including owner and next controlled handoff.

Include a subcontractor commitment table or detail interaction with contract amount, proposed subcontractor change order, approved subcontractor change order, linked client change-order decision, invoice/payment state, and a missing release/supporting-record exception where applicable. Use sample subcontractor names and sample dollar values only.

### Accounting boundary

Present **PM Accounting** and **Accounting** as separate record categories. The Accounting local detail must visibly state it is accounting-owned and read-only to project managers. Reconciliation is an exception routed to Accounting with a named receiving owner; do not expose controls that edit protected accounting values.

### Functional local details

Budget, Billing, PM Accounting, and Accounting record cards must open corresponding local detail surfaces. The existing Project Records and checklist source actions must no longer be inert `href="#"` handlers: activate a local detail/modal or navigate to the relevant local view while preserving the existing record label.

### Regression expectations

Keep the existing six-project portfolio, four filters (phase, owner, start window, attention), owner action-pressure signals, lifecycle controls, checklist, record categories, and work queues working. No headcount, utilization, or workload rollups.

## Acceptance checks

1. Finance Controls is reachable through both primary navigation and Cedar Grove context.
2. All required financial metrics, receivables/payables, and a reconciliation exception are visible and illustrative.
3. At least one subcontractor trace includes contract, PCO, approved CO, client CO, invoice/payment, and release exception.
4. PM Accounting is distinguished from protected, read-only Accounting.
5. Budget, Billing, PM Accounting, Accounting, and representative checklist actions open functional local details; no `href="#"` or `preventDefault()` dead-link patterns remain for these controls.
6. Existing remediation requirements continue to pass.

## Delivery gate

Do not build until this exact artifact participates in a freshly verified scope-bound planning provenance chain. After a valid build, return the local path and commit to Auditmaster for review; do not merge or deploy.
