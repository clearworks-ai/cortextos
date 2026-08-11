import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBridgeServer, type BridgeServerOptions } from '../../../src/cli/webhook-bridge';
import { handleProviderShadowIngress, readBoundedProviderBody, writeCalendarShadowChannel } from '../../../src/cli/provider-shadow-ingress';
import { getEventCursor } from '../../../src/bus/event-receipt-index';
import { readEventReceipts, recordIngressReceipt } from '../../../src/bus/event-delivery';

const now = Date.parse('2026-08-07T00:00:00.000Z');
const audience = 'https://bridge.example.com/relay/gmail-pubsub';
const serviceAccount = 'push@example.iam.gserviceaccount.com';
const subscription = 'projects/existing/subscriptions/gmail-shadow';
const token = 'opaque.jwt.value';
const claims = { iss: 'https://accounts.google.com', aud: audience, exp: now / 1000 + 300, iat: now / 1000 - 30, email: serviceAccount, email_verified: true };
let root = ''; let stateDir = '';

async function listen(options: Partial<BridgeServerOptions> = {}) {
  const server = createBridgeServer({ ctxRoot: root, frameworkRoot: root, org: 'clearworksai', bridgeSecret: 'bridge-secret', providerShadowStateDir: stateDir, now: () => now, gmailShadow: { audience, serviceAccount, subscription, verifyOidc: async () => claims }, calendarShadow: {}, ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as AddressInfo;
  return { server, base: `http://${address.address}:${address.port}` };
}
async function post(base: string, path: string, body = '', headers: Record<string, string | string[]> = {}) {
  return new Promise<{ status: number; text: string; json: Record<string, unknown> }>((resolve, reject) => { const request = httpRequest(new URL(path, base), { method: 'POST', headers }, (response) => { const chunks: Buffer[] = []; response.on('data', (chunk) => chunks.push(Buffer.from(chunk))); response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: response.statusCode ?? 0, text, json: JSON.parse(text) as Record<string, unknown> }); }); }); request.on('error', reject); request.end(body); });
}
const gmailBody = (historyId = '10', emailAddress = 'User@Example.com', extra?: Record<string, unknown>) => JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId, ...extra })).toString('base64'), messageId: 'telemetry-only' }, subscription });
const gmailHeaders = { authorization: `Bearer ${token}` };
const expiration = new Date(now + 60_000).toISOString();
const calendarHeaders = (overrides: Record<string, string | string[]> = {}) => ({ 'x-goog-channel-id': 'channel-secret', 'x-goog-resource-id': 'resource-secret', 'x-goog-resource-state': 'exists', 'x-goog-message-number': '10', 'x-goog-channel-expiration': expiration, 'x-goog-channel-token': 'channel-token-secret', ...overrides });
const close = (server: ReturnType<typeof createBridgeServer>) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'provider-shadow-')); stateDir = join(root, 'state', 'pa'); mkdirSync(join(root, 'orgs', 'clearworksai', 'agents', 'pa'), { recursive: true }); writeFileSync(join(root, 'orgs', 'clearworksai', 'agents', 'pa', 'IDENTITY.md'), '# PA'); writeCalendarShadowChannel(stateDir, { channelId: 'channel-secret', resourceId: 'resource-secret', channelToken: 'channel-token-secret', expiresAt: expiration }); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('Gmail Pub/Sub shadow ingress', () => {
  it('authenticates before decoding and records accepted + proposed without transport or raw identity leakage', async () => { const verifier = vi.fn(async (jwt: string) => { expect(jwt).toBe(token); return claims; }); const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not call provider')); const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true); writeFileSync(join(stateDir, '.fast-checker.pid'), String(process.pid)); const { server, base } = await listen({ gmailShadow: { audience, serviceAccount, subscription, verifyOidc: verifier } }); try { const response = await post(base, '/relay/gmail-pubsub', gmailBody(), gmailHeaders); expect(response.status).toBe(200); expect(response.json).toEqual({ ok: true, mode: 'shadow', disposition: 'accepted' }); const receipts = readEventReceipts(stateDir); expect(receipts.map((entry) => entry.stage)).toEqual(['ingress', 'routing']); expect(receipts[1]).toMatchObject({ routing_state: 'proposed', route: 'pa-codex.comms-check-worker' }); expect(receipts.some((entry) => entry.stage === 'processing')).toBe(false); const persisted = readFileSync(join(stateDir, 'event-receipts.jsonl'), 'utf8'); for (const secret of ['User@Example.com', 'user@example.com', token, subscription, 'telemetry-only']) expect(persisted + response.text).not.toContain(secret); expect(existsSync(join(root, 'inbox'))).toBe(false); expect(existsSync(join(root, 'logs', 'pa', 'inbound-messages.jsonl'))).toBe(false); expect(existsSync(join(root, 'crons.json'))).toBe(false); expect(fetchSpy).not.toHaveBeenCalled(); expect(killSpy).not.toHaveBeenCalled(); expect(consoleSpy).not.toHaveBeenCalled(); } finally { await close(server); } });
  it.each([
    ['signature', async () => { throw new Error(`signature rejected ${token}`); }],
    ['issuer', async () => ({ ...claims, iss: 'evil.example' })],
    ['audience', async () => ({ ...claims, aud: `${audience}/wrong` })],
    ['expiry', async () => ({ ...claims, exp: now / 1000 - 61 })],
    ['future iat', async () => ({ ...claims, iat: now / 1000 + 61 })],
    ['old iat', async () => ({ ...claims, iat: now / 1000 - 661 })],
    ['verified email', async () => ({ ...claims, email_verified: false })],
    ['service account', async () => ({ ...claims, email: 'other@example.iam.gserviceaccount.com' })],
  ])('rejects invalid %s with one redacted auth code', async (_case, verifyOidc) => { const { server, base } = await listen({ gmailShadow: { audience, serviceAccount, subscription, verifyOidc } }); try { const response = await post(base, '/relay/gmail-pubsub', gmailBody(), gmailHeaders); expect(response.status).toBe(401); expect(response.json).toEqual({ error: 'gmail_auth_invalid' }); expect(response.text).not.toContain(token); expect(readEventReceipts(stateDir)).toEqual([]); } finally { await close(server); } });
  it('fails closed without a verifier and rejects subscription before data decoding', async () => { let fixture = await listen({ gmailShadow: { audience, serviceAccount, subscription } }); try { expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody(), gmailHeaders)).json).toEqual({ error: 'gmail_auth_unavailable' }); } finally { await close(fixture.server); } fixture = await listen(); try { const body = JSON.stringify({ message: { data: 'not base64' }, subscription: `${subscription}-wrong` }); expect((await post(fixture.base, '/relay/gmail-pubsub', body, gmailHeaders)).json).toEqual({ error: 'gmail_invalid_envelope' }); } finally { await close(fixture.server); } });
  it.each([
    [JSON.stringify({ message: { data: '***=' }, subscription }), 'gmail_invalid_data'],
    [JSON.stringify({ message: { data: Buffer.from('{').toString('base64') }, subscription }), 'gmail_invalid_payload'],
    [JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: 'a@example.com' })).toString('base64') }, subscription }), 'gmail_invalid_payload'],
    [gmailBody('01'), 'gmail_invalid_history_id'],
    [gmailBody('1.2'), 'gmail_invalid_history_id'],
    [gmailBody('1'.repeat(129)), 'gmail_invalid_history_id'],
    [gmailBody('10', 'a@example.com', { extra: true }), 'gmail_invalid_payload'],
  ])('strictly rejects malformed encoded/schema input', async (body, code) => { const { server, base } = await listen(); try { const response = await post(base, '/relay/gmail-pubsub', body, gmailHeaders); expect(response.status).toBe(400); expect(response.json).toEqual({ error: code }); } finally { await close(server); } });
  it('enforces a provider body bound', async () => { const { server, base } = await listen(); try { const response = await post(base, '/relay/gmail-pubsub', 'x'.repeat(32 * 1024 + 1), gmailHeaders); expect(response.status).toBe(413); expect(response.json).toEqual({ error: 'provider_body_too_large' }); } finally { await close(server); } });
  it('drops retained chunks immediately after the streaming limit and only drains later chunks', async () => {
    const stream = new EventEmitter() as IncomingMessage & { resume: ReturnType<typeof vi.fn> };
    stream.resume = vi.fn();
    const copy = vi.spyOn(Buffer, 'from');
    const body = readBoundedProviderBody(stream, 4);
    stream.emit('data', Buffer.alloc(4, 1));
    expect(copy).toHaveBeenCalledTimes(1);
    stream.emit('data', Buffer.alloc(1, 2));
    await expect(body).rejects.toThrow('provider_body_too_large');
    const copiesAtLimit = copy.mock.calls.length;
    stream.emit('data', Buffer.alloc(64 * 1024, 3));
    stream.emit('data', Buffer.alloc(64 * 1024, 4));
    stream.emit('end');
    expect(copy).toHaveBeenCalledTimes(copiesAtLimit);
    expect(stream.resume).toHaveBeenCalledOnce();
  });
  it('uses arbitrary-precision monotonic IDs across 9→10, huge values, duplicates, decreasing values, concurrency, and restart', async () => { let fixture = await listen(); try { expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody('9'), gmailHeaders)).json.disposition).toBe('accepted'); expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody('10'), gmailHeaders)).json.disposition).toBe('accepted'); const huge = '9'.repeat(100); expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody(huge), gmailHeaders)).json.disposition).toBe('accepted'); expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody('10'), gmailHeaders)).json.disposition).toBe('stale'); const copies = await Promise.all(Array.from({ length: 8 }, () => post(fixture.base, '/relay/gmail-pubsub', gmailBody('1' + '0'.repeat(100)), gmailHeaders))); expect(copies.filter((copy) => copy.json.disposition === 'accepted')).toHaveLength(1); expect(getEventCursor(stateDir, 'gmail.shadow.notification_high_water')).toBe('1' + '0'.repeat(100)); } finally { await close(fixture.server); } fixture = await listen(); try { expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody('1' + '0'.repeat(100)), gmailHeaders)).json.disposition).toBe('duplicate'); expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toHaveLength(4); } finally { await close(fixture.server); } });
  it('keeps one proposal after more than 2,000 intervening receipts and server restart', async () => {
    let fixture = await listen();
    try { expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody('42'), gmailHeaders)).json.disposition).toBe('accepted'); }
    finally { await close(fixture.server); }
    for (let index = 0; index < 2_100; index += 1) recordIngressReceipt(stateDir, { provider: 'noise', eventType: 'notification', sourceId: `noise-${index}` }, false);
    fixture = await listen();
    try {
      expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody('42'), gmailHeaders)).json.disposition).toBe('duplicate');
      const index = JSON.parse(readFileSync(join(stateDir, 'event-receipt-index.json'), 'utf8')) as { proposedRoutes: Record<string, string> };
      expect(Object.keys(index.proposedRoutes)).toHaveLength(1);
    } finally { await close(fixture.server); }
  });
  it('never advances before receipt persistence and heals cursor failure on duplicate retry', async () => { const receiptFailure = await listen({ providerIngressDependencies: { recordIngress: () => { throw new Error(`receipt secret ${serviceAccount} ${subscription} ${token}`); } } }); try { const failed = await post(receiptFailure.base, '/relay/gmail-pubsub', gmailBody(), gmailHeaders); expect(failed.status).toBe(503); expect(failed.json).toEqual({ error: 'provider_storage_failed' }); for (const secret of [serviceAccount, subscription, token]) expect(failed.text).not.toContain(secret); expect(getEventCursor(stateDir, 'gmail.shadow.notification_high_water')).toBeUndefined(); } finally { await close(receiptFailure.server); } let fail = true; const realAdvance = (await import('../../../src/bus/event-receipt-index')).advanceNumericEventCursor; const fixture = await listen({ providerIngressDependencies: { advanceCursor: (dir, key, value) => { if (fail) { fail = false; throw new Error('cursor secret'); } return realAdvance(dir, key, value); } } }); try { expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody(), gmailHeaders)).status).toBe(503); expect((await post(fixture.base, '/relay/gmail-pubsub', gmailBody(), gmailHeaders)).json.disposition).toBe('duplicate'); expect(getEventCursor(stateDir, 'gmail.shadow.notification_high_water')).toBe('10'); const index = JSON.parse(readFileSync(join(stateDir, 'event-receipt-index.json'), 'utf8')) as { cursors: Record<string, string> }; expect(Object.keys(index.cursors)).toEqual(['gmail.shadow.notification_high_water']); expect(index.cursors).not.toHaveProperty('gmail.processed_history_cursor'); } finally { await close(fixture.server); } });
});

