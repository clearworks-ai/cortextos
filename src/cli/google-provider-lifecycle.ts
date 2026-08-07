import { createHash, randomBytes, randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { withFileLockAsync } from '../utils/lock.js';

export const GOOGLE_PROVIDER_ALLOWLIST = Object.freeze({
  project: 'cortextos-gws-495505',
  topic: 'projects/cortextos-gws-495505/topics/cortextos-gmail-push',
  mailbox: 'josh@clearworks.ai',
  calendar: 'josh@clearworks.ai',
  gmailEndpoint: 'https://gmail.googleapis.com/gmail/v1/users/me',
  calendarEndpoint: 'https://www.googleapis.com/calendar/v3',
  calendarWatchEndpoint: 'https://hooks.clearworks.ai/relay/calendar-watch',
});

const DAY_MS = 86_400_000;
const CALENDAR_TTL_SECONDS = 604_800;
const PENDING_MS = 300_000;

export interface ProviderHttpRequest { method: 'POST'; url: string; headers: Record<string, string>; body?: unknown; }
export interface ProviderHttpResponse { status: number; body: unknown; }
export interface SecureFileSystem {
  exists(path: string): boolean;
  read(path: string): string;
  atomicWrite(path: string, data: string, mode: number): void;
}
export interface CalendarIngressLifecycle {
  writePending(stateDir: string, value: { channelId: string; channelToken: string; endpoint: string; ttlSeconds: number; pendingUntil: string }): void;
  reconcile(stateDir: string, value: { channelId: string; resourceId: string; expiresAt: string; now: number }): { status: 'active' } | { status: 'cleanup_required'; code: string };
  markCleanupRequired(stateDir: string, channelId: string, code: 'calendar_channel_mismatch' | 'calendar_channel_expired' | 'calendar_channel_unavailable'): void;
  markStopped(stateDir: string, channelId: string): void;
}
export interface GoogleProviderDependencies {
  stateDir: string;
  now: () => number;
  http: (request: ProviderHttpRequest) => Promise<ProviderHttpResponse>;
  token: () => Promise<string>;
  uuid: () => string;
  secret: (bytes: number) => Buffer;
  files: SecureFileSystem;
  calendarIngress: CalendarIngressLifecycle;
  outcome?: (code: string) => void;
}
export interface MutationOptions { apply?: boolean; approval?: string; }
export interface LifecycleResult { code: string; applied: boolean; status?: string; handle?: string; nextRenewBy?: string; }

interface GmailLease {
  version: 1;
  status: 'active' | 'stopped';
  historyId: string;
  expiration: string;
  topic: string;
  lastSuccessAt: string;
  nextRenewBy: string;
  retry?: { attempt: number; nextAt: string };
}
interface CalendarControl {
  version: 1;
  channels: Array<{ handle: string; channelId: string; resourceId: string; expiresAt: string; status: 'active' | 'cleanup_required' | 'stopped'; createdAt: string; cleanupCode?: string }>;
}

export class GoogleProviderLifecycleError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const defaultSecureFileSystem: SecureFileSystem = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  atomicWrite(path, data, mode) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.tmp.google-provider.${process.pid}.${randomBytes(8).toString('hex')}`);
    try {
      writeFileSync(temp, `${data}\n`, { encoding: 'utf8', mode, flag: 'wx' });
      chmodSync(temp, mode);
      renameSync(temp, path);
      chmodSync(path, mode);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  },
};

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const iso = (value: number): string => new Date(value).toISOString();
const gmailLeasePath = (stateDir: string): string => join(stateDir, 'google-provider', 'gmail-lease.json');
const calendarControlPath = (stateDir: string): string => join(stateDir, 'google-provider', 'calendar-control.json');

function readJson<T>(deps: GoogleProviderDependencies, path: string, validate: (value: unknown) => value is T): T | undefined {
  if (!deps.files.exists(path)) return undefined;
  try { const value: unknown = JSON.parse(deps.files.read(path)); if (!validate(value)) throw new Error(); return value; }
  catch { throw new GoogleProviderLifecycleError('provider_state_invalid'); }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function canonicalHistory(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value) || value.length > 100) throw new GoogleProviderLifecycleError('gmail_response_invalid');
  return value;
}
function canonicalExpiration(value: unknown, now: number, code: string): string {
  const numeric = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric) || numeric <= now || numeric > now + 8 * DAY_MS) throw new GoogleProviderLifecycleError(code);
  return iso(numeric);
}
function isGmailLease(value: unknown): value is GmailLease {
  return object(value) && value.version === 1 && ['active', 'stopped'].includes(String(value.status)) && typeof value.historyId === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value.historyId) && value.historyId.length <= 100 && typeof value.expiration === 'string' && Number.isFinite(Date.parse(value.expiration)) && value.topic === digest(GOOGLE_PROVIDER_ALLOWLIST.topic) && typeof value.lastSuccessAt === 'string' && Number.isFinite(Date.parse(value.lastSuccessAt)) && typeof value.nextRenewBy === 'string' && Number.isFinite(Date.parse(value.nextRenewBy));
}
function isCalendarControl(value: unknown): value is CalendarControl {
  return object(value) && value.version === 1 && Array.isArray(value.channels) && value.channels.length <= 1_000 && value.channels.every((entry) => object(entry) && typeof entry.handle === 'string' && /^[a-f0-9]{24}$/.test(entry.handle) && typeof entry.channelId === 'string' && entry.channelId.length > 0 && entry.channelId.length <= 256 && typeof entry.resourceId === 'string' && entry.resourceId.length > 0 && entry.resourceId.length <= 512 && typeof entry.expiresAt === 'string' && Number.isFinite(Date.parse(entry.expiresAt)) && ['active', 'cleanup_required', 'stopped'].includes(String(entry.status)));
}
function writeJson(deps: GoogleProviderDependencies, path: string, value: unknown): void { deps.files.atomicWrite(path, JSON.stringify(value, null, 2), 0o600); }
function assertMutation(options: MutationOptions): boolean {
  if (!options.apply) return false;
  if (!options.approval || !/^[-A-Za-z0-9_/.]{3,128}$/.test(options.approval)) throw new GoogleProviderLifecycleError('provider_approval_required');
  return true;
}
async function request(deps: GoogleProviderDependencies, url: string, body?: unknown): Promise<unknown> {
  let token: string;
  try { token = await deps.token(); } catch { throw new GoogleProviderLifecycleError('provider_credential_unavailable'); }
  if (!token || token.length > 16_384 || /[\r\n]/.test(token)) throw new GoogleProviderLifecycleError('provider_credential_unavailable');
  let response: ProviderHttpResponse;
  try { response = await deps.http({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body }); }
  catch { throw new GoogleProviderLifecycleError('provider_request_failed'); }
  if (response.status < 200 || response.status >= 300) throw new GoogleProviderLifecycleError('provider_request_failed');
  return response.body;
}
function record(deps: GoogleProviderDependencies, result: LifecycleResult): LifecycleResult { deps.outcome?.(result.code); return result; }

export function gmailStatus(deps: GoogleProviderDependencies): LifecycleResult {
  const lease = readJson(deps, gmailLeasePath(deps.stateDir), isGmailLease);
  if (!lease) return record(deps, { code: 'gmail_lease_absent', applied: false, status: 'absent' });
  const status = lease.status === 'active' && Date.parse(lease.expiration) <= deps.now() ? 'expired' : lease.status;
  return record(deps, { code: `gmail_lease_${status}`, applied: false, status, nextRenewBy: lease.nextRenewBy });
}

async function gmailWatchApply(deps: GoogleProviderDependencies, renewing: boolean): Promise<LifecycleResult> {
  const prior = readJson(deps, gmailLeasePath(deps.stateDir), isGmailLease);
  let body: unknown;
  try {
    body = await request(deps, `${GOOGLE_PROVIDER_ALLOWLIST.gmailEndpoint}/watch`, {
      topicName: GOOGLE_PROVIDER_ALLOWLIST.topic,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    });
  } catch (error) {
    if (prior) {
      const attempt = Math.min((prior.retry?.attempt ?? 0) + 1, 8);
      const backoff = Math.min(2 ** (attempt - 1) * 300_000, 6 * 60 * 60_000);
      writeJson(deps, gmailLeasePath(deps.stateDir), { ...prior, retry: { attempt, nextAt: iso(Math.min(deps.now() + backoff, Date.parse(prior.expiration) - 60_000)) } });
    }
    throw error;
  }
  if (!object(body)) throw new GoogleProviderLifecycleError('gmail_response_invalid');
  const expiration = canonicalExpiration(body.expiration, deps.now(), 'gmail_response_invalid');
  const lease: GmailLease = {
    version: 1,
    status: 'active',
    historyId: canonicalHistory(body.historyId),
    expiration,
    topic: digest(GOOGLE_PROVIDER_ALLOWLIST.topic),
    lastSuccessAt: iso(deps.now()),
    nextRenewBy: iso(Math.min(Date.parse(expiration) - DAY_MS, deps.now() + DAY_MS)),
  };
  writeJson(deps, gmailLeasePath(deps.stateDir), lease);
  return record(deps, { code: renewing ? 'gmail_renewed' : 'gmail_watch_created', applied: true, status: 'active', nextRenewBy: lease.nextRenewBy });
}

export async function gmailWatch(deps: GoogleProviderDependencies, options: MutationOptions = {}): Promise<LifecycleResult> {
  if (!assertMutation(options)) return record(deps, { code: 'gmail_watch_dry_run', applied: false, status: 'dry_run' });
  return gmailWatchApply(deps, false);
}
export async function gmailRenew(deps: GoogleProviderDependencies, options: MutationOptions = {}): Promise<LifecycleResult> {
  if (!assertMutation(options)) return record(deps, { code: 'gmail_renew_dry_run', applied: false, status: 'dry_run' });
  const lease = readJson(deps, gmailLeasePath(deps.stateDir), isGmailLease);
  if (lease?.retry && deps.now() < Date.parse(lease.retry.nextAt)) return record(deps, { code: 'gmail_renew_retry_not_due', applied: false, status: lease.status, nextRenewBy: lease.retry.nextAt });
  if (lease?.status === 'active' && deps.now() < Date.parse(lease.nextRenewBy)) return record(deps, { code: 'gmail_renew_not_due', applied: false, status: 'active', nextRenewBy: lease.nextRenewBy });
  return gmailWatchApply(deps, true);
}
export async function gmailStop(deps: GoogleProviderDependencies, options: MutationOptions = {}): Promise<LifecycleResult> {
  if (!assertMutation(options)) return record(deps, { code: 'gmail_stop_dry_run', applied: false, status: 'dry_run' });
  const lease = readJson(deps, gmailLeasePath(deps.stateDir), isGmailLease);
  await request(deps, `${GOOGLE_PROVIDER_ALLOWLIST.gmailEndpoint}/stop`);
  if (lease) writeJson(deps, gmailLeasePath(deps.stateDir), { ...lease, status: 'stopped', lastSuccessAt: iso(deps.now()) });
  return record(deps, { code: 'gmail_watch_stopped', applied: true, status: 'stopped' });
}

function readControl(deps: GoogleProviderDependencies): CalendarControl { return readJson(deps, calendarControlPath(deps.stateDir), isCalendarControl) ?? { version: 1, channels: [] }; }
function writeControl(deps: GoogleProviderDependencies, control: CalendarControl): void { writeJson(deps, calendarControlPath(deps.stateDir), control); }
function calendarHandle(channelId: string): string { return digest(channelId).slice(0, 24); }
async function withCalendarLifecycleLock<T>(deps: GoogleProviderDependencies, operation: () => Promise<T>): Promise<T> {
  const lockRoot = join(deps.stateDir, 'google-provider-calendar-control-lock');
  mkdirSync(lockRoot, { recursive: true });
  return withFileLockAsync(lockRoot, operation, { timeoutMs: 30_000 });
}

export function calendarStatus(deps: GoogleProviderDependencies): LifecycleResult {
  const control = readControl(deps); const active = control.channels.filter((item) => item.status === 'active' && Date.parse(item.expiresAt) > deps.now()); const cleanup = control.channels.filter((item) => item.status === 'cleanup_required');
  return record(deps, { code: cleanup.length ? 'calendar_cleanup_required' : active.length ? 'calendar_channels_active' : 'calendar_channels_absent', applied: false, status: cleanup.length ? 'cleanup_required' : active.length ? 'active' : 'absent' });
}

async function stopRaw(deps: GoogleProviderDependencies, channelId: string, resourceId: string): Promise<void> {
  await request(deps, `${GOOGLE_PROVIDER_ALLOWLIST.calendarEndpoint}/channels/stop`, { id: channelId, resourceId });
}
async function calendarRegisterUnlocked(deps: GoogleProviderDependencies, options: MutationOptions): Promise<LifecycleResult> {
  if (!assertMutation(options)) return record(deps, { code: 'calendar_register_dry_run', applied: false, status: 'dry_run' });
  const channelId = deps.uuid(); const channelToken = deps.secret(32).toString('base64url');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelId) || channelToken.length < 32) throw new GoogleProviderLifecycleError('calendar_random_invalid');
  deps.calendarIngress.writePending(deps.stateDir, { channelId, channelToken, endpoint: GOOGLE_PROVIDER_ALLOWLIST.calendarWatchEndpoint, ttlSeconds: CALENDAR_TTL_SECONDS, pendingUntil: iso(deps.now() + PENDING_MS) });
  let response: unknown;
  try {
    response = await request(deps, `${GOOGLE_PROVIDER_ALLOWLIST.calendarEndpoint}/calendars/${encodeURIComponent(GOOGLE_PROVIDER_ALLOWLIST.calendar)}/events/watch`, { id: channelId, type: 'web_hook', address: GOOGLE_PROVIDER_ALLOWLIST.calendarWatchEndpoint, token: channelToken, params: { ttl: String(CALENDAR_TTL_SECONDS) } });
  } catch (error) {
    deps.calendarIngress.markCleanupRequired(deps.stateDir, channelId, 'calendar_channel_unavailable');
    throw error;
  }
  if (!object(response) || response.id !== channelId || typeof response.resourceId !== 'string' || !response.resourceId || response.resourceId.length > 512) {
    deps.calendarIngress.markCleanupRequired(deps.stateDir, channelId, 'calendar_channel_unavailable');
    if (object(response) && typeof response.id === 'string' && response.id && response.id.length <= 256 && typeof response.resourceId === 'string' && response.resourceId && response.resourceId.length <= 512) {
      try { await stopRaw(deps, response.id, response.resourceId); }
      catch {
        const control = readControl(deps); control.channels.push({ handle: calendarHandle(response.id), channelId: response.id, resourceId: response.resourceId, expiresAt: iso(deps.now() + 8 * DAY_MS), status: 'cleanup_required', createdAt: iso(deps.now()), cleanupCode: 'calendar_channel_unavailable' }); writeControl(deps, control);
      }
    }
    throw new GoogleProviderLifecycleError('calendar_response_invalid');
  }
  const resourceId = response.resourceId; let expiresAt: string;
  try { expiresAt = canonicalExpiration(response.expiration, deps.now(), 'calendar_response_invalid'); }
  catch (error) {
    deps.calendarIngress.markCleanupRequired(deps.stateDir, channelId, 'calendar_channel_unavailable');
    try { await stopRaw(deps, channelId, resourceId); }
    catch { const control = readControl(deps); control.channels.push({ handle: calendarHandle(channelId), channelId, resourceId, expiresAt: iso(deps.now() + 8 * DAY_MS), status: 'cleanup_required', createdAt: iso(deps.now()), cleanupCode: 'calendar_channel_unavailable' }); writeControl(deps, control); }
    throw error;
  }
  const reconciliation = deps.calendarIngress.reconcile(deps.stateDir, { channelId, resourceId, expiresAt, now: deps.now() });
  const handle = calendarHandle(channelId); const control = readControl(deps);
  if (reconciliation.status !== 'active') {
    let cleanupRequired = false;
    try { await stopRaw(deps, channelId, resourceId); } catch { cleanupRequired = true; }
    control.channels.push({ handle, channelId, resourceId, expiresAt, status: cleanupRequired ? 'cleanup_required' : 'stopped', createdAt: iso(deps.now()), cleanupCode: reconciliation.code });
    writeControl(deps, control);
    throw new GoogleProviderLifecycleError(cleanupRequired ? 'calendar_cleanup_required' : 'calendar_reconcile_failed');
  }
  control.channels.push({ handle, channelId, resourceId, expiresAt, status: 'active', createdAt: iso(deps.now()) });
  writeControl(deps, control);
  return record(deps, { code: 'calendar_channel_active', applied: true, status: 'active', handle });
}

export async function calendarRegister(deps: GoogleProviderDependencies, options: MutationOptions = {}): Promise<LifecycleResult> {
  if (!options.apply) return calendarRegisterUnlocked(deps, options);
  return withCalendarLifecycleLock(deps, () => calendarRegisterUnlocked(deps, options));
}

async function calendarStopUnlocked(deps: GoogleProviderDependencies, handle: string, options: MutationOptions): Promise<LifecycleResult> {
  if (!/^[a-f0-9]{24}$/.test(handle)) throw new GoogleProviderLifecycleError('calendar_handle_invalid');
  if (!assertMutation(options)) return record(deps, { code: 'calendar_stop_dry_run', applied: false, status: 'dry_run', handle });
  const control = readControl(deps); const channel = control.channels.find((item) => item.handle === handle && item.status !== 'stopped');
  if (!channel) throw new GoogleProviderLifecycleError('calendar_handle_unknown');
  const cleanupOnly = channel.status === 'cleanup_required';
  try { if (Date.parse(channel.expiresAt) > deps.now()) await stopRaw(deps, channel.channelId, channel.resourceId); }
  catch (error) { channel.status = 'cleanup_required'; channel.cleanupCode = 'calendar_channel_unavailable'; writeControl(deps, control); throw error; }
  try { deps.calendarIngress.markStopped(deps.stateDir, channel.channelId); }
  catch (error) { if (!cleanupOnly) { channel.status = 'cleanup_required'; channel.cleanupCode = 'calendar_channel_unavailable'; writeControl(deps, control); throw new GoogleProviderLifecycleError('calendar_cleanup_required'); } }
  channel.status = 'stopped'; delete channel.cleanupCode; writeControl(deps, control);
  return record(deps, { code: 'calendar_channel_stopped', applied: true, status: 'stopped', handle });
}

export async function calendarStop(deps: GoogleProviderDependencies, handle: string, options: MutationOptions = {}): Promise<LifecycleResult> {
  if (!options.apply) return calendarStopUnlocked(deps, handle, options);
  return withCalendarLifecycleLock(deps, () => calendarStopUnlocked(deps, handle, options));
}

export async function calendarRenew(deps: GoogleProviderDependencies, options: MutationOptions = {}): Promise<LifecycleResult> {
  if (!assertMutation(options)) return record(deps, { code: 'calendar_renew_dry_run', applied: false, status: 'dry_run' });
  return withCalendarLifecycleLock(deps, async () => {
    const before = readControl(deps);
    const due = before.channels.filter((item) => item.status === 'active' && Date.parse(item.expiresAt) <= deps.now() + DAY_MS);
    const cleanup = before.channels.filter((item) => item.status === 'cleanup_required');
    if (!due.length && !cleanup.length) return record(deps, { code: 'calendar_renew_not_due', applied: false, status: 'active' });
    const fresh = before.channels.find((item) => item.status === 'active' && Date.parse(item.expiresAt) > deps.now() + DAY_MS);
    const replacement = due.length && !fresh
      ? await calendarRegisterUnlocked(deps, options)
      : { code: 'calendar_replacement_reused', applied: false, status: 'active', handle: fresh?.handle };
    for (const old of [...due, ...cleanup]) await calendarStopUnlocked(deps, old.handle, options);
    return record(deps, { ...replacement, code: due.length ? 'calendar_channel_renewed' : 'calendar_cleanup_retried' });
  });
}

export function createDefaultGoogleProviderDependencies(stateDir: string, token: () => Promise<string>, calendarIngress: CalendarIngressLifecycle): GoogleProviderDependencies {
  return {
    stateDir, now: Date.now, token, calendarIngress, files: defaultSecureFileSystem,
    uuid: randomUUID, secret: randomBytes,
    http: async (requestOptions) => {
      const response = await fetch(requestOptions.url, { method: requestOptions.method, redirect: 'error', headers: requestOptions.headers, body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body), signal: AbortSignal.timeout(15_000) });
      const contentLength = Number(response.headers.get('content-length')); const contentType = response.headers.get('content-type') ?? '';
      if ((Number.isFinite(contentLength) && contentLength > 64 * 1024) || !contentType.toLowerCase().startsWith('application/json')) return { status: response.status, body: null };
      const text = await response.text(); let body: unknown = {};
      if (Buffer.byteLength(text) > 64 * 1024) body = null;
      else if (text) { try { body = JSON.parse(text); } catch { body = null; } }
      return { status: response.status, body };
    },
  };
}
