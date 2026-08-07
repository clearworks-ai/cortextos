import { createHash, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { join } from 'path';
import { recordIngressReceipt, recordRejectedIngressReceipt, type EventReceipt, type IngressEvent } from '../bus/event-delivery.js';
import { advanceNumericEventCursor, assertCanonicalNumericCursor, compareCanonicalNumericCursors, getEventCursor } from '../bus/event-receipt-index.js';
import { ShadowRouter } from '../bus/shadow-router.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

const GMAIL_BODY_LIMIT = 32 * 1024;
const CALENDAR_HEADER_LIMIT = 512;
const PROVIDER_RATE_LIMIT_MAX = 60;
const RATE_WINDOW_MS = 60_000;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GMAIL_SHADOW_MAILBOX = 'josh@clearworks.ai';

export interface GoogleOidcClaims { iss?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; email?: unknown; email_verified?: unknown; }
export type GoogleOidcVerifier = (jwt: string) => Promise<GoogleOidcClaims>;
export interface ProviderIngressDependencies {
  recordIngress?: typeof recordIngressReceipt;
  recordRejected?: typeof recordRejectedIngressReceipt;
  getCursor?: typeof getEventCursor;
  advanceCursor?: typeof advanceNumericEventCursor;
  makeRouter?: (stateDir: string) => ShadowRouter;
}
export interface GmailShadowOptions {
  audience: string;
  serviceAccount: string;
  subscription: string;
  verifyOidc?: GoogleOidcVerifier;
  maxTokenAgeSeconds?: number;
  clockSkewSeconds?: number;
  rateLimitMax?: number;
}
export interface CalendarShadowOptions { rateLimitMax?: number; }
export interface ProviderShadowOptions {
  stateDir: string;
  now: () => number;
  gmail?: GmailShadowOptions;
  calendar?: CalendarShadowOptions;
  dependencies?: ProviderIngressDependencies;
}
export interface CalendarShadowChannel { channelId: string; resourceId: string; channelToken: string; expiresAt: string; }
export interface CalendarPendingShadowChannel { channelId: string; channelToken: string; endpoint: string; ttlSeconds: number; pendingUntil: string; }
export interface CalendarShadowChannelActivation { channelId: string; resourceId: string; expiresAt: string; now: number; }
export interface CalendarShadowSyncBinding { channelId: string; resourceId: string; channelToken: string; expiresAt: string; now: number; }
export type CalendarShadowCleanupCode = 'calendar_channel_mismatch' | 'calendar_channel_expired' | 'calendar_channel_unavailable';
export type CalendarShadowReconciliation =
  | { status: 'active' }
  | { status: 'cleanup_required'; code: CalendarShadowCleanupCode };

interface RateBucket { startedAt: number; count: number; }
export type ProviderRateBuckets = Map<string, RateBucket>;

class ProviderError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const digestHex = (value: string): string => digest(value).toString('hex');
const safeEqual = (left: string, rightDigestHex: string): boolean => { const expected = Buffer.from(rightDigestHex, 'hex'); const actual = digest(left); return expected.length === actual.length && timingSafeEqual(actual, expected); };
const json = (response: ServerResponse, status: number, body: Record<string, unknown>): void => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };

