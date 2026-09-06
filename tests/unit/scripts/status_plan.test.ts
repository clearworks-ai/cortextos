import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync as readFile, rmSync, writeFileSync as writeFile } from 'fs';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import { composeSyntheticMarkdown, resolveEngagementId, setLastUpdate } from '../../../scripts/brain/status_plan';

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
  - Outcomes: Installed skill v4.
  - Decisions: Reports land Monday EOD.

## Open Items

| Item | Owner | Deadline | Source | Status |
|---|---|---|---|---|
| Run tactical reports | Ivette Ramos | — | commitment:b | open |
`;

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
});

function seedVault(): string {
  const vault = mkdtempSync(pathJoin(tmpdir(), 'status-plan-'));
  const proj = pathJoin(vault, 'raw/areas/clearworks/org-brain/projects');
  mkdirSync(proj, { recursive: true });
  writeFile(pathJoin(proj, 'alloi-01.md'), ENGAGEMENT_MD);
  writeFile(pathJoin(proj, 'alloi-03.md'), CHILD_MD);
  return vault;
}

describe('status_plan.ts CLI (--write parity)', () => {
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
