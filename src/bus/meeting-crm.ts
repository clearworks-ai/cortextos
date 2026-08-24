import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import { digestWithout, sha256Canonical } from './meeting-identity.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const REQUIRED_WRITE_SET_OPS = [
  'upsert_account',
  'upsert_contact',
  'upsert_engagement',
  'upsert_interaction',
  'upsert_lifecycle',
] as const;

export class CrmWriteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrmWriteValidationError';
  }
}

export class CrmWriteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrmWriteConflictError';
  }
}

export type CrmActor = 'service' | 'browser';

function fsyncPath(filePath: string): void {
  const fd = openSync(filePath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_');
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new CrmWriteValidationError(`${label} must be a sha256 hex digest`);
  }
}

function persistJson(path: string, value: Record<string, unknown>): void {
  atomicWriteSync(path, JSON.stringify(value, null, 2));
  fsyncPath(path);
}

function requestPath(storeDir: string, clientRequestId: string): string {
  return join(storeDir, 'requests', `${safeId(clientRequestId)}.json`);
}

function intentPath(storeDir: string, intentId: string): string {
  return join(storeDir, 'intents', `${safeId(intentId)}.json`);
}

function idempotencyPath(storeDir: string, idempotencyKey: string): string {
  return join(storeDir, 'idempotency', `${safeId(idempotencyKey)}.json`);
}

function writeSetPath(storeDir: string, writeSetId: string): string {
  return join(storeDir, 'write-sets', `${safeId(writeSetId)}.json`);
}

export function crmRequestDigest(request: Record<string, unknown>): string {
  return digestWithout(request, 'requestDigest');
}

export function crmIntentDigest(intent: Record<string, unknown>): string {
  return digestWithout(intent, 'intentDigest');
}

export function crmWriteSetDigest(writeSet: Record<string, unknown>): string {
  return digestWithout(writeSet, 'writeSetDigest');
}

export function assertCrmWriteIntentRequest(request: Record<string, unknown>): void {
  if (request.schemaVersion !== '1.0') throw new CrmWriteValidationError('unsupported CRM request schemaVersion');
  if (typeof request.orgId !== 'string' || request.orgId.length < 1) {
    throw new CrmWriteValidationError('orgId is required');
  }
  if (typeof request.clientRequestId !== 'string' || request.clientRequestId.length < 1) {
    throw new CrmWriteValidationError('clientRequestId is required');
  }
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length < 1) {
    throw new CrmWriteValidationError('idempotencyKey is required');
  }
  if (typeof request.requestKind !== 'string' || request.requestKind.length < 1) {
    throw new CrmWriteValidationError('requestKind is required');
  }
  if (typeof request.operation !== 'string' || request.operation.length < 1) {
    throw new CrmWriteValidationError('operation is required');
  }
  assertSha256(request.requestDigest, 'requestDigest');
  assertSha256(request.recordDigest, 'recordDigest');
  assertSha256(request.proposedValueDigest, 'proposedValueDigest');
  if (crmRequestDigest(request) !== request.requestDigest) {
    throw new CrmWriteValidationError('requestDigest mismatch');
  }
  if (sha256Canonical(request.proposedValue) !== request.proposedValueDigest) {
    throw new CrmWriteValidationError('proposedValueDigest mismatch');
  }
}

export function assertCrmWriteIntent(intent: Record<string, unknown>): void {
  if (intent.schemaVersion !== '1.0') throw new CrmWriteValidationError('unsupported CRM intent schemaVersion');
  if (typeof intent.intentId !== 'string' || intent.intentId.length < 1) {
    throw new CrmWriteValidationError('intentId is required');
  }
  if (typeof intent.state !== 'string' || intent.state.length < 1) {
    throw new CrmWriteValidationError('state is required');
  }
  assertSha256(intent.intentDigest, 'intentDigest');
  assertSha256(intent.requestDigest, 'requestDigest');
  if (crmIntentDigest(intent) !== intent.intentDigest) {
    throw new CrmWriteValidationError('intentDigest mismatch');
  }
}

export function assertCrmWriteSet(writeSet: Record<string, unknown>): void {
  if (writeSet.schemaVersion !== '1.0') throw new CrmWriteValidationError('unsupported CRM write-set schemaVersion');
  if (typeof writeSet.writeSetId !== 'string' || writeSet.writeSetId.length < 1) {
    throw new CrmWriteValidationError('writeSetId is required');
  }
  assertSha256(writeSet.writeSetDigest, 'writeSetDigest');
  assertSha256(writeSet.recordDigest, 'recordDigest');
  if (!Array.isArray(writeSet.expectedWrites) || writeSet.expectedWrites.length !== 5) {
    throw new CrmWriteValidationError('CRM write set must contain exactly five expected writes');
  }
  const operations = writeSet.expectedWrites.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CrmWriteValidationError(`expectedWrites[${index}] must be an object`);
    }
    const write = item as Record<string, unknown>;
    if (typeof write.operation !== 'string') {
      throw new CrmWriteValidationError(`expectedWrites[${index}].operation is required`);
    }
    return write.operation;
  });
  for (const required of REQUIRED_WRITE_SET_OPS) {
    if (!operations.includes(required)) {
      throw new CrmWriteValidationError(`CRM write set is missing ${required}`);
    }
  }
  if (crmWriteSetDigest(writeSet) !== writeSet.writeSetDigest) {
    throw new CrmWriteValidationError('writeSetDigest mismatch');
  }
}