function exactObject(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function uniqueHeader(request: IncomingMessage, name: string, required = true): string | undefined {
  const values: string[] = []; for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? '');
  if (values.length > 1) throw new ProviderError(400, 'calendar_duplicate_header');
  const value = values[0] ?? (Array.isArray(request.headers[name]) ? undefined : request.headers[name]);
  if (required && (typeof value !== 'string' || !value)) throw new ProviderError(400, 'calendar_missing_header');
  if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value) > CALENDAR_HEADER_LIMIT || /[\r\n]/.test(value))) throw new ProviderError(400, 'calendar_invalid_header');
  return value;
}
export async function readBoundedProviderBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => { const chunks: Buffer[] = []; let size = 0; let exceeded = false; request.on('data', (chunk: Buffer) => { if (exceeded) return; size += chunk.length; if (size > maxBytes) { exceeded = true; chunks.length = 0; reject(new ProviderError(413, 'provider_body_too_large')); request.resume(); return; } chunks.push(Buffer.from(chunk)); }); request.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks).toString('utf8')); }); request.on('error', () => { if (!exceeded) reject(new ProviderError(400, 'provider_body_invalid')); }); });
}
function consumeRate(provider: string, buckets: ProviderRateBuckets, now: number, max: number): boolean {
  const current = buckets.get(provider); const bucket = !current || now - current.startedAt >= RATE_WINDOW_MS ? { startedAt: now, count: 0 } : current;
  if (bucket.count >= max) { buckets.set(provider, bucket); return false; } bucket.count += 1; buckets.set(provider, bucket); return true;
}
function strictBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > GMAIL_BODY_LIMIT || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ProviderError(400, 'gmail_invalid_data');
  const decoded = Buffer.from(value, 'base64'); if (decoded.toString('base64') !== value || decoded.length > 4 * 1024) throw new ProviderError(400, 'gmail_invalid_data'); return decoded;
}
function canonicalMailbox(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderError(400, 'gmail_invalid_payload'); const mailbox = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox) || mailbox.length > 320) throw new ProviderError(400, 'gmail_invalid_payload'); return mailbox;
}
function canonicalNumber(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new ProviderError(400, code); try { assertCanonicalNumericCursor(value); } catch { throw new ProviderError(400, code); } return value;
}
function bearer(headers: IncomingHttpHeaders): string {
  const value = headers.authorization; if (typeof value !== 'string' || value.length > 8_200 || !value.startsWith('Bearer ') || value.slice(7).length === 0) throw new ProviderError(401, 'gmail_auth_invalid'); return value.slice(7);
}
async function authenticateGmail(request: IncomingMessage, config: GmailShadowOptions, nowMs: number): Promise<void> {
  if (!config.verifyOidc) throw new ProviderError(503, 'gmail_auth_unavailable');
  let claims: GoogleOidcClaims;
  try { claims = await config.verifyOidc(bearer(request.headers)); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'google_oidc_unavailable') throw new ProviderError(503, 'gmail_auth_unavailable');
    throw new ProviderError(401, 'gmail_auth_invalid');
  }
  const now = Math.floor(nowMs / 1_000); const skew = config.clockSkewSeconds ?? 60; const maxAge = config.maxTokenAgeSeconds ?? 600;
  if (!GOOGLE_ISSUERS.has(String(claims.iss)) || claims.aud !== config.audience || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || !Number.isInteger(claims.exp) || typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || !Number.isInteger(claims.iat) || claims.exp < now - skew || claims.iat > now + skew || claims.iat < now - maxAge - skew || claims.email_verified !== true || claims.email !== config.serviceAccount) throw new ProviderError(401, 'gmail_auth_invalid');
}
function dependencies(options: ProviderShadowOptions) {
  return { recordIngress: options.dependencies?.recordIngress ?? recordIngressReceipt, recordRejected: options.dependencies?.recordRejected ?? recordRejectedIngressReceipt, getCursor: options.dependencies?.getCursor ?? getEventCursor, advanceCursor: options.dependencies?.advanceCursor ?? advanceNumericEventCursor, makeRouter: options.dependencies?.makeRouter ?? ((stateDir: string) => new ShadowRouter('shadow', { stateDir })) };
}
function processMonotonic(options: ProviderShadowOptions, event: IngressEvent, cursorKey: string, value: string, route: string | undefined): { disposition: string; receipt: EventReceipt } {
  const deps = dependencies(options); const current = deps.getCursor(options.stateDir, cursorKey);
  if (current !== undefined && compareCanonicalNumericCursors(current, value) > 0) return { disposition: 'stale', receipt: deps.recordRejected(options.stateDir, event, 'stale_cursor') };
  const receipt = deps.recordIngress(options.stateDir, event);
  if (route) deps.makeRouter(options.stateDir).route(receipt, route, 'provider_shadow');
  deps.advanceCursor(options.stateDir, cursorKey, value);
  return { disposition: receipt.disposition ?? 'duplicate', receipt };
}

