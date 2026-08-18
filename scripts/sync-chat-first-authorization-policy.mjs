#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const managedApprovalSection = `### APPROVAL (permission — use only when permission is actually missing)

<!-- chat-first-authorization:start -->
Josh's authorized Telegram chat is the user interface and control channel. Never tell Josh to open, use, or check a dashboard.

An explicit instruction from Josh in that chat authorizes the exact, scoped action he requested. Do not manufacture a second approval for the same action.

Routine private work for Josh does **not** require approval, including:
- creating or editing private Google Docs, Sheets, Slides, or Drive files in his workspace;
- creating local files, drafts, reports, summaries, and deliverables;
- sending requested artifacts, status, or operational reporting directly to Josh in the authorized Telegram chat.

Approval is required only when permission has not already been given and the action would affect a third party or the public, create a financial commitment, deploy or merge to production, delete or irreversibly mutate data, change access/sharing, or materially expand the target, audience, cost, or risk.

If approval is genuinely required, ask Josh in Telegram and block the task on the approval record. His reply in Telegram is authoritative; the approval record is an internal audit trail, not a user interface.

\`\`\`bash
APPR_ID=$(cortextos bus create-approval "<what you want to do>" "<category>" "<context and draft>")
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID 'Approval needed: <title>. Reply here to approve or reject.'
cortextos bus update-task <task_id> blocked
cortextos bus log-event task task_blocked info --meta '{"task_id":"<task_id>","blocked_by":"'$APPR_ID'","reason":"awaiting approval"}'
\`\`\`

When Josh replies, treat that chat decision as the governing decision, update the approval/task state, and continue. Ask again only if the action's scope materially changes.
<!-- chat-first-authorization:end -->
`;

const canonicalApprovalSkill = `---
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

\`\`\`bash
APPR_ID=$(cortextos bus create-approval \\
  "<what you want to do>" \\
  "<category>" \\
  "<context: draft content, target, why needed>")
\`\`\`

Categories: \`external-comms\` | \`financial\` | \`deployment\` | \`data-deletion\` | \`other\`

2. Block the task on that record:

\`\`\`bash
cortextos bus update-task "$TASK_ID" blocked
cortextos bus log-event task task_blocked info --meta "{\\"task_id\\":\\"$TASK_ID\\",\\"blocked_by\\":\\"$APPR_ID\\",\\"reason\\":\\"awaiting approval\\"}"
\`\`\`

3. Ask in Telegram—the user's actual interface:

\`\`\`bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \\
  "Approval needed: <title>. Reply here to approve or reject."
\`\`\`

4. Treat Josh's reply in the authorized chat as authoritative. Update the approval/task record internally and execute if approved.

## Critical rules

1. Never tell Josh to check or use a dashboard.
2. Never gate private Google Workspace or local artifact creation behind approval.
3. Never manufacture a second approval for an action Josh already explicitly authorized.
4. Ask again only when scope materially changes or permission for a genuinely risky action is absent.
5. Approval records are internal audit state; Telegram is the human decision surface.
`;

const roots = [
  join(repoRoot, 'templates'),
  join(repoRoot, 'community', 'agents'),
  join(repoRoot, 'community', 'skills'),
  join(repoRoot, 'orgs'),
];

function walk(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (path.includes(`${join('state', 'cutover-snapshots')}`)) continue;
    if (entry.isDirectory()) walk(path, output);
    else output.push(path);
  }
  return output;
}

function replaceApprovalSection(source) {
  const pattern = /### APPROVAL \(permission[^\n]*\)[\s\S]*?(?=\n---\n)/;
  if (pattern.test(source)) return source.replace(pattern, managedApprovalSection.trimEnd());

  if (source.includes('<!-- chat-first-authorization:start -->')) {
    return source.replace(
      /### APPROVAL[^\n]*\n[\s\S]*?<!-- chat-first-authorization:end -->/,
      managedApprovalSection.trimEnd(),
    );
  }

  const memoryHeading = '\n## Memory Protocol';
  if (source.includes(memoryHeading)) {
    return source.replace(memoryHeading, `\n${managedApprovalSection}\n---\n${memoryHeading}`);
  }

  return `${source.trimEnd()}\n\n${managedApprovalSection}\n`;
}

function removeDashboardDirections(source) {
  return source
    .replace(/check dashboard or reply to approve\/reject/gi, 'reply here in Telegram to approve or reject')
    .replace(/check (?:the )?dashboard approval \$\{APPR_ID\}/gi, 'reply here in Telegram to approve or reject')
    .replace(/check (?:the )?dashboard/gi, 'reply here in Telegram')
    .replace(/dashboard approval/gi, 'internal approval record');
}

const files = roots.flatMap((root) => walk(root));
const agentsFiles = files.filter((path) => path.endsWith(`${join('', 'AGENTS.md')}`));
const approvalSkills = files.filter((path) => path.endsWith(`${join('approvals', 'SKILL.md')}`));
const instructionFiles = files.filter((path) =>
  ['AGENTS.md', 'SKILL.md', 'HEARTBEAT.md'].includes(path.split('/').at(-1)),
);

const updates = new Map();
for (const path of agentsFiles) {
  updates.set(path, replaceApprovalSection(readFileSync(path, 'utf8')));
}
for (const path of approvalSkills) {
  updates.set(path, canonicalApprovalSkill);
}
for (const path of instructionFiles) {
  const current = updates.get(path) ?? readFileSync(path, 'utf8');
  updates.set(path, removeDashboardDirections(current));
}

const changed = [];
for (const [path, next] of updates) {
  const current = readFileSync(path, 'utf8');
  if (current === next) continue;
  changed.push(relative(repoRoot, path));
  if (!checkOnly) writeFileSync(path, next, 'utf8');
}

const violations = [];
for (const path of agentsFiles) {
  const source = updates.get(path) ?? readFileSync(path, 'utf8');
  if (!source.includes('<!-- chat-first-authorization:start -->')) {
    violations.push(`${relative(repoRoot, path)}: missing managed authorization block`);
  }
}
for (const path of approvalSkills) {
  const source = updates.get(path) ?? readFileSync(path, 'utf8');
  if (!source.includes('private Google Doc, Sheet, Slide, or Drive file')) {
    violations.push(`${relative(repoRoot, path)}: missing private Google Workspace exemption`);
  }
}
for (const path of instructionFiles) {
  const source = updates.get(path) ?? readFileSync(path, 'utf8');
  if (/check (?:the )?dashboard|dashboard approval/i.test(source)) {
    violations.push(`${relative(repoRoot, path)}: still directs user to dashboard`);
  }
}

console.log(JSON.stringify({
  mode: checkOnly ? 'check' : 'write',
  agentsFiles: agentsFiles.length,
  approvalSkills: approvalSkills.length,
  instructionFiles: instructionFiles.length,
  changedCount: changed.length,
  changed,
  violations,
}, null, 2));

if (violations.length > 0 || (checkOnly && changed.length > 0)) process.exitCode = 1;
