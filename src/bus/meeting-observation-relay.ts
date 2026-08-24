import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLockSync } from '../utils/lock.js';
import {
  canonicalJson,
  digestWithout,
  observationStoragePath,
  persistCanonicalJsonFile,
  sha256Hex,
  type MeetingObservationV1,
} from './meeting-observation-ingress.js';

export const INTERNAL_RELAY_METHOD = 'POST';
export const INTERNAL_RELAY_PATH = '/internal/v1/meeting-observations';
export const RELAY_NONCE_STORE_ID = 'meeting-relay-nonce-store-v1' as const;
export const RELAY_LEASE_OWNER = 'cortext:fireflies-relay';
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_REPLAY_WINDOW_SECONDS = 300;

export interface InternalRelayHeaders {
  'X-Service-Key-Id'?: string;
  'X-Org-Id'?: string;
  'X-Request-Timestamp'?: string;
  'X-Request-Nonce'?: string;
  'X-Request-Signature'?: string;
  [header: string]: string | undefined;
}

export interface RelaySignableObservation {
  orgId: string;
  observationId: string;
  provider: string;
  providerSourceId: string;
  rawBodyDigest: string;
  relay: {
    idempotencyKey: string;
    intentDigest: string;
  };
}

export interface InternalAuthV1 {
  scheme: 'hmac-sha256-canonical-request-v1';
  keyId: string;
  method: 'POST';
  path: '/internal/v1/meeting-observations';
  timestamp: string;
  nonce: string;
  bodyDigest: string;
  canonicalRequestDigest: string;
  macHex: string;
}

export interface ReplayReceiptV1 {
  storeId: typeof RELAY_NONCE_STORE_ID;
  nonceKey: string;
  decision: 'accepted_new';
  acceptedAt: string;
  expiresAt: string;
  receiptMacHex: string;
}

export interface RelayedMeetingObservation extends Omit<MeetingObservationV1, 'relay'> {
  relay: Omit<MeetingObservationV1['relay'], 'state' | 'internalAuth' | 'replayReceipt' | 'relayReceiptDigest' | 'previousState' | 'attempt' | 'leaseVersion' | 'firstAttemptAt' | 'deadlineAt' | 'leaseOwner' | 'leaseExpiresAt' | 'errorCode'> & {
    state: 'RELAY_PENDING' | 'LEASED' | 'RETRYABLE' | 'RELAYED' | 'TERMINAL_FAILED' | 'UNKNOWN_COMMIT';
    relayReceiptDigest: string | null;
    internalAuth: InternalAuthV1 | null;
    replayReceipt: ReplayReceiptV1 | null;
    previousState: null | 'RELAY_PENDING' | 'LEASED' | 'RETRYABLE' | 'UNKNOWN_COMMIT';
    attempt: number;
    leaseVersion: number;
    firstAttemptAt: string | null;
    deadlineAt: string | null;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
    errorCode: string | null;
  };
}

export interface SignInternalRelayInput {
  observation: RelaySignableObservation;
  keyId: string;
  secret: string;
  timestamp: string;
  nonce: string;
}

export interface SignedInternalRelay {
  headers: Required<Pick<InternalRelayHeaders, 'X-Service-Key-Id' | 'X-Org-Id' | 'X-Request-Timestamp' | 'X-Request-Nonce' | 'X-Request-Signature'>>;
  canonicalRequestDigest: string;
  macHex: string;
  bodyDigest: string;
}

export interface AcceptInternalRelayInput {
  storeDir: string;
  observationId: string;
  method: string;
  path: string;
  rawBody: string;
  headers: InternalRelayHeaders;
  now: () => Date;
  secretsByKeyId: Record<string, string>;
  trustedKeyIds: string[];
  trustedOrgId: string;
  replayWindowSeconds?: number;
  maximumClockSkewSeconds?: number;
}

export interface AcceptInternalRelayResult {
  status: number;
  observation?: RelayedMeetingObservation;
  error?: string;
}

export function relayCanonicalPayload(
  observation: RelaySignableObservation,
  auth: { method: string; path: string; timestamp: string; nonce: string; bodyDigest: string },
): string {
  return canonicalJson({
    method: auth.method,
    path: auth.path,
    timestamp: auth.timestamp,
    nonce: auth.nonce,
    bodyDigest: auth.bodyDigest,
    rawBodyDigest: observation.rawBodyDigest,
    orgId: observation.orgId,
    observationId: observation.observationId,
    provider: observation.provider,
    providerSourceId: observation.providerSourceId,
    idempotencyKey: observation.relay.idempotencyKey,
    intentDigest: observation.relay.intentDigest,
  });
}

