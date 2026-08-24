import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import { digestWithout } from './meeting-identity.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
export const REQUIRED_SINKS = [
  'briefs_projection',
  'crm_interaction',
  'lifecycle_projection',
  'followup_draft',
] as const;

export type RequiredSink = typeof REQUIRED_SINKS[number];
export type SinkState =
  | 'PENDING'
  | 'LEASED'
  | 'SUCCEEDED'
  | 'SKIPPED_POLICY'
  | 'RETRYABLE'
  | 'TERMINAL_FAILED'
  | 'UNKNOWN_COMMIT';

const LEGAL_PREVIOUS: Record<SinkState, Array<SinkState | null>> = {
  PENDING: [null],
  LEASED: ['PENDING', 'RETRYABLE'],
  SUCCEEDED: ['LEASED', 'UNKNOWN_COMMIT'],
  SKIPPED_POLICY: ['PENDING', 'LEASED'],
  RETRYABLE: ['LEASED'],
  TERMINAL_FAILED: ['LEASED', 'RETRYABLE', 'UNKNOWN_COMMIT'],
  UNKNOWN_COMMIT: ['LEASED', 'UNKNOWN_COMMIT'],
};

export class DeliveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryValidationError';
  }
}

export class DeliveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryConflictError';
  }
}

export interface SinkOutcome {
  state: SinkState;
  policyVersion?: string | null;
  reason?: string | null;
  errorCode?: string | null;
  readbackDigest?: string | null;
  providerId?: string | null;
  unknownProbeCount?: number;
  lastProbeAt?: string | null;
}

export interface PaEligibility {
  kind: 'normal_completion' | 'terminal_exception' | 'suppressed';
  failedSink?: RequiredSink;
}

