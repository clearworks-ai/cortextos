import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseClientMd, clientSlug } from '../data/clients';

// ---------------------------------------------------------------------------
// parseClientMd — markdown table / history / contacts parsing
// ---------------------------------------------------------------------------

const ALLOI_MD = `# Client: Alloi

## Contacts

- Marcos Santa Ana — Ops/IT Lead — marcos@alloi.us

## History (dated, newest first)

- 2026-07-22 — Alloi training/tactical planning (51m, Josh+Marcos).
- 2026-07-21 — Alloi AI-ops audit (2026-07-17) delivered to Marcos by Josh directly via Slack.
- 2026-07-19 — Invoice AI-2026-2 ($2500) sent to Alloi Inc via Moxie.

## Open Items

| Item | Owner | Deadline | Source | Status |
|---|---|---|---|---|
| tactical cadence proposal | Josh | 2026-07-24 | fireflies:x | open |
| backup strategy 45TB | Marcos |  | pipeline.json | open |
| send 1-pager on bounded EA agent | Josh |  | pipeline.json | done |
`;

describe('parseClientMd', () => {
  const parsed = parseClientMd(ALLOI_MD);

  it('extracts the client title from the H1', () => {
    expect(parsed.title).toBe('Alloi');
  });

  it('parses the Contacts line', () => {
    expect(parsed.contacts.length).toBe(1);
    expect(parsed.contacts[0]).toContain('Marcos Santa Ana');
  });

  it('parses dated History lines newest-first', () => {
    expect(parsed.history.length).toBe(3);
    expect(parsed.history[0]).toContain('2026-07-22');
  });

  it('parses the Open Items table, skipping header + separator', () => {
    expect(parsed.openItems.length).toBe(3);
    const cadence = parsed.openItems.find((i) => i.item.includes('cadence'));
    expect(cadence?.owner).toBe('Josh');
    expect(cadence?.open).toBe(true);
    expect(cadence?.deadline).toBeDefined();
  });

  it('marks a done row as closed', () => {
    const onePager = parsed.openItems.find((i) => i.item.includes('1-pager'));
    expect(onePager?.open).toBe(false);
  });
});

describe('clientSlug', () => {
  it('drops the TLD and slugifies', () => {
    expect(clientSlug('alloi.us')).toBe('alloi');
    expect(clientSlug('OCG Properties')).toBe('ocg-properties');
  });
});

// ---------------------------------------------------------------------------
// getBlessedRoster — the 5 authoritative engagements + unified phase model
// ---------------------------------------------------------------------------