describe('Gmail lane → comms-check-worker spawn (FR-E3)', () => {
  // The comms-check-worker skill the ACTIVE-lane template probes for. Present by
  // default so the active path can produce a filable spawn.
  const installSkill = () => { const dir = join(root, 'orgs', 'clearworksai', 'skills', 'comms-check-worker'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), '# Comms Check Worker'); };
  // provider-config.json is a TEST fixture only — never shipped. Written into the
  // config dir (which defaults to the framework root) to flip the gmail lane.
  const writeLaneConfig = (mode: string) => writeFileSync(join(root, 'provider-config.json'), JSON.stringify({ lanes: { gmail: mode } }));
  const spawnRecorder = () => { const spawns: Array<{ integration: string; name: string; env: Record<string, string>; dir: string; parent: string; prompt: string }> = []; const spawnWorker: NonNullable<BridgeServerOptions['providerIngressDependencies']>['spawnWorker'] = async (integration, planFn, opts) => { const plan = planFn(); if (!plan) return { ok: false }; spawns.push({ integration, name: plan.workerName, env: plan.extraEnv, dir: plan.dir, parent: opts.parent, prompt: plan.prompt }); return { ok: true, integration, workerName: plan.workerName }; }; return { spawns, spawnWorker }; };

  it('active mode spawns comms-check-worker with the right name + GMAIL_HISTORY_ID env, skipping shadow routing', async () => {
    installSkill(); writeLaneConfig('active'); const { spawns, spawnWorker } = spawnRecorder();
    const { server, base } = await listen({ providerIngressDependencies: { spawnWorker } });
    try {
      const response = await post(base, '/relay/gmail-pubsub', gmailBody('55'), gmailHeaders);
      expect(response.status).toBe(200);
      expect(response.json).toEqual({ ok: true, mode: 'active', disposition: 'accepted' });
      expect(spawns).toEqual([{
        integration: 'gmail',
        name: 'comms-check-55',
        env: { GMAIL_HISTORY_ID: '55' },
        dir: join(root, 'orgs', 'clearworksai', 'agents', 'pa-codex'),
        parent: 'pa-codex',
        prompt: expect.stringContaining(join('..', '..', 'skills', 'comms-check-worker', 'SKILL.md')),
      }]);
      expect(spawns[0].prompt).not.toContain('.claude');
      expect(spawns[0].prompt).not.toContain('plugins');
      // The spawn IS the delivery — no shadow routing proposal is recorded.
      expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toEqual([]);
    } finally { await close(server); }
  });

  it('shadow mode (the default) spawns nothing and preserves the routing-proposal behavior', async () => {
    installSkill(); const { spawns, spawnWorker } = spawnRecorder(); // no config file → shadow default
    const { server, base } = await listen({ providerIngressDependencies: { spawnWorker } });
    try {
      const response = await post(base, '/relay/gmail-pubsub', gmailBody('55'), gmailHeaders);
      expect(response.json).toEqual({ ok: true, mode: 'shadow', disposition: 'accepted' });
      expect(spawns).toEqual([]);
      expect(readEventReceipts(stateDir).find((entry) => entry.stage === 'routing')).toMatchObject({ routing_state: 'proposed', route: 'pa-codex.comms-check-worker' });
    } finally { await close(server); }
  });

  it('spawns at most once per event id (duplicate + stale never re-fire)', async () => {
    installSkill(); writeLaneConfig('active'); const { spawns, spawnWorker } = spawnRecorder();
    const { server, base } = await listen({ providerIngressDependencies: { spawnWorker } });
    try {
      expect((await post(base, '/relay/gmail-pubsub', gmailBody('60'), gmailHeaders)).json.disposition).toBe('accepted');
      expect((await post(base, '/relay/gmail-pubsub', gmailBody('60'), gmailHeaders)).json.disposition).toBe('duplicate'); // same id
      expect((await post(base, '/relay/gmail-pubsub', gmailBody('59'), gmailHeaders)).json.disposition).toBe('stale'); // older id
      expect(spawns.map((entry) => entry.name)).toEqual(['comms-check-60']);
    } finally { await close(server); }
  });

  it('active mode does not spawn when the tracked central comms skill is missing', async () => {
    writeLaneConfig('active'); const { spawns, spawnWorker } = spawnRecorder(); // skill NOT installed
    const { server, base } = await listen({ providerIngressDependencies: { spawnWorker } });
    try {
      expect((await post(base, '/relay/gmail-pubsub', gmailBody('77'), gmailHeaders)).json).toEqual({ ok: true, mode: 'active', disposition: 'accepted' });
      expect(spawns).toEqual([]);
    } finally { await close(server); }
  });
});

