import { createHash, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { join } from 'path';
import { recordIngressReceipt, recordRejectedIngressReceipt, type EventReceipt, type IngressEvent } from '../bus/event-delivery.js';
import { advanceNumericEventCursor, assertCanonicalNumericCursor, compareCanonicalNumericCursors, getEventCursor } from '../bus/event-receipt-index.js';
import { ShadowRouter } from '../bus/shadow-router.js';
import { resolveLaneMode, type LaneMode, type ProviderLane } from './provider-lane-config.js';
import { planWorkerSpawn, trySpawnWorkerForEvent, type WorkerSpawnTemplate } from '../daemon/worker-spawn-plan.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

const GMAIL_BODY_LIMIT = 32 * 1024;
const CALENDAR_HEADER_LIMIT = 512;
const PROVIDER_RATE_LIMIT_MAX = 60;
const RATE_WINDOW_MS = 60_000;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export interface GoogleOidcClaims { iss?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; email?: unknown; email_verified?: unknown; }
export type GoogleOidcVerifier = (jwt: string) => Promise<GoogleOidcClaims>;
export interface ProviderIngressDependencies {
  recordIngress?: typeof recordIngressReceipt;
  recordRejected?: typeof recordRejectedIngressReceipt;
  getCursor?: typeof getEventCursor;
  advanceCursor?: typeof advanceNumericEventCursor;
  makeRouter?: (stateDir: string, lane: ProviderLane) => ShadowRouter;
  /**
   * FR-E3 test seam: the guarded worker spawn used by a lane's ACTIVE path.
   * Defaults to the real `trySpawnWorkerForEvent` (IPC to the daemon). Tests
   * inject a stub to assert the plan (name + env) without a live daemon.
   */
  spawnWorker?: typeof trySpawnWorkerForEvent;
  /** Test seam for skill-path existence checks in the spawn template. */
  skillExists?: (path: string) => boolean;
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
  /**
   * Directory holding provider-config.json — the per-lane shadow|active flag
   * (FR-E2). When unset (or the file is absent/malformed) every lane resolves to
   * its safe `shadow` default, so behavior is unchanged from before FR-E2.
   */
  configDir?: string;
  /**
   * Framework root (absolute). Required for a lane's ACTIVE path to resolve the
   * target agent dir dynamically for a worker spawn (FR-E3). Absent => the active
   * path cannot file a spawn and falls back to shadow routing (no regression).
   */
  frameworkRoot?: string;
  /** Org name; required alongside frameworkRoot for a filable ACTIVE spawn. */
  org?: string;
  /** Instance id passed to the daemon IPC client for the ACTIVE spawn. */
  instanceId?: string;
}
export interface CalendarShadowChannel { channelId: string; resourceId: string; channelToken: string; expiresAt: string; }

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
  let claims: GoogleOidcClaims; try { claims = await config.verifyOidc(bearer(request.headers)); } catch { throw new ProviderError(401, 'gmail_auth_invalid'); }
  const now = Math.floor(nowMs / 1_000); const skew = config.clockSkewSeconds ?? 60; const maxAge = config.maxTokenAgeSeconds ?? 600;
  if (!GOOGLE_ISSUERS.has(String(claims.iss)) || claims.aud !== config.audience || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || !Number.isInteger(claims.exp) || typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || !Number.isInteger(claims.iat) || claims.exp < now - skew || claims.iat > now + skew || claims.iat < now - maxAge - skew || claims.email_verified !== true || claims.email !== config.serviceAccount) throw new ProviderError(401, 'gmail_auth_invalid');
}
function dependencies(options: ProviderShadowOptions) {
  // FR-E2: the per-lane mode is resolved from provider-config.json (default
  // `shadow`) at router-construction time. With no config dir/file the lane
  // stays shadow, identical to pre-FR-E2 behavior. Reaching `active` also needs
  // a delivery capability (ShadowRouter enforces this) which is intentionally
  // NOT wired here — that is the gated activation (FR-E3).
  const defaultMakeRouter = (stateDir: string, lane: ProviderLane): ShadowRouter => {
    const mode = options.configDir ? resolveLaneMode(options.configDir, lane) : 'shadow';
    return new ShadowRouter(mode, { stateDir });
  };
  return { recordIngress: options.dependencies?.recordIngress ?? recordIngressReceipt, recordRejected: options.dependencies?.recordRejected ?? recordRejectedIngressReceipt, getCursor: options.dependencies?.getCursor ?? getEventCursor, advanceCursor: options.dependencies?.advanceCursor ?? advanceNumericEventCursor, makeRouter: options.dependencies?.makeRouter ?? defaultMakeRouter, spawnWorker: options.dependencies?.spawnWorker ?? trySpawnWorkerForEvent };
}

