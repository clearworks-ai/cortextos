import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync as readFile, rmSync, writeFileSync as writeFile } from 'fs';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import {
  composeSyntheticMarkdown,
  deriveStatusMaterial,
  resolveContactDisplay,
  resolveEngagementId,
  setLastUpdate,
} from '../../../scripts/brain/status_plan';

const ENGAGEMENT_MD = `# Client: Alloi — Managed Services

## Node
id: alloi-01
kind: engagement
client: alloi
parent:
title: Managed Services
domains: alloi.us
delivery_state: active

## Reporting
cadence: weekly
channel: email
contact: marcos@alloi.us
last_update:

## History (dated, newest first)

## Open Items
`;

const CHILD_MD = `# Client: Alloi — Tactical Reports

## Node
id: alloi-03
kind: project
client: alloi
parent: alloi-01
title: Tactical Reports
delivery_state: active

## Reporting
cadence:
channel:
contact:
last_update:

## History (dated, newest first)

- 2026-09-04 — Alloi Tacticals Troubleshooting (meeting: meetings/x.md) [source: fireflies:01M1MW2G]
  - Outcomes: Installed skill v4 and resolved the version mismatch. Weekly runs now post to Slack job channels. A third sentence that also ships.
  - Decisions: Reports land Monday EOD. ; Use the Alloi skill config. ; A third decision that also ships.

## Open Items

| Item | Owner | Deadline | Source | Status |
|---|---|---|---|---|
| Run tactical reports | Ivette Ramos | — | commitment:b | open |
| Send the updated skill and calendar codes. | Josh Weiss | — | commitment:c | open |
| Already closed item | Josh Weiss | — | commitment:d | done |
`;

const CLIENT_PAGE_MD = `# Client: Alloi

## Contacts

domains: alloi.us

- Marcos Santa Ana — Ops/IT Lead — marcos@alloi.us

## Current state

- Deal stage: won
`;

describe('deriveStatusMaterial (Josh 2026-09-06: the draft must carry real meeting content)', () => {
  const children = [
    { node: { id: 'alloi-03', kind: 'project', client: 'alloi', parent: 'alloi-01', title: 'Tactical Reports', path: '' }, md: CHILD_MD },
  ];

  it('turns every Outcomes sentence and every Decision into completedTasks, no cap, newest first', () => {
    const { completedTasks } = deriveStatusMaterial(ENGAGEMENT_MD, children, '2026-09-10');
    expect(completedTasks.map((t) => t.title)).toEqual([
      'Installed skill v4 and resolved the version mismatch',
      'Weekly runs now post to Slack job channels',
      'A third sentence that also ships',
      'Decided: Reports land Monday EOD',
      'Decided: Use the Alloi skill config',
      'Decided: A third decision that also ships',
    ]);
    expect(completedTasks.every((t) => t.completedAt === '2026-09-04')).toBe(true);
  });

  it('turns only OPEN our-side open items into in_progress issues', () => {
    const { issues } = deriveStatusMaterial(ENGAGEMENT_MD, children, '2026-09-10');
    expect(issues).toEqual([{ title: 'Send the updated skill and calendar codes', status: 'in_progress', updated_at: '2026-09-10' }]);
  });

  it('FINAL F-1: the R2 writer\'s "none" placeholders never become bullets', () => {
    const md = CHILD_MD.replace(/  - Outcomes:[^\n]*\n  - Decisions:[^\n]*/, '  - Outcomes: none\n  - Decisions: none');
    const { completedTasks } = deriveStatusMaterial(ENGAGEMENT_MD, [{ ...children[0], md }], '2026-09-10');
    expect(completedTasks).toEqual([]);
  });

  it('FINAL F-2: an escaped pipe inside an Open Items cell does not shift columns or drop the row', () => {
    const md = CHILD_MD.replace(
      '| Send the updated skill and calendar codes. | Josh Weiss |',
      '| Send the skill \\| calendar codes \\\\ instructions. | Josh Weiss |',
    );
    const { issues } = deriveStatusMaterial(ENGAGEMENT_MD, [{ ...children[0], md }], '2026-09-10');
    expect(issues.map((i) => i.title)).toEqual(['Send the skill | calendar codes \\ instructions']);
  });

  it('FINAL F-4: escaped pipes and backslashes inside a Decision are unescaped', () => {
    const md = CHILD_MD.replace('Use the Alloi skill config.', 'Use the Alloi \\| landscape config.');
    const { completedTasks } = deriveStatusMaterial(ENGAGEMENT_MD, [{ ...children[0], md }], '2026-09-10');
    expect(completedTasks.map((t) => t.title)).toContain('Decided: Use the Alloi | landscape config');
  });

  it('yields nothing from a History entry without sub-bullets', () => {
    const bare = CHILD_MD.replace(/\n  - Outcomes:[^\n]*\n  - Decisions:[^\n]*/, '');
    const { completedTasks } = deriveStatusMaterial(ENGAGEMENT_MD, [{ ...children[0], md: bare }], '2026-09-10');
    expect(completedTasks).toEqual([]);
  });
});