describe('Calendar lane → booking-calendar-delta spawn (FR-E3)', () => {
  const installSkill = () => { const dir = join(root, 'orgs', 'clearworksai', 'skills', 'booking-calendar-delta'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), '# Booking Calendar Delta'); };
  const writeLaneConfig = (mode: string) => writeFileSync(join(root, 'provider-config.json'), JSON.stringify({ lanes: { calendar: mode } }));
  const spawnRecorder = () => { const spawns: Array<{ integration: string; name: string; env: Record<string, string>; dir: string; parent: string; prompt: string }> = []; const spawnWorker: NonNullable<BridgeServerOptions['providerIngressDependencies']>['spawnWorker'] = async (integration, planFn, opts) => { const plan = planFn(); if (!plan) return { ok: false }; spawns.push({ integration, name: plan.workerName, env: plan.extraEnv, dir: plan.dir, parent: opts.parent, prompt: plan.prompt }); return { ok: true, integration, workerName: plan.workerName }; }; return { spawns, spawnWorker }; };

  it('active mode spawns pa-codex from the tracked central skill and skips shadow routing', async () => {
    installSkill(); writeLaneConfig('active'); const { spawns, spawnWorker } = spawnRecorder();
    const { server, base } = await listen({ providerIngressDependencies: { spawnWorker } });
    try {
      const response = await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-state': 'exists', 'x-goog-message-number': '5' }));
      expect(response.json).toEqual({ ok: true, mode: 'active', disposition: 'accepted' });
      expect(spawns).toEqual([{
        integration: 'calendar',
        name: 'calendar-delta-5',
        env: { CALENDAR_TRIGGER: 'watch-push' },
        dir: join(root, 'orgs', 'clearworksai', 'agents', 'pa-codex'),
        parent: 'pa-codex',
        prompt: expect.stringContaining(join('..', '..', 'skills', 'booking-calendar-delta', 'SKILL.md')),
      }]);
      expect(spawns[0].prompt).not.toContain('.claude');
      expect(spawns[0].prompt).not.toContain('plugins');
      expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toEqual([]);
    } finally { await close(server); }
  });

  it('never spawns for sync notifications, duplicate changes, or stale changes', async () => {
    installSkill(); writeLaneConfig('active'); const { spawns, spawnWorker } = spawnRecorder();
    const { server, base } = await listen({ providerIngressDependencies: { spawnWorker } });
    try {
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' }))).json.disposition).toBe('sync');
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-state': 'exists', 'x-goog-message-number': '9' }))).json.disposition).toBe('accepted');
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-state': 'exists', 'x-goog-message-number': '9' }))).json.disposition).toBe('duplicate');
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-state': 'not_exists', 'x-goog-message-number': '8' }))).json.disposition).toBe('stale');
      expect(spawns.map((entry) => entry.name)).toEqual(['calendar-delta-9']);
    } finally { await close(server); }
  });

  it('keeps shadow mode routing unchanged and does not spawn', async () => {
    installSkill(); const { spawns, spawnWorker } = spawnRecorder();
    const { server, base } = await listen({ providerIngressDependencies: { spawnWorker } });
    try {
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-message-number': '5' }))).json).toEqual({ ok: true, mode: 'shadow', disposition: 'accepted' });
      expect(spawns).toEqual([]);
      expect(readEventReceipts(stateDir).find((entry) => entry.stage === 'routing')).toMatchObject({ route: 'pa-codex.booking-calendar-delta', routing_state: 'proposed' });
    } finally { await close(server); }
  });

  it('does not spawn when the tracked central skill is missing', async () => {
    writeLaneConfig('active'); const { spawns, spawnWorker } = spawnRecorder();
    const { server, base } = await listen({ providerIngressDependencies: { spawnWorker } });
    try {
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-message-number': '7' }))).json).toEqual({ ok: true, mode: 'active', disposition: 'accepted' });
      expect(spawns).toEqual([]);
    } finally { await close(server); }
  });
});

