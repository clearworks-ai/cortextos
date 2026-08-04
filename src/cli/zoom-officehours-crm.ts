// Zoom Office Hours webhook CRM logic — pure functions, no server wiring, no
// process.env reads, no top-level I/O. All FS paths are passed in.
//
// This is an in-process TypeScript port of the v1 Python pipeline (per master-plan
// decision D1/D8 — the Python file is gitignored/untracked and cannot be shared).
// Every duplicated constant and helper cross-references its source:
//   orgs/clearworksai/agents/crm/crm/zoom-officehours-sync.py
//   orgs/clearworksai/agents/crm/crm/upsert-contact.py
// ZERO changes to those Python files; they remain the reference implementation.

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { atomicWriteSync } from '../utils/atomic.js';

// ── Constants (duplicated from Python, per D8) ──────────────────────────────
// zoom-officehours-sync.py:38-39
export const ZOOM_OFFICEHOURS_MEETING_ID = '84893116740';
export const ZOOM_OFFICEHOURS_TAG = 'aia-office-hours';
export const ZOOM_MAILCHIMP_LIST_ID = '6e5ba0b9c3';
// master-plan D3 — Zoom's documented 5-minute replay window.
export const ZOOM_TIMESTAMP_SKEW_SECONDS = 300;

// zoom-officehours-sync.py:42,45-46
const SUFFIXES = new Set(['iii', 'ii', 'iv', 'jr', 'sr', 'pe', 'aia', 'leed', 'ncarb', 'ra', 'assoc']);
const NOISE_EMAILS = new Set(['fred@fireflies.ai']);
const NOISE_NAME_RE = /notetaker|fireflies/i;
const ZOOM_SOURCE_REF = `zoom:officehours:${ZOOM_OFFICEHOURS_MEETING_ID}`;
// Always registration-only in the webhook path (master-plan D5): never aia-attended,
// never a cohort tag — attendance/cohort come from the batch recon cron.
const ZOOM_REGISTRATION_TAGS = [ZOOM_OFFICEHOURS_TAG, 'aia-registered'];

// upsert-contact.py:57-65
const JUNK_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/^admin\b/, 'admin-prefix'],
  [/^(no[\s-]?reply|do[\s-]?not[\s-]?reply)\b/, 'noreply-prefix'],
  [/^(mailer-daemon|postmaster)$/, 'bounceback'],
  [/^(notifications?|notification)\b/, 'notifications-prefix'],
  [/\bdigest$/, 'digest-suffix'],
  [/\breminder$/, 'reminder-suffix'],
  [/^@/, 'email-as-name'],
];

export interface ContactRecord {
  id: string;
  name?: string;
  emails?: string[];
  aliases?: string[];
  tags?: string[];
  source_refs?: string[];
  [key: string]: unknown;
}

export interface ZoomRegistrant {
  email: string;
  name: string;
  firstName: string;
  lastName: string;
}

// ── CRC handshake (scope item 1) ────────────────────────────────────────────
export function buildCrcResponse(plainToken: string, secret: string): { plainToken: string; encryptedToken: string } {
  const encryptedToken = createHmac('sha256', secret).update(plainToken).digest('hex');
  return { plainToken, encryptedToken };
}

// ── Signature verification (scope item 2) ───────────────────────────────────
// message = `v0:${timestamp}:${rawBody}`; expected header = `v0=${hexDigest}`.
// Length-safe compare via sha256 of both sides then timingSafeEqual (same trick as
// hmacSignatureMatches in webhook-bridge.ts, but a distinct prefix/message format).
function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function verifyZoomSignature(args: {
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secret: string;
  nowSeconds: number;
}): { ok: true } | { ok: false; reason: string } {
  const { rawBody, signatureHeader, timestampHeader, secret, nowSeconds } = args;
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!timestampHeader) return { ok: false, reason: 'missing_timestamp' };

  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > ZOOM_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestampHeader}:${rawBody}`).digest('hex')}`;
  if (!timingSafeEqual(sha256(signatureHeader), sha256(expected))) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

// ── Ported name/id helpers ──────────────────────────────────────────────────
// _norm (sync.py:49-52 / upsert-contact.py:20-23): NFKD, drop combining marks, trim, lower.
function stripAccentsLower(value: string): string {
  return (value || '').normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

// norm_name (sync.py:55-60)
export function normPersonName(name: string): string {
  const n = stripAccentsLower(name).replace(/[.,]/g, ' ');
  return n.split(/\s+/).filter((t) => t && !SUFFIXES.has(t)).join(' ');
}

// slugify (upsert-contact.py:78-80)
export function slugifyContactId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'contact';
}

// detect_junk_name (upsert-contact.py:68-75)
export function detectJunkName(name: string): { junk: boolean; reason: string | null } {
  const n = (name || '').trim().toLowerCase();
  if (!n) return { junk: true, reason: 'empty' };
  for (const [pattern, reason] of JUNK_NAME_PATTERNS) {
    if (pattern.test(n)) return { junk: true, reason };
  }
  return { junk: false, reason: null };
}

