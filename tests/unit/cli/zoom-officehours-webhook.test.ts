import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, createHash } from 'crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { type AddressInfo } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBridgeServer } from '../../../src/cli/webhook-bridge';
import {
  buildCrcResponse,
  verifyZoomSignature,
  normPersonName,
  slugifyContactId,
  detectJunkName,
  classifyRegistrant,
  processRegistrant,
  ZOOM_TIMESTAMP_SKEW_SECONDS,
  type ContactRecord,
} from '../../../src/cli/zoom-officehours-crm';

const SECRET = 'zoom-test-secret';
const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const MEETING = '84893116740';

interface ResponseShape {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: Record<string, unknown> | null;
}

let tempRoot = '';
let crmDir = '';
let contactsPath = '';
let stateDir = '';
let suppressionPath = '';

function setupRegistry(root: string, agentName: string): void {
  const agentDir = join(root, 'orgs', 'clearworksai', 'agents', agentName);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'IDENTITY.md'), `# ${agentName}\n`, 'utf-8');
}

async function listen(server: ReturnType<typeof createBridgeServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://${address.address}:${address.port}`;
}

async function sendRequest(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<ResponseShape> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json: Record<string, unknown> | null = null;
        try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function buildZoomServer(opts: {
  secret?: string;
  mailchimpApiKey?: string;
  fetchImpl?: typeof fetch;
  contactsPath?: string;
} = {}) {
  return createBridgeServer({
    instanceId: 'test-instance',
    ctxRoot: tempRoot,
    frameworkRoot: tempRoot,
    org: 'clearworksai',
    bridgeSecret: 'top-secret',
    zoomWebhookSecretToken: 'secret' in opts ? opts.secret : SECRET,
    zoomContactsPath: opts.contactsPath ?? contactsPath,
    zoomStateDir: stateDir,
    mailchimpApiKey: opts.mailchimpApiKey,
    fetchImpl: opts.fetchImpl,
    now: () => NOW_MS,
  });
}

function signHeaders(rawBody: string, ts: number = NOW_S): Record<string, string> {
  const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${rawBody}`).digest('hex')}`;
  return { 'x-zm-signature': sig, 'x-zm-request-timestamp': String(ts), 'content-type': 'application/json' };
}

function registrationBody(registrant: Record<string, unknown>, meetingId: number | string = 84893116740, event = 'meeting.registration_created'): string {
  return JSON.stringify({
    event,
    event_ts: NOW_MS,
    payload: { account_id: 'acc-1', object: { id: meetingId, registrant } },
  });
}

function seedContacts(contacts: ContactRecord[]): void {
  writeFileSync(contactsPath, JSON.stringify({ version: '1.0.0', source: 'test', contacts }, null, 2) + '\n', 'utf-8');
}

function readContacts(): ContactRecord[] {
  return (JSON.parse(readFileSync(contactsPath, 'utf-8')) as { contacts: ContactRecord[] }).contacts;
}

function readStateLog(): Array<Record<string, unknown>> {
  const p = join(stateDir, 'zoom-officehours-webhook.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'zoom-webhook-'));
  setupRegistry(tempRoot, 'crm');
  setupRegistry(tempRoot, 'pa');
  crmDir = join(tempRoot, 'crm-data');
  mkdirSync(crmDir, { recursive: true });
  contactsPath = join(crmDir, 'contacts.json');
  stateDir = join(crmDir, 'state');
  suppressionPath = join(crmDir, '_ingest_suppression.json');
  seedContacts([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempRoot, { recursive: true, force: true });
});

// ── Server-level tests (items 1-17) ─────────────────────────────────────────

describe('zoom-officehours webhook — CRC + signature', () => {
  it('1. answers a signed CRC handshake with hex HMAC of plainToken', async () => {
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'abc123token' } });
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);
    expect(res.json?.plainToken).toBe('abc123token');
    expect(res.json?.encryptedToken).toBe(createHmac('sha256', SECRET).update('abc123token').digest('hex'));
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('2. rejects an unsigned CRC (401 anti-oracle) and an oversized plainToken (400)', async () => {
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'x' } });
    const unsigned = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(unsigned.status).toBe(401);
    expect(unsigned.json?.tier).toBe('auth');

    const bigToken = 'z'.repeat(513);
    const bigBody = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: bigToken } });
    const oversized = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(bigBody), body: bigBody });
    expect(oversized.status).toBe(400);
    expect(oversized.json).toMatchObject({ error: 'invalid_crc', tier: 'payload' });
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('3. accepts a valid signature + fresh timestamp on a registration payload', async () => {
    seedContacts([]);
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'new@example.com', first_name: 'New', last_name: 'Person' });
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);
    expect(res.json?.ok).toBe(true);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('4. signature reject matrix — all 401 auth, no mutation, no inbox', async () => {
    seedContacts([]);
    const before = readFileSync(contactsPath, 'utf-8');
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'a@example.com', first_name: 'A', last_name: 'B' });
    const good = signHeaders(body);

    const cases: Array<Record<string, string>> = [
      { 'x-zm-request-timestamp': String(NOW_S), 'content-type': 'application/json' }, // missing signature
      { ...good, 'x-zm-signature': 'v0=deadbeef' }, // wrong digest
      { 'x-zm-signature': good['x-zm-signature'] as string, 'content-type': 'application/json' }, // missing timestamp
      signHeaders(body, NOW_S - ZOOM_TIMESTAMP_SKEW_SECONDS - 1), // too old
      signHeaders(body, NOW_S + ZOOM_TIMESTAMP_SKEW_SECONDS + 1), // too future
    ];
    for (const headers of cases) {
      const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers, body });
      expect(res.status).toBe(401);
      expect(res.json?.tier).toBe('auth');
    }
    // tampered body: sign one body, send another
    const tampered = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      headers: signHeaders(registrationBody({ email: 'x@x.com', first_name: 'X', last_name: 'Y' })),
      body,
    });
    expect(tampered.status).toBe(401);

    expect(readFileSync(contactsPath, 'utf-8')).toBe(before);
    expect(existsSync(join(tempRoot, 'inbox', 'crm'))).toBe(false);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });
});