describe('Calendar watch shadow ingress', () => {
  it.each([
    ['missing header', { 'x-goog-channel-id': '' }, 'calendar_missing_header'],
    ['token mismatch', { 'x-goog-channel-token': 'wrong' }, 'calendar_token_mismatch'],
    ['unknown channel', { 'x-goog-channel-id': 'unknown' }, 'calendar_channel_unknown'],
    ['resource mismatch', { 'x-goog-resource-id': 'wrong' }, 'calendar_channel_mismatch'],
    ['state', { 'x-goog-resource-state': 'changed' }, 'calendar_invalid_state'],
    ['number', { 'x-goog-message-number': '01' }, 'calendar_invalid_message_number'],
    ['expiration', { 'x-goog-channel-expiration': new Date(now - 1).toISOString() }, 'calendar_channel_expired'],
  ])('rejects invalid %s using stable redacted codes', async (_case, override, code) => { const { server, base } = await listen(); try { const response = await post(base, '/relay/calendar-watch', '', calendarHeaders(override)); expect([400, 401]).toContain(response.status); expect(response.json).toEqual({ error: code }); expect(response.text).not.toContain('resource-secret'); } finally { await close(server); } });
  it('rejects duplicate headers and non-empty bodies', async () => { const { server, base } = await listen(); try { expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': ['channel-secret', 'channel-secret'] }))).json).toEqual({ error: 'calendar_duplicate_header' }); expect((await post(base, '/relay/calendar-watch', '{}', calendarHeaders())).json).toEqual({ error: 'calendar_body_not_empty' }); } finally { await close(server); } });
  it('records sync without a worker proposal and routes allowed change states only', async () => { const { server, base } = await listen(); try { expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' }))).json.disposition).toBe('sync'); expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toEqual([]); expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-state': 'not_exists', 'x-goog-message-number': '2' }))).json.disposition).toBe('accepted'); expect(readEventReceipts(stateDir).find((entry) => entry.stage === 'routing')).toMatchObject({ route: 'pa-codex.booking-calendar-delta', routing_state: 'proposed' }); } finally { await close(server); } });
  it.each([
    ['sync→exists', 'sync', 'exists'],
    ['exists→not_exists', 'exists', 'not_exists'],
    ['reordered states', 'not_exists', 'exists'],
  ])('keeps Calendar identity independent of resource state for %s', async (_case, first, second) => {
    const channelId = `state-${first}-${second}`;
    writeCalendarShadowChannel(stateDir, { channelId, resourceId: 'resource-secret', channelToken: 'channel-token-secret', expiresAt: expiration });
    const { server, base } = await listen();
    try {
      await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': channelId, 'x-goog-resource-state': first, 'x-goog-message-number': '7' }));
      await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': channelId, 'x-goog-resource-state': second, 'x-goog-message-number': '7' }));
      const relevant = readEventReceipts(stateDir).filter((entry) => entry.stage === 'ingress');
      expect(new Set(relevant.map((entry) => entry.event_id)).size).toBe(1);
      expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toHaveLength(1);
    } finally { await close(server); }
  });
  it('scopes huge monotonic counters to channel + resource and permits renewal-channel reset', async () => { const { server, base } = await listen(); try { const huge = '8'.repeat(100); expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-message-number': huge }))).json.disposition).toBe('accepted'); expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-message-number': '9' }))).json.disposition).toBe('stale'); writeCalendarShadowChannel(stateDir, { channelId: 'renewal-channel', resourceId: 'resource-secret', channelToken: 'channel-token-secret', expiresAt: expiration }); expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'renewal-channel', 'x-goog-message-number': '1' }))).json.disposition).toBe('accepted'); const cursors = JSON.parse(readFileSync(join(stateDir, 'event-receipt-index.json'), 'utf8')).cursors as Record<string, string>; expect(Object.values(cursors)).toEqual(expect.arrayContaining([huge, '1'])); } finally { await close(server); } });
  it('deduplicates concurrent copies durably across server restart', async () => { let fixture = await listen(); try { const copies = await Promise.all(Array.from({ length: 6 }, () => post(fixture.base, '/relay/calendar-watch', '', calendarHeaders()))); expect(copies.filter((copy) => copy.json.disposition === 'accepted')).toHaveLength(1); expect(copies.filter((copy) => copy.json.disposition === 'duplicate')).toHaveLength(5); } finally { await close(fixture.server); } fixture = await listen(); try { expect((await post(fixture.base, '/relay/calendar-watch', '', calendarHeaders())).json.disposition).toBe('duplicate'); expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toHaveLength(1); } finally { await close(fixture.server); } });
  it('keeps Calendar cursor behind failed receipts and heals a failed cursor on retry', async () => {
    const receiptFailure = await listen({ providerIngressDependencies: { recordIngress: () => { throw new Error('calendar receipt secret resource-secret channel-token-secret'); } } });
    try {
      const failed = await post(receiptFailure.base, '/relay/calendar-watch', '', calendarHeaders());
      expect(failed).toMatchObject({ status: 503, json: { error: 'provider_storage_failed' } });
      expect(failed.text).not.toContain('resource-secret');
      const indexPath = join(stateDir, 'event-receipt-index.json');
      expect(existsSync(indexPath) ? Object.keys((JSON.parse(readFileSync(indexPath, 'utf8')) as { cursors: Record<string, string> }).cursors) : []).toEqual([]);
    } finally { await close(receiptFailure.server); }
    let fail = true;
    const realAdvance = (await import('../../../src/bus/event-receipt-index')).advanceNumericEventCursor;
    const fixture = await listen({ providerIngressDependencies: { advanceCursor: (dir, key, value) => { if (fail) { fail = false; throw new Error('calendar cursor secret'); } return realAdvance(dir, key, value); } } });
    try {
      expect((await post(fixture.base, '/relay/calendar-watch', '', calendarHeaders())).status).toBe(503);
      expect((await post(fixture.base, '/relay/calendar-watch', '', calendarHeaders())).json.disposition).toBe('duplicate');
      const cursors = (JSON.parse(readFileSync(join(stateDir, 'event-receipt-index.json'), 'utf8')) as { cursors: Record<string, string> }).cursors;
      expect(Object.values(cursors)).toEqual(['10']);
      expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toHaveLength(1);
    } finally { await close(fixture.server); }
  });
  it('rejects expired configured leases and oversized headers', async () => { writeCalendarShadowChannel(stateDir, { channelId: 'expired-channel', resourceId: 'resource-secret', channelToken: 'channel-token-secret', expiresAt: new Date(now - 1).toISOString() }); const { server, base } = await listen(); try { expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'expired-channel', 'x-goog-channel-expiration': new Date(now - 1).toISOString() }))).json).toEqual({ error: 'calendar_channel_expired' }); expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-id': 'x'.repeat(513) }))).json).toEqual({ error: 'calendar_invalid_header' }); } finally { await close(server); } });
});