function fsyncPath(filePath: string): void {
  const fd = openSync(filePath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function persistJson(path: string, value: Record<string, unknown>): void {
  atomicWriteSync(path, JSON.stringify(value, null, 2));
  fsyncPath(path);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_');
}

function envelopePath(storeDir: string, canonicalMeetingId: string): string {
  return join(storeDir, 'envelopes', `${safeId(canonicalMeetingId)}.json`);
}

function ackPath(storeDir: string, ackId: string): string {
  return join(storeDir, 'acks', `${safeId(ackId)}.json`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new DeliveryValidationError(`${label} must be a sha256 hex digest`);
  }
}

export function deliveryManifestDigest(envelope: Record<string, unknown>): string {
  return digestWithout(envelope, 'manifestDigest');
}

export function replicationAckDigest(ack: Record<string, unknown>): string {
  return digestWithout(ack, 'ackDigest');
}

function receiptsOf(envelope: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(envelope.upstreamReceipts)) {
    throw new DeliveryValidationError('upstreamReceipts is required');
  }
  return envelope.upstreamReceipts as Array<Record<string, unknown>>;
}

export function assertDeliveryEnvelope(envelope: Record<string, unknown>): void {
  if (envelope.schemaVersion !== '1.0') throw new DeliveryValidationError('unsupported delivery schemaVersion');
  if (typeof envelope.canonicalMeetingId !== 'string' || envelope.canonicalMeetingId.length < 1) {
    throw new DeliveryValidationError('canonicalMeetingId is required');
  }
  assertSha256(envelope.manifestDigest, 'manifestDigest');
  assertSha256(envelope.recordDigest, 'recordDigest');
  const receipts = receiptsOf(envelope);
  const sinks = receipts.map((receipt) => receipt.sink);
  if (sinks.length !== REQUIRED_SINKS.length || REQUIRED_SINKS.some((sink) => !sinks.includes(sink))) {
    throw new DeliveryValidationError('required sink set invalid');
  }
  if (new Set(sinks).size !== sinks.length) {
    throw new DeliveryValidationError('required sink set invalid');
  }
  for (const receipt of receipts) {
    if (receipt.recordDigest !== envelope.recordDigest) {
      throw new DeliveryValidationError('receipt record digest mismatch');
    }
    if (receipt.state === 'SKIPPED_POLICY' && receipt.sink !== 'followup_draft') {
      throw new DeliveryValidationError('only followup may skip');
    }
    if (receipt.state === 'SKIPPED_POLICY' && (!receipt.policyVersion || !receipt.reason)) {
      throw new DeliveryValidationError('policy skip lacks policy');
    }
    if (receipt.state === 'SUCCEEDED' && (!receipt.readbackDigest || !receipt.providerId)) {
      throw new DeliveryValidationError('succeeded receipt lacks readback');
    }
    if (['RETRYABLE', 'TERMINAL_FAILED'].includes(receipt.state as string) && !receipt.errorCode) {
      throw new DeliveryValidationError('failed receipt lacks error code');
    }
  }
  if (deliveryManifestDigest(envelope) !== envelope.manifestDigest) {
    throw new DeliveryValidationError('manifestDigest mismatch');
  }
}

export function upstreamSatisfied(envelope: Record<string, unknown>): boolean {
  return receiptsOf(envelope).every((receipt) => (
    receipt.state === 'SUCCEEDED'
    || (receipt.sink === 'followup_draft' && receipt.state === 'SKIPPED_POLICY')
  ));
}

export function evaluatePaEligibility(envelope: Record<string, unknown>): PaEligibility {
  const receipts = receiptsOf(envelope);
  const failed = receipts.find((receipt) => receipt.state === 'TERMINAL_FAILED');
  if (failed) {
    return { kind: 'terminal_exception', failedSink: failed.sink as RequiredSink };
  }
  const unknown = receipts.some((receipt) => receipt.state === 'UNKNOWN_COMMIT');
  const retrying = receipts.some((receipt) => ['PENDING', 'LEASED', 'RETRYABLE'].includes(receipt.state as string));
  if (unknown || retrying || !upstreamSatisfied(envelope)) {
    return { kind: 'suppressed' };
  }
  return { kind: 'normal_completion' };
}

export function acquireSinkLease(
  storeDir: string,
  canonicalMeetingId: string,
  sink: RequiredSink,
  lease: { owner: string; updatedAt: string; expiresAt: string },
): Record<string, unknown> {
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => {
    const path = envelopePath(storeDir, canonicalMeetingId);
    if (!existsSync(path)) throw new DeliveryValidationError('delivery envelope not found');
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assertDeliveryEnvelope(envelope);
    const receipt = receiptsOf(envelope).find((item) => item.sink === sink);
    if (!receipt) throw new DeliveryValidationError(`missing sink ${sink}`);
    if (!['PENDING', 'RETRYABLE'].includes(receipt.state as string)) {
      throw new DeliveryConflictError(`sink ${sink} is not leaseable from ${String(receipt.state)}`);
    }
    if (Date.parse(lease.expiresAt) <= Date.parse(lease.updatedAt)) {
      throw new DeliveryValidationError('leased receipt is not live at update');
    }
    receipt.previousState = receipt.state;
    receipt.state = 'LEASED';
    receipt.leaseOwner = lease.owner;
    receipt.leaseExpiresAt = lease.expiresAt;
    receipt.leaseVersion = Math.max(1, Number(receipt.leaseVersion ?? 0) + 1);
    receipt.updatedAt = lease.updatedAt;
    receipt.nextAttemptAt = null;
    receipt.unknownProbeCount = 0;
    receipt.lastProbeAt = null;
    envelope.manifestDigest = deliveryManifestDigest(envelope);
    persistJson(path, envelope);
    return envelope;
  });
}

export function persistDeliveryEnvelope(
  storeDir: string,
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  assertDeliveryEnvelope(envelope);
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => {
    const path = envelopePath(storeDir, envelope.canonicalMeetingId as string);
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      assertDeliveryEnvelope(existing);
      if (existing.manifestDigest !== envelope.manifestDigest) {
        throw new DeliveryConflictError('delivery envelope digest conflict');
      }
      return existing;
    }
    persistJson(path, envelope);
    return envelope;
  });
}

