import { readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { atomicWriteSync } from '../utils/atomic.js';

// ---------------------------------------------------------------------------
// Pre-meeting brief core (fleet-consolidation Phase 2, capability #1).
//
// Shape: calendar event ~45-min-out -> attendees split internal/external by
// domain -> CRM (pipeline.json) + prior intel + web research -> synthesize ->
// publish tokened web URL -> Telegram link. This module owns the deterministic
// half: calendar parsing, external-meeting selection, surfaced-id dedup, CRM
// context lookup, and the 11-section markdown renderer. Research + synthesis
// happen in the calling skill/worker.
// ---------------------------------------------------------------------------

export interface CalendarEventInput {
  id: string;
  title: string;
  start: string;
  end?: string;
  attendees: string[];
  location?: string;
  description?: string;
}

export interface MeetingCandidate {
  eventId: string;
  title: string;
  startIso: string;
  endIso?: string;
  location?: string;
  externalAttendees: string[];
  internalAttendees: string[];
}

export interface CrmMatch {
  contactId: string;
  name: string;
  company?: string;
  email: string;
  category?: string;
}

export interface CrmEngagement {
  clientOrg: string;
  stage: string;
  openCommitments: string[];
  lastSignalAt?: string;
}

export interface CrmInteraction {
  ts: string;
  contactId: string;
  type: string;
  summary: string;
}

export interface CrmContext {
  matches: CrmMatch[];
  engagements: CrmEngagement[];
  recentInteractions: CrmInteraction[];
}

export interface BriefData {
  meeting: MeetingCandidate;
  crm: CrmContext | null;
  agenda: string;
  executiveSummary: string;
  engagementStrategy: { opener: string; missionAlignment: string; suggestedAsk: string };
  talkingPoints: string[];
  questionsToAsk: string[];
  anticipatedQuestions: string[];
  keySensitivities: string[];
  actionItems: string[];
  priorIntelligence: string;
  researchProfile: string;
}

// ---------------------------------------------------------------------------
// Calendar parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Extract an event start/end from a raw field: ISO string or {dateTime}|{date}. */
function parseWhen(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) return direct;
  if (isRecord(value)) {
    return asString(value.dateTime) ?? asString(value.date);
  }
  return undefined;
}

/** Extract attendees from a raw field: string[] or {email}[]. */
function parseAttendees(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const direct = asString(entry);
    if (direct) {
      out.push(direct);
      continue;
    }
    if (isRecord(entry)) {
      const email = asString(entry.email);
      if (email) out.push(email);
    }
  }
  return out;
}

/**
 * Tolerant parser for `gws calendar +agenda --format json` output.
 * Accepts a bare array or {events:[...]}. Never throws — malformed JSON
 * returns []. Entries with no parseable start are skipped.
 */
export function parseCalendarEvents(raw: string): CalendarEventInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  let entries: unknown[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.events)) {
    entries = parsed.events;
  } else {
    return [];
  }

  const events: CalendarEventInput[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;

    const start = parseWhen(entry.start);
    if (!start) continue;

    const title = asString(entry.title) ?? asString(entry.summary) ?? '';
    const id = asString(entry.id) ?? asString(entry.eventId) ?? asString(entry.iCalUID) ?? `${title}@${start}`;

    const event: CalendarEventInput = {
      id,
      title,
      start,
      attendees: parseAttendees(entry.attendees),
    };
    const end = parseWhen(entry.end);
    if (end) event.end = end;
    const location = asString(entry.location);
    if (location) event.location = location;
    const description = asString(entry.description);
    if (description) event.description = description;

    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Attendee split
// ---------------------------------------------------------------------------

/**
 * Split attendees into internal/external. Entries in internalDomains that
 * contain '@' are exact-email matches (so weissjosh0@gmail.com can be internal
 * without making all of gmail.com internal); the rest are domain matches.
 * Case-insensitive on both sides.
 */
export function splitAttendees(
  attendees: string[],
  internalDomains: string[],
): { internal: string[]; external: string[] } {
  const exactEmails = new Set<string>();
  const domains = new Set<string>();
  for (const raw of internalDomains) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes('@')) exactEmails.add(entry);
    else domains.add(entry);
  }

  const internal: string[] = [];
  const external: string[] = [];
  for (const attendee of attendees) {
    const lower = attendee.trim().toLowerCase();
    const atIdx = lower.lastIndexOf('@');
    const domain = atIdx >= 0 ? lower.slice(atIdx + 1) : '';
    if (exactEmails.has(lower) || (domain && domains.has(domain))) {
      internal.push(attendee);
    } else {
      external.push(attendee);
    }
  }
  return { internal, external };
}