describe('resolveContactDisplay', () => {
  it('replaces a bare Reporting email with the client page contact name', () => {
    expect(resolveContactDisplay('marcos@alloi.us', CLIENT_PAGE_MD)).toBe('Marcos Santa Ana <marcos@alloi.us>');
  });

  it('leaves a named contact or an unknown email untouched', () => {
    expect(resolveContactDisplay('Marcos Santa Ana <marcos@alloi.us>', CLIENT_PAGE_MD)).toBe('Marcos Santa Ana <marcos@alloi.us>');
    expect(resolveContactDisplay('nobody@alloi.us', CLIENT_PAGE_MD)).toBe('nobody@alloi.us');
    expect(resolveContactDisplay('marcos@alloi.us', '')).toBe('marcos@alloi.us');
  });
});

describe('composeSyntheticMarkdown', () => {
  it('builds a # Client: header, merges Reporting/History/Open Items newest-first', () => {
    const md = composeSyntheticMarkdown('Alloi', { id: 'alloi-01', kind: 'engagement', client: 'alloi', parent: '', title: 'Managed Services', path: '' }, ENGAGEMENT_MD, [
      { node: { id: 'alloi-03', kind: 'project', client: 'alloi', parent: 'alloi-01', title: 'Tactical Reports', path: '' }, md: CHILD_MD },
    ]);
    expect(md).toContain('# Client: Alloi — Managed Services');
    expect(md).toContain('cadence: weekly');
    expect(md).toContain('- 2026-09-04 — Alloi Tacticals Troubleshooting');
    expect(md).toContain('| Run tactical reports | Ivette Ramos |');
  });

  it('FINAL F-3: the milestone fallback lists only OPEN child projects', () => {
    const eng = { id: 'alloi-01', kind: 'engagement', client: 'alloi', parent: '', title: 'Managed Services', path: '' };
    const open = { node: { id: 'alloi-03', kind: 'project', client: 'alloi', parent: 'alloi-01', title: 'Tactical Reports', path: '', delivery_state: 'active' }, md: CHILD_MD };
    const closed = { node: { id: 'alloi-04', kind: 'project', client: 'alloi', parent: 'alloi-01', title: 'Old Migration', path: '', delivery_state: 'closed' }, md: CHILD_MD };
    const md = composeSyntheticMarkdown('Alloi', eng, ENGAGEMENT_MD, [closed, open]);
    expect(md).toContain('milestones: Tactical Reports');
    expect(md).not.toContain('Old Migration');
    const none = composeSyntheticMarkdown('Alloi', eng, ENGAGEMENT_MD, [closed]);
    expect(none).not.toContain('milestones:');
  });
});

describe('resolveEngagementId', () => {
  const nodes = {
    'alloi-01': { id: 'alloi-01', kind: 'engagement', client: 'alloi', parent: '', title: 'Managed Services', path: '' },
    'alloi-03': { id: 'alloi-03', kind: 'project', client: 'alloi', parent: 'alloi-01', title: 'Tactical Reports', path: '' },
  };

  it('uses the node itself when it is an engagement', () => {
    expect(resolveEngagementId('alloi-01', nodes)).toEqual({ engagementId: 'alloi-01', skipReason: null });
  });

  it("uses the node's parent when it is a project", () => {
    expect(resolveEngagementId('alloi-03', nodes)).toEqual({ engagementId: 'alloi-01', skipReason: null });
  });

  it('skips with no-engagement when the node is unknown', () => {
    expect(resolveEngagementId('nope', nodes)).toEqual({ engagementId: '', skipReason: 'no-engagement' });
  });
});