// ── classify (sync.py:118-158) ──────────────────────────────────────────────
export function classifyRegistrant(reg: ZoomRegistrant, contacts: ContactRecord[]):
  | { tier: 'NOISE' }
  | { tier: 'EMAIL' | 'NAME'; match: ContactRecord }
  | { tier: 'AMBIG'; candidates: ContactRecord[] }
  | { tier: 'NEW' } {
  const email = (reg.email || '').trim().toLowerCase();
  const name = `${reg.firstName || ''} ${reg.lastName || ''}`.trim();

  if (NOISE_EMAILS.has(email) || NOISE_NAME_RE.test(name)) {
    return { tier: 'NOISE' };
  }

  // build_indexes (sync.py:118-130)
  const byEmail = new Map<string, ContactRecord>();
  const byName = new Map<string, ContactRecord[]>();
  for (const contact of contacts) {
    for (const e of contact.emails ?? []) {
      if (typeof e === 'string') byEmail.set(e.trim().toLowerCase(), contact);
    }
    const nn = normPersonName(contact.name ?? '');
    if (nn) (byName.get(nn) ?? byName.set(nn, []).get(nn)!).push(contact);
    for (const alias of contact.aliases ?? []) {
      if (typeof alias !== 'string') continue;
      const an = normPersonName(alias);
      if (an) (byName.get(an) ?? byName.set(an, []).get(an)!).push(contact);
    }
  }

  const hit = byEmail.get(email);
  if (hit) return { tier: 'EMAIL', match: hit };

  const cands = byName.get(normPersonName(name)) ?? [];
  const uniq = new Map<string, ContactRecord>();
  for (const c of cands) uniq.set(c.id, c);
  if (uniq.size === 1) return { tier: 'NAME', match: [...uniq.values()][0] };
  if (uniq.size > 1) return { tier: 'AMBIG', candidates: [...uniq.values()] };
  return { tier: 'NEW' };
}

// ── Suppression (upsert-contact.py:30-54) ───────────────────────────────────
function loadSuppression(suppressionPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(suppressionPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null; // missing or unreadable → not suppressed
  }
}

function checkSuppressed(
  suppressionPath: string,
  contactId: string,
  name: string,
  emails: string[],
): string | null {
  const sup = loadSuppression(suppressionPath);
  if (!sup) return null;
  const contactIds = Array.isArray(sup.contact_ids) ? (sup.contact_ids as string[]) : [];
  if (contactId && contactIds.includes(contactId)) return `contact_id:${contactId}`;
  const nname = stripAccentsLower(name);
  const supNames = new Set((Array.isArray(sup.names) ? (sup.names as string[]) : []).map(stripAccentsLower));
  if (nname && supNames.has(nname)) return `name:${name}`;
  const blockDomains = new Set(
    (Array.isArray(sup.domains) ? (sup.domains as string[]) : []).map((d) => d.toLowerCase().replace(/^@/, '')),
  );
  for (const email of emails) {
    const dom = (email || '').split('@').pop()?.trim().toLowerCase() ?? '';
    if (dom && blockDomains.has(dom)) return `domain:${dom}`;
  }
  return null;
}