async function handleGmail(request: IncomingMessage, response: ServerResponse, options: ProviderShadowOptions, buckets: ProviderRateBuckets): Promise<void> {
  const config = options.gmail; if (!config || !consumeRate('gmail', buckets, options.now(), config.rateLimitMax ?? PROVIDER_RATE_LIMIT_MAX)) { if (config) response.setHeader('retry-after', '60'); throw new ProviderError(config ? 429 : 503, config ? 'gmail_rate_limited' : 'gmail_not_configured'); }
  const raw = await readBoundedProviderBody(request, GMAIL_BODY_LIMIT); await authenticateGmail(request, config, options.now());
  let envelope: unknown; try { envelope = JSON.parse(raw); } catch { throw new ProviderError(400, 'gmail_invalid_envelope'); }
  if (!exactObject(envelope, ['message', 'subscription']) || envelope.subscription !== config.subscription || !exactObject(envelope.message, ['data', 'messageId', 'publishTime']) || (envelope.message.messageId !== undefined && (typeof envelope.message.messageId !== 'string' || envelope.message.messageId.length > 256))) throw new ProviderError(400, 'gmail_invalid_envelope');
  let decoded: unknown; try { decoded = JSON.parse(strictBase64(envelope.message.data).toString('utf8')); } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError(400, 'gmail_invalid_payload'); }
  if (!exactObject(decoded, ['emailAddress', 'historyId']) || Object.keys(decoded).length !== 2) throw new ProviderError(400, 'gmail_invalid_payload');
  const mailbox = canonicalMailbox(decoded.emailAddress);
  if (mailbox !== GMAIL_SHADOW_MAILBOX) throw new ProviderError(400, 'gmail_invalid_payload');
  const historyId = canonicalNumber(decoded.historyId, 'gmail_invalid_history_id');
  const result = processMonotonic(options, { provider: 'gmail', eventType: 'notification', sourceId: `${mailbox}\u0000${historyId}` }, 'gmail.shadow.notification_high_water', historyId, 'pa.comms-check-worker');
  json(response, 200, { ok: true, mode: 'shadow', disposition: result.disposition });
}

interface StoredCalendarChannelV1 { version: 1; channel: string; resource: string; token: string; expiresAt: string; }
interface StoredCalendarPendingChannel {
  version: 2;
  status: 'pending';
  channel: string;
  resource: string | null;
  token: string;
  requested: { endpoint: string; ttlSeconds: number };
  pendingUntil: string;
  expiresAt: string | null;
}
interface StoredCalendarActiveChannel { version: 2; status: 'active'; channel: string; resource: string; token: string; expiresAt: string; }
interface StoredCalendarCleanupChannel {
  version: 2;
  status: 'cleanup_required';
  channel: string;
  resource: string | null;
  token: string;
  expiresAt: string | null;
  reason: CalendarShadowCleanupCode;
}
type StoredCalendarChannel = StoredCalendarChannelV1 | StoredCalendarPendingChannel | StoredCalendarActiveChannel | StoredCalendarCleanupChannel;
type UsableCalendarChannel = StoredCalendarChannelV1 | StoredCalendarPendingChannel | StoredCalendarActiveChannel;

