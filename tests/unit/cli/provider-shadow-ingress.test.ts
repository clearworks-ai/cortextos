import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { request as httpRequest } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { createBridgeServer, type BridgeServerOptions } from '../../../src/cli/webhook-bridge';
import { handleProviderShadowIngress, markCalendarShadowChannelCleanupRequired, markCalendarShadowChannelStopped, readBoundedProviderBody, reconcileCalendarShadowChannel, writeCalendarShadowChannel, writePendingCalendarShadowChannel } from '../../../src/cli/provider-shadow-ingress';
import { getEventCursor } from '../../../src/bus/event-receipt-index';
import { readEventReceipts, recordIngressReceipt } from '../../../src/bus/event-delivery';
import { acquireLock, releaseLock } from '../../../src/utils/lock';

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
const gmailBody = (historyId = '10', emailAddress = 'Josh@Clearworks.AI', extra?: Record<string, unknown>) => JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId, ...extra })).toString('base64'), messageId: 'telemetry-only' }, subscription });
const gmailHeaders = { authorization: `Bearer ${token}` };
const expiration = new Date(now + 60_000).toISOString();
const pendingUntil = new Date(now + 300_000).toISOString();
const calendarHeaders = (overrides: Record<string, string | string[]> = {}) => ({ 'x-goog-channel-id': 'channel-secret', 'x-goog-resource-id': 'resource-secret', 'x-goog-resource-state': 'exists', 'x-goog-message-number': '10', 'x-goog-channel-expiration': expiration, 'x-goog-channel-token': 'channel-token-secret', ...overrides });
const channelFile = (channelId: string) => join(stateDir, 'calendar-shadow-channels', `${createHash('sha256').update(channelId).digest('hex')}.json`);
const channelLock = (channelId: string) => join(stateDir, 'calendar-shadow-channel-locks', createHash('sha256').update(channelId).digest('hex'));
const close = (server: ReturnType<typeof createBridgeServer>) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