function persistRequestLocked(storeDir: string, request: Record<string, unknown>): Record<string, unknown> {
  assertCrmWriteIntentRequest(request);
  const keyPath = idempotencyPath(storeDir, request.idempotencyKey as string);
  const path = requestPath(storeDir, request.clientRequestId as string);
  if (existsSync(keyPath)) {
    const existing = JSON.parse(readFileSync(keyPath, 'utf8')) as Record<string, unknown>;
    if (existing.requestDigest !== request.requestDigest) {
      throw new CrmWriteConflictError('same idempotency key with a different request digest');
    }
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assertCrmWriteIntentRequest(stored);
    return stored;
  }
  persistJson(path, request);
  persistJson(keyPath, {
    clientRequestId: request.clientRequestId,
    requestDigest: request.requestDigest,
    idempotencyKey: request.idempotencyKey,
  });
  return request;
}

export function persistCrmWriteIntentRequest(
  storeDir: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => persistRequestLocked(storeDir, request));
}

export function submitCrmWriteIntentRequest(
  storeDir: string,
  request: Record<string, unknown>,
  actor: CrmActor,
): Record<string, unknown> {
  if (actor === 'browser' && request.requestKind === 'system_exact') {
    throw new CrmWriteValidationError('browser actors cannot issue system_exact CRM writes');
  }
  return persistCrmWriteIntentRequest(storeDir, request);
}

export function persistCrmWriteIntent(
  storeDir: string,
  intent: Record<string, unknown>,
): Record<string, unknown> {
  assertCrmWriteIntent(intent);
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => {
    const path = intentPath(storeDir, intent.intentId as string);
    persistJson(path, intent);
    return intent;
  });
}

export function acceptServiceExactIntent(
  storeDir: string,
  input: {
    request: Record<string, unknown>;
    intentId: string;
    acceptedAt: string;
    updatedAt: string;
  },
): Record<string, unknown> {
  const request = submitCrmWriteIntentRequest(storeDir, input.request, 'service');
  const intent: Record<string, unknown> = {
    ...structuredClone(request),
    intentId: input.intentId,
    acceptedAt: input.acceptedAt,
    authoritativeReadbackVersion: null,
    authoritativeReadbackDigest: null,
    reconciliationReceipt: null,
    state: 'accepted_pending',
    stateVersion: 1,
    previousIntentDigest: null,
    rejectionCode: null,
    updatedAt: input.updatedAt,
  };
  intent.intentDigest = crmIntentDigest(intent);
  return persistCrmWriteIntent(storeDir, intent);
}

export function applyIntentWithReadback(
  storeDir: string,
  intentId: string,
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => {
    const path = intentPath(storeDir, intentId);
    if (!existsSync(path)) throw new CrmWriteValidationError('CRM intent not found');
    const pending = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assertCrmWriteIntent(pending);
    if (pending.state !== 'accepted_pending') {
      throw new CrmWriteConflictError('CRM intent is not accepted_pending');
    }
    if (typeof snapshot.sourceVersion !== 'string' || snapshot.sourceVersion.length < 1) {
      throw new CrmWriteValidationError('CRM snapshot sourceVersion is required');
    }
    assertSha256(snapshot.sourceDigest, 'sourceDigest');
    const applied: Record<string, unknown> = {
      ...pending,
      authoritativeReadbackVersion: snapshot.sourceVersion,
      authoritativeReadbackDigest: snapshot.sourceDigest,
      state: 'applied',
      stateVersion: (pending.stateVersion as number) + 1,
      previousIntentDigest: pending.intentDigest,
      updatedAt: typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt : pending.updatedAt,
    };
    applied.intentDigest = crmIntentDigest(applied);
    persistJson(path, applied);
    return applied;
  });
}

export function persistCrmWriteSet(
  storeDir: string,
  writeSet: Record<string, unknown>,
  requests: Record<string, unknown>[],
  intents: Record<string, unknown>[],
): Record<string, unknown> {
  assertCrmWriteSet(writeSet);
  if (requests.length !== 5 || intents.length !== 5) {
    throw new CrmWriteValidationError('CRM write-set artifacts must include five requests and five intents');
  }
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => {
    for (const request of requests) persistRequestLocked(storeDir, request);
    for (const intent of intents) {
      assertCrmWriteIntent(intent);
      persistJson(intentPath(storeDir, intent.intentId as string), intent);
    }
    persistJson(writeSetPath(storeDir, writeSet.writeSetId as string), writeSet);
    return writeSet;
  });
}