describe('zoom-officehours webhook — dispatch + tiers', () => {
  it('5. normalizes the full native Zoom shape (no integration/target fields)', async () => {
    seedContacts([]);
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'native@example.com', first_name: 'Native', last_name: 'Shape' });
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);
    expect(res.json?.tier).toBe('NEW');
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('6. ignores a registration for a different meeting id (200, no write)', async () => {
    seedContacts([]);
    const before = readFileSync(contactsPath, 'utf-8');
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'other@example.com', first_name: 'O', last_name: 'M' }, 99999999999);
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, ignored: true });
    expect(readFileSync(contactsPath, 'utf-8')).toBe(before);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('7. ignores a non-registration event (200, no write)', async () => {
    seedContacts([]);
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'x@example.com', first_name: 'X', last_name: 'Y' }, 84893116740, 'meeting.started');
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, ignored: true });
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('8. EMAIL tier merges tags/source_ref idempotently, never downgrading', async () => {
    seedContacts([{ id: 'marcos', name: 'Marcos Client', category: 'client', priority: 'high', emails: ['marcos@firm.com'], tags: ['existing'], source_refs: [] }]);
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'marcos@firm.com', first_name: 'Marcos', last_name: 'Client' });

    const res1 = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res1.status).toBe(200);
    expect(res1.json).toMatchObject({ ok: true, tier: 'EMAIL', contactId: 'marcos' });
    let c = readContacts()[0];
    expect(c.category).toBe('client'); // never downgraded
    expect(c.priority).toBe('high');
    expect(c.name).toBe('Marcos Client');
    expect(c.tags).toEqual(expect.arrayContaining(['existing', 'aia-office-hours', 'aia-registered']));
    expect(c.source_refs).toContain('zoom:officehours:84893116740');

    // redelivery: idempotent, no duplicate tags
    await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    c = readContacts()[0];
    expect(c.tags!.filter((t) => t === 'aia-registered')).toHaveLength(1);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('9. NAME tier normalizes suffix/diacritics and attaches the email', async () => {
    seedContacts([{ id: 'jose-smith', name: 'Jose Smith', category: 'prospect', priority: 'normal', emails: [], tags: [], source_refs: [] }]);
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'jose@design.com', first_name: 'José', last_name: 'Smith, AIA' });
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, tier: 'NAME', contactId: 'jose-smith' });
    const c = readContacts()[0];
    expect(c.emails).toContain('jose@design.com');
    expect(c.tags).toEqual(expect.arrayContaining(['aia-office-hours', 'aia-registered']));
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('10. AMBIG relays a review message to crm and writes nothing', async () => {
    seedContacts([
      { id: 'jane-1', name: 'Jane Doe', category: 'prospect', priority: 'normal', emails: ['jane1@a.com'], tags: [], source_refs: [] },
      { id: 'jane-2', name: 'Jane Doe', category: 'prospect', priority: 'normal', emails: ['jane2@b.com'], tags: [], source_refs: [] },
    ]);
    const before = readFileSync(contactsPath, 'utf-8');
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'jane-new@c.com', first_name: 'Jane', last_name: 'Doe' });
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);
    expect(res.json?.tier).toBe('AMBIG');
    expect(readFileSync(contactsPath, 'utf-8')).toBe(before);

    const inboxDir = join(tempRoot, 'inbox', 'crm');
    const files = readdirSync(inboxDir);
    expect(files).toHaveLength(1);
    const payload = JSON.parse(readFileSync(join(inboxDir, files[0]), 'utf-8')) as { text: string };
    expect(payload.text).toContain('AMBIG');
    expect(payload.text).toContain('jane-1');
    expect(payload.text).toContain('jane-2');
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('11. NEW creates a contact with the full default field shape', async () => {
    seedContacts([]);
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'fresh@lead.com', first_name: 'Fresh', last_name: 'Lead' });
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, tier: 'NEW', contactId: 'fresh-lead' });
    const c = readContacts().find((x) => x.id === 'fresh-lead')!;
    expect(c.category).toBe('prospect');
    expect(c.priority).toBe('normal');
    expect(c.emails).toContain('fresh@lead.com');
    expect(c.source_refs).toContain('zoom:officehours:84893116740');
    expect(Object.keys(c).sort()).toEqual([
      'aliases', 'category', 'company', 'context', 'emails', 'followup_cadence_days', 'handles', 'id',
      'important_dates', 'industry', 'last_meaningful_contact', 'location', 'name', 'notes', 'phones',
      'preferences', 'priority', 'relationship_strength', 'role', 'source_refs', 'tags', 'type',
    ]);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('12. NOISE (fireflies notetaker) is not written', async () => {
    seedContacts([]);
    const before = readFileSync(contactsPath, 'utf-8');
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    for (const reg of [
      { email: 'fred@fireflies.ai', first_name: 'Fred', last_name: 'Bot' },
      { email: 'nb@x.com', first_name: 'Fireflies', last_name: 'Notetaker' },
    ]) {
      const body = registrationBody(reg);
      const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
      expect(res.status).toBe(200);
      expect(res.json?.tier).toBe('NOISE');
    }
    expect(readFileSync(contactsPath, 'utf-8')).toBe(before);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('13. SUPPRESSED (blocked domain) is not written', async () => {
    seedContacts([]);
    writeFileSync(suppressionPath, JSON.stringify({ domains: ['blocked.com'] }), 'utf-8');
    const before = readFileSync(contactsPath, 'utf-8');
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'someone@blocked.com', first_name: 'Blk', last_name: 'Domain' });
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);
    expect(res.json?.tier).toBe('SUPPRESSED');
    expect(readFileSync(contactsPath, 'utf-8')).toBe(before);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('14. Mailchimp mirror: POST tags happy path, 404→PUT create, and skipped_no_key', async () => {
    seedContacts([]);
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method), body: String(init?.body) });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const server = buildZoomServer({ mailchimpApiKey: 'key-us21', fetchImpl });
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'MC@Lead.com', first_name: 'Mc', last_name: 'Lead' });
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const hash = createHash('md5').update('mc@lead.com').digest('hex');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`https://us21.api.mailchimp.com/3.0/lists/6e5ba0b9c3/members/${hash}/tags`);
    await vi.waitFor(() => expect(readStateLog().some((e) => e.type === 'mailchimp' && e.outcome === 'tagged')).toBe(true));
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

    // 404 → PUT create path
    seedContacts([]);
    const calls2: Array<{ url: string; method: string }> = [];
    const fetch404 = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls2.push({ url: String(url), method: String(init?.method) });
      return calls2.length === 1 ? ({ ok: false, status: 404 } as Response) : ({ ok: true, status: 200 } as Response);
    }) as unknown as typeof fetch;
    const server2 = buildZoomServer({ mailchimpApiKey: 'key-us21', fetchImpl: fetch404 });
    const baseUrl2 = await listen(server2);
    const body2 = registrationBody({ email: 'put@lead.com', first_name: 'Put', last_name: 'Lead' });
    await sendRequest(baseUrl2, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body2), body: body2 });
    await vi.waitFor(() => expect(calls2.length).toBe(2));
    expect(calls2[1].method).toBe('PUT');
    await vi.waitFor(() => expect(readStateLog().some((e) => e.type === 'mailchimp' && e.outcome === 'created')).toBe(true));
    await new Promise<void>((resolve, reject) => server2.close((e) => (e ? reject(e) : resolve())));

    // no key → no fetch, skipped_no_key state-log
    seedContacts([]);
    const noKeyFetch = vi.fn() as unknown as typeof fetch;
    const server3 = buildZoomServer({ fetchImpl: noKeyFetch });
    const baseUrl3 = await listen(server3);
    const body3 = registrationBody({ email: 'nokey@lead.com', first_name: 'No', last_name: 'Key' });
    await sendRequest(baseUrl3, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body3), body: body3 });
    await vi.waitFor(() => expect(readStateLog().some((e) => e.type === 'mailchimp' && e.outcome === 'skipped_no_key')).toBe(true));
    expect(noKeyFetch).not.toHaveBeenCalled();
    await new Promise<void>((resolve, reject) => server3.close((e) => (e ? reject(e) : resolve())));
  });

  it('15. crm unavailable (missing contacts.json) → 500 crm_unavailable', async () => {
    const server = buildZoomServer({ contactsPath: join(crmDir, 'does-not-exist.json') });
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'x@y.com', first_name: 'X', last_name: 'Y' });
    const res = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ error: 'crm_unavailable', tier: 'crm' });
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('16. state log appends exactly one processed line with tier+email, never the secret', async () => {
    seedContacts([]);
    const server = buildZoomServer();
    const baseUrl = await listen(server);
    const body = registrationBody({ email: 'log@lead.com', first_name: 'Log', last_name: 'Lead' });
    await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(body), body });
    const processed = readStateLog().filter((e) => e.type === 'processed');
    expect(processed).toHaveLength(1);
    expect(processed[0]).toMatchObject({ tier: 'NEW', email: 'log@lead.com' });
    const raw = readFileSync(join(stateDir, 'zoom-officehours-webhook.jsonl'), 'utf-8');
    expect(raw).not.toContain(SECRET);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('17. dormant mode (no zoom secret) keeps v1 shared-secret behavior; a zoom-signed native POST is 401', async () => {
    const dormant = createBridgeServer({
      instanceId: 'test-instance',
      ctxRoot: tempRoot,
      frameworkRoot: tempRoot,
      org: 'clearworksai',
      bridgeSecret: 'top-secret',
      now: () => NOW_MS,
    });
    const baseUrl = await listen(dormant);

    // v1 internal-envelope relay still works with the shared secret
    const relayBody = JSON.stringify({ integration: 'zoom-officehours', target: 'crm', event: 'lead.registered', meeting_id: MEETING });
    const relay = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'top-secret', 'content-type': 'application/json' },
      body: relayBody,
    });
    expect(relay.status).toBe(200);
    expect(relay.json?.ok).toBe(true);
    const inbox = readdirSync(join(tempRoot, 'inbox', 'crm'));
    expect(inbox.length).toBe(1);

    // a Zoom-signed native POST (no shared-secret header) is rejected 401
    const nativeBody = registrationBody({ email: 'x@y.com', first_name: 'X', last_name: 'Y' });
    const native = await sendRequest(baseUrl, '/relay/zoom-officehours', { method: 'POST', headers: signHeaders(nativeBody), body: nativeBody });
    expect(native.status).toBe(401);
    await new Promise<void>((resolve, reject) => dormant.close((e) => (e ? reject(e) : resolve())));
  });
});

