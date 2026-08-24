import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLockSync } from '../utils/lock.js';

const SIGNATURE_HEADER = 'X-Hub-Signature';
const SIGNATURE_EXACT = /^sha256=[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const STORE_ID = 'meeting-observation-store-v1';

export interface FirefliesVerificationConfigV1 {
  schemaVersion: string;
  orgId: string;
  provider: string;
  configId: string;
  configVersion: string;
  configDigest: string;
  validFrom: string;
  validUntil: string;
  scheme: string;
  headerName: string;
  providerDocsSource: string;
  activeKeyId: string;
  keys: Array<{ keyId: string; status: string; validFrom: string; validUntil: string }>;
  rotation: Record<string, unknown>;
}

export interface MeetingObservationV1 {
  schemaVersion: '1.0';
  orgId: string;
  observationId: string;
  observationDigest: string;
  provider: 'fireflies';
  providerSourceId: string;
  receivedAt: string;
  rawBodyDigest: string;
  signatureVerification: {
    scheme: 'hmac-sha256-raw-body';
    headerName: 'X-Hub-Signature';
    headerValueDigest: string;
    keyId: string;
    keyConfigVersion: string;
    verificationConfigDigest: string;
    providerDocsSource: 'https://docs.fireflies.ai/graphql-api/webhooks-v2';
    verifiedAt: string;
    verificationReceiptDigest: string;
    verified: true;
  };
  relay: {
    state: 'RELAY_PENDING';
    intentDigest: string;
    relayReceiptDigest: null;
    idempotencyKey: string;
    durableReceipt: {
      storeId: typeof STORE_ID;
      storageKey: string;
      observationId: string;
      rawBodyDigest: string;
      persistedAt: string;
      durability: 'fsync_committed';
      receiptDigest: string;
    };
    internalAuth: null;
    replayReceipt: null;
    previousState: null;
    attempt: 0;
    leaseVersion: 0;
    firstAttemptAt: null;
    deadlineAt: null;
    leaseOwner: null;
    leaseExpiresAt: null;
    lastUpdatedAt: string;
    errorCode: null;
  };
}

export interface FirefliesIngressInput {
  rawBody: string;
  headerName: string | undefined;
  signatureHeader: string | undefined;
  orgId: string;
  now: () => Date;
  storeDir: string;
  secretsByKeyId: Record<string, string>;
  verificationConfig: FirefliesVerificationConfigV1;
  verificationConfigDigest: string;
  requestId?: string;
  quarantineKey?: string;
}

export interface PreRecordIngressFailureV1 {
  schemaVersion: '1.0';
  orgId: string;
  failureId: string;
  failureDigest: string;
  provider: 'fireflies';
  stage: 'parse' | 'auth' | 'persist';
  authenticationState: 'unverified' | 'verified';
  sourceIdentity: {
    requestId: string;
    providerSourceId: string | null;
    rawBodyDigest: string;
    receivedAt: string;
    sourceIdentityDigest: string;
  };
  errorCode: 'INGRESS_PARSE_FAILED' | 'INGRESS_AUTH_FAILED' | 'INGRESS_PERSIST_FAILED';
  retryable: boolean;
  failedAt: string;
  encryptedQuarantine: {
    state: 'ENCRYPTED' | 'DELETED';
    reference: string;
    ciphertextDigest: string;
    encryptionKeyId: string;
    encryptedAt: string;
    expiresAt: string;
  } | null;
  piiSafeAlertReceipt: {
    alertId: string;
    errorCode: 'INGRESS_PARSE_FAILED' | 'INGRESS_AUTH_FAILED' | 'INGRESS_PERSIST_FAILED';
    summaryCode: 'PRE_RECORD_PARSE_FAILURE' | 'PRE_RECORD_AUTH_FAILURE' | 'PRE_RECORD_PERSIST_FAILURE';
    rawBodyIncluded: false;
    providerPayloadIncluded: false;
    createdAt: string;
    receiptDigest: string;
  };
  deletionReceipt: {
    state: 'SCHEDULED' | 'DELETED';
    scheduledFor: string;
    deletedAt: string | null;
    quarantineReferenceDigest: string;
    receiptDigest: string;
  } | null;
}

export interface FirefliesIngressResult {
  status: number;
  observation?: MeetingObservationV1;
  failure?: PreRecordIngressFailureV1;
  error?: string;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('unserializable value');
}

export function digestWithout(field: string, value: Record<string, unknown>): string {
  const clone = { ...value };
  delete clone[field];
  return sha256Hex(canonicalJson(clone));
}

function headerNameMatches(provided: string | undefined): boolean {
  return typeof provided === 'string' && provided.toLowerCase() === SIGNATURE_HEADER.toLowerCase();
}

function providerSignatureValid(input: FirefliesIngressInput): boolean {
  if (!headerNameMatches(input.headerName)) return false;
  if (typeof input.signatureHeader !== 'string' || !SIGNATURE_EXACT.test(input.signatureHeader)) {
    return false;
  }
  if (input.verificationConfig.scheme !== 'hmac-sha256-raw-body') return false;
  if (input.verificationConfig.headerName !== SIGNATURE_HEADER) return false;
  if (input.verificationConfigDigest !== input.verificationConfig.configDigest) return false;
  if (!SHA256_HEX.test(input.verificationConfigDigest)) return false;

  const secret = input.secretsByKeyId[input.verificationConfig.activeKeyId];
  if (typeof secret !== 'string' || secret.length === 0) return false;

  const expected = createHmac('sha256', secret).update(input.rawBody, 'utf8').digest('hex');
  const provided = input.signatureHeader.slice('sha256='.length);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

function parseProviderSourceId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const meetingId = parsed.meeting_id ?? parsed.meetingId;
    if (typeof meetingId === 'string' && meetingId.trim().length > 0) return meetingId.trim();
    const nested = parsed.data;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedId = (nested as Record<string, unknown>).meetingId
        ?? (nested as Record<string, unknown>).meeting_id;
      if (typeof nestedId === 'string' && nestedId.trim().length > 0) return nestedId.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function fsyncRenameWrite(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(dirname(filePath), `.tmp.${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeSync(fd, data, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  const dirFd = openSync(dirname(filePath), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function observationStoragePath(storeDir: string, observationId: string): string {
  return join(storeDir, 'observations', `${observationId.replaceAll(':', '_')}.json`);
}

export function persistCanonicalJsonFile(filePath: string, value: unknown): void {
  fsyncRenameWrite(filePath, `${canonicalJson(value)}\n`);
}

function buildPendingObservation(input: FirefliesIngressInput, providerSourceId: string): MeetingObservationV1 {
  const isoNow = input.now().toISOString();
  const rawBodyDigest = sha256Hex(input.rawBody);
  const observationId = `observation:fireflies:${providerSourceId}`;
  const storageKey = `${input.orgId}:${observationId}`;
  const headerValueDigest = sha256Hex(input.signatureHeader as string);
  const verificationReceiptDigest = sha256Hex(canonicalJson({
    provider: 'fireflies',
    providerSourceId,
    rawBodyDigest,
    scheme: 'hmac-sha256-raw-body',
    headerName: SIGNATURE_HEADER,
    headerValueDigest,
    keyId: input.verificationConfig.activeKeyId,
    keyConfigVersion: input.verificationConfig.configVersion,
    verificationConfigDigest: input.verificationConfigDigest,
    providerDocsSource: 'https://docs.fireflies.ai/graphql-api/webhooks-v2',
    verifiedAt: isoNow,
    verified: true,
  }));
  const intentDigest = sha256Hex(canonicalJson({
    orgId: input.orgId,
    observationId,
    provider: 'fireflies',
    providerSourceId,
    rawBodyDigest,
  }));
  const durableWithoutDigest = {
    storeId: STORE_ID,
    storageKey,
    observationId,
    rawBodyDigest,
    persistedAt: isoNow,
    durability: 'fsync_committed' as const,
  };
  const observation: MeetingObservationV1 = {
    schemaVersion: '1.0',
    orgId: input.orgId,
    observationId,
    observationDigest: '',
    provider: 'fireflies',
    providerSourceId,
    receivedAt: isoNow,
    rawBodyDigest,
    signatureVerification: {
      scheme: 'hmac-sha256-raw-body',
      headerName: SIGNATURE_HEADER,
      headerValueDigest,
      keyId: input.verificationConfig.activeKeyId,
      keyConfigVersion: input.verificationConfig.configVersion,
      verificationConfigDigest: input.verificationConfigDigest,
      providerDocsSource: 'https://docs.fireflies.ai/graphql-api/webhooks-v2',
      verifiedAt: isoNow,
      verificationReceiptDigest,
      verified: true,
    },
    relay: {
      state: 'RELAY_PENDING',
      intentDigest,
      relayReceiptDigest: null,
      idempotencyKey: `fireflies:${providerSourceId}:relay:v1`,
      durableReceipt: {
        ...durableWithoutDigest,
        receiptDigest: digestWithout('receiptDigest', { ...durableWithoutDigest, receiptDigest: '' }),
      },
      internalAuth: null,
      replayReceipt: null,
      previousState: null,
      attempt: 0,
      leaseVersion: 0,
      firstAttemptAt: null,
      deadlineAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastUpdatedAt: isoNow,
      errorCode: null,
    },
  };
  observation.observationDigest = digestWithout('observationDigest', observation as unknown as Record<string, unknown>);
  return observation;
}

function requestIdFor(input: FirefliesIngressInput): string {
  if (typeof input.requestId === 'string' && input.requestId.length > 0) return input.requestId;
  return `request:fireflies:webhook:${sha256Hex(input.rawBody).slice(0, 16)}`;
}

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

function persistBinary(filePath: string, data: Buffer): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(dirname(filePath), `.tmp.${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  const dirFd = openSync(dirname(filePath), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function encryptQuarantine(rawBody: string, quarantineKey: string): { blob: Buffer; digest: string } {
  const key = createHash('sha256').update(quarantineKey, 'utf8').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(rawBody, 'utf8'), cipher.final()]);
  const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  return { blob, digest: sha256Hex(blob) };
}

function persistPreRecordFailure(
  input: FirefliesIngressInput,
  stage: 'auth' | 'persist',
  providerSourceId: string | null,
): PreRecordIngressFailureV1 {
  const receivedAt = input.now().toISOString();
  const failedAt = receivedAt;
  const alertedAt = receivedAt;
  const requestId = requestIdFor(input);
  const rawBodyDigest = sha256Hex(input.rawBody);
  const sourceIdentityWithoutDigest = {
    requestId,
    providerSourceId,
    rawBodyDigest,
    receivedAt,
  };
  const errorCode = stage === 'auth' ? 'INGRESS_AUTH_FAILED' as const : 'INGRESS_PERSIST_FAILED' as const;
  const summaryCode = stage === 'auth' ? 'PRE_RECORD_AUTH_FAILURE' as const : 'PRE_RECORD_PERSIST_FAILURE' as const;
  const alertWithoutDigest = {
    alertId: `alert:pre-record:${requestId}`,
    errorCode,
    summaryCode,
    rawBodyIncluded: false as const,
    providerPayloadIncluded: false as const,
    createdAt: alertedAt,
  };

  let encryptedQuarantine: PreRecordIngressFailureV1['encryptedQuarantine'] = null;
  let deletionReceipt: PreRecordIngressFailureV1['deletionReceipt'] = null;
  if (stage === 'persist') {
    const quarantineKey = input.quarantineKey;
    if (typeof quarantineKey !== 'string' || quarantineKey.length === 0) {
      throw new Error('quarantine key required for authenticated persist failure');
    }
    const encryptedAt = failedAt;
    const expiresAt = addHours(receivedAt, 24);
    const day = receivedAt.slice(0, 10);
    const reference = `encrypted-quarantine://fireflies/${day}/${requestId.replace(/[^A-Za-z0-9._-]/g, '_')}.bin`;
    const encrypted = encryptQuarantine(input.rawBody, quarantineKey);
    const quarantinePath = join(input.storeDir, 'quarantine', `${sha256Hex(reference)}.bin`);
    persistBinary(quarantinePath, encrypted.blob);
    encryptedQuarantine = {
      state: 'ENCRYPTED',
      reference,
      ciphertextDigest: encrypted.digest,
      encryptionKeyId: 'ingress-quarantine-key-v1',
      encryptedAt,
      expiresAt,
    };
    const deletionWithoutDigest = {
      state: 'SCHEDULED' as const,
      scheduledFor: expiresAt,
      deletedAt: null,
      quarantineReferenceDigest: sha256Hex(reference),
    };
    deletionReceipt = {
      ...deletionWithoutDigest,
      receiptDigest: digestWithout('receiptDigest', { ...deletionWithoutDigest, receiptDigest: '' }),
    };
  }

  const failure: PreRecordIngressFailureV1 = {
    schemaVersion: '1.0',
    orgId: input.orgId,
    failureId: `pre-record-failure:fireflies:${requestId}:${stage}`,
    failureDigest: '',
    provider: 'fireflies',
    stage,
    authenticationState: stage === 'auth' ? 'unverified' : 'verified',
    sourceIdentity: {
      ...sourceIdentityWithoutDigest,
      sourceIdentityDigest: digestWithout('sourceIdentityDigest', { ...sourceIdentityWithoutDigest, sourceIdentityDigest: '' }),
    },
    errorCode,
    retryable: stage === 'persist',
    failedAt,
    encryptedQuarantine,
    piiSafeAlertReceipt: {
      ...alertWithoutDigest,
      receiptDigest: digestWithout('receiptDigest', { ...alertWithoutDigest, receiptDigest: '' }),
    },
    deletionReceipt,
  };
  failure.failureDigest = digestWithout('failureDigest', failure as unknown as Record<string, unknown>);
  const failurePath = join(input.storeDir, 'failures', `${failure.failureId.replaceAll(':', '_')}.json`);
  persistCanonicalJsonFile(failurePath, failure);
  return failure;
}

export function acceptFirefliesIngress(input: FirefliesIngressInput): FirefliesIngressResult {
  if (!providerSignatureValid(input)) {
    const failure = persistPreRecordFailure(input, 'auth', null);
    return { status: 401, error: 'invalid_signature', failure };
  }

  const providerSourceId = parseProviderSourceId(input.rawBody);
  if (providerSourceId === null) {
    const failure = persistPreRecordFailure(input, 'persist', null);
    return { status: 400, error: 'unpersistable_authenticated_body', failure };
  }

  let observation = buildPendingObservation(input, providerSourceId);
  const filePath = observationStoragePath(input.storeDir, observation.observationId);
  const lockDir = join(input.storeDir, '.observation-lock');
  mkdirSync(lockDir, { recursive: true });

  withFileLockSync(lockDir, () => {
    if (existsSync(filePath)) {
      const existing = JSON.parse(readFileSync(filePath, 'utf8')) as MeetingObservationV1;
      if (existing.rawBodyDigest === observation.rawBodyDigest) {
        observation = existing;
        return;
      }
    }
    fsyncRenameWrite(filePath, `${canonicalJson(observation)}\n`);
  });

  return { status: 202, observation };
}