/** Resolve a lane's mode the same way the router does — shadow unless a well-formed config flips it. */
function resolveMode(options: ProviderShadowOptions, lane: ProviderLane): LaneMode {
  return options.configDir ? resolveLaneMode(options.configDir, lane) : 'shadow';
}

/**
 * The Gmail (mail.human) comms-check lane, expressed as a generic worker-spawn
 * template (FR-E3) — the exact mirror of the fireflies meeting-writeback lane.
 * When the gmail lane is flipped to `active`, an inbound Pub/Sub notification
 * deterministically spawns the comms-check-worker with GMAIL_HISTORY_ID set (the
 * monotonic notification id), so a single-event triage runs now instead of
 * waiting for the poll. Returns null (caller stays in shadow) when the target
 * has no comms-check-worker skill or the inputs can't produce a filable spawn.
 */
function commsCheckWorkerTemplate(args: {
  frameworkRoot: string;
  org?: string;
  target: string;
  skillExists?: (path: string) => boolean;
}): WorkerSpawnTemplate {
  return {
    frameworkRoot: args.frameworkRoot,
    org: args.org,
    target: args.target,
    workerNamePrefix: 'comms-check',
    skillRelativePaths: [
      join('.claude', 'skills', 'comms-check-worker', 'SKILL.md'),
      join('plugins', 'comms-check-worker', 'SKILL.md'),
    ],
    buildPrompt: ({ skillRelativePath, eventId }) =>
      [
        'You are the comms-check worker (short-lived session).',
        `GMAIL_HISTORY_ID=${eventId} is set in your environment.`,
        `Read ${skillRelativePath} and execute it exactly,`,
        'then output DONE. Do nothing else — no heartbeat, no daily memory, no prose.',
      ].join(' '),
    buildEnv: (eventId) => ({ GMAIL_HISTORY_ID: eventId }),
    skillExists: args.skillExists,
  };
}
function processMonotonic(options: ProviderShadowOptions, event: IngressEvent, cursorKey: string, value: string, route: string | undefined, lane: ProviderLane): { disposition: string; receipt: EventReceipt } {
  const deps = dependencies(options); const current = deps.getCursor(options.stateDir, cursorKey);
  if (current !== undefined && compareCanonicalNumericCursors(current, value) > 0) return { disposition: 'stale', receipt: deps.recordRejected(options.stateDir, event, 'stale_cursor') };
  const receipt = deps.recordIngress(options.stateDir, event);
  if (route) deps.makeRouter(options.stateDir, lane).route(receipt, route, 'provider_shadow');
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
  const mailbox = canonicalMailbox(decoded.emailAddress); const historyId = canonicalNumber(decoded.historyId, 'gmail_invalid_history_id');
  const mode = resolveMode(options, 'gmail');
  // ACTIVE (FR-E3): the spawn IS the delivery, so skip shadow routing (an active
  // ShadowRouter would demand a transport capability). SHADOW keeps today's
  // behavior — record the routing proposal, spawn nothing.
  const shadowRoute = mode === 'active' ? undefined : 'pa.comms-check-worker';
  const result = processMonotonic(options, { provider: 'gmail', eventType: 'notification', sourceId: `${mailbox}\u0000${historyId}` }, 'gmail.shadow.notification_high_water', historyId, shadowRoute, 'gmail');
  // Spawn exactly once per event: gated on first-seen (`accepted`) — the monotonic
  // cursor already deduped duplicates/stale to non-accepted, so no double-fire.
  if (mode === 'active' && result.disposition === 'accepted' && options.frameworkRoot && options.org) {
    const deps = dependencies(options);
    await deps.spawnWorker(
      'gmail',
      () => planWorkerSpawn(commsCheckWorkerTemplate({ frameworkRoot: options.frameworkRoot as string, org: options.org, target: 'pa', skillExists: options.dependencies?.skillExists }), historyId),
      { instanceId: options.instanceId, parent: 'pa' },
    );
  }
  json(response, 200, { ok: true, mode, disposition: result.disposition });
}