// ── merge_unique (sync.py:244-249 / upsert-contact.py:114-121) ──────────────
function mergeUnique(existing: string[], additions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...existing, ...additions]) {
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

// Recursively key-sorted, 2-space, ensure_ascii serialization to byte-match
// Python json.dump(indent=2, sort_keys=True) + trailing newline (master-plan D9).
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function pythonJsonDump(value: unknown): string {
  const json = JSON.stringify(sortKeysDeep(value), null, 2);
  // Python's default ensure_ascii=True escapes every non-ASCII code unit.
  return json.replace(/[-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}

// Full NEW-contact default shape (upsert-contact.py:172-195).
function newContactDefaults(id: string): ContactRecord {
  return {
    id,
    type: 'person',
    name: '',
    category: 'other',
    priority: 'normal',
    relationship_strength: null,
    tags: [],
    aliases: [],
    emails: [],
    phones: [],
    handles: {},
    company: null,
    industry: null,
    role: null,
    location: null,
    context: '',
    preferences: {},
    important_dates: [],
    last_meaningful_contact: null,
    followup_cadence_days: null,
    notes: '',
    source_refs: [],
  };
}

export interface ProcessResult {
  tier: 'NOISE' | 'EMAIL' | 'NAME' | 'AMBIG' | 'NEW' | 'SUPPRESSED';
  contactId?: string;
  candidateIds?: string[];
  tags: string[];
  mailchimpEligible: boolean;
  registrant: ZoomRegistrant;
}

/**
 * Full single-registrant pipeline against contacts.json on disk: classify + write.
 * No Mailchimp, no bus, no HTTP. Throws only on contacts.json read/parse failure
 * (caller maps to 500 so Zoom retries). Append-only merge semantics, never
 * downgrading an existing contact (sync.py commit block: "Marcos is a client").
 */
export function processRegistrant(args: {
  contactsPath: string;
  suppressionPath: string;
  registrant: ZoomRegistrant;
}): ProcessResult {
  const { contactsPath, suppressionPath } = args;
  const email = (args.registrant.email || '').trim().toLowerCase();
  const name = `${args.registrant.firstName || ''} ${args.registrant.lastName || ''}`.trim();
  const registrant: ZoomRegistrant = { ...args.registrant, email, name };

  // Read/parse failure THROWS (caller → 500).
  const data = JSON.parse(readFileSync(contactsPath, 'utf-8')) as { contacts?: ContactRecord[] };
  const contacts: ContactRecord[] = Array.isArray(data.contacts) ? data.contacts : [];

  const classification = classifyRegistrant(args.registrant, contacts);

  if (classification.tier === 'NOISE') {
    return { tier: 'NOISE', tags: [], mailchimpEligible: false, registrant };
  }
  if (classification.tier === 'AMBIG') {
    return {
      tier: 'AMBIG',
      candidateIds: classification.candidates.map((c) => c.id),
      tags: [],
      mailchimpEligible: false,
      registrant,
    };
  }

  // Target id for suppression + write.
  const targetId = classification.tier === 'NEW' ? slugifyContactId(name) : classification.match.id;
  const blocked = checkSuppressed(suppressionPath, targetId, name, email ? [email] : []);
  if (blocked) {
    return { tier: 'SUPPRESSED', tags: [], mailchimpEligible: false, registrant };
  }

  const applyMerge = (contact: ContactRecord, tags: string[]): void => {
    contact.tags = mergeUnique(contact.tags ?? [], tags);
    if (email) contact.emails = mergeUnique(contact.emails ?? [], [email]);
    contact.source_refs = mergeUnique(contact.source_refs ?? [], [ZOOM_SOURCE_REF]);
  };

  let contactId: string;
  const tags = [...ZOOM_REGISTRATION_TAGS];

  if (classification.tier === 'EMAIL' || classification.tier === 'NAME') {
    // Merge into the matched contact; NEVER touch category/priority/name/company.
    const target = contacts.find((c) => c.id === classification.match.id) ?? classification.match;
    applyMerge(target, tags);
    contactId = target.id;
  } else {
    // NEW: upsert-by-slug (mirrors v1's shell-out to upsert-contact.py).
    const junk = detectJunkName(name);
    const existing = contacts.find((c) => c.id === targetId);
    if (existing) {
      // Existing id → merge only (append-only), don't rewrite scalar fields.
      applyMerge(existing, junk.junk ? [...tags, 'auto-flagged:junk-name', `junk-name-reason:${junk.reason}`] : tags);
      contactId = existing.id;
    } else {
      const contact = newContactDefaults(targetId);
      contact.name = name;
      if (junk.junk) {
        contact.category = 'other';
        contact.priority = 'low';
        tags.push('auto-flagged:junk-name', `junk-name-reason:${junk.reason}`);
      } else {
        contact.category = 'prospect';
        contact.priority = 'normal';
      }
      applyMerge(contact, tags);
      contacts.push(contact);
      contactId = contact.id;
    }
  }

  data.contacts = contacts;
  atomicWriteSync(contactsPath, pythonJsonDump(data));

  return {
    tier: classification.tier,
    contactId,
    tags,
    mailchimpEligible: !!email,
    registrant,
  };
}

// ── Mailchimp mirror (sync.py:281-334, single-candidate form) ───────────────
export async function mirrorToMailchimp(args: {
  apiKey: string;
  listId: string;
  email: string;
  tags: string[];
  fetchImpl: typeof fetch;
}): Promise<{ outcome: 'tagged' | 'created' | 'error'; detail?: string }> {
  const { apiKey, listId, email, tags, fetchImpl } = args;
  try {
    const dc = apiKey.slice(apiKey.lastIndexOf('-') + 1);
    const subscriberHash = createHash('md5').update(email.trim().toLowerCase()).digest('hex');
    const auth = `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`;
    const base = `https://${dc}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash}`;
    const headers = { Authorization: auth, 'Content-Type': 'application/json' };

    const tagRes = await fetchImpl(`${base}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags: tags.map((t) => ({ name: t, status: 'active' })) }),
    });
    if (tagRes.ok) return { outcome: 'tagged' };
    if (tagRes.status === 404) {
      const putRes = await fetchImpl(base, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ email_address: email, status_if_new: 'subscribed', status: 'subscribed', tags }),
      });
      if (putRes.ok) return { outcome: 'created' };
      return { outcome: 'error', detail: `put_status_${putRes.status}` };
    }
    return { outcome: 'error', detail: `post_status_${tagRes.status}` };
  } catch (err) {
    return { outcome: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}
