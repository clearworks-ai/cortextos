---
name: approvals
description: "Use when an action affects a third party or the public, creates financial/production/destructive risk, and Josh has not already explicitly authorized that exact action in the authorized Telegram chat. Private Google Workspace artifacts, local deliverables, and direct reporting to Josh are routine internal work and do not require approval."
triggers: ["need approval", "create approval", "request approval", "approval needed", "needs sign-off", "needs permission", "before deploying", "before sending email", "before deleting", "before posting", "external action", "irreversible action", "financial commitment", "purchase", "deploy to production", "merge to main", "send to real person", "publish", "approval workflow", "pending approval", "waiting for approval", "check approvals", "list approvals"]
external_calls: []
---

# Approvals

Josh's authorized Telegram chat is the user interface and control channel. Never direct him to a dashboard.

An explicit instruction from Josh in that chat authorizes the exact, scoped action requested. Do not create a duplicate approval after he has already authorized it.

## Decision table

| Action type | Requires new approval? |
|-------------|------------------------|
| Create/edit a private Google Doc, Sheet, Slide, or Drive file for Josh | NO |
| Create local files, drafts, research, reports, or deliverables | NO |
| Send requested artifacts, summaries, or status directly to Josh in Telegram | NO |
| Execute an exact action Josh explicitly requested in Telegram | NO |
| Send an unrequested email/message to a third party | YES |
| Publish publicly or change sharing/access for third parties | YES |
| Make a purchase or financial commitment | YES |
| Deploy or merge to production without prior instruction | YES |
| Delete or irreversibly mutate data | YES |
| Materially expand an authorized action's audience, cost, target, or risk | YES |

## Workflow when approval is genuinely missing

1. Create an internal approval record:

```bash
APPR_ID=$(cortextos bus create-approval \
  "<what you want to do>" \
  "<category>" \
  "<context: draft content, target, why needed>")
```

Categories: `external-comms` | `financial` | `deployment` | `data-deletion` | `other`

2. Block the task on that record:

```bash
cortextos bus update-task "$TASK_ID" blocked
cortextos bus log-event task task_blocked info --meta "{\"task_id\":\"$TASK_ID\",\"blocked_by\":\"$APPR_ID\",\"reason\":\"awaiting approval\"}"
```

3. Ask in Telegram—the user's actual interface:

```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
  "Approval needed: <title>. Reply here to approve or reject."
```

4. Treat Josh's reply in the authorized chat as authoritative. Update the approval/task record internally and execute if approved.

## Critical rules

1. Never tell Josh to check or use a dashboard.
2. Never gate private Google Workspace or local artifact creation behind approval.
3. Never manufacture a second approval for an action Josh already explicitly authorized.
4. Ask again only when scope materially changes or permission for a genuinely risky action is absent.
5. Approval records are internal audit state; Telegram is the human decision surface.