interface StoredCalendarChannel { version: 1; channel: string; resource: string; token: string; expiresAt: string; }
function channelPath(stateDir: string, channelId: string): string { return join(stateDir, 'calendar-shadow-channels', `${digestHex(channelId)}.json`); }
export function writeCalendarShadowChannel(stateDir: string, channel: CalendarShadowChannel): void {
  const expires = Date.parse(channel.expiresAt); if (!channel.channelId || channel.channelId.length > 256 || !channel.resourceId || channel.resourceId.length > 512 || !channel.channelToken || channel.channelToken.length > 512 || !Number.isFinite(expires)) throw new Error('invalid calendar shadow channel');
  const stored: StoredCalendarChannel = { version: 1, channel: digestHex(channel.channelId), resource: digestHex(channel.resourceId), token: digestHex(channel.channelToken), expiresAt: new Date(expires).toISOString() };
  const path = channelPath(stateDir, channel.channelId); ensureDir(join(stateDir, 'calendar-shadow-channels')); atomicWriteSync(path, JSON.stringify(stored));
}
function readCalendarChannel(stateDir: string, channelId: string): StoredCalendarChannel {
  const path = channelPath(stateDir, channelId); if (!existsSync(path)) throw new ProviderError(401, 'calendar_channel_unknown');
  try { const value = JSON.parse(readFileSync(path, 'utf8')) as StoredCalendarChannel; if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.channel) || !/^[a-f0-9]{64}$/.test(value.resource) || !/^[a-f0-9]{64}$/.test(value.token) || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error(); return value; } catch { throw new ProviderError(503, 'calendar_channel_unavailable'); }
}
async function handleCalendar(request: IncomingMessage, response: ServerResponse, options: ProviderShadowOptions, buckets: ProviderRateBuckets): Promise<void> {
  const config = options.calendar; if (!config || !consumeRate('calendar', buckets, options.now(), config.rateLimitMax ?? PROVIDER_RATE_LIMIT_MAX)) { if (config) response.setHeader('retry-after', '60'); throw new ProviderError(config ? 429 : 503, config ? 'calendar_rate_limited' : 'calendar_not_configured'); }
  let body: string; try { body = await readBoundedProviderBody(request, 0); } catch { throw new ProviderError(400, 'calendar_body_not_empty'); } if (body.length !== 0) throw new ProviderError(400, 'calendar_body_not_empty');
  const channelId = uniqueHeader(request, 'x-goog-channel-id')!; const resourceId = uniqueHeader(request, 'x-goog-resource-id')!; const state = uniqueHeader(request, 'x-goog-resource-state')!; const messageNumber = canonicalNumber(uniqueHeader(request, 'x-goog-message-number')!, 'calendar_invalid_message_number'); const expiration = uniqueHeader(request, 'x-goog-channel-expiration')!; const token = uniqueHeader(request, 'x-goog-channel-token')!;
  if (!['sync', 'exists', 'not_exists'].includes(state)) throw new ProviderError(400, 'calendar_invalid_state');
  const configured = readCalendarChannel(options.stateDir, channelId); const expires = Date.parse(expiration); if (configured.channel !== digestHex(channelId) || configured.resource !== digestHex(resourceId)) throw new ProviderError(401, 'calendar_channel_mismatch'); if (!safeEqual(token, configured.token)) throw new ProviderError(401, 'calendar_token_mismatch'); if (!Number.isFinite(expires) || expires <= options.now() || new Date(expires).toISOString() !== configured.expiresAt || Date.parse(configured.expiresAt) <= options.now()) throw new ProviderError(401, 'calendar_channel_expired');
  const scope = digestHex(`${channelId}\u0000${resourceId}`).slice(0, 40); const result = processMonotonic(options, { provider: 'calendar', eventType: 'notification', sourceId: `${digestHex(channelId)}\u0000${digestHex(resourceId)}\u0000${messageNumber}` }, `calendar.shadow.notification_high_water:${scope}`, messageNumber, state === 'sync' ? undefined : 'pa.booking-calendar-delta', 'calendar');
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
