import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseCalendarEvents,
  splitAttendees,
  selectUpcomingExternalMeetings,
  readSurfacedIds,
  markSurfaced,
  claimEventLease,
  releaseEventLease,
  readClaimedIds,
  DEFAULT_CLAIM_TTL_MS,
  lookupCrmContext,
  renderBriefMarkdown,
} from '../../../src/bus/meeting-brief';
import type { BriefData, CalendarEventInput, MeetingCandidate } from '../../../src/bus/meeting-brief';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'meeting-brief-test-'));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

const INTERNAL = ['clearworks.ai', 'weissjosh0@gmail.com'];

function makeEvent(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    id: 'evt-1',
    title: 'Intro Call',
    start: '2026-07-03T18:00:00Z',
    attendees: ['josh@clearworks.ai', 'matt@ocg.com'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseCalendarEvents
// ---------------------------------------------------------------------------

describe('parseCalendarEvents', () => {
  it('parses a bare array of simple events', () => {
    const events = parseCalendarEvents(JSON.stringify([
      { id: 'a', title: 'Call', start: '2026-07-03T18:00:00Z', attendees: ['x@y.com'] },
    ]));
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('a');
    expect(events[0].title).toBe('Call');
    expect(events[0].start).toBe('2026-07-03T18:00:00Z');
    expect(events[0].attendees).toEqual(['x@y.com']);
  });

  it('parses an {events:[...]} wrapper', () => {
    const events = parseCalendarEvents(JSON.stringify({
      events: [{ id: 'b', summary: 'Sync', start: '2026-07-03T19:00:00Z', attendees: [] }],
    }));
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('b');
    expect(events[0].title).toBe('Sync');
  });

  it('handles gws-ish shapes: {dateTime} starts, {email} attendees, iCalUID ids', () => {
    const events = parseCalendarEvents(JSON.stringify([
      {
        iCalUID: 'uid-123',
        summary: 'Prospect Call',
        start: { dateTime: '2026-07-03T20:00:00-07:00' },
        end: { dateTime: '2026-07-03T21:00:00-07:00' },
        attendees: [{ email: 'ext@corp.com' }, { email: 'josh@clearworks.ai' }],
        location: 'Zoom',
      },
    ]));
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('uid-123');
    expect(events[0].title).toBe('Prospect Call');
    expect(events[0].start).toBe('2026-07-03T20:00:00-07:00');
    expect(events[0].end).toBe('2026-07-03T21:00:00-07:00');
    expect(events[0].attendees).toEqual(['ext@corp.com', 'josh@clearworks.ai']);
    expect(events[0].location).toBe('Zoom');
  });

  it('maps eventId as an id source and {date} starts (all-day)', () => {
    const events = parseCalendarEvents(JSON.stringify([
      { eventId: 'ev-9', title: 'OOO', start: { date: '2026-07-04' }, attendees: [] },
    ]));
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('ev-9');
    expect(events[0].start).toBe('2026-07-04');
  });

  it('skips entries with no parseable start', () => {
    const events = parseCalendarEvents(JSON.stringify([
      { id: 'no-start', title: 'Broken' },
      { id: 'ok', title: 'Fine', start: '2026-07-03T18:00:00Z' },
    ]));
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('ok');
  });

  it('never throws on garbage input — returns []', () => {
    expect(parseCalendarEvents('not json at all {{{')).toEqual([]);
    expect(parseCalendarEvents('')).toEqual([]);
    expect(parseCalendarEvents('42')).toEqual([]);
    expect(parseCalendarEvents('{"nope": true}')).toEqual([]);
    expect(parseCalendarEvents(JSON.stringify([null, 7, 'str']))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// splitAttendees
// ---------------------------------------------------------------------------

describe('splitAttendees', () => {
  it('splits by domain and exact-email internal entries', () => {
    const { internal, external } = splitAttendees(
      ['josh@clearworks.ai', 'weissjosh0@gmail.com', 'randoperson@gmail.com', 'matt@ocg.com'],
      INTERNAL,
    );
    expect(internal).toEqual(['josh@clearworks.ai', 'weissjosh0@gmail.com']);
    // Exact-email entry must NOT make all of gmail.com internal
    expect(external).toEqual(['randoperson@gmail.com', 'matt@ocg.com']);
  });

  it('is case-insensitive on both sides', () => {
    const { internal, external } = splitAttendees(
      ['Josh@Clearworks.AI', 'WEISSJOSH0@GMAIL.COM', 'Matt@OCG.com'],
      ['CLEARWORKS.ai', 'WeissJosh0@Gmail.com'],
    );
    expect(internal).toEqual(['Josh@Clearworks.AI', 'WEISSJOSH0@GMAIL.COM']);
    expect(external).toEqual(['Matt@OCG.com']);
  });

  it('treats attendees without an @ as external', () => {
    const { internal, external } = splitAttendees(['conference-room-1'], INTERNAL);
    expect(internal).toEqual([]);
    expect(external).toEqual(['conference-room-1']);
  });
});

// ---------------------------------------------------------------------------
// selectUpcomingExternalMeetings
// ---------------------------------------------------------------------------

describe('selectUpcomingExternalMeetings', () => {
  const now = Date.parse('2026-07-03T17:15:00Z');
  const opts = { minLeadMin: 30, maxLeadMin: 75 };

  it('keeps an in-window event with an external attendee', () => {
    // 18:00 is 45 minutes out — inside [30, 75]
    const out = selectUpcomingExternalMeetings([makeEvent()], now, opts, INTERNAL, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].eventId).toBe('evt-1');
    expect(out[0].externalAttendees).toEqual(['matt@ocg.com']);
    expect(out[0].internalAttendees).toEqual(['josh@clearworks.ai']);
    expect(out[0].startIso).toBe('2026-07-03T18:00:00Z');
  });

  it('excludes events starting too soon', () => {
    const tooSoon = makeEvent({ id: 'soon', start: '2026-07-03T17:30:00Z' }); // 15 min out
    expect(selectUpcomingExternalMeetings([tooSoon], now, opts, INTERNAL, new Set())).toEqual([]);
  });

  it('excludes events starting too late', () => {
    const tooLate = makeEvent({ id: 'late', start: '2026-07-03T19:30:00Z' }); // 135 min out
    expect(selectUpcomingExternalMeetings([tooLate], now, opts, INTERNAL, new Set())).toEqual([]);
  });

  it('excludes all-internal meetings', () => {
    const internalOnly = makeEvent({ id: 'int', attendees: ['josh@clearworks.ai', 'weissjosh0@gmail.com'] });
    expect(selectUpcomingExternalMeetings([internalOnly], now, opts, INTERNAL, new Set())).toEqual([]);
  });

  it('excludes already-surfaced event ids', () => {
    const out = selectUpcomingExternalMeetings([makeEvent()], now, opts, INTERNAL, new Set(['evt-1']));
    expect(out).toEqual([]);
  });

  it('excludes live-claimed event ids (in-flight worker), keeping unclaimed ones', () => {
    const a = makeEvent({ id: 'evt-a', attendees: ['matt@ocg.com'] });
    const b = makeEvent({ id: 'evt-b', attendees: ['jane@corp.com'] });
    const out = selectUpcomingExternalMeetings(
      [a, b], now, opts, INTERNAL,
      new Set(),          // none surfaced
      new Set(['evt-a']), // evt-a claimed
    );
    expect(out.map(c => c.eventId)).toEqual(['evt-b']);
  });

  it('excludes an id that is BOTH surfaced AND live-claimed', () => {
    const out = selectUpcomingExternalMeetings(
      [makeEvent()], now, opts, INTERNAL,
      new Set(['evt-1']),
      new Set(['evt-1']),
    );
    expect(out).toEqual([]);
  });

  it('skips all-day (date-only start) events', () => {
    const allDay = makeEvent({ id: 'allday', start: '2026-07-03' });
    expect(selectUpcomingExternalMeetings([allDay], now, opts, INTERNAL, new Set())).toEqual([]);
  });

  it('skips events with an unparseable start', () => {
    const bad = makeEvent({ id: 'bad', start: 'whenever' });
    expect(selectUpcomingExternalMeetings([bad], now, opts, INTERNAL, new Set())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readSurfacedIds / markSurfaced
// ---------------------------------------------------------------------------

describe('surfaced-id dedup file', () => {
  it('returns an empty set on ENOENT', () => {
    expect(readSurfacedIds(join(tmpDir, 'does-not-exist.txt')).size).toBe(0);
  });

  it('roundtrips ids through mark + read, creating parent dirs', () => {
    const stateFile = join(tmpDir, 'nested', 'deeper', 'surfaced.txt');
    markSurfaced(stateFile, 'evt-1');
    markSurfaced(stateFile, 'evt-2');
    const ids = readSurfacedIds(stateFile);
    expect(ids.has('evt-1')).toBe(true);
    expect(ids.has('evt-2')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('re-marking the same id is idempotent', () => {
    const stateFile = join(tmpDir, 'surfaced.txt');
    markSurfaced(stateFile, 'evt-1');
    markSurfaced(stateFile, 'evt-1');
    markSurfaced(stateFile, 'evt-1');
    expect(readSurfacedIds(stateFile).size).toBe(1);
    const lines = readFileSync(stateFile, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines).toEqual(['evt-1']);
  });

  it('reads one id per line, skipping blanks', () => {
    const stateFile = join(tmpDir, 'surfaced.txt');
    writeFileSync(stateFile, 'a\n\nb\n  \nc\n');
    const ids = readSurfacedIds(stateFile);
    expect(Array.from(ids).sort()).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// Claim lease — cross-process-atomic in-flight dedup
// ---------------------------------------------------------------------------

describe('claim lease', () => {
  it('two overlapping claims for the same eventId: exactly ONE wins', () => {
    const claimsDir = join(tmpDir, 'claims');
    const first = claimEventLease(claimsDir, 'evt-1');
    const second = claimEventLease(claimsDir, 'evt-1');

    expect(first.claimed).toBe(true);
    expect(first.reason).toBe('won');
    // Second caller, no release in between -> rejected.
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe('already-claimed');
  });

  it('different event ids each get their own claim', () => {
    const claimsDir = join(tmpDir, 'claims');
    expect(claimEventLease(claimsDir, 'evt-a').claimed).toBe(true);
    expect(claimEventLease(claimsDir, 'evt-b').claimed).toBe(true);
  });

  it('a stale/expired claim (older than TTL) is garbage-collected, not reclaimed in-band', () => {
    const claimsDir = join(tmpDir, 'claims');
    const t0 = 1_000_000_000_000;
    const ttlMs = DEFAULT_CLAIM_TTL_MS;

    expect(claimEventLease(claimsDir, 'evt-1', { nowMs: t0, ttlMs }).claimed).toBe(true);

    // Just before TTL — still actively claimed, rejected.
    const stillLive = claimEventLease(claimsDir, 'evt-1', { nowMs: t0 + ttlMs - 1, ttlMs });
    expect(stillLive.claimed).toBe(false);
    expect(stillLive.reason).toBe('already-claimed');

    // Past TTL — the previous holder is assumed dead. The stale lock is CLEARED
    // (not reclaimed in-band): winning only ever happens via the atomic O_EXCL
    // fast path, so this call does NOT win.
    const cleared = claimEventLease(claimsDir, 'evt-1', { nowMs: t0 + ttlMs + 1, ttlMs });
    expect(cleared.claimed).toBe(false);
    expect(cleared.reason).toBe('stale-cleared');

    // The very next fire finds no lock and cleanly claims it (crash recovery,
    // one cycle later).
    const recovered = claimEventLease(claimsDir, 'evt-1', { nowMs: t0 + ttlMs + 2, ttlMs });
    expect(recovered.claimed).toBe(true);
    expect(recovered.reason).toBe('won');
  });

  it('stale-clear never double-wins: two racers past TTL both fail to claim, next fire wins once', () => {
    // Simulate the crash-recovery boundary: a stale lock plus two overlapping
    // fires. Neither may win off the stale path (that was the residual race);
    // exactly one clean claim happens on the following fire.
    const claimsDir = join(tmpDir, 'claims');
    const t0 = 1_000_000_000_000;
    const ttlMs = DEFAULT_CLAIM_TTL_MS;
    expect(claimEventLease(claimsDir, 'evt-x', { nowMs: t0, ttlMs }).claimed).toBe(true);

    const past = t0 + ttlMs + 1;
    const racerA = claimEventLease(claimsDir, 'evt-x', { nowMs: past, ttlMs });
    // The call that takes the STALE path never wins in-band — it only clears the
    // lock. This is the invariant that kills the double-win: a winner can ONLY
    // come from the atomic O_EXCL fast path, never from a stale reclaim.
    expect(racerA.claimed).toBe(false);
    expect(racerA.reason).toBe('stale-cleared');

    // Across the boundary there is at most one holder at a time: after the clear,
    // the next fast-path fire wins once, and a further overlapping fire is then
    // rejected as already-claimed.
    const recovered = claimEventLease(claimsDir, 'evt-x', { nowMs: past + 1, ttlMs });
    const overlap = claimEventLease(claimsDir, 'evt-x', { nowMs: past + 2, ttlMs });
    expect(recovered.claimed).toBe(true);
    expect(recovered.reason).toBe('won');
    expect(overlap.claimed).toBe(false);
    expect(overlap.reason).toBe('already-claimed');
  });

  it('after release (failure path) the event can be claimed again', () => {
    const claimsDir = join(tmpDir, 'claims');
    expect(claimEventLease(claimsDir, 'evt-1').claimed).toBe(true);
    // Second attempt blocked while the claim is live.
    expect(claimEventLease(claimsDir, 'evt-1').claimed).toBe(false);

    releaseEventLease(claimsDir, 'evt-1');

    // Now a fresh claim wins outright.
    const after = claimEventLease(claimsDir, 'evt-1');
    expect(after.claimed).toBe(true);
    expect(after.reason).toBe('won');
  });

  it('release is idempotent — releasing a non-existent claim is a no-op', () => {
    const claimsDir = join(tmpDir, 'claims');
    expect(() => releaseEventLease(claimsDir, 'never-claimed')).not.toThrow();
    expect(() => releaseEventLease(claimsDir, 'never-claimed')).not.toThrow();
  });

  it('readClaimedIds returns only live-claimed candidate ids', () => {
    const claimsDir = join(tmpDir, 'claims');
    const t0 = 1_000_000_000_000;
    const ttlMs = DEFAULT_CLAIM_TTL_MS;

    claimEventLease(claimsDir, 'evt-live', { nowMs: t0, ttlMs });
    claimEventLease(claimsDir, 'evt-old', { nowMs: t0 - ttlMs - 1000, ttlMs });

    const claimed = readClaimedIds(
      claimsDir,
      ['evt-live', 'evt-old', 'evt-unclaimed'],
      { nowMs: t0, ttlMs },
    );
    expect(claimed.has('evt-live')).toBe(true);
    expect(claimed.has('evt-old')).toBe(false);        // expired -> not live
    expect(claimed.has('evt-unclaimed')).toBe(false);  // never claimed
    expect(claimed.size).toBe(1);
  });

  it('readClaimedIds on a missing claims dir returns an empty set', () => {
    const claimed = readClaimedIds(join(tmpDir, 'no-such-claims-dir'), ['evt-1']);
    expect(claimed.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lookupCrmContext
// ---------------------------------------------------------------------------

function writeCrmFixture(crmDir: string): void {
  mkdirSync(crmDir, { recursive: true });
  writeFileSync(join(crmDir, 'contacts.json'), JSON.stringify({
    contacts: [
      { id: 'matt-owens', name: 'Matt Owens', company: 'OCG', category: 'client', emails: ['matt@ocg.com', 'mowens@personal.com'] },
      { id: 'elaine-roark', name: 'Elaine Roark', company: 'Stoss', category: 'lead', emails: ['elaine@stoss.com'] },
      { id: 'unrelated', name: 'Someone Else', emails: ['nobody@nowhere.com'] },
    ],
  }, null, 2));
  writeFileSync(join(crmDir, 'pipeline.json'), JSON.stringify({
    engagements: [
      {
        client_org: 'OCG',
        stage: 'active',
        contact_ids: ['matt-owens'],
        last_signal_at: '2026-07-01T12:00:00Z',
        _open_commitments: { josh: ['Send proposal', 'Review loan docs'] },
      },
      { client_org: 'Unrelated Co', stage: 'lead', contact_ids: ['unrelated'] },
    ],
  }, null, 2));
  const interactions = [
    JSON.stringify({ ts: '2026-06-01T10:00:00Z', contact_id: 'matt-owens', type: 'email', summary: 'Oldest' }),
    'this line is not json {{{',
    JSON.stringify({ ts: '2026-07-02T10:00:00Z', contact_id: 'matt-owens', type: 'call', summary: 'Newest' }),
    JSON.stringify({ ts: '2026-06-15T10:00:00Z', contact_id: 'matt-owens', type: 'email', summary: 'Middle' }),
    JSON.stringify({ ts: '2026-06-20T10:00:00Z', contact_id: 'unrelated', type: 'email', summary: 'Not ours' }),
  ];
  writeFileSync(join(crmDir, 'interactions.jsonl'), interactions.join('\n') + '\n');
}

describe('lookupCrmContext', () => {
  it('happy path: matches contact, engagement stage + open commitments, newest-first interactions', () => {
    const crmDir = join(tmpDir, 'crm');
    writeCrmFixture(crmDir);

    const ctx = lookupCrmContext(crmDir, ['Matt@OCG.com']);

    expect(ctx.matches).toHaveLength(1);
    expect(ctx.matches[0].contactId).toBe('matt-owens');
    expect(ctx.matches[0].name).toBe('Matt Owens');
    expect(ctx.matches[0].company).toBe('OCG');
    expect(ctx.matches[0].category).toBe('client');

    expect(ctx.engagements).toHaveLength(1);
    expect(ctx.engagements[0].clientOrg).toBe('OCG');
    expect(ctx.engagements[0].stage).toBe('active');
    expect(ctx.engagements[0].openCommitments).toEqual(['Send proposal', 'Review loan docs']);
    expect(ctx.engagements[0].lastSignalAt).toBe('2026-07-01T12:00:00Z');

    // Newest first, malformed line skipped, other contacts' interactions excluded
    expect(ctx.recentInteractions.map(i => i.summary)).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('caps interactions at maxInteractions', () => {
    const crmDir = join(tmpDir, 'crm');
    writeCrmFixture(crmDir);
    const ctx = lookupCrmContext(crmDir, ['matt@ocg.com'], { maxInteractions: 2 });
    expect(ctx.recentInteractions.map(i => i.summary)).toEqual(['Newest', 'Middle']);
  });

  it('accepts a bare-array contacts.json', () => {
    const crmDir = join(tmpDir, 'crm-bare');
    mkdirSync(crmDir, { recursive: true });
    writeFileSync(join(crmDir, 'contacts.json'), JSON.stringify([
      { id: 'c1', name: 'Bare Array', emails: ['bare@corp.com'] },
    ]));
    const ctx = lookupCrmContext(crmDir, ['bare@corp.com']);
    expect(ctx.matches).toHaveLength(1);
    expect(ctx.matches[0].contactId).toBe('c1');
  });

  it('missing files yield an empty CrmContext without throwing', () => {
    const ctx = lookupCrmContext(join(tmpDir, 'no-such-dir'), ['matt@ocg.com']);
    expect(ctx).toEqual({ matches: [], engagements: [], recentInteractions: [] });
  });

  it('malformed contacts.json and pipeline.json are tolerated', () => {
    const crmDir = join(tmpDir, 'crm-broken');
    mkdirSync(crmDir, { recursive: true });
    writeFileSync(join(crmDir, 'contacts.json'), 'not json');
    writeFileSync(join(crmDir, 'pipeline.json'), '[[[');
    const ctx = lookupCrmContext(crmDir, ['matt@ocg.com']);
    expect(ctx).toEqual({ matches: [], engagements: [], recentInteractions: [] });
  });

  it('no matched contacts means no engagements or interactions', () => {
    const crmDir = join(tmpDir, 'crm');
    writeCrmFixture(crmDir);
    const ctx = lookupCrmContext(crmDir, ['stranger@elsewhere.com']);
    expect(ctx.matches).toEqual([]);
    expect(ctx.engagements).toEqual([]);
    expect(ctx.recentInteractions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderBriefMarkdown
// ---------------------------------------------------------------------------

const H2_SECTIONS = [
  '## Agenda',
  '## Executive Summary',
  '## Engagement Strategy',
  '## Talking Points',
  '## Questions to Ask',
  '## Anticipated Questions',
  '## Key Sensitivities',
  '## Action Items',
  '## Meeting Details & Participants',
  '## CRM Record',
  '## Research Profile',
];

function makeMeeting(): MeetingCandidate {
  return {
    eventId: 'evt-1',
    title: 'Intro Call',
    startIso: '2026-07-03T18:00:00Z',
    endIso: '2026-07-03T19:00:00Z',
    location: 'Zoom',
    externalAttendees: ['matt@ocg.com'],
    internalAttendees: ['josh@clearworks.ai'],
  };
}

function makeBriefData(overrides: Partial<BriefData> = {}): BriefData {
  return {
    meeting: makeMeeting(),
    crm: {
      matches: [{ contactId: 'matt-owens', name: 'Matt Owens', company: 'OCG', email: 'matt@ocg.com', category: 'client' }],
      engagements: [{ clientOrg: 'OCG', stage: 'active', openCommitments: ['Send proposal'], lastSignalAt: '2026-07-01T12:00:00Z' }],
      recentInteractions: [{ ts: '2026-07-02T10:00:00Z', contactId: 'matt-owens', type: 'call', summary: 'Discussed scope' }],
    },
    agenda: 'Kick off the syndication project.',
    executiveSummary: 'Matt wants to move fast.',
    engagementStrategy: { opener: 'Ask about the Q3 close.', missionAlignment: 'Loan ops automation.', suggestedAsk: 'Propose the audit.' },
    talkingPoints: ['Timeline', 'Budget'],
    questionsToAsk: ['Who signs off?'],
    anticipatedQuestions: ['How long will it take?'],
    keySensitivities: ['Do not mention the delayed invoice.'],
    actionItems: ['Send follow-up recap'],
    priorIntelligence: 'Met at the June conference.',
    researchProfile: 'OCG is a loan syndication firm.',
    ...overrides,
  };
}

describe('renderBriefMarkdown', () => {
  it('renders the H1 title and When/Where/Who preamble', () => {
    const md = renderBriefMarkdown(makeBriefData());
    expect(md).toContain('# Pre-Meeting Brief — Intro Call');
    expect(md).toContain('**When:** 2026-07-03T18:00:00Z → 2026-07-03T19:00:00Z');
    expect(md).toContain('**Where:** Zoom');
    expect(md).toContain('**Who:** matt@ocg.com, josh@clearworks.ai');
  });

  it('renders all 11 H2 sections in exact order', () => {
    const md = renderBriefMarkdown(makeBriefData());
    let lastIdx = -1;
    for (const heading of H2_SECTIONS) {
      const idx = md.indexOf(`\n${heading}\n`);
      expect(idx, `missing or out-of-order heading: ${heading}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    // exactly 11 H2 headings — no extras
    expect(md.match(/^## /gm)).toHaveLength(11);
  });

  it('renders the Engagement Strategy H3 subsections and Prior Intelligence H3', () => {
    const md = renderBriefMarkdown(makeBriefData());
    expect(md).toContain('### Opener\nAsk about the Q3 close.');
    expect(md).toContain('### Mission Alignment\nLoan ops automation.');
    expect(md).toContain('### Suggested Ask\nPropose the audit.');
    expect(md).toContain('### Prior Intelligence\nMet at the June conference.');
  });

  it('renders content from populated fields', () => {
    const md = renderBriefMarkdown(makeBriefData());
    expect(md).toContain('- Timeline');
    expect(md).toContain('- Who signs off?');
    expect(md).toContain('stage: active');
    expect(md).toContain('- Send proposal');
    expect(md).toContain('[call] Discussed scope');
  });

  it('never omits a section — empty fields render the placeholder', () => {
    const md = renderBriefMarkdown(makeBriefData({
      agenda: '',
      executiveSummary: '   ',
      engagementStrategy: { opener: '', missionAlignment: '', suggestedAsk: '' },
      talkingPoints: [],
      questionsToAsk: [],
      anticipatedQuestions: [],
      keySensitivities: [],
      actionItems: [],
      priorIntelligence: '',
      researchProfile: '',
    }));
    for (const heading of H2_SECTIONS) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('## Agenda\n_None on file._');
    expect(md).toContain('## Talking Points\n_None on file._');
    expect(md).toContain('### Opener\n_None on file._');
    expect(md).toContain('### Prior Intelligence\n_None on file._');
  });

  it('renders the CRM-null placeholder', () => {
    const md = renderBriefMarkdown(makeBriefData({ crm: null }));
    expect(md).toContain('## CRM Record\n_No CRM record found._');
    // still 11 sections
    expect(md.match(/^## /gm)).toHaveLength(11);
  });
});
