# FR-004 runtime policy reconciliation

The CRM agent's authoritative policy is **never auto-apply**. This document is
tracked because the live agent config and cron registry are runtime files and
are intentionally gitignored. At runtime, reconcile them as follows:

```json
{"approval_rules":{"always_ask":["external-comms","financial","deployment","data-deletion","crm-record-write"]}}
```

Ensure `.cortextOS/state/agents/crm/crons.json` contains one recurring
`records-admin-sweep` entry (weekly, Sunday 20:00 Pacific). Its prompt must
generate a dated diff and approval-queue item; it must never invoke a write
script with `--apply` or claim STALE/MISSING changes were applied.

If the registry is absent, do not silently treat the lane as healthy: report
`records-admin-sweep` missing and repair it through the daemon's cron API.