export function signInternalRelayRequest(input: SignInternalRelayInput): SignedInternalRelay {
  const bodyDigest = input.observation.rawBodyDigest;
  const payload = relayCanonicalPayload(input.observation, {
    method: INTERNAL_RELAY_METHOD,
    path: INTERNAL_RELAY_PATH,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodyDigest,
  });
  const macHex = createHmac('sha256', input.secret).update(payload).digest('hex');
  return {
    headers: {
      'X-Service-Key-Id': input.keyId,
      'X-Org-Id': input.observation.orgId,
      'X-Request-Timestamp': input.timestamp,
      'X-Request-Nonce': input.nonce,
      'X-Request-Signature': macHex,
    },
    canonicalRequestDigest: sha256Hex(payload),
    macHex,
    bodyDigest,
  };
}

function headerValue(headers: InternalRelayHeaders, name: string): string | undefined {
  const direct = headers[name];
  if (typeof direct === 'string') return direct;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof match?.[1] === 'string' ? match[1] : undefined;
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  const leftBuf = Buffer.from(left, 'hex');
  const rightBuf = Buffer.from(right, 'hex');
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

function serviceRelayEnabled(input: AcceptInternalRelayInput): boolean {
  if (typeof input.storeDir !== 'string' || input.storeDir.length === 0) return false;
  if (typeof input.trustedOrgId !== 'string' || input.trustedOrgId.length === 0) return false;
  if (!Array.isArray(input.trustedKeyIds) || input.trustedKeyIds.length === 0) return false;
  const window = input.replayWindowSeconds;
  if (typeof window !== 'number' || !Number.isFinite(window) || window < 1 || window > MAX_REPLAY_WINDOW_SECONDS) {
    return false;
  }
  return input.trustedKeyIds.some((keyId) => {
    const secret = input.secretsByKeyId[keyId];
    return typeof secret === 'string' && secret.length > 0;
  });
}

function noncePath(storeDir: string, nonceKey: string): string {
  return join(storeDir, 'nonces', `${nonceKey}.json`);
}

function readObservation(storeDir: string, observationId: string, orgId: string): RelayedMeetingObservation | null {
  const filePath = observationStoragePath(storeDir, observationId, orgId);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8')) as RelayedMeetingObservation;
}

export function acceptInternalRelay(input: AcceptInternalRelayInput): AcceptInternalRelayResult {
  const lockDir = join(input.storeDir, '.observation-lock');
  mkdirSync(lockDir, { recursive: true });
  mkdirSync(join(input.storeDir, 'nonces'), { recursive: true });
  mkdirSync(join(input.storeDir, 'observations'), { recursive: true });

  return withFileLockSync(lockDir, () => {
    const stored = readObservation(input.storeDir, input.observationId, input.trustedOrgId);
    if (!stored) {
      return { status: 404, error: 'observation_not_found' };
    }

    if (!serviceRelayEnabled(input)) {
      return { status: 503, observation: stored, error: 'relay_not_enabled' };
    }

    const keyId = headerValue(input.headers, 'X-Service-Key-Id');
    const orgId = headerValue(input.headers, 'X-Org-Id');
    const timestamp = headerValue(input.headers, 'X-Request-Timestamp');
    const nonce = headerValue(input.headers, 'X-Request-Nonce');
    const signature = headerValue(input.headers, 'X-Request-Signature');
    const secret = typeof keyId === 'string' ? input.secretsByKeyId[keyId] : undefined;

    if (
      input.method !== INTERNAL_RELAY_METHOD
      || input.path !== INTERNAL_RELAY_PATH
      || typeof keyId !== 'string'
      || typeof orgId !== 'string'
      || typeof timestamp !== 'string'
      || typeof nonce !== 'string'
      || typeof signature !== 'string'
      || typeof secret !== 'string'
      || secret.length === 0
      || !input.trustedKeyIds.includes(keyId)
      || orgId !== stored.orgId
      || orgId !== input.trustedOrgId
      || stored.orgId !== input.trustedOrgId
      || !NONCE_RE.test(nonce)
    ) {
      return { status: 401, observation: stored, error: 'invalid_internal_hmac' };
    }

    const bodyDigest = sha256Hex(input.rawBody);
    if (bodyDigest !== stored.rawBodyDigest) {
      return { status: 401, observation: stored, error: 'invalid_internal_hmac' };
    }

    const payload = relayCanonicalPayload(stored, {
      method: input.method,
      path: input.path,
      timestamp,
      nonce,
      bodyDigest,
    });
    const expectedMac = createHmac('sha256', secret).update(payload).digest('hex');
    if (!timingSafeHexEqual(signature, expectedMac)) {
      return { status: 401, observation: stored, error: 'invalid_internal_hmac' };
    }

    if (stored.relay.state === 'RELAYED' && stored.rawBodyDigest === bodyDigest) {
      return { status: 202, observation: stored };
    }

    const nowMs = input.now().getTime();
    const timestampMs = Date.parse(timestamp);
    const receivedMs = Date.parse(stored.receivedAt);
    const skewMs = (input.maximumClockSkewSeconds ?? MAX_REPLAY_WINDOW_SECONDS) * 1000;
    if (
      !Number.isFinite(timestampMs)
      || !Number.isFinite(receivedMs)
      || Math.abs(timestampMs - nowMs) > skewMs
      || Math.abs(timestampMs - receivedMs) > skewMs
    ) {
      return { status: 401, observation: stored, error: 'stale_timestamp' };
    }

    const replayWindowSeconds = input.replayWindowSeconds as number;
    const nonceKey = sha256Hex(canonicalJson({ orgId: stored.orgId, keyId, nonce }));
    const nonceFile = noncePath(input.storeDir, nonceKey);
    if (existsSync(nonceFile)) {
      const existingNonce = JSON.parse(readFileSync(nonceFile, 'utf8')) as { expiresAt: string };
      const expiresAt = Date.parse(existingNonce.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > nowMs) {
        return { status: 401, observation: stored, error: 'replayed_nonce' };
      }
    }

    const isoNow = input.now().toISOString();
    const persistedAt = stored.relay.durableReceipt.persistedAt;
    const firstAttemptCandidate = stored.relay.firstAttemptAt ?? isoNow;
    const firstAttemptAt = Date.parse(firstAttemptCandidate) < Date.parse(persistedAt)
      ? persistedAt
      : firstAttemptCandidate;
    const deadlineAt = stored.relay.deadlineAt ?? new Date(Date.parse(firstAttemptAt) + 15 * 60 * 1000).toISOString();
    const leaseExpiresAt = new Date(Date.parse(firstAttemptAt) + 60 * 1000).toISOString();
    const expiresAt = new Date(timestampMs + replayWindowSeconds * 1000).toISOString();
    const internalAuth: InternalAuthV1 = {
      scheme: 'hmac-sha256-canonical-request-v1',
      keyId,
      method: INTERNAL_RELAY_METHOD,
      path: INTERNAL_RELAY_PATH,
      timestamp,
      nonce,
      bodyDigest,
      canonicalRequestDigest: sha256Hex(payload),
      macHex: expectedMac,
    };
    const replayWithoutMac = {
      storeId: RELAY_NONCE_STORE_ID,
      nonceKey,
      decision: 'accepted_new' as const,
      acceptedAt: timestamp,
      expiresAt,
    };
    const replayReceipt: ReplayReceiptV1 = {
      ...replayWithoutMac,
      receiptMacHex: createHmac('sha256', secret).update(canonicalJson({
        orgId: stored.orgId,
        keyId,
        nonce,
        canonicalRequestDigest: internalAuth.canonicalRequestDigest,
        storeId: replayWithoutMac.storeId,
        nonceKey,
        decision: replayWithoutMac.decision,
        acceptedAt: replayWithoutMac.acceptedAt,
        expiresAt: replayWithoutMac.expiresAt,
      })).digest('hex'),
    };

    const relayed: RelayedMeetingObservation = {
      ...stored,
      observationDigest: '',
      relay: {
        ...stored.relay,
        state: 'RELAYED',
        intentDigest: stored.relay.intentDigest,
        relayReceiptDigest: expectedMac,
        idempotencyKey: stored.relay.idempotencyKey,
        durableReceipt: stored.relay.durableReceipt,
        internalAuth,
        replayReceipt,
        previousState: 'LEASED',
        attempt: stored.relay.attempt >= 1 ? stored.relay.attempt : 1,
        leaseVersion: stored.relay.leaseVersion >= 1 ? stored.relay.leaseVersion : 1,
        firstAttemptAt,
        deadlineAt,
        leaseOwner: RELAY_LEASE_OWNER,
        leaseExpiresAt,
        lastUpdatedAt: isoNow,
        errorCode: null,
      },
    };
    relayed.observationDigest = digestWithout('observationDigest', relayed as unknown as Record<string, unknown>);

    persistCanonicalJsonFile(nonceFile, {
      nonceKey,
      observationId: stored.observationId,
      acceptedAt: timestamp,
      expiresAt,
    });
    persistCanonicalJsonFile(observationStoragePath(input.storeDir, stored.observationId, stored.orgId), relayed);
    return { status: 202, observation: relayed };
  });
}