describe('getBlessedRoster', () => {
  it('is exactly the 5 blessed engagements at the correct phases', async () => {
    const { getBlessedRoster } = await import('../data/blessed-roster');
    const roster = getBlessedRoster();
    expect(roster.map((r) => r.id).sort()).toEqual(
      ['alloi', 'kadre', 'msia', 'ocg', 'seiu-521'].sort(),
    );
    const byId = Object.fromEntries(roster.map((r) => [r.id, r]));
    expect(byId.ocg.phase).toBe('Phase 1 · Pre-sales Design');
    expect(byId.kadre.phase).toBe('Phase 1 · Pre-sales Design');
    expect(byId.alloi.phase).toBe('Phase 2 · Build / Active Delivery');
    expect(byId['seiu-521'].phase).toBe('Phase 3 · Delivered / Monitoring');
    expect(byId.msia.phase).toBe('Phase 4 · Post-delivery Follow-up');
  });

  it('orders by unified phase ascending', async () => {
    const { getBlessedRoster } = await import('../data/blessed-roster');
    const nums = getBlessedRoster().map((r) => r.phaseNumber);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// buildEngagements — blessed-5 render + Multica live status wiring
// ---------------------------------------------------------------------------

describe('buildEngagements — blessed roster + live Multica status', () => {
  let tmpCrm: string;
  let tmpClients: string;
  let tmpMulticaState: string;
  const prevCrm = process.env.CRM_DIR;
  const prevClients = process.env.ORG_BRAIN_CLIENTS_DIR;
  const prevMultica = process.env.MULTICA_SYNC_STATE;

  beforeAll(() => {
    tmpCrm = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crm-'));
    tmpClients = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-clients-'));

    // CRM pipeline only supplies last_signal_at / stage_history / industry —
    // NOT membership. Alloi's client_org matches the roster; MSIA is present
    // under its long CRM org name. SEIU 521 / Kadre / OCG need no pipeline row.
    fs.writeFileSync(
      path.join(tmpCrm, 'pipeline.json'),
      JSON.stringify({
        engagements: [
          {
            name: 'Marcos Santa Ana — Discovery Call',
            stage: 'won',
            client_org: 'alloi.us',
            client_industry: 'AEC',
            primary_contact_id: 'marcos-santa-ana',
            last_signal_at: '2026-07-22T02:31:57Z',
            stage_history: [{ at: '2026-06-19T23:35:00Z', from: 'qualified', to: 'committed' }],
          },
          {
            name: 'MSIA Busywork Audit',
            stage: 'won',
            client_org: 'Movement of Spiritual Awareness',
            client_industry: 'Non-Profit',
            primary_contact_id: 'mark-lurie',
            last_signal_at: '2026-06-30T19:40:16Z',
          },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(tmpCrm, 'contacts.json'),
      JSON.stringify({
        contacts: [
          { id: 'marcos-santa-ana', name: 'Marcos Santa Ana', role: 'Ops/IT Lead', category: 'client' },
          { id: 'mark-lurie', name: 'Mark Lurie', role: 'COO', category: 'client' },
        ],
      }),
    );

    fs.writeFileSync(path.join(tmpClients, 'alloi.md'), ALLOI_MD);

    // Multica sync-state: an Alloi-linked bus task is live in_progress. Since
    // getTasks() reads an empty test DB, this only exercises the loader path;
    // the live map itself is asserted below.
    tmpMulticaState = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'mc-multica-')),
      'sync-state.json',
    );
    fs.writeFileSync(
      tmpMulticaState,
      JSON.stringify({
        schema_version: '1',
        updated_at: '2026-08-04T00:00:00Z',
        links: {
          task_alloi_1: {
            multica_issue_id: 'issue-1',
            last_seen_multica_status: 'in_progress',
          },
          task_no_issue: { multica_issue_id: null, last_seen_multica_status: 'todo' },
        },
      }),
    );

    process.env.CRM_DIR = tmpCrm;
    process.env.ORG_BRAIN_CLIENTS_DIR = tmpClients;
    process.env.MULTICA_SYNC_STATE = tmpMulticaState;
  });

  afterAll(() => {
    if (prevCrm === undefined) delete process.env.CRM_DIR;
    else process.env.CRM_DIR = prevCrm;
    if (prevClients === undefined) delete process.env.ORG_BRAIN_CLIENTS_DIR;
    else process.env.ORG_BRAIN_CLIENTS_DIR = prevClients;
    if (prevMultica === undefined) delete process.env.MULTICA_SYNC_STATE;
    else process.env.MULTICA_SYNC_STATE = prevMultica;
    fs.rmSync(tmpCrm, { recursive: true, force: true });
    fs.rmSync(tmpClients, { recursive: true, force: true });
    fs.rmSync(path.dirname(tmpMulticaState), { recursive: true, force: true });
  });

  it('renders all 5 blessed engagements with correct phases', async () => {
    const { buildEngagements } = await import('../data/clients');
    const rows = buildEngagements();
    expect(rows.map((r) => r.id)).toEqual(['ocg', 'kadre', 'alloi', 'seiu-521', 'msia']);

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.ocg.phase).toBe('Phase 1 · Pre-sales Design');
    expect(byId.kadre.phase).toBe('Phase 1 · Pre-sales Design');
    expect(byId.alloi.phase).toBe('Phase 2 · Build / Active Delivery');
    expect(byId['seiu-521'].phase).toBe('Phase 3 · Delivered / Monitoring');
    expect(byId.msia.phase).toBe('Phase 4 · Post-delivery Follow-up');
  });

  it('joins org-brain md data onto the roster row (Alloi)', async () => {
    const { buildEngagements } = await import('../data/clients');
    const alloi = buildEngagements().find((r) => r.id === 'alloi');
    expect(alloi?.contact?.name).toBe('Marcos Santa Ana');
    expect(alloi?.industry).toBe('AEC');
    expect(alloi?.startedAt).toBeDefined();
    // Open Items: 2 open + 1 closed of 3 rows (no bus tasks in the test DB).
    expect(alloi?.open).toBe(2);
    expect(alloi?.total).toBe(3);
  });

  it('does NOT invent rows outside the blessed roster', async () => {
    const { buildEngagements } = await import('../data/clients');
    const rows = buildEngagements();
    expect(rows).toHaveLength(5);
    expect(rows.some((r) => r.clientOrg === 'coldco.com')).toBe(false);
  });

  it('reads live Multica status keyed by bus task id (in_progress reflected)', async () => {
    const { loadMulticaLiveStatus, isLiveInFlight } = await import('../data/multica-status');
    const live = loadMulticaLiveStatus();
    expect(live.get('task_alloi_1')).toBe('in_progress');
    expect(isLiveInFlight('in_progress')).toBe(true);
    // A link without a resolved issue id is skipped (no fabricated status).
    expect(live.has('task_no_issue')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveRole — SkillTree role tagging
// ---------------------------------------------------------------------------

describe('resolveRole', () => {
  it('honors an explicit meta.role', async () => {
    const { resolveRole } = await import('../data/skilltree-roles');
    const r = resolveRole({
      id: '1',
      timestamp: '2026-08-03T00:00:00Z',
      agent: 'crm',
      org: '',
      type: 'action',
      category: 'billing',
      severity: 'info',
      message: 'sent invoice',
      data: { role: 'Billing Manager', client: 'alloi.us' },
    });
    expect(r.role).toBe('Billing Manager');
    expect(r.isFallback).toBe(false);
    expect(r.client).toBe('alloi.us');
  });

  it('maps invoice keywords to Billing Manager', async () => {
    const { resolveRole } = await import('../data/skilltree-roles');
    const r = resolveRole({
      id: '2',
      timestamp: '2026-08-03T00:00:00Z',
      agent: 'crm',
      org: '',
      type: 'action',
      category: 'action',
      severity: 'info',
      message: 'Moxie invoice AI-2026-2 sent',
    });
    expect(r.role).toBe('Billing Manager');
    expect(r.isFallback).toBe(false);
  });

  it('falls back to the raw agent name when nothing matches', async () => {
    const { resolveRole } = await import('../data/skilltree-roles');
    const r = resolveRole({
      id: '3',
      timestamp: '2026-08-03T00:00:00Z',
      agent: 'someagent',
      org: '',
      type: 'action',
      category: 'action',
      severity: 'info',
      message: 'did a thing',
    });
    expect(r.role).toBe('someagent');
    expect(r.isFallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildEngagements — CRM stage-compatibility filter (dashboard-seiu-deal-collision-fix)
// A phase-3/4 roster row must NOT absorb an unrelated pre-sales-stage deal that
// merely shares the client name (confirmed live: SEIU 521's delivered engagement
// vs a newer 'qualified' Busywork-Audit prospect under the same name).
// ---------------------------------------------------------------------------
describe('buildEngagements — stage-compatibility filter for phase-3/4 rows', () => {
  let tmpCrm: string;
  let tmpClients: string;
  const prevCrm = process.env.CRM_DIR;
  const prevClients = process.env.ORG_BRAIN_CLIENTS_DIR;
  const prevMultica = process.env.MULTICA_SYNC_STATE;

  // Distinct from SEIU 521's roster industry ('Labor Union'), so an attached
  // pipeline row is unambiguously visible in the built engagement's `industry`.
  const PIPELINE_INDUSTRY = 'Prospect-Deal-Industry';

  beforeAll(() => {
    tmpCrm = fs.mkdtempSync(path.join(os.tmpdir(), 'seiu-crm-'));
    tmpClients = fs.mkdtempSync(path.join(os.tmpdir(), 'seiu-clients-'));
    // No org-brain md and no MULTICA state — isolate the CRM-join behavior.
    fs.writeFileSync(path.join(tmpCrm, 'contacts.json'), JSON.stringify({ contacts: [] }));
    process.env.CRM_DIR = tmpCrm;
    process.env.ORG_BRAIN_CLIENTS_DIR = tmpClients;
    delete process.env.MULTICA_SYNC_STATE;
  });

  afterAll(() => {
    if (prevCrm === undefined) delete process.env.CRM_DIR;
    else process.env.CRM_DIR = prevCrm;
    if (prevClients === undefined) delete process.env.ORG_BRAIN_CLIENTS_DIR;
    else process.env.ORG_BRAIN_CLIENTS_DIR = prevClients;
    if (prevMultica === undefined) delete process.env.MULTICA_SYNC_STATE;
    else process.env.MULTICA_SYNC_STATE = prevMultica;
    fs.rmSync(tmpCrm, { recursive: true, force: true });
    fs.rmSync(tmpClients, { recursive: true, force: true });
  });

  // Write a pipeline.json whose ONLY SEIU 521 entry is at `stage`.
  function writeSeiuPipeline(stage: string): void {
    fs.writeFileSync(
      path.join(tmpCrm, 'pipeline.json'),
      JSON.stringify({
        engagements: [
          {
            name: 'SEIU 521 — Busywork Audit',
            stage,
            status: 'prospect',
            client_org: 'SEIU 521',
            client_industry: PIPELINE_INDUSTRY,
            last_signal_at: '2026-08-03T00:00:00Z',
          },
        ],
      }),
    );
  }

  async function seiuRow() {
    const { buildEngagements } = await import('../data/clients');
    return buildEngagements().find((r) => r.id === 'seiu-521');
  }

  it('does NOT attach a qualified-stage deal to the phase-3 SEIU 521 row', async () => {
    writeSeiuPipeline('qualified');
    const seiu = await seiuRow();
    // Falls back to the roster's own industry, not the prospect deal's.
    expect(seiu?.industry).toBe('Labor Union');
    expect(seiu?.industry).not.toBe(PIPELINE_INDUSTRY);
  });

  it('does NOT attach a lead-stage deal to the phase-3 SEIU 521 row', async () => {
    writeSeiuPipeline('lead');
    const seiu = await seiuRow();
    expect(seiu?.industry).toBe('Labor Union');
    expect(seiu?.industry).not.toBe(PIPELINE_INDUSTRY);
  });

  it('DOES attach a won-stage deal to the phase-3 SEIU 521 row', async () => {
    writeSeiuPipeline('won');
    const seiu = await seiuRow();
    expect(seiu?.industry).toBe(PIPELINE_INDUSTRY);
  });

  it('DOES attach a committed-stage deal to the phase-3 SEIU 521 row', async () => {
    writeSeiuPipeline('committed');
    const seiu = await seiuRow();
    expect(seiu?.industry).toBe(PIPELINE_INDUSTRY);
  });
});

// ---------------------------------------------------------------------------
// parseClientMd — blank Open Items row (dashboard-seiu-deal-collision-fix)
// ---------------------------------------------------------------------------
describe('parseClientMd — blank Open Items row', () => {
  const MD_WITH_BLANK_ROW = `# Client: Blankrow Co

## Open Items

| Item | Owner | Deadline | Source | Status |
|---|---|---|---|---|
| real open task | Josh | 2026-08-10 | fireflies:x | open |
| | | | | |
`;

  it('skips an all-blank template row and counts only the real row', () => {
    const parsed = parseClientMd(MD_WITH_BLANK_ROW);
    expect(parsed.openItems).toHaveLength(1);
    expect(parsed.openItems[0].item).toBe('real open task');
    expect(parsed.openItems[0].open).toBe(true);
  });
});