// ---------------------------------------------------------------------------
// Meeting selection
// ---------------------------------------------------------------------------

/** Date-only starts (YYYY-MM-DD) are all-day events — the brief flow skips them. */
function isDateOnly(start: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(start.trim());
}

/**
 * Keep events starting within [nowMs+minLead, nowMs+maxLead] that have at
 * least one external attendee and have not already been surfaced. All-day
 * (date-only) events are skipped.
 */
export function selectUpcomingExternalMeetings(
  events: CalendarEventInput[],
  nowMs: number,
  opts: { minLeadMin: number; maxLeadMin: number },
  internalDomains: string[],
  surfacedIds: Set<string>,
): MeetingCandidate[] {
  const windowStart = nowMs + opts.minLeadMin * 60_000;
  const windowEnd = nowMs + opts.maxLeadMin * 60_000;

  const candidates: MeetingCandidate[] = [];
  for (const event of events) {
    if (surfacedIds.has(event.id)) continue;
    if (isDateOnly(event.start)) continue;

    const startMs = Date.parse(event.start);
    if (Number.isNaN(startMs)) continue;
    if (startMs < windowStart || startMs > windowEnd) continue;

    const { internal, external } = splitAttendees(event.attendees, internalDomains);
    if (external.length === 0) continue;

    const candidate: MeetingCandidate = {
      eventId: event.id,
      title: event.title,
      startIso: event.start,
      externalAttendees: external,
      internalAttendees: internal,
    };
    if (event.end) candidate.endIso = event.end;
    if (event.location) candidate.location = event.location;
    candidates.push(candidate);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Surfaced-id dedup file (one event id per line)
// ---------------------------------------------------------------------------

export function readSurfacedIds(filePath: string): Set<string> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return new Set();
  }
  const ids = new Set<string>();
  for (const line of content.split('\n')) {
    const id = line.trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Append an event id to the surfaced file (idempotent). The full content is
 * rewritten via atomicWriteSync; the parent directory is created as needed.
 */
export function markSurfaced(filePath: string, eventId: string): void {
  const ids = readSurfacedIds(filePath);
  if (ids.has(eventId)) return;
  ids.add(eventId);
  atomicWriteSync(filePath, Array.from(ids).join('\n'));
}

// ---------------------------------------------------------------------------
// In-flight claim (O_EXCL claim-before-spawn — at most one brief worker per
// event id). The surfaced file only records VERIFIED publishes (Step 8), so
// two cron fires 15 min apart both see the same unsurfaced event and both
// spawn workers. The claim closes that window: the cron claims each candidate
// BEFORE spawn-worker; a second fire's claim fails and the duplicate is
// dropped. A claim is released on publish failure (clearInFlight) or expires
// after IN_FLIGHT_TTL_MS so a crashed worker's event still retries.
// ---------------------------------------------------------------------------

/** 90 min > worker lifetime; a crashed worker's stale claim expires and the event retries. */
export const IN_FLIGHT_TTL_MS = 90 * 60_000;

/** Claim dir lives next to the surfaced state file. */
function inFlightDirFor(stateFile: string): string {
  return stateFile + '.inflight.d';
}

/**
 * One file per event. Filename is the sha256 of the eventId — event ids can
 * be the `title@start` fallback containing '/', ':' etc., so the raw id is
 * never used as a filename. File CONTENT is the raw eventId (one line) so
 * readInFlightIds can recover ids.
 */
function inFlightPathFor(stateFile: string, eventId: string): string {
  return join(inFlightDirFor(stateFile), createHash('sha256').update(eventId).digest('hex'));
}

/**
 * Atomically claim an event as in-flight. Returns true if this caller won the
 * claim; false if a live (non-expired) claim already exists. The 'wx' flag
 * (O_EXCL) makes the create atomic — exactly one of two concurrent claimers
 * succeeds. A stale claim (older than IN_FLIGHT_TTL_MS) is removed and the
 * claim retried once. Never throws on the expected-contention path.
 */
export function claimInFlight(stateFile: string, eventId: string, nowMs = Date.now()): boolean {
  const dir = inFlightDirFor(stateFile);
  mkdirSync(dir, { recursive: true });
  const claimPath = inFlightPathFor(stateFile, eventId);
  try {
    writeFileSync(claimPath, eventId + '\n', { flag: 'wx', encoding: 'utf-8' });
    return true;
  } catch {
    // EEXIST (or transient stat/unlink races below) — check for staleness.
  }
  try {
    const stat = statSync(claimPath);
    if (nowMs - stat.mtimeMs <= IN_FLIGHT_TTL_MS) return false; // live claim
  } catch {
    // Claim vanished between write and stat — fall through and retry once.
  }
  try {
    unlinkSync(claimPath);
  } catch {
    // Already removed by a concurrent claimer — retry decides the winner.
  }
  try {
    writeFileSync(claimPath, eventId + '\n', { flag: 'wx', encoding: 'utf-8' });
    return true;
  } catch {
    return false; // Lost the retry race to another claimer.
  }
}

/**
 * Read the raw event ids of all live (non-expired) in-flight claims.
 * Tolerant: a missing claim dir or unreadable entry contributes nothing.
 */
export function readInFlightIds(stateFile: string, nowMs = Date.now()): Set<string> {
  const dir = inFlightDirFor(stateFile);
  const ids = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return ids;
  }
  for (const name of names) {
    const filePath = join(dir, name);
    try {
      const stat = statSync(filePath);
      if (nowMs - stat.mtimeMs > IN_FLIGHT_TTL_MS) continue; // stale — ignore
      const id = readFileSync(filePath, 'utf-8').trim();
      if (id) ids.add(id);
    } catch {
      continue; // removed or unreadable mid-scan — skip
    }
  }
  return ids;
}

/**
 * Release an in-flight claim (publish failure path, and after markSurfaced on
 * success so stale claim files never accumulate). Tolerant of ENOENT.
 */
export function clearInFlight(stateFile: string, eventId: string): void {
  try {
    unlinkSync(inFlightPathFor(stateFile, eventId));
  } catch {
    // Never claimed or already cleared — fine.
  }
}

// ---------------------------------------------------------------------------
// CRM context lookup (contacts.json + pipeline.json + interactions.jsonl)
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Look up CRM context for the meeting's external attendees. Reads the crm
 * agent's dir shape (contacts.json, pipeline.json, interactions.jsonl); every
 * read is tolerant — a missing or malformed file contributes nothing and never
 * throws. Contacts match by exact lowercase email; engagements match by
 * contact-id intersection; interactions are newest-first, capped.
 */
export function lookupCrmContext(
  crmDir: string,
  externalEmails: string[],
  opts?: { maxInteractions?: number },
): CrmContext {
  const maxInteractions = opts?.maxInteractions ?? 10;
  const wanted = new Set(externalEmails.map(e => e.trim().toLowerCase()).filter(e => e.length > 0));

  // --- contacts.json: { contacts: [...] } or bare array ---
  const matches: CrmMatch[] = [];
  const matchedIds = new Set<string>();
  const contactsRaw = readJsonFile(join(crmDir, 'contacts.json'));
  const contactList: unknown[] = Array.isArray(contactsRaw)
    ? contactsRaw
    : isRecord(contactsRaw) && Array.isArray(contactsRaw.contacts)
      ? contactsRaw.contacts
      : [];
  for (const entry of contactList) {
    if (!isRecord(entry)) continue;
    const contactId = asString(entry.id);
    if (!contactId) continue;
    const emails = asStringArray(entry.emails);
    const matched = emails.find(e => wanted.has(e.trim().toLowerCase()));
    if (!matched) continue;
    matchedIds.add(contactId);
    const match: CrmMatch = {
      contactId,
      name: asString(entry.name) ?? contactId,
      email: matched,
    };
    const company = asString(entry.company);
    if (company) match.company = company;
    const category = asString(entry.category);
    if (category) match.category = category;
    matches.push(match);
  }

  // --- pipeline.json: { engagements: [...] } ---
  const engagements: CrmEngagement[] = [];
  const pipelineRaw = readJsonFile(join(crmDir, 'pipeline.json'));
  const engagementList: unknown[] = isRecord(pipelineRaw) && Array.isArray(pipelineRaw.engagements)
    ? pipelineRaw.engagements
    : [];
  for (const entry of engagementList) {
    if (!isRecord(entry)) continue;
    const contactIds = asStringArray(entry.contact_ids);
    if (!contactIds.some(id => matchedIds.has(id))) continue;
    const engagement: CrmEngagement = {
      clientOrg: asString(entry.client_org) ?? '',
      stage: asString(entry.stage) ?? '',
      openCommitments: isRecord(entry._open_commitments) ? asStringArray(entry._open_commitments.josh) : [],
    };
    const lastSignalAt = asString(entry.last_signal_at);
    if (lastSignalAt) engagement.lastSignalAt = lastSignalAt;
    engagements.push(engagement);
  }

  // --- interactions.jsonl: one JSON object per line ---
  const recentInteractions: CrmInteraction[] = [];
  let jsonl: string | undefined;
  try {
    jsonl = readFileSync(join(crmDir, 'interactions.jsonl'), 'utf-8');
  } catch {
    jsonl = undefined;
  }
  if (jsonl) {
    for (const line of jsonl.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // malformed line — skip
      }
      if (!isRecord(entry)) continue;
      const contactId = asString(entry.contact_id);
      if (!contactId || !matchedIds.has(contactId)) continue;
      recentInteractions.push({
        ts: asString(entry.ts) ?? '',
        contactId,
        type: asString(entry.type) ?? '',
        summary: asString(entry.summary) ?? '',
      });
    }
    recentInteractions.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    recentInteractions.splice(maxInteractions);
  }

  return { matches, engagements, recentInteractions };
}