describe('setLastUpdate', () => {
  it('rewrites only the Reporting last_update line, byte-identical elsewhere (G0a F-3)', () => {
    const out = setLastUpdate(ENGAGEMENT_MD, '2026-09-10');
    expect(out).toContain('last_update: 2026-09-10');
    expect(out).toContain('cadence: weekly'); // rest of Reporting unchanged
    expect(out).toContain('## History (dated, newest first)\n\n## Open Items'); // heading NOT deleted
    // whole-file diff is exactly the last_update line, nothing else
    const outLines = out.split('\n');
    const inLines = ENGAGEMENT_MD.split('\n');
    expect(outLines.length).toBe(inLines.length);
    const changed = outLines.filter((line, i) => line !== inLines[i]);
    expect(changed).toEqual(['last_update: 2026-09-10']);
  });

  it('is a zero-diff no-op on a second --write for the same date', () => {
    const once = setLastUpdate(ENGAGEMENT_MD, '2026-09-10');
    const twice = setLastUpdate(once, '2026-09-10');
    expect(twice).toBe(once);
  });

  it('never touches a last_update-shaped line outside ## Reporting', () => {
    const withDecoy = ENGAGEMENT_MD.replace(
      '## Open Items\n',
      '## Open Items\n\n- note: last_update: should-not-change\n',
    );
    const out = setLastUpdate(withDecoy, '2026-09-10');
    expect(out).toContain('- note: last_update: should-not-change');
    expect(out).toContain('## Reporting\ncadence: weekly\nchannel: email\ncontact: marcos@alloi.us\nlast_update: 2026-09-10');
  });

  it('CH-5: an earlier "## Reporting notes" section is not matched by prefix — only the exact ## Reporting heading is updated', () => {
    const md = `# Client: Alloi — Managed Services

## Reporting notes
freeform commentary
last_update: should-not-change

## Reporting
cadence: weekly
channel: email
contact: marcos@alloi.us
last_update:

## History (dated, newest first)

## Open Items
`;
    const out = setLastUpdate(md, '2026-09-10');
    // the decoy section, which sorts before the real one, is untouched
    expect(out).toContain('## Reporting notes\nfreeform commentary\nlast_update: should-not-change');
    // only the real ## Reporting section's last_update advances
    expect(out).toContain('## Reporting\ncadence: weekly\nchannel: email\ncontact: marcos@alloi.us\nlast_update: 2026-09-10');
  });
});

function seedVault(): string {
  const vault = mkdtempSync(pathJoin(tmpdir(), 'status-plan-'));
  const proj = pathJoin(vault, 'raw/areas/clearworks/org-brain/projects');
  mkdirSync(proj, { recursive: true });
  writeFile(pathJoin(proj, 'alloi-01.md'), ENGAGEMENT_MD);
  writeFile(pathJoin(proj, 'alloi-03.md'), CHILD_MD);
  const clients = pathJoin(vault, 'raw/areas/clearworks/org-brain/clients');
  mkdirSync(clients, { recursive: true });
  writeFile(pathJoin(clients, 'alloi.md'), CLIENT_PAGE_MD);
  return vault;
}

const ENGAGEMENT_MD_BAD = `# Client: Alloi — Managed Services

## Node
id: alloi-01
kind: engagement
client: alloi
parent:
title: Managed Services
domains: alloi.us
delivery_state: active

## Reporting
cadence: weekly
channel: email
contact: marcos@alloi.us
last_update:

## History (dated, newest first)

- 2026-09-09 — Client escalated concerns about delayed reports.

## Open Items
`;

function seedVaultBrief(): string {
  const vault = mkdtempSync(pathJoin(tmpdir(), 'status-plan-brief-'));
  const proj = pathJoin(vault, 'raw/areas/clearworks/org-brain/projects');
  mkdirSync(proj, { recursive: true });
  writeFile(pathJoin(proj, 'alloi-01.md'), ENGAGEMENT_MD_BAD);
  return vault;
}

describe('status_plan.ts CLI (draft content — Josh 2026-09-06 changes requested)', () => {
  it('the client draft names the contact, leads with the meeting outcome, lists decisions and our open commitment, and never says "Steady progress"', () => {
    const vault = seedVault();
    const tsxBin = require.resolve('tsx/cli');
    const scriptPath = pathJoin(__dirname, '../../../scripts/brain/status_plan.ts');
    const preview = execFileSync('node', [tsxBin, scriptPath, '--client', 'alloi', '--node', 'alloi-01', '--today', '2026-09-10', '--vault', vault], { encoding: 'utf8' });
    const previewJson = JSON.parse(preview.trim().split('\n').pop() as string);
    expect(previewJson.action).toBe('draft');
    const body = String(previewJson.fileContent);
    expect(body).toContain('Hi Marcos');
    expect(body).not.toContain('marcos@alloi.us —');
    expect(body).toContain('*Installed skill v4 and resolved the version mismatch.*');
    expect(body).toContain('• Weekly runs now post to Slack job channels');
    expect(body).toContain('• Decided: Reports land Monday EOD');
    expect(body).toContain('• Decided: A third decision that also ships'); // no cap
    expect(body).toContain('• Send the updated skill and calendar codes');
    expect(body).toContain('Next up: Tactical Reports.');
    expect(body).not.toContain('Steady progress');
    expect(body).not.toContain('the next milestone');
    rmSync(vault, { recursive: true, force: true });
  });
});