const CALENDAR_DIGEST = /^[a-f0-9]{64}$/;
const CALENDAR_CLEANUP_CODES = new Set<StoredCalendarCleanupChannel['reason']>(['calendar_channel_mismatch', 'calendar_channel_expired', 'calendar_channel_unavailable']);
function channelPath(stateDir: string, channelId: string): string { return join(stateDir, 'calendar-shadow-channels', `${digestHex(channelId)}.json`); }
function channelLockDir(stateDir: string, channelId: string): string { return join(stateDir, 'calendar-shadow-channel-locks', digestHex(channelId)); }
function withCalendarChannelLock<T>(stateDir: string, channelId: string, fn: () => T): T {
  const lockDir = channelLockDir(stateDir, channelId);
  ensureDir(lockDir);
  return withFileLockSync(lockDir, fn);
}
function canonicalCalendarExpiration(value: string): string {
  const expires = /^\d{13}$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(expires)) throw new Error('invalid calendar shadow channel');
  return new Date(expires).toISOString();
}
function validDigest(value: unknown): value is string { return typeof value === 'string' && CALENDAR_DIGEST.test(value); }
function validIso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function validCalendarEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try { const endpoint = new URL(value); return endpoint.protocol === 'https:' && endpoint.username === '' && endpoint.password === '' && endpoint.hash === ''; }
  catch { return false; }
}
function writeStoredCalendarChannel(stateDir: string, channelId: string, stored: StoredCalendarChannel): void {
  ensureDir(join(stateDir, 'calendar-shadow-channels'));
  atomicWriteSync(channelPath(stateDir, channelId), JSON.stringify(stored));
}
export function writeCalendarShadowChannel(stateDir: string, channel: CalendarShadowChannel): void {
  if (!channel.channelId || channel.channelId.length > 256 || !channel.resourceId || channel.resourceId.length > 512 || !channel.channelToken || channel.channelToken.length > 512) throw new Error('invalid calendar shadow channel');
  const stored: StoredCalendarActiveChannel = { version: 2, status: 'active', channel: digestHex(channel.channelId), resource: digestHex(channel.resourceId), token: digestHex(channel.channelToken), expiresAt: canonicalCalendarExpiration(channel.expiresAt) };
  withCalendarChannelLock(stateDir, channel.channelId, () => {
    if (existsSync(channelPath(stateDir, channel.channelId))) {
      const current = readCalendarChannel(stateDir, channel.channelId);
      if (JSON.stringify(current) === JSON.stringify(stored)) return;
      throw new Error('calendar_channel_transition_conflict');
    }
    writeStoredCalendarChannel(stateDir, channel.channelId, stored);
  });
}
export function writePendingCalendarShadowChannel(stateDir: string, channel: CalendarPendingShadowChannel): void {
  const pendingUntil = canonicalCalendarExpiration(channel.pendingUntil);
  let endpoint: URL;
  try { endpoint = new URL(channel.endpoint); } catch { throw new Error('invalid calendar shadow pending channel'); }
  if (!channel.channelId || channel.channelId.length > 256 || !channel.channelToken || channel.channelToken.length > 512 || !validCalendarEndpoint(channel.endpoint) || !Number.isSafeInteger(channel.ttlSeconds) || channel.ttlSeconds <= 0 || channel.ttlSeconds > 604_800) throw new Error('invalid calendar shadow pending channel');
  const stored: StoredCalendarPendingChannel = { version: 2, status: 'pending', channel: digestHex(channel.channelId), resource: null, token: digestHex(channel.channelToken), requested: { endpoint: endpoint.toString(), ttlSeconds: channel.ttlSeconds }, pendingUntil, expiresAt: null };
  withCalendarChannelLock(stateDir, channel.channelId, () => {
    if (existsSync(channelPath(stateDir, channel.channelId))) {
      const current = readCalendarChannel(stateDir, channel.channelId);
      if (JSON.stringify(current) === JSON.stringify(stored)) return;
      throw new Error('calendar_channel_transition_conflict');
    }
    writeStoredCalendarChannel(stateDir, channel.channelId, stored);
  });
}
function parseCalendarChannel(value: unknown): StoredCalendarChannel {
  if (!exactObject(value, ['version', 'status', 'channel', 'resource', 'token', 'requested', 'pendingUntil', 'expiresAt', 'reason'])) throw new Error();
  if (value.version === 1 && exactObject(value, ['version', 'channel', 'resource', 'token', 'expiresAt']) && validDigest(value.channel) && validDigest(value.resource) && validDigest(value.token) && validIso(value.expiresAt)) return value as unknown as StoredCalendarChannelV1;
  if (value.version !== 2 || !validDigest(value.channel) || !validDigest(value.token)) throw new Error();
  if (value.status === 'active' && exactObject(value, ['version', 'status', 'channel', 'resource', 'token', 'expiresAt']) && validDigest(value.resource) && validIso(value.expiresAt)) return value as unknown as StoredCalendarActiveChannel;
  if (value.status === 'pending' && exactObject(value, ['version', 'status', 'channel', 'resource', 'token', 'requested', 'pendingUntil', 'expiresAt']) && (value.resource === null || validDigest(value.resource)) && exactObject(value.requested, ['endpoint', 'ttlSeconds']) && validCalendarEndpoint(value.requested.endpoint) && Number.isSafeInteger(value.requested.ttlSeconds) && (value.requested.ttlSeconds as number) > 0 && (value.requested.ttlSeconds as number) <= 604_800 && validIso(value.pendingUntil) && (value.expiresAt === null || validIso(value.expiresAt)) && ((value.resource === null) === (value.expiresAt === null))) return value as unknown as StoredCalendarPendingChannel;
  if (value.status === 'cleanup_required' && exactObject(value, ['version', 'status', 'channel', 'resource', 'token', 'expiresAt', 'reason']) && (value.resource === null || validDigest(value.resource)) && (value.expiresAt === null || validIso(value.expiresAt)) && typeof value.reason === 'string' && CALENDAR_CLEANUP_CODES.has(value.reason as StoredCalendarCleanupChannel['reason'])) return value as unknown as StoredCalendarCleanupChannel;
  throw new Error();
}
function readCalendarChannel(stateDir: string, channelId: string): StoredCalendarChannel {
  const path = channelPath(stateDir, channelId); if (!existsSync(path)) throw new ProviderError(401, 'calendar_channel_unknown');
  try { return parseCalendarChannel(JSON.parse(readFileSync(path, 'utf8'))); } catch { throw new ProviderError(503, 'calendar_channel_unavailable'); }
}
export function markCalendarShadowChannelCleanupRequired(stateDir: string, channelId: string, code: CalendarShadowCleanupCode): void {
  if (!CALENDAR_CLEANUP_CODES.has(code)) throw new Error('invalid calendar cleanup code');
  withCalendarChannelLock(stateDir, channelId, () => {
    const current = readCalendarChannel(stateDir, channelId);
    if (current.version === 2 && current.status === 'cleanup_required') return;
    const stored: StoredCalendarCleanupChannel = { version: 2, status: 'cleanup_required', channel: current.channel, resource: current.resource, token: current.token, expiresAt: current.expiresAt, reason: code };
    writeStoredCalendarChannel(stateDir, channelId, stored);
  });
}
export function markCalendarShadowChannelStopped(stateDir: string, channelId: string): void {
  if (!channelId || channelId.length > 256) throw new Error('invalid calendar shadow channel');
  withCalendarChannelLock(stateDir, channelId, () => {
    const path = channelPath(stateDir, channelId);
    if (!existsSync(path)) return;
    readCalendarChannel(stateDir, channelId);
    unlinkSync(path);
  });
}
export function reconcileCalendarShadowChannel(stateDir: string, activation: CalendarShadowChannelActivation): CalendarShadowReconciliation {
  if (!activation.channelId || activation.channelId.length > 256 || !activation.resourceId || activation.resourceId.length > 512 || !Number.isFinite(activation.now)) return { status: 'cleanup_required', code: 'calendar_channel_unavailable' };
  return withCalendarChannelLock(stateDir, activation.channelId, () => {
    let current: StoredCalendarChannel;
    try { current = readCalendarChannel(stateDir, activation.channelId); }
    catch { return { status: 'cleanup_required', code: 'calendar_channel_unavailable' }; }
    let expiresAt: string;
    try { expiresAt = canonicalCalendarExpiration(activation.expiresAt); }
    catch {
      if (!(current.version === 2 && current.status === 'cleanup_required')) writeStoredCalendarChannel(stateDir, activation.channelId, { version: 2, status: 'cleanup_required', channel: current.channel, resource: current.resource, token: current.token, expiresAt: current.expiresAt, reason: 'calendar_channel_unavailable' });
      return { status: 'cleanup_required', code: 'calendar_channel_unavailable' };
    }
    if (current.version === 2 && current.status === 'cleanup_required') return { status: 'cleanup_required', code: current.reason };
    const resource = digestHex(activation.resourceId);
    if (current.version !== 2 || current.status !== 'pending') {
      if (current.version === 2 && current.status === 'active' && current.resource === resource && current.expiresAt === expiresAt) return { status: 'active' };
      writeStoredCalendarChannel(stateDir, activation.channelId, { version: 2, status: 'cleanup_required', channel: current.channel, resource: current.resource, token: current.token, expiresAt: current.expiresAt, reason: 'calendar_channel_mismatch' });
      return { status: 'cleanup_required', code: 'calendar_channel_mismatch' };
    }
    if (Date.parse(current.pendingUntil) <= activation.now || Date.parse(expiresAt) <= activation.now) {
      writeStoredCalendarChannel(stateDir, activation.channelId, { version: 2, status: 'cleanup_required', channel: current.channel, resource: current.resource, token: current.token, expiresAt: current.expiresAt, reason: 'calendar_channel_expired' });
      return { status: 'cleanup_required', code: 'calendar_channel_expired' };
    }
    if ((current.resource !== null && current.resource !== resource) || (current.expiresAt !== null && current.expiresAt !== expiresAt)) {
      writeStoredCalendarChannel(stateDir, activation.channelId, { version: 2, status: 'cleanup_required', channel: current.channel, resource: current.resource, token: current.token, expiresAt: current.expiresAt, reason: 'calendar_channel_mismatch' });
      return { status: 'cleanup_required', code: 'calendar_channel_mismatch' };
    }
    writeStoredCalendarChannel(stateDir, activation.channelId, { version: 2, status: 'active', channel: current.channel, resource, token: current.token, expiresAt });
    return { status: 'active' };
  });
}
function validateAndBindCalendarNotification(stateDir: string, channelId: string, resourceId: string, token: string, state: string, expiration: string, now: number): UsableCalendarChannel {
  return withCalendarChannelLock(stateDir, channelId, () => {
    const configured = readCalendarChannel(stateDir, channelId);
    if (configured.channel !== digestHex(channelId)) throw new ProviderError(401, 'calendar_channel_mismatch');
    if (!safeEqual(token, configured.token)) throw new ProviderError(401, 'calendar_token_mismatch');
    if (configured.version === 2 && configured.status === 'cleanup_required') throw new ProviderError(503, 'calendar_cleanup_required');
    let expiresAt: string;
    try { expiresAt = canonicalCalendarExpiration(expiration); } catch { throw new ProviderError(401, 'calendar_channel_expired'); }
    const resource = digestHex(resourceId);
    if (configured.version === 2 && configured.status === 'pending') {
      if (state !== 'sync') throw new ProviderError(401, 'calendar_channel_pending');
      if (Date.parse(configured.pendingUntil) <= now || Date.parse(expiresAt) <= now) {
        writeStoredCalendarChannel(stateDir, channelId, { version: 2, status: 'cleanup_required', channel: configured.channel, resource: configured.resource, token: configured.token, expiresAt: configured.expiresAt, reason: 'calendar_channel_expired' });
        throw new ProviderError(401, 'calendar_channel_expired');
      }
      if ((configured.resource !== null && configured.resource !== resource) || (configured.expiresAt !== null && configured.expiresAt !== expiresAt)) {
        writeStoredCalendarChannel(stateDir, channelId, { version: 2, status: 'cleanup_required', channel: configured.channel, resource: configured.resource, token: configured.token, expiresAt: configured.expiresAt, reason: 'calendar_channel_mismatch' });
        throw new ProviderError(401, 'calendar_channel_mismatch');
      }
      if (configured.resource === null) {
        const bound: StoredCalendarPendingChannel = { ...configured, resource, expiresAt };
        writeStoredCalendarChannel(stateDir, channelId, bound);
        return bound;
      }
      return configured;
    }
    if (Date.parse(expiresAt) <= now || Date.parse(configured.expiresAt) <= now) {
      writeStoredCalendarChannel(stateDir, channelId, { version: 2, status: 'cleanup_required', channel: configured.channel, resource: configured.resource, token: configured.token, expiresAt: configured.expiresAt, reason: 'calendar_channel_expired' });
      throw new ProviderError(401, 'calendar_channel_expired');
    }
    if (configured.resource !== resource || configured.expiresAt !== expiresAt) {
      writeStoredCalendarChannel(stateDir, channelId, { version: 2, status: 'cleanup_required', channel: configured.channel, resource: configured.resource, token: configured.token, expiresAt: configured.expiresAt, reason: 'calendar_channel_mismatch' });
      throw new ProviderError(401, 'calendar_channel_mismatch');
    }
    return configured;
  });
}
export function bindCalendarShadowSync(stateDir: string, binding: CalendarShadowSyncBinding): void {
  validateAndBindCalendarNotification(stateDir, binding.channelId, binding.resourceId, binding.channelToken, 'sync', binding.expiresAt, binding.now);
}
async function handleCalendar(request: IncomingMessage, response: ServerResponse, options: ProviderShadowOptions, buckets: ProviderRateBuckets): Promise<void> {
  const config = options.calendar; if (!config || !consumeRate('calendar', buckets, options.now(), config.rateLimitMax ?? PROVIDER_RATE_LIMIT_MAX)) { if (config) response.setHeader('retry-after', '60'); throw new ProviderError(config ? 429 : 503, config ? 'calendar_rate_limited' : 'calendar_not_configured'); }
  let body: string; try { body = await readBoundedProviderBody(request, 0); } catch { throw new ProviderError(400, 'calendar_body_not_empty'); } if (body.length !== 0) throw new ProviderError(400, 'calendar_body_not_empty');
  const channelId = uniqueHeader(request, 'x-goog-channel-id')!; const resourceId = uniqueHeader(request, 'x-goog-resource-id')!; const state = uniqueHeader(request, 'x-goog-resource-state')!; const messageNumber = canonicalNumber(uniqueHeader(request, 'x-goog-message-number')!, 'calendar_invalid_message_number'); const expiration = uniqueHeader(request, 'x-goog-channel-expiration')!; const token = uniqueHeader(request, 'x-goog-channel-token')!;
  if (!['sync', 'exists', 'not_exists'].includes(state)) throw new ProviderError(400, 'calendar_invalid_state');
  validateAndBindCalendarNotification(options.stateDir, channelId, resourceId, token, state, expiration, options.now());
  const scope = digestHex(`${channelId}\u0000${resourceId}`).slice(0, 40); const result = processMonotonic(options, { provider: 'calendar', eventType: 'notification', sourceId: `${digestHex(channelId)}\u0000${digestHex(resourceId)}\u0000${messageNumber}` }, `calendar.shadow.notification_high_water:${scope}`, messageNumber, state === 'sync' ? undefined : 'pa.booking-calendar-delta');
  json(response, 200, { ok: true, mode: 'shadow', disposition: state === 'sync' && result.disposition === 'accepted' ? 'sync' : result.disposition });
}

export async function handleProviderShadowIngress(integration: string, request: IncomingMessage, response: ServerResponse, options: ProviderShadowOptions, buckets: ProviderRateBuckets): Promise<boolean> {
  if (integration !== 'gmail-pubsub' && integration !== 'calendar-watch') return false;
  try { if (integration === 'gmail-pubsub') await handleGmail(request, response, options, buckets); else await handleCalendar(request, response, options, buckets); }
  catch (error) {
    const safe = error instanceof ProviderError ? error : new ProviderError(503, 'provider_storage_failed');
    try { json(response, safe.status, { error: safe.code }); }
    catch { throw new ProviderError(503, 'provider_response_failed'); }
  }
  return true;
}