// ---------------------------------------------------------------------------
// Markdown renderer — the brief must NEVER omit a section
// ---------------------------------------------------------------------------

const PLACEHOLDER = '_None on file._';

function text(value: string): string {
  return value.trim().length > 0 ? value.trim() : PLACEHOLDER;
}

function bullets(items: string[]): string {
  const kept = items.map(i => i.trim()).filter(i => i.length > 0);
  if (kept.length === 0) return PLACEHOLDER;
  return kept.map(i => `- ${i}`).join('\n');
}

function renderCrmSection(crm: CrmContext | null): string {
  if (crm === null) return '_No CRM record found._';
  const lines: string[] = [];

  if (crm.engagements.length > 0) {
    lines.push('**Engagements:**');
    for (const e of crm.engagements) {
      const signal = e.lastSignalAt ? ` (last signal: ${e.lastSignalAt})` : '';
      lines.push(`- ${e.clientOrg || PLACEHOLDER} — stage: ${e.stage || PLACEHOLDER}${signal}`);
    }
    lines.push('');
    lines.push('**Open Commitments:**');
    const commitments = crm.engagements.flatMap(e => e.openCommitments);
    lines.push(bullets(commitments));
  } else {
    lines.push('**Engagements:**');
    lines.push(PLACEHOLDER);
    lines.push('');
    lines.push('**Open Commitments:**');
    lines.push(PLACEHOLDER);
  }

  lines.push('');
  lines.push('**Recent Interactions:**');
  if (crm.recentInteractions.length > 0) {
    for (const i of crm.recentInteractions) {
      lines.push(`- ${i.ts} [${i.type}] ${i.summary}`);
    }
  } else {
    lines.push(PLACEHOLDER);
  }

  return lines.join('\n');
}