export function applySinkOutcome(
  storeDir: string,
  canonicalMeetingId: string,
  sink: RequiredSink,
  outcome: SinkOutcome,
): Record<string, unknown> {
  if (outcome.state === 'SKIPPED_POLICY' && sink !== 'followup_draft') {
    throw new DeliveryValidationError('only followup may skip');
  }
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => {
    const path = envelopePath(storeDir, canonicalMeetingId);
    if (!existsSync(path)) throw new DeliveryValidationError('delivery envelope not found');
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assertDeliveryEnvelope(envelope);
    const receipts = receiptsOf(envelope);
    const receipt = receipts.find((item) => item.sink === sink);
    if (!receipt) throw new DeliveryValidationError(`missing sink ${sink}`);
    if (!LEGAL_PREVIOUS[outcome.state].includes(receipt.state as SinkState | null)) {
      throw new DeliveryValidationError(`illegal receipt transition ${String(receipt.state)} -> ${outcome.state}`);
    }
    receipt.previousState = receipt.state;
    receipt.state = outcome.state;
    if (outcome.policyVersion !== undefined) receipt.policyVersion = outcome.policyVersion;
    if (outcome.reason !== undefined) receipt.reason = outcome.reason;
    if (outcome.errorCode !== undefined) receipt.errorCode = outcome.errorCode;
    if (outcome.readbackDigest !== undefined) receipt.readbackDigest = outcome.readbackDigest;
    if (outcome.providerId !== undefined) receipt.providerId = outcome.providerId;
    if (outcome.unknownProbeCount !== undefined) receipt.unknownProbeCount = outcome.unknownProbeCount;
    if (outcome.lastProbeAt !== undefined) receipt.lastProbeAt = outcome.lastProbeAt;
    if (['SUCCEEDED', 'SKIPPED_POLICY', 'TERMINAL_FAILED', 'UNKNOWN_COMMIT'].includes(outcome.state)) {
      receipt.nextAttemptAt = null;
    }
    if (outcome.state === 'TERMINAL_FAILED' && !receipt.errorCode) {
      throw new DeliveryValidationError('failed receipt lacks error code');
    }
    if (outcome.state === 'SKIPPED_POLICY' && (!receipt.policyVersion || !receipt.reason)) {
      throw new DeliveryValidationError('policy skip lacks policy');
    }
    envelope.manifestDigest = deliveryManifestDigest(envelope);
    persistJson(path, envelope);
    return envelope;
  });
}

export function persistReplicationAck(
  storeDir: string,
  ack: Record<string, unknown>,
): Record<string, unknown> {
  if (ack.schemaVersion !== '1.0') throw new DeliveryValidationError('unsupported replication ack schemaVersion');
  const ackId = ack.ackId;
  if (typeof ackId !== 'string' || ackId.length < 1) {
    throw new DeliveryValidationError('ackId is required');
  }
  assertSha256(ack.ackDigest, 'ackDigest');
  assertSha256(ack.recordDigest, 'recordDigest');
  assertSha256(ack.manifestDigest, 'manifestDigest');
  if (replicationAckDigest(ack) !== ack.ackDigest) {
    throw new DeliveryValidationError('ackDigest mismatch');
  }
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => {
    const envelopeFile = envelopePath(storeDir, ack.canonicalMeetingId as string);
    if (existsSync(envelopeFile)) {
      const envelope = JSON.parse(readFileSync(envelopeFile, 'utf8')) as Record<string, unknown>;
      if (envelope.recordDigest !== ack.recordDigest || envelope.manifestDigest !== ack.manifestDigest) {
        throw new DeliveryValidationError('ack/record binding mismatch');
      }
    }
    persistJson(ackPath(storeDir, ackId), ack);
    return ack;
  });
}