async function startChildCalendarOperation(operation: 'bind' | 'reconcile', payload: Record<string, unknown>) {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'cli', 'provider-shadow-ingress.ts')).href;
  const script = `
    const { bindCalendarShadowSync, reconcileCalendarShadowChannel } = (await import(${JSON.stringify(moduleUrl)})).default;
    const stateDir = process.argv[1];
    const operation = process.argv[2];
    const payload = JSON.parse(process.argv[3]);
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => {
      try {
        const value = operation === 'bind' ? bindCalendarShadowSync(stateDir, payload) : reconcileCalendarShadowChannel(stateDir, payload);
        process.stdout.write('RESULT ' + JSON.stringify(value ?? null) + '\\n');
      } catch (error) {
        process.stdout.write('ERROR ' + JSON.stringify(String(error)) + '\\n');
      }
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, stateDir, operation, JSON.stringify(payload)], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.includes('READY\n')) resolve(); });
    child.once('error', reject);
    child.once('close', (code) => { if (!stdout.includes('READY\n')) reject(new Error(`calendar child exited before ready (${code}): ${stderr}`)); });
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const done = new Promise<{ result?: unknown; error?: string }>((resolve, reject) => child.on('close', (code) => {
    if (code !== 0) { reject(new Error(`calendar child failed: ${stderr}`)); return; }
    const result = stdout.match(/^RESULT (.+)$/m); const error = stdout.match(/^ERROR (.+)$/m);
    if (result) resolve({ result: JSON.parse(result[1]) });
    else if (error) resolve({ error: JSON.parse(error[1]) });
    else reject(new Error(`calendar child returned no result: ${stdout} ${stderr}`));
  }));
  void done.catch(() => {});
  await ready;
  return { child, run: () => { child.stdin.end('go'); return done; } };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'provider-shadow-')); stateDir = join(root, 'state', 'pa'); mkdirSync(join(root, 'orgs', 'clearworksai', 'agents', 'pa'), { recursive: true }); writeFileSync(join(root, 'orgs', 'clearworksai', 'agents', 'pa', 'IDENTITY.md'), '# PA'); writeCalendarShadowChannel(stateDir, { channelId: 'channel-secret', resourceId: 'resource-secret', channelToken: 'channel-token-secret', expiresAt: expiration }); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('Gmail Pub/Sub shadow ingress', () => {
  it('authenticates before decoding and records accepted + proposed without transport or raw identity leakage', async () => { const verifier = vi.fn(async (jwt: string) => { expect(jwt).toBe(token); return claims; }); const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not call provider')); const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true); writeFileSync(join(stateDir, '.fast-checker.pid'), String(process.pid)); const { server, base } = await listen({ gmailShadow: { audience, serviceAccount, subscription, verifyOidc: verifier } }); try { const response = await post(base, '/relay/gmail-pubsub', gmailBody(), gmailHeaders); expect(response.status).toBe(200); expect(response.json).toEqual({ ok: true, mode: 'shadow', disposition: 'accepted' }); const receipts = readEventReceipts(stateDir); expect(receipts.map((entry) => entry.stage)).toEqual(['ingress', 'routing']); expect(receipts[1]).toMatchObject({ routing_state: 'proposed', route: 'pa.comms-check-worker' }); expect(receipts.some((entry) => entry.stage === 'processing')).toBe(false); const persisted = readFileSync(join(stateDir, 'event-receipts.jsonl'), 'utf8'); for (const secret of ['Josh@Clearworks.AI', 'josh@clearworks.ai', token, subscription, 'telemetry-only']) expect(persisted + response.text).not.toContain(secret); expect(existsSync(join(root, 'inbox'))).toBe(false); expect(existsSync(join(root, 'logs', 'pa', 'inbound-messages.jsonl'))).toBe(false); expect(existsSync(join(root, 'crons.json'))).toBe(false); expect(fetchSpy).not.toHaveBeenCalled(); expect(killSpy).not.toHaveBeenCalled(); expect(consoleSpy).not.toHaveBeenCalled(); } finally { await close(server); } });
  it('rejects a validly authenticated notification for a mailbox outside the frozen allowlist', async () => { const { server, base } = await listen(); try { const response = await post(base, '/relay/gmail-pubsub', gmailBody('10', 'other@clearworks.ai'), gmailHeaders); expect(response).toMatchObject({ status: 400, json: { error: 'gmail_invalid_payload' } }); expect(readEventReceipts(stateDir)).toEqual([]); } finally { await close(server); } });
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
  it.each([
    ['google_oidc_unavailable', 503, 'gmail_auth_unavailable'],
    ['google_oidc_invalid', 401, 'gmail_auth_invalid'],
  ])('preserves verifier classification for %s without exposing verifier details', async (code, status, expected) => {
    const verifierSecret = `verifier-secret-${code}`;
    const verifyOidc = async () => { throw Object.assign(new Error(verifierSecret), { code }); };
    const { server, base } = await listen({ gmailShadow: { audience, serviceAccount, subscription, verifyOidc } });
    try {
      const response = await post(base, '/relay/gmail-pubsub', gmailBody(), gmailHeaders);
      expect(response).toMatchObject({ status, json: { error: expected } });
      expect(response.text).not.toContain(verifierSecret);
      expect(readEventReceipts(stateDir)).toEqual([]);
    } finally { await close(server); }
  });
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

describe('Calendar watch shadow ingress', () => {
  it('writes a strict 0600 v2 active record containing only digests and canonical expiration', () => {
    const path = channelFile('channel-secret');
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ version: 2, status: 'active', expiresAt: expiration });
    expect(Object.keys(stored).sort()).toEqual(['channel', 'expiresAt', 'resource', 'status', 'token', 'version']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const disk = readFileSync(path, 'utf8');
    for (const secret of ['channel-secret', 'resource-secret', 'channel-token-secret']) expect(disk).not.toContain(secret);
  });
  it('refuses initialization writers that would replace an existing active or cleanup record', () => {
    expect(() => writePendingCalendarShadowChannel(stateDir, { channelId: 'channel-secret', channelToken: 'replacement-token', endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil })).toThrow('calendar_channel_transition_conflict');
    expect(JSON.parse(readFileSync(channelFile('channel-secret'), 'utf8'))).toMatchObject({ status: 'active' });
    markCalendarShadowChannelCleanupRequired(stateDir, 'channel-secret', 'calendar_channel_unavailable');
    expect(() => writeCalendarShadowChannel(stateDir, { channelId: 'channel-secret', resourceId: 'replacement-resource', channelToken: 'replacement-token', expiresAt: expiration })).toThrow('calendar_channel_transition_conflict');
    expect(JSON.parse(readFileSync(channelFile('channel-secret'), 'utf8'))).toMatchObject({ status: 'cleanup_required' });
  });
  it('binds an authenticated early sync without routing, then reconciles and activates the channel', async () => {
    writePendingCalendarShadowChannel(stateDir, { channelId: 'early-channel', channelToken: 'early-token', endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil });
    const path = channelFile('early-channel');
    const pendingDisk = readFileSync(path, 'utf8');
    for (const secret of ['early-channel', 'early-token', 'resource-secret']) expect(pendingDisk).not.toContain(secret);
    expect(JSON.parse(pendingDisk)).toMatchObject({ version: 2, status: 'pending', resource: null, expiresAt: null, requested: { endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800 }, pendingUntil });
    const { server, base } = await listen();
    try {
      const sync = await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'early-channel', 'x-goog-channel-token': 'early-token', 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' }));
      expect(sync).toMatchObject({ status: 200, json: { disposition: 'sync' } });
      expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toEqual([]);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ status: 'pending', resource: expect.stringMatching(/^[a-f0-9]{64}$/), expiresAt: expiration });
      expect(reconcileCalendarShadowChannel(stateDir, { channelId: 'early-channel', resourceId: 'resource-secret', expiresAt: expiration, now })).toEqual({ status: 'active' });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 2, status: 'active', expiresAt: expiration });
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'early-channel', 'x-goog-channel-token': 'early-token', 'x-goog-message-number': '2' }))).json.disposition).toBe('accepted');
    } finally { await close(server); }
  });
  it('activates response-first and accepts a later sync without a proposal', async () => {
    writePendingCalendarShadowChannel(stateDir, { channelId: 'response-first', channelToken: 'response-token', endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil });
    expect(reconcileCalendarShadowChannel(stateDir, { channelId: 'response-first', resourceId: 'response-resource', expiresAt: String(Date.parse(expiration)), now })).toEqual({ status: 'active' });
    const { server, base } = await listen();
    try {
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'response-first', 'x-goog-resource-id': 'response-resource', 'x-goog-channel-token': 'response-token', 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' }))).json.disposition).toBe('sync');
      expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toEqual([]);
    } finally { await close(server); }
  });
  it('serializes concurrent sync binding and response reconciliation to one active record', async () => {
    writePendingCalendarShadowChannel(stateDir, { channelId: 'concurrent-channel', channelToken: 'concurrent-token', endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil });
    const { server, base } = await listen();
    try {
      const sync = post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'concurrent-channel', 'x-goog-channel-token': 'concurrent-token', 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' }));
      const activation = await new Promise<ReturnType<typeof reconcileCalendarShadowChannel>>((resolve) => setImmediate(() => resolve(reconcileCalendarShadowChannel(stateDir, { channelId: 'concurrent-channel', resourceId: 'resource-secret', expiresAt: expiration, now }))));
      expect(activation).toEqual({ status: 'active' });
      expect((await sync).status).toBe(200);
      expect(JSON.parse(readFileSync(channelFile('concurrent-channel'), 'utf8'))).toMatchObject({ version: 2, status: 'active' });
      expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toEqual([]);
    } finally { await close(server); }
  });
  it('uses an inter-process channel lock so stale pending sync cannot overwrite active state across restart', async () => {
    const channelId = 'locked-active'; const channelToken = 'locked-active-token'; const resourceId = 'locked-active-resource';
    writePendingCalendarShadowChannel(stateDir, { channelId, channelToken, endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil });
    expect(acquireLock(channelLock(channelId))).toBe(true);
    const child = await startChildCalendarOperation('bind', { channelId, resourceId, channelToken, expiresAt: expiration, now });
    const childResult = child.run();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(child.child.exitCode).toBeNull();
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      writeFileSync(channelFile(channelId), JSON.stringify({ version: 2, status: 'active', channel: hash(channelId), resource: hash(resourceId), token: hash(channelToken), expiresAt: expiration }), { mode: 0o600 });
    } finally { releaseLock(channelLock(channelId)); }
    expect(await childResult).toEqual({ result: null });
    expect(JSON.parse(readFileSync(channelFile(channelId), 'utf8'))).toMatchObject({ version: 2, status: 'active' });
    const fixture = await listen();
    try { expect((await post(fixture.base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': channelId, 'x-goog-resource-id': resourceId, 'x-goog-channel-token': channelToken, 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' }))).status).toBe(200); }
    finally { await close(fixture.server); }
  });
  it('preserves cleanup-required against a blocked stale sync writer across restart', async () => {
    const channelId = 'locked-cleanup'; const channelToken = 'locked-cleanup-token'; const resourceId = 'locked-cleanup-resource';
    writePendingCalendarShadowChannel(stateDir, { channelId, channelToken, endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil });
    expect(acquireLock(channelLock(channelId))).toBe(true);
    const child = await startChildCalendarOperation('bind', { channelId, resourceId, channelToken, expiresAt: expiration, now });
    const childResult = child.run();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(child.child.exitCode).toBeNull();
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      writeFileSync(channelFile(channelId), JSON.stringify({ version: 2, status: 'cleanup_required', channel: hash(channelId), resource: null, token: hash(channelToken), expiresAt: null, reason: 'calendar_channel_unavailable' }), { mode: 0o600 });
    } finally { releaseLock(channelLock(channelId)); }
    expect((await childResult).error).toContain('calendar_cleanup_required');
    expect(JSON.parse(readFileSync(channelFile(channelId), 'utf8'))).toMatchObject({ status: 'cleanup_required', reason: 'calendar_channel_unavailable' });
    const fixture = await listen();
    try { expect(await post(fixture.base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': channelId, 'x-goog-resource-id': resourceId, 'x-goog-channel-token': channelToken, 'x-goog-resource-state': 'sync' }))).toMatchObject({ status: 503, json: { error: 'calendar_cleanup_required' } }); }
    finally { await close(fixture.server); }
  });
  it('converges conflicting cross-process sync and reconciliation to cleanup-required, never active', async () => {
    const channelId = 'locked-conflict'; const channelToken = 'locked-conflict-token';
    writePendingCalendarShadowChannel(stateDir, { channelId, channelToken, endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil });
    const child = await startChildCalendarOperation('bind', { channelId, resourceId: 'sync-resource', channelToken, expiresAt: expiration, now });
    const childResult = child.run();
    const reconciliation = reconcileCalendarShadowChannel(stateDir, { channelId, resourceId: 'response-resource', expiresAt: expiration, now });
    await childResult;
    expect(reconciliation.status).toMatch(/active|cleanup_required/);
    expect(JSON.parse(readFileSync(channelFile(channelId), 'utf8'))).toMatchObject({ version: 2, status: 'cleanup_required', reason: 'calendar_channel_mismatch' });
    const fixture = await listen();
    try { expect((await post(fixture.base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': channelId, 'x-goog-resource-id': 'sync-resource', 'x-goog-channel-token': channelToken, 'x-goog-resource-state': 'sync' }))).json).toEqual({ error: 'calendar_cleanup_required' }); }
    finally { await close(fixture.server); }
  });
  it('does not bind pending state on token mismatch or a non-sync notification', async () => {
    writePendingCalendarShadowChannel(stateDir, { channelId: 'pending-channel', channelToken: 'pending-token', endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil });
    const path = channelFile('pending-channel');
    const { server, base } = await listen();
    try {
      const wrongToken = await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'pending-channel', 'x-goog-channel-token': 'wrong', 'x-goog-resource-state': 'sync' }));
      expect(wrongToken.json).toEqual({ error: 'calendar_token_mismatch' });
      const changed = await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'pending-channel', 'x-goog-channel-token': 'pending-token', 'x-goog-resource-state': 'exists' }));
      expect(changed.json).toEqual({ error: 'calendar_channel_pending' });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ status: 'pending', resource: null, expiresAt: null });
      expect(readEventReceipts(stateDir)).toEqual([]);
    } finally { await close(server); }
  });
  it('expires pending state closed and marks expired or mismatched reconciliation cleanup-required', async () => {
    writePendingCalendarShadowChannel(stateDir, { channelId: 'expired-pending', channelToken: 'expired-token', endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil: new Date(now - 1).toISOString() });
    const { server, base } = await listen();
    try {
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'expired-pending', 'x-goog-channel-token': 'expired-token', 'x-goog-resource-state': 'sync' }))).json).toEqual({ error: 'calendar_channel_expired' });
    } finally { await close(server); }
    expect(reconcileCalendarShadowChannel(stateDir, { channelId: 'expired-pending', resourceId: 'resource-secret', expiresAt: expiration, now })).toEqual({ status: 'cleanup_required', code: 'calendar_channel_expired' });
    expect(JSON.parse(readFileSync(channelFile('expired-pending'), 'utf8'))).toMatchObject({ status: 'cleanup_required', reason: 'calendar_channel_expired' });

    writePendingCalendarShadowChannel(stateDir, { channelId: 'mismatch', channelToken: 'mismatch-token', endpoint: 'https://hooks.clearworks.ai/relay/calendar-watch', ttlSeconds: 604_800, pendingUntil });
    const mismatchFixture = await listen();
    try { expect((await post(mismatchFixture.base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'mismatch', 'x-goog-channel-token': 'mismatch-token', 'x-goog-resource-state': 'sync' }))).status).toBe(200); }
    finally { await close(mismatchFixture.server); }
    expect(reconcileCalendarShadowChannel(stateDir, { channelId: 'mismatch', resourceId: 'different-resource', expiresAt: expiration, now })).toEqual({ status: 'cleanup_required', code: 'calendar_channel_mismatch' });
    expect(JSON.parse(readFileSync(channelFile('mismatch'), 'utf8'))).toMatchObject({ status: 'cleanup_required', reason: 'calendar_channel_mismatch' });
  });
  it('supports explicit cleanup-required state with a stable redacted handler error', async () => {
    markCalendarShadowChannelCleanupRequired(stateDir, 'channel-secret', 'calendar_channel_unavailable');
    const { server, base } = await listen();
    try {
      const response = await post(base, '/relay/calendar-watch', '', calendarHeaders());
      expect(response).toMatchObject({ status: 503, json: { error: 'calendar_cleanup_required' } });
      for (const secret of ['channel-secret', 'resource-secret', 'channel-token-secret']) expect(response.text).not.toContain(secret);
    } finally { await close(server); }
  });
  it('removes handler eligibility only when Calendar lifecycle marks a channel stopped', async () => {
    const path = channelFile('channel-secret');
    expect(existsSync(path)).toBe(true);
    markCalendarShadowChannelStopped(stateDir, 'channel-secret');
    expect(existsSync(path)).toBe(false);
    expect(() => markCalendarShadowChannelStopped(stateDir, 'channel-secret')).not.toThrow();
    const { server, base } = await listen();
    try {
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders())).json).toEqual({ error: 'calendar_channel_unknown' });
    } finally { await close(server); }
  });
  it('accepts strict v1 active records and rejects corrupt v2 records', async () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    writeFileSync(channelFile('legacy-channel'), JSON.stringify({ version: 1, channel: hash('legacy-channel'), resource: hash('legacy-resource'), token: hash('legacy-token'), expiresAt: expiration }), { mode: 0o600 });
    writeFileSync(channelFile('corrupt-channel'), JSON.stringify({ version: 2, status: 'active', channel: hash('corrupt-channel'), resource: null, token: hash('corrupt-token'), expiresAt: expiration }), { mode: 0o600 });
    const { server, base } = await listen();
    try {
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'legacy-channel', 'x-goog-resource-id': 'legacy-resource', 'x-goog-channel-token': 'legacy-token' }))).status).toBe(200);
      expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-channel-id': 'corrupt-channel', 'x-goog-resource-id': 'corrupt-resource', 'x-goog-channel-token': 'corrupt-token' }))).json).toEqual({ error: 'calendar_channel_unavailable' });
    } finally { await close(server); }
  });
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
  it('records sync without a worker proposal and routes allowed change states only', async () => { const { server, base } = await listen(); try { expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' }))).json.disposition).toBe('sync'); expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing')).toEqual([]); expect((await post(base, '/relay/calendar-watch', '', calendarHeaders({ 'x-goog-resource-state': 'not_exists', 'x-goog-message-number': '2' }))).json.disposition).toBe('accepted'); expect(readEventReceipts(stateDir).find((entry) => entry.stage === 'routing')).toMatchObject({ route: 'pa.booking-calendar-delta', routing_state: 'proposed' }); } finally { await close(server); } });
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