/**
 * Render the full pre-meeting brief. Emits exactly these H2 sections, in
 * order, regardless of how much data is available: Agenda, Executive Summary,
 * Engagement Strategy, Talking Points, Questions to Ask, Anticipated
 * Questions, Key Sensitivities, Action Items, Meeting Details & Participants,
 * CRM Record, Research Profile.
 */
export function renderBriefMarkdown(data: BriefData): string {
  const m = data.meeting;
  const when = m.endIso ? `${m.startIso} → ${m.endIso}` : m.startIso;
  const who = [...m.externalAttendees, ...m.internalAttendees];

  const parts: string[] = [
    `# Pre-Meeting Brief — ${m.title || PLACEHOLDER}`,
    '',
    `**When:** ${when}`,
    `**Where:** ${m.location ?? PLACEHOLDER}`,
    `**Who:** ${who.length > 0 ? who.join(', ') : PLACEHOLDER}`,
    '',
    '## Agenda',
    text(data.agenda),
    '',
    '## Executive Summary',
    text(data.executiveSummary),
    '',
    '## Engagement Strategy',
    '### Opener',
    text(data.engagementStrategy.opener),
    '### Mission Alignment',
    text(data.engagementStrategy.missionAlignment),
    '### Suggested Ask',
    text(data.engagementStrategy.suggestedAsk),
    '',
    '## Talking Points',
    bullets(data.talkingPoints),
    '',
    '## Questions to Ask',
    bullets(data.questionsToAsk),
    '',
    '## Anticipated Questions',
    bullets(data.anticipatedQuestions),
    '',
    '## Key Sensitivities',
    bullets(data.keySensitivities),
    '',
    '## Action Items',
    bullets(data.actionItems),
    '',
    '## Meeting Details & Participants',
    `**Event ID:** ${m.eventId}`,
    `**External attendees:**\n${bullets(m.externalAttendees)}`,
    `**Internal attendees:**\n${bullets(m.internalAttendees)}`,
    '',
    '## CRM Record',
    renderCrmSection(data.crm),
    '',
    '## Research Profile',
    text(data.researchProfile),
    '### Prior Intelligence',
    text(data.priorIntelligence),
  ];

  return parts.join('\n') + '\n';
}