describe('provider isolation', () => {
  it('keeps provider rate budgets separate from each other and from Fireflies/Ops capacity', async () => { const { server, base } = await listen({ gmailShadow: { audience, serviceAccount, subscription, verifyOidc: async () => claims, rateLimitMax: 1 }, calendarShadow: { rateLimitMax: 1 } }); try { expect((await post(base, '/relay/gmail-pubsub', gmailBody(), gmailHeaders)).status).toBe(200); expect((await post(base, '/relay/gmail-pubsub', gmailBody('11'), gmailHeaders)).status).toBe(429); expect((await post(base, '/relay/calendar-watch', '', calendarHeaders())).status).toBe(200); const generic = await post(base, '/relay/ops-check-lead', JSON.stringify({ integration: 'ops-check-lead', target: 'pa', event: 'check' }), { 'x-webhook-bridge-secret': 'bridge-secret' }); expect(generic.status).toBe(200); expect(readdirSync(join(root, 'inbox', 'pa'))).toHaveLength(1); } finally { await close(server); } });
  it('redacts response-writer failures before they can escape the provider branch', async () => {
    const request = new EventEmitter() as IncomingMessage;
    const response = { writeHead: vi.fn(), end: vi.fn(() => { throw new Error(`sink ${serviceAccount} ${subscription} ${token} resource-secret channel-token-secret`); }) } as unknown as ServerResponse;
    await expect(handleProviderShadowIngress('gmail-pubsub', request, response, { stateDir, now: () => now }, new Map())).rejects.toThrow('provider_response_failed');
    try { await handleProviderShadowIngress('gmail-pubsub', request, response, { stateDir, now: () => now }, new Map()); } catch (error) { expect(String(error)).not.toContain(serviceAccount); expect(String(error)).not.toContain(subscription); expect(String(error)).not.toContain(token); expect(String(error)).not.toContain('resource-secret'); }
  });
  it('keeps failure paths free of processing, inbox, wake, log, worker, and provider side effects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider call forbidden'));
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    writeFileSync(join(stateDir, '.fast-checker.pid'), String(process.pid));
    const { server, base } = await listen({ providerIngressDependencies: { recordIngress: () => { throw new Error('storage unavailable'); } } });
    try {
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders())).json).toEqual({ error: 'provider_storage_failed' });
      expect(readEventReceipts(stateDir).some((entry) => entry.stage === 'processing')).toBe(false);
      expect(existsSync(join(root, 'inbox'))).toBe(false);
      expect(existsSync(join(root, 'logs', 'pa', 'inbound-messages.jsonl'))).toBe(false);
      expect(existsSync(join(root, 'crons.json'))).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    } finally { await close(server); }
  });
});