describe('status_plan.ts CLI (--write parity)', () => {
  it('G2-P1-2: a private brief (BAD/MIXED) is persisted but last_update stays untouched', () => {
    const vault = seedVaultBrief();
    const tsxBin = require.resolve('tsx/cli');
    const scriptPath = pathJoin(__dirname, '../../../scripts/brain/status_plan.ts');
    const preview = execFileSync('node', [tsxBin, scriptPath, '--client', 'alloi', '--node', 'alloi-01', '--today', '2026-09-10', '--vault', vault], { encoding: 'utf8' });
    const previewJson = JSON.parse(preview.trim().split('\n').pop() as string);
    expect(previewJson.action).toBe('brief');

    const engagementBefore = readFile(pathJoin(vault, 'raw/areas/clearworks/org-brain/projects/alloi-01.md'), 'utf8');

    const written = execFileSync('node', [tsxBin, scriptPath, '--client', 'alloi', '--node', 'alloi-01', '--today', '2026-09-10', '--write', '--vault', vault], { encoding: 'utf8' });
    const writtenJson = JSON.parse(written.trim().split('\n').pop() as string);
    expect(writtenJson.action).toBe('brief');
    expect(String(writtenJson.relPath)).toContain('status-brief-2026-09-10.md');

    // brief content IS persisted
    const briefContent = readFile(pathJoin(vault, writtenJson.relPath), 'utf8');
    expect(briefContent.length).toBeGreaterThan(0);

    // D-09: the preview JSON must already carry the full body a human
    // reviews before --write ever runs, and it must match what --write
    // actually persists byte-for-byte.
    expect(previewJson.fileContent).toBeTruthy();
    expect(previewJson.fileContent).toBe(briefContent);
    expect(writtenJson.fileContent).toBe(briefContent);

    // but last_update on the engagement node is untouched (still blank, byte-identical)
    const engagementAfter = readFile(pathJoin(vault, 'raw/areas/clearworks/org-brain/projects/alloi-01.md'), 'utf8');
    expect(engagementAfter).toBe(engagementBefore);
    expect(engagementAfter).not.toContain('last_update: 2026-09-10');
    rmSync(vault, { recursive: true, force: true });
  });

  it('the --write file matches the no-write preview relPath, and last_update advances', () => {
    const vault = seedVault();
    const tsxBin = require.resolve('tsx/cli');
    const scriptPath = pathJoin(__dirname, '../../../scripts/brain/status_plan.ts');
    const preview = execFileSync('node', [tsxBin, scriptPath, '--client', 'alloi', '--node', 'alloi-01', '--today', '2026-09-10', '--vault', vault], { encoding: 'utf8' });
    const previewJson = JSON.parse(preview.trim().split('\n').pop() as string);
    expect(previewJson.action).toBe('draft');
    expect(String(previewJson.relPath)).toContain('status-update-2026-09-10.md');

    const written = execFileSync('node', [tsxBin, scriptPath, '--client', 'alloi', '--node', 'alloi-01', '--today', '2026-09-10', '--write', '--vault', vault], { encoding: 'utf8' });
    const writtenJson = JSON.parse(written.trim().split('\n').pop() as string);
    expect(writtenJson.relPath).toBe(previewJson.relPath);

    const fileContent = readFile(pathJoin(vault, writtenJson.relPath), 'utf8');
    expect(fileContent.length).toBeGreaterThan(0);

    // D-09: preview must show the reviewer the exact body --apply will
    // write, not just the relPath — assert byte-identical to the file
    // --write actually persists.
    expect(previewJson.fileContent).toBeTruthy();
    expect(previewJson.fileContent).toBe(fileContent);
    expect(writtenJson.fileContent).toBe(fileContent);

    const engagementMd = readFile(pathJoin(vault, 'raw/areas/clearworks/org-brain/projects/alloi-01.md'), 'utf8');
    expect(engagementMd).toContain('last_update: 2026-09-10');
    expect(engagementMd).toContain('## History (dated, newest first)'); // heading survives (G0a F-3)

    // second --write on the same date is a byte-identical no-op
    const engagementBefore = engagementMd;
    execFileSync('node', [tsxBin, scriptPath, '--client', 'alloi', '--node', 'alloi-01', '--today', '2026-09-10', '--write', '--vault', vault], { encoding: 'utf8' });
    const engagementAfter = readFile(pathJoin(vault, 'raw/areas/clearworks/org-brain/projects/alloi-01.md'), 'utf8');
    expect(engagementAfter).toBe(engagementBefore);
    rmSync(vault, { recursive: true, force: true });
  });
});
