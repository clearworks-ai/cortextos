import { describe, it, expect } from 'vitest';
import {
  parseClientFile,
  parseReporting,
  parseHistory,
  gatherSinceLastUpdate,
  classifyNews,
  renderDrafts,
  buildStatusReportPlan,
  cadenceToDays,
} from '../../../src/bus/delivery-status';

// A representative org-brain client file with a `## Reporting` block.
const ALLOI_MD = `# Client: Alloi

## Contacts

- Marcos Santa Ana — Ops/IT Lead — marcos@alloi.us

## Reporting

- cadence: weekly
- channel: slack+email
- contact: Marcos Santa Ana <marcos@alloi.us>
- milestones: Slack->JobTread task tooling; Zoom->Drive automation; workflow-IA session
- last_update: 2026-08-02

## History (dated, newest first)

- 2026-08-05 — Slack "slash to-do" quick task creation shipped and merged; tested live.
- 2026-08-04 — Invoice AI-2026-3 delivered to Alloi.
- 2026-07-19 — Invoice AI-2026-2 sent to Alloi Inc via Moxie.

## Open Items

| Item | Owner | Deadline | Source | Status |
|---|---|---|---|---|
| backup strategy 45TB | Marcos |  | pipeline.json | open |
`;

describe('delivery-status: parsing', () => {
  it('parses the client name, reporting block, history, and open items', () => {
    const c = parseClientFile('alloi', ALLOI_MD);
    expect(c.name).toBe('Alloi');
    expect(c.reporting).not.toBeNull();
    expect(c.reporting!.cadence).toBe('weekly');
    expect(c.reporting!.cadenceDays).toBe(7);
    expect(c.reporting!.channel).toBe('slack+email');
    expect(c.reporting!.lastUpdate).toBe('2026-08-02');
    expect(c.reporting!.milestones.length).toBe(3);
    expect(c.history.length).toBe(3);
    expect(c.openItems).toContain('backup strategy 45TB');
  });

  it('returns null reporting when the block is absent', () => {
    const md = '# Client: Kadre\n\n## History (dated, newest first)\n\n- 2026-07-27 — met Nerin\n';
    expect(parseReporting(md)).toBeNull();
  });

  it('maps cadence words to days, default 7 for unknown', () => {
    expect(cadenceToDays('weekly')).toBe(7);
    expect(cadenceToDays('biweekly')).toBe(14);
    expect(cadenceToDays('monthly')).toBe(30);
    expect(cadenceToDays('whenever')).toBe(7);
  });
});

describe('delivery-status: gather-since-last_update', () => {
  it('keeps only rows strictly after last_update across all sources', () => {
    const history = parseHistory(ALLOI_MD); // 3 entries, one older than 2026-08-02
    const g = gatherSinceLastUpdate({
      history,
      issues: [
        { title: 'Backend task-visibility fix', status: 'in_progress', updated_at: '2026-08-05T10:00:00Z' },
        { title: 'Old done thing', status: 'done', updated_at: '2026-07-01T10:00:00Z' },
        { title: 'A backlog idea', status: 'backlog', updated_at: '2026-08-06T10:00:00Z' }, // irrelevant status
      ],
      completedTasks: [{ title: 'Shipped slash-todo', completedAt: '2026-08-05' }],
      interactions: [{ summary: 'Call with Marcos', date: '2026-08-04' }],
      lastUpdate: '2026-08-02',
    });
    // history: only the two 2026-08-04/05 entries survive (2026-07-19 dropped)
    expect(g.history.map((h) => h.date)).toEqual(['2026-08-05', '2026-08-04']);
    // issues: only relevant-status AND after-date -> the in_progress one; backlog filtered, old done filtered
    expect(g.issues.map((i) => i.title)).toEqual(['Backend task-visibility fix']);
    expect(g.completedTasks.length).toBe(1);
    expect(g.interactions.length).toBe(1);
    expect(g.empty).toBe(false);
  });

  it('reports empty when nothing moved since last_update', () => {
    const g = gatherSinceLastUpdate({
      history: parseHistory(ALLOI_MD),
      lastUpdate: '2026-09-01', // after every history date
    });
    expect(g.empty).toBe(true);
  });
});

describe('delivery-status: classification (HARD RULE)', () => {
  it('classifies pure good news as GOOD (draft-eligible)', () => {
    const g = gatherSinceLastUpdate({
      history: [{ date: '2026-08-05', text: 'Slash-todo shipped and merged' }],
      lastUpdate: '2026-08-01',
    });
    const c = classifyNews(g);
    expect(c.klass).toBe('GOOD');
    expect(c.clientDraftEligible).toBe(true);
  });

  it('classifies a blocker as BAD (NOT draft-eligible)', () => {
    const g = gatherSinceLastUpdate({
      history: [{ date: '2026-08-05', text: 'Integration is blocked on their side' }],
      lastUpdate: '2026-08-01',
    });
    const c = classifyNews(g);
    expect(c.klass).toBe('BAD');
    expect(c.clientDraftEligible).toBe(false);
    expect(c.badSignals.length).toBeGreaterThan(0);
  });

  it('classifies good+bad as MIXED and MIXED is NOT draft-eligible', () => {
    const g = gatherSinceLastUpdate({
      history: [
        { date: '2026-08-05', text: 'Two features shipped this week' },
        { date: '2026-08-05', text: 'Launch delayed to next month, apologies' },
      ],
      lastUpdate: '2026-08-01',
    });
    const c = classifyNews(g);
    expect(c.klass).toBe('MIXED');
    expect(c.clientDraftEligible).toBe(false);
  });

  it('treats a Multica issue with status=blocked as a bad signal', () => {
    const g = gatherSinceLastUpdate({
      history: [],
      issues: [{ title: 'Data migration', status: 'blocked', updated_at: '2026-08-05T00:00:00Z' }],
      lastUpdate: '2026-08-01',
    });
    const c = classifyNews(g);
    expect(c.clientDraftEligible).toBe(false);
  });
});

