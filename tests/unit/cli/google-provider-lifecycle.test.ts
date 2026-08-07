import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_PROVIDER_ALLOWLIST, GoogleProviderLifecycleError, calendarRegister, calendarRenew, calendarStop,
  defaultSecureFileSystem, gmailRenew, gmailStop, gmailWatch, type GoogleProviderDependencies, type ProviderHttpRequest,
} from '../../../src/cli/google-provider-lifecycle';

const now = Date.parse('2026-08-07T08:00:00.000Z');
const channelId = '123e4567-e89b-42d3-a456-426614174000';
const tokenSecret = 'seeded-calendar-token-that-must-never-persist';
let root: string; let stateDir: string; let calls: ProviderHttpRequest[]; let order: string[];

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function deps(responses: Array<{ status: number; body: unknown }> = []): GoogleProviderDependencies {
  return {
    stateDir, now: () => now, files: defaultSecureFileSystem, uuid: () => channelId,
    secret: () => Buffer.from(tokenSecret), token: vi.fn(async () => 'seeded-access-token'),
    http: vi.fn(async (request) => { calls.push(request); order.push(`http:${request.url.endsWith('/channels/stop') ? 'stop' : 'create'}`); return responses.shift() ?? { status: 200, body: {} }; }),
    calendarIngress: {
      writePending(dir, value) {
        order.push('pending'); mkdirSync(join(dir, 'calendar-shadow-channels'), { recursive: true });
        writeFileSync(join(dir, 'calendar-shadow-channels', `${hash(value.channelId)}.json`), JSON.stringify({ version: 2, status: 'pending', channel: hash(value.channelId), token: hash(value.channelToken), resource: null, pendingUntil: value.pendingUntil }), { mode: 0o600 });
      },
      reconcile(_dir, value) { order.push('active'); return value.resourceId === 'mismatch' ? { status: 'cleanup_required', code: 'calendar_channel_mismatch' } : { status: 'active' }; },
      markCleanupRequired() { order.push('cleanup'); }, markStopped() { order.push('stopped'); },
    },
  };
}
function allFiles(path: string): string[] { return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? allFiles(join(path, entry.name)) : [join(path, entry.name)]); }

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'google-provider-')); stateDir = join(root, 'state', 'pa'); calls = []; order = []; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Google provider lifecycle', () => {
  it('makes every default mutation a zero-call, zero-write dry run', async () => {
    const d = deps();
    await expect(gmailWatch(d)).resolves.toMatchObject({ applied: false, code: 'gmail_watch_dry_run' });
    await expect(gmailRenew(d)).resolves.toMatchObject({ applied: false });
    await expect(gmailStop(d)).resolves.toMatchObject({ applied: false });
    await expect(calendarRegister(d)).resolves.toMatchObject({ applied: false });
    await expect(calendarRenew(d)).resolves.toMatchObject({ applied: false });
    expect(calls).toHaveLength(0); expect(d.token).not.toHaveBeenCalled(); expect(readdirSync(root)).toEqual([]);
  });

  it('pins the exact Gmail watch request and atomically stores a canonical 0600 lease', async () => {
    const d = deps([{ status: 200, body: { historyId: '900719925474099312345', expiration: String(now + 6 * 86_400_000) } }]);
    await expect(gmailWatch(d, { apply: true, approval: 'runbook-42' })).resolves.toMatchObject({ code: 'gmail_watch_created', applied: true });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${GOOGLE_PROVIDER_ALLOWLIST.gmailEndpoint}/watch`, body: { topicName: GOOGLE_PROVIDER_ALLOWLIST.topic, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' } });
    const path = join(stateDir, 'google-provider', 'gmail-lease.json'); const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(stored).toMatchObject({ version: 1, status: 'active', historyId: '900719925474099312345', topic: hash(GOOGLE_PROVIDER_ALLOWLIST.topic) });
    expect(statSync(path).mode & 0o777).toBe(0o600); expect(JSON.stringify(stored)).not.toContain('seeded-access-token');
    expect(readdirSync(join(stateDir, 'google-provider')).some((name) => name.startsWith('.tmp.'))).toBe(false);
  });

  it('renews only when due and preserves the last successful lease on failure with bounded retry metadata', async () => {
    const d = deps([{ status: 200, body: { historyId: '10', expiration: String(now + 6 * 86_400_000) } }]);
    await gmailWatch(d, { apply: true, approval: 'runbook-42' }); calls.length = 0;
    await expect(gmailRenew(d, { apply: true, approval: 'runbook-42' })).resolves.toMatchObject({ code: 'gmail_renew_not_due' }); expect(calls).toHaveLength(0);
    const path = join(stateDir, 'google-provider', 'gmail-lease.json'); const lease = JSON.parse(readFileSync(path, 'utf8')); lease.nextRenewBy = new Date(now - 1).toISOString(); writeFileSync(path, JSON.stringify(lease));
    d.http = vi.fn(async () => { throw new Error(`secret seeded-access-token ${GOOGLE_PROVIDER_ALLOWLIST.mailbox}`); });
    await expect(gmailRenew(d, { apply: true, approval: 'runbook-42' })).rejects.toMatchObject({ code: 'provider_request_failed' });
    const preserved = JSON.parse(readFileSync(path, 'utf8')); expect(preserved.historyId).toBe('10'); expect(preserved.retry.attempt).toBe(1); expect(JSON.stringify(preserved)).not.toContain('seeded-access-token');
    calls.length = 0;
    await expect(gmailRenew(d, { apply: true, approval: 'runbook-42' })).resolves.toMatchObject({ code: 'gmail_renew_retry_not_due' });
    expect(calls).toHaveLength(0);
  });

  it('marks Gmail stopped only after provider success and rejects missing approval', async () => {
    const d = deps([{ status: 200, body: { historyId: '10', expiration: String(now + 6 * 86_400_000) } }, { status: 500, body: { token: 'seeded-access-token' } }]);
    await gmailWatch(d, { apply: true, approval: 'runbook-42' });
    await expect(gmailStop(d, { apply: true, approval: 'runbook-42' })).rejects.toMatchObject({ code: 'provider_request_failed' });
    expect(JSON.parse(readFileSync(join(stateDir, 'google-provider', 'gmail-lease.json'), 'utf8')).status).toBe('active');
    await expect(gmailStop(d, { apply: true })).rejects.toBeInstanceOf(GoogleProviderLifecycleError);
  });

  it('writes pending before Calendar watch, reconciles active, and persists only raw stop identifiers in a 0600 control index', async () => {
    const expiration = String(now + 6 * 86_400_000); const d = deps([{ status: 200, body: { id: channelId, resourceId: 'resource-secret', expiration } }]);
    const result = await calendarRegister(d, { apply: true, approval: 'runbook-42' });
    expect(order).toEqual(['pending', 'http:create', 'active']); expect(result.handle).toMatch(/^[a-f0-9]{24}$/);
    expect(calls[0].body).toEqual({ id: channelId, type: 'web_hook', address: GOOGLE_PROVIDER_ALLOWLIST.calendarWatchEndpoint, token: Buffer.from(tokenSecret).toString('base64url'), params: { ttl: '604800' } });
    const controlPath = join(stateDir, 'google-provider', 'calendar-control.json'); expect(statSync(controlPath).mode & 0o777).toBe(0o600);
    const disk = allFiles(stateDir).map((path) => readFileSync(path, 'utf8')).join('\n'); expect(disk).not.toContain(tokenSecret); expect(disk).not.toContain(Buffer.from(tokenSecret).toString('base64url')); expect(disk).not.toContain('seeded-access-token');
  });

  it('consumes Lane B cleanup_required and attempts immediate provider cleanup', async () => {
    const d = deps([{ status: 200, body: { id: channelId, resourceId: 'mismatch', expiration: String(now + 6 * 86_400_000) } }, { status: 500, body: {} }]);
    await expect(calendarRegister(d, { apply: true, approval: 'runbook-42' })).rejects.toMatchObject({ code: 'calendar_cleanup_required' });
    expect(order).toEqual(['pending', 'http:create', 'active', 'http:stop']);
    expect(JSON.parse(readFileSync(join(stateDir, 'google-provider', 'calendar-control.json'), 'utf8')).channels[0]).toMatchObject({ status: 'cleanup_required', cleanupCode: 'calendar_channel_mismatch' });
  });

  it('overlaps Calendar renewal and stops the old channel only after new activation proof', async () => {
    const d = deps([{ status: 200, body: { id: channelId, resourceId: 'old-resource', expiration: String(now + 60_000) } }]);
    const old = await calendarRegister(d, { apply: true, approval: 'runbook-42' }); order = []; calls = [];
    d.uuid = () => '223e4567-e89b-42d3-a456-426614174000';
    d.http = vi.fn(async (request) => { calls.push(request); order.push(`http:${request.url.endsWith('/channels/stop') ? 'stop' : 'create'}`); return request.url.endsWith('/channels/stop') ? { status: 200, body: {} } : { status: 200, body: { id: d.uuid(), resourceId: 'new-resource', expiration: String(now + 6 * 86_400_000) } }; });
    await calendarRenew(d, { apply: true, approval: 'runbook-42' });
    expect(order).toEqual(['pending', 'http:create', 'active', 'http:stop', 'stopped']);
    const control = JSON.parse(readFileSync(join(stateDir, 'google-provider', 'calendar-control.json'), 'utf8')); expect(control.channels.find((item: { handle: string }) => item.handle === old.handle).status).toBe('stopped'); expect(control.channels.filter((item: { status: string }) => item.status === 'active')).toHaveLength(1);
  });

  it('does not mark Calendar stopped when provider stop fails', async () => {
    const d = deps([{ status: 200, body: { id: channelId, resourceId: 'resource-secret', expiration: String(now + 6 * 86_400_000) } }, { status: 503, body: {} }]);
    const registered = await calendarRegister(d, { apply: true, approval: 'runbook-42' });
    await expect(calendarStop(d, registered.handle!, { apply: true, approval: 'runbook-42' })).rejects.toMatchObject({ code: 'provider_request_failed' });
    expect(JSON.parse(readFileSync(join(stateDir, 'google-provider', 'calendar-control.json'), 'utf8')).channels[0].status).toBe('cleanup_required');
  });

  it('reuses a fresh replacement and retries cleanup without creating duplicate channels', async () => {
    const d = deps([{ status: 200, body: { id: channelId, resourceId: 'old-resource', expiration: String(now + 60_000) } }]);
    await calendarRegister(d, { apply: true, approval: 'runbook-42' });
    d.uuid = () => '223e4567-e89b-42d3-a456-426614174000';
    let stopAttempts = 0;
    d.http = vi.fn(async (request) => {
      calls.push(request);
      if (request.url.endsWith('/channels/stop')) {
        stopAttempts += 1;
        return stopAttempts === 1 ? { status: 503, body: {} } : { status: 200, body: {} };
      }
      return { status: 200, body: { id: d.uuid(), resourceId: 'new-resource', expiration: String(now + 6 * 86_400_000) } };
    });
    await expect(calendarRenew(d, { apply: true, approval: 'runbook-42' })).rejects.toMatchObject({ code: 'provider_request_failed' });
    calls.length = 0;
    await expect(calendarRenew(d, { apply: true, approval: 'runbook-42' })).resolves.toMatchObject({ code: 'calendar_cleanup_retried' });
    expect(calls.filter((request) => request.url.endsWith('/events/watch'))).toHaveLength(0);
    const control = JSON.parse(readFileSync(join(stateDir, 'google-provider', 'calendar-control.json'), 'utf8'));
    expect(control.channels.filter((item: { status: string }) => item.status === 'active')).toHaveLength(1);
    expect(control.channels.filter((item: { status: string }) => item.status === 'stopped')).toHaveLength(1);
  });
});
