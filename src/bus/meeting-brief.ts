import { readFileSync, openSync, closeSync, writeSync, statSync, utimesSync, readdirSync, mkdirSync } from 'fs';
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
 * (date-only) events are skipped. When `claimedIds` is provided, events that
 * hold a live (non-expired) claim lease are excluded too — this is what stops
 * a second, overlapping cron fire from spawning a duplicate worker while the
 * first worker is still mid-flight (see claim-lease section below).
 */
export function selectUpcomingExternalMeetings(
  events: CalendarEventInput[],
  nowMs: number,
  opts: { minLeadMin: number; maxLeadMin: number },
  internalDomains: string[],
  surfacedIds: Set<string>,
  claimedIds?: Set<string>,
): MeetingCandidate[] {
  const windowStart = nowMs + opts.minLeadMin * 60_000;
  const windowEnd = nowMs + opts.maxLeadMin * 60_000;

  const candidates: MeetingCandidate[] = [];
  for (const event of events) {
    if (surfacedIds.has(event.id)) continue;
    if (claimedIds && claimedIds.has(event.id)) continue;
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
// Claim lease — short-TTL, cross-process-atomic dedup for in-flight briefs
//
// The surfaced-id file is marked LAST (only after a verified publish), which
// leaves a multi-minute window where an overlapping 15-min cron fire still
// sees the event as un-surfaced and spawns a SECOND worker -> duplicate brief.
//
// A plain read-modify-write on a shared JSON file is NOT enough here: two
// separate node processes (two cron fires) can both read "unclaimed" and both
// write. So the claim is a per-event LOCKFILE opened with O_CREAT|O_EXCL
// (openSync 'wx'), which is atomic across processes — exactly one caller wins.
// On EEXIST we inspect the lock's timestamp: if it is older than the TTL the
// previous holder crashed/hung, so we reclaim it; otherwise the event is
// actively claimed and the caller skips it.
//
// The TTL is deliberately SHORT (default 20 min — longer than the 15-min cron
// interval so overlapping fires collide, short enough that a failed publish is
// retried the same hour). This is why we do NOT reuse event-dedup.ts: its
// pruneLedger enforces a 30-day floor, which would permanently block retry.
// ---------------------------------------------------------------------------

export const DEFAULT_CLAIM_TTL_MS = 20 * 60 * 1000;

export interface ClaimResult {
  claimed: boolean;
  reason: 'won' | 'stale-reclaimed' | 'already-claimed';
}

/** Map an arbitrary event id to a filesystem-safe lockfile path. */
function claimLockPath(claimsDir: string, eventId: string): string {
  const hash = createHash('sha256').update(eventId).digest('hex').slice(0, 32);
  return join(claimsDir, `${hash}.lock`);
}

/** Age, in ms, of a claim lock. mtime is authoritative; fall back to content. */
function claimAgeMs(lockPath: string, nowMs: number): number | undefined {
  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
  let contentMs: number | undefined;
  try {
    const parsed = Number.parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    if (Number.isFinite(parsed)) contentMs = parsed;
  } catch {
    // ignore — mtime is enough
  }
  // Use whichever timestamp is more recent so a touched/rewritten lock is
  // never mistaken for stale.
  const claimedAt = Math.max(mtimeMs ?? 0, contentMs ?? 0);
  return nowMs - claimedAt;
}

/**
 * Atomically claim an event for processing. Returns `{ claimed: true }` for
 * exactly one caller per live lease; a concurrent second caller (no release in
 * between) gets `{ claimed: false, reason: 'already-claimed' }`. A lock older
 * than `ttlMs` is treated as expired and reclaimed (`stale-reclaimed`).
 *
 * Cross-process atomic: the winning write is an O_CREAT|O_EXCL open, so two
 * separate node processes racing on the same event id cannot both win.
 */
export function claimEventLease(
  claimsDir: string,
  eventId: string,
  opts?: { nowMs?: number; ttlMs?: number },
): ClaimResult {
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = opts?.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
  mkdirSync(claimsDir, { recursive: true });
  const lockPath = claimLockPath(claimsDir, eventId);

  // Fast path: atomic exclusive create. Winner writes its claim timestamp and
  // stamps mtime to match, so age checks stay consistent even when callers
  // pass a simulated `nowMs` that differs from wall-clock time.
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    try {
      writeSync(fd, String(nowMs));
    } finally {
      closeSync(fd);
    }
    utimesSync(lockPath, nowMs / 1000, nowMs / 1000);
    return { claimed: true, reason: 'won' };
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }

  // Lock exists — decide whether it is stale (reclaimable) or live.
  const ageMs = claimAgeMs(lockPath, nowMs);
  if (ageMs === undefined || ageMs > ttlMs) {
    // Stale (or vanished after our failed create). Reclaim by rewriting the
    // timestamp and stamping mtime to now. openSync 'r+' does not race with a
    // fresh EXCL create because the file already exists; the last writer wins,
    // which is acceptable for reclaim of an already-abandoned lease.
    try {
      const fd = openSync(lockPath, 'r+', 0o600);
      try {
        writeSync(fd, String(nowMs), 0);
      } finally {
        closeSync(fd);
      }
      utimesSync(lockPath, nowMs / 1000, nowMs / 1000);
      return { claimed: true, reason: 'stale-reclaimed' };
    } catch {
      // Someone else may have removed/reclaimed it in between; be conservative.
      return { claimed: false, reason: 'already-claimed' };
    }
  }

  return { claimed: false, reason: 'already-claimed' };
}

/**
 * Release a claim so the next cron fire can retry (used on publish/verify
 * failure). Idempotent — releasing a non-existent claim is a no-op.
 */
export function releaseEventLease(claimsDir: string, eventId: string): void {
  const lockPath = claimLockPath(claimsDir, eventId);
  try {
    const { unlinkSync } = require('fs') as typeof import('fs');
    unlinkSync(lockPath);
  } catch {
    // Already gone — nothing to release.
  }
}

/**
 * Read the set of event ids that currently hold a LIVE (non-expired) claim.
 * Because lockfile names are hashed event ids, this cannot recover the raw
 * ids; instead it returns the SET OF HASHES that are live. Pair it with
 * {@link liveClaimHashes}-aware filtering. For scan filtering we expose a
 * companion that tests a specific event id — see {@link readClaimedIds}.
 */
function liveClaimHashes(claimsDir: string, nowMs: number, ttlMs: number): Set<string> {
  const live = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(claimsDir);
  } catch {
    return live;
  }
  for (const name of entries) {
    if (!name.endsWith('.lock')) continue;
    const lockPath = join(claimsDir, name);
    const ageMs = claimAgeMs(lockPath, nowMs);
    if (ageMs !== undefined && ageMs <= ttlMs) {
      live.add(name.slice(0, -'.lock'.length));
    }
  }
  return live;
}

/**
 * Given the candidate event ids, return the subset that currently hold a live
 * claim. Used by the scan to exclude in-flight events (it hashes each candidate
 * id and checks it against the live lock set). Event ids that are not among
 * `candidateIds` are ignored.
 */
export function readClaimedIds(
  claimsDir: string,
  candidateIds: Iterable<string>,
  opts?: { nowMs?: number; ttlMs?: number },
): Set<string> {
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = opts?.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
  const liveHashes = liveClaimHashes(claimsDir, nowMs, ttlMs);
  const claimed = new Set<string>();
  if (liveHashes.size === 0) return claimed;
  for (const id of candidateIds) {
    const hash = createHash('sha256').update(id).digest('hex').slice(0, 32);
    if (liveHashes.has(hash)) claimed.add(id);
  }
  return claimed;
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