describe('delivery-status: draft rendering (BOTH channels)', () => {
  it('renders both a Slack format and an email format with subject', () => {
    const client = parseClientFile('alloi', ALLOI_MD);
    const g = gatherSinceLastUpdate({
      history: client.history,
      completedTasks: [{ title: 'Slack slash-todo live', completedAt: '2026-08-05' }],
      lastUpdate: '2026-08-02',
    });
    const drafts = renderDrafts(client, g, '2026-08-06');
    // Slack: no subject line, uses Slack bold + bullet markers
    expect(drafts.slack).toContain('Hi Marcos');
    expect(drafts.slack).toContain('•');
    expect(drafts.slack).not.toHaveProperty('subject');
    // Email: has subject + body, greeting + sign-off
    expect(drafts.email.subject).toContain('Alloi');
    expect(drafts.email.subject).toContain('2026-08-06');
    expect(drafts.email.body).toContain('Hi Marcos');
    expect(drafts.email.body).toContain('Best,');
  });
});

describe('delivery-status: buildStatusReportPlan (approval-gated, never a send)', () => {
  it('GOOD news -> draft plan with an approval row spec and NO send field', () => {
    const plan = buildStatusReportPlan({
      slug: 'alloi',
      clientFileMarkdown: ALLOI_MD,
      today: '2026-08-06',
      completedTasks: [{ title: 'Slack slash-todo shipped and live', completedAt: '2026-08-05' }],
    });
    expect(plan.action).toBe('draft');
    expect(plan.draft).toBeDefined();
    // Approval row is external-comms and owned by the reporter job.
    expect(plan.draft!.approval.category).toBe('external-comms');
    expect(plan.draft!.approval.owningJob).toBe('delivery-status-reporter');
    expect(plan.draft!.approval.client).toBe('alloi');
    // Draft file goes under the standardized clients/[client]/status-update path.
    expect(plan.draft!.relPath).toBe('raw/areas/clearworks/clients/alloi/status-update-2026-08-06.md');
    // Both channel formats present.
    expect(plan.draft!.channels.slack.length).toBeGreaterThan(0);
    expect(plan.draft!.channels.email.subject.length).toBeGreaterThan(0);
    // Activity line matches the mission-control spec pattern.
    expect(plan.draft!.activityLine).toContain('drafted');
    expect(plan.draft!.activityLine).toContain('pending approval');
    // The plan object exposes NO send instruction anywhere.
    const serialized = JSON.stringify(plan).toLowerCase();
    expect(serialized).not.toContain('"send"');
    expect(serialized).not.toContain('autosend');
    expect(serialized).not.toContain('auto_send":true');
    // The filed draft explicitly records auto_send: false + the send discipline note.
    expect(plan.draft!.fileContent).toContain('auto_send: false');
    expect(plan.draft!.fileContent).toContain('Approval is NOT a send');
  });

  it('BAD news -> brief plan (no client draft, HUMAN REVIEW REQUIRED), never a send', () => {
    const badMd = ALLOI_MD.replace(
      '- 2026-08-05 — Slack "slash to-do" quick task creation shipped and merged; tested live.',
      '- 2026-08-05 — Integration blocked; delivery delayed, apologies owed to Marcos.',
    );
    const plan = buildStatusReportPlan({
      slug: 'alloi',
      clientFileMarkdown: badMd,
      today: '2026-08-06',
    });
    expect(plan.action).toBe('brief');
    expect(plan.draft).toBeUndefined();
    expect(plan.brief).toBeDefined();
    expect(plan.brief!.relPath).toContain('status-brief-2026-08-06.md');
    expect(plan.brief!.fileContent).toContain('HUMAN REVIEW REQUIRED');
    expect(plan.brief!.signals.length).toBeGreaterThan(0);
  });

  it('insufficient data -> skip gracefully, no fabricated status', () => {
    const plan = buildStatusReportPlan({
      slug: 'seiu-521',
      // last_update in the future of all history => nothing moved
      clientFileMarkdown:
        '# Client: SEIU 521\n\n## Reporting\n\n- cadence: monthly\n- channel: email\n- contact: David Sailer\n- last_update: 2026-12-01\n\n## History (dated, newest first)\n\n- 2026-06-03 — AI policy meeting.\n',
      today: '2026-08-06',
    });
    expect(plan.action).toBe('skip');
    expect(plan.draft).toBeUndefined();
    expect(plan.brief).toBeUndefined();
    expect(plan.skipReason).toBeTruthy();
  });
});