// ── Pure-function unit tests (item 18) ──────────────────────────────────────

describe('zoom-officehours-crm pure functions', () => {
  it('buildCrcResponse computes the documented vector', () => {
    const out = buildCrcResponse('tok', SECRET);
    expect(out.plainToken).toBe('tok');
    expect(out.encryptedToken).toBe(createHmac('sha256', SECRET).update('tok').digest('hex'));
  });

  it('verifyZoomSignature reason table', () => {
    const rawBody = '{"a":1}';
    const good = `v0=${createHmac('sha256', SECRET).update(`v0:${NOW_S}:${rawBody}`).digest('hex')}`;
    expect(verifyZoomSignature({ rawBody, signatureHeader: good, timestampHeader: String(NOW_S), secret: SECRET, nowSeconds: NOW_S })).toEqual({ ok: true });
    expect(verifyZoomSignature({ rawBody, signatureHeader: undefined, timestampHeader: String(NOW_S), secret: SECRET, nowSeconds: NOW_S })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verifyZoomSignature({ rawBody, signatureHeader: good, timestampHeader: undefined, secret: SECRET, nowSeconds: NOW_S })).toEqual({ ok: false, reason: 'missing_timestamp' });
    expect(verifyZoomSignature({ rawBody, signatureHeader: good, timestampHeader: String(NOW_S - 301), secret: SECRET, nowSeconds: NOW_S })).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyZoomSignature({ rawBody, signatureHeader: 'v0=bad', timestampHeader: String(NOW_S), secret: SECRET, nowSeconds: NOW_S })).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('normPersonName strips suffixes, accents, punctuation', () => {
    expect(normPersonName('José Smith, AIA')).toBe('jose smith');
    expect(normPersonName('John Doe III')).toBe('john doe');
    expect(normPersonName('  Anne-Marie  Dupont, PE ')).toBe('anne-marie dupont');
  });

  it('slugifyContactId lowercases + hyphenates with fallback', () => {
    expect(slugifyContactId('Fresh Lead')).toBe('fresh-lead');
    expect(slugifyContactId('  A & B  ')).toBe('a-b');
    expect(slugifyContactId('!!!')).toBe('contact');
  });

  it('detectJunkName returns the reason', () => {
    expect(detectJunkName('')).toEqual({ junk: true, reason: 'empty' });
    expect(detectJunkName('admin team')).toEqual({ junk: true, reason: 'admin-prefix' });
    expect(detectJunkName('no-reply')).toEqual({ junk: true, reason: 'noreply-prefix' });
    expect(detectJunkName('Real Person')).toEqual({ junk: false, reason: null });
  });

  it('classifyRegistrant tier table', () => {
    const contacts: ContactRecord[] = [
      { id: 'a', name: 'Alice Smith', emails: ['alice@x.com'], aliases: [], tags: [], source_refs: [] },
      { id: 'b', name: 'Bob Jones', emails: ['bob@x.com'], aliases: [], tags: [], source_refs: [] },
      { id: 'c1', name: 'Same Name', emails: [], aliases: [], tags: [], source_refs: [] },
      { id: 'c2', name: 'Same Name', emails: [], aliases: [], tags: [], source_refs: [] },
    ];
    expect(classifyRegistrant({ email: 'alice@x.com', name: '', firstName: 'Alice', lastName: 'Smith' }, contacts).tier).toBe('EMAIL');
    expect(classifyRegistrant({ email: 'none@x.com', name: '', firstName: 'Bob', lastName: 'Jones' }, contacts).tier).toBe('NAME');
    expect(classifyRegistrant({ email: 'x@x.com', name: '', firstName: 'Same', lastName: 'Name' }, contacts).tier).toBe('AMBIG');
    expect(classifyRegistrant({ email: 'x@x.com', name: '', firstName: 'Totally', lastName: 'Unknown' }, contacts).tier).toBe('NEW');
    expect(classifyRegistrant({ email: 'fred@fireflies.ai', name: '', firstName: 'Fred', lastName: 'Bot' }, contacts).tier).toBe('NOISE');
  });

  it('processRegistrant NEW then EMAIL redelivery merges idempotently', () => {
    processRegistrant({ contactsPath, suppressionPath, registrant: { email: 'p@q.com', name: '', firstName: 'Pat', lastName: 'Quinn' } });
    const first = readContacts().find((c) => c.id === 'pat-quinn')!;
    expect(first.tags).toEqual(['aia-office-hours', 'aia-registered']);
    const r2 = processRegistrant({ contactsPath, suppressionPath, registrant: { email: 'p@q.com', name: '', firstName: 'Pat', lastName: 'Quinn' } });
    expect(r2.tier).toBe('EMAIL');
    const second = readContacts().find((c) => c.id === 'pat-quinn')!;
    expect(second.tags).toEqual(['aia-office-hours', 'aia-registered']);
  });
});
