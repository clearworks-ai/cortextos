import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import { digestWithout, sha256Canonical } from './meeting-identity.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

export class MeetingRecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingRecordValidationError';
  }
}

export class MeetingRecordConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingRecordConflictError';
  }
}

export interface ClaimCandidate {
  claimId: string;
  canonicalClaimId: string;
  identityBasisDigest: string;
  candidateContentDigest: string;
  evidenceRefs: string[];
  statement: string;
  claimKind: string;
  semanticClass: string;
}

export interface ClaimCandidateSetV1 {
  schemaVersion: '1.0';
  orgId: string;
  candidateSetId: string;
  candidateSetDigest: string;
  candidates: ClaimCandidate[];
}

export interface RecordSinks {
  crm: (record: Record<string, unknown>) => void;
  lifecycle: (record: Record<string, unknown>) => void;
  draft: (record: Record<string, unknown>) => void;
  pa: (record: Record<string, unknown>) => void;
}

export interface DeliverRecordInput {
  record: Record<string, unknown>;
  candidateSet: unknown;
  dispositionSet: Record<string, unknown>;
  authorityRegistry: Record<string, unknown>;
  authorityRoot: Record<string, unknown>;
  sinks: RecordSinks;
}

function fsyncPath(filePath: string): void {
  const fd = openSync(filePath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function recordPath(storeDir: string, canonicalMeetingId: string): string {
  return join(storeDir, `${canonicalMeetingId.replace(/[^a-zA-Z0-9._:-]/g, '_')}.json`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new MeetingRecordValidationError(`${label} must be a sha256 hex digest`);
  }
}

export function meetingRecordDigest(record: Record<string, unknown>): string {
  return digestWithout(record, 'recordDigest');
}

export function assertMeetingRecord(record: Record<string, unknown>): void {
  if (record.schemaVersion !== '1.0') throw new MeetingRecordValidationError('unsupported meeting record schemaVersion');
  if (typeof record.orgId !== 'string' || record.orgId.length < 1) {
    throw new MeetingRecordValidationError('orgId is required');
  }
  if (typeof record.canonicalMeetingId !== 'string' || record.canonicalMeetingId.length < 1) {
    throw new MeetingRecordValidationError('canonicalMeetingId is required');
  }
  if (!Number.isInteger(record.recordVersion) || (record.recordVersion as number) < 1) {
    throw new MeetingRecordValidationError('recordVersion must be an integer >= 1');
  }
  assertSha256(record.recordDigest, 'recordDigest');
  if (record.previousRecordDigest !== null) assertSha256(record.previousRecordDigest, 'previousRecordDigest');
  assertSha256(record.candidateSetDigest, 'candidateSetDigest');
  assertSha256(record.claimDispositionSetDigest, 'claimDispositionSetDigest');
  assertSha256(record.claimAuthorityRegistryDigest, 'claimAuthorityRegistryDigest');
  if (meetingRecordDigest(record) !== record.recordDigest) {
    throw new MeetingRecordValidationError('recordDigest mismatch');
  }
  if ((record.recordVersion as number) === 1 && record.previousRecordDigest !== null) {
    throw new MeetingRecordValidationError('record version 1 must have a null previousRecordDigest');
  }
  if ((record.recordVersion as number) > 1 && record.previousRecordDigest === null) {
    throw new MeetingRecordValidationError('record version > 1 must name previousRecordDigest');
  }
}

export function candidateSetDigest(candidateSet: ClaimCandidateSetV1): string {
  return digestWithout(candidateSet as unknown as Record<string, unknown>, 'candidateSetDigest');
}

export function parseCandidateSet(value: unknown): ClaimCandidateSetV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MeetingRecordValidationError('candidate set must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== '1.0') throw new MeetingRecordValidationError('unsupported candidate set schemaVersion');
  if (typeof raw.orgId !== 'string' || raw.orgId.length < 1) throw new MeetingRecordValidationError('candidate orgId is required');
  if (typeof raw.candidateSetId !== 'string' || raw.candidateSetId.length < 1) {
    throw new MeetingRecordValidationError('candidateSetId is required');
  }
  assertSha256(raw.candidateSetDigest, 'candidateSetDigest');
  if (!Array.isArray(raw.candidates) || raw.candidates.length < 1) {
    throw new MeetingRecordValidationError('candidate set must contain at least one candidate');
  }
  const candidates: ClaimCandidate[] = raw.candidates.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new MeetingRecordValidationError(`candidates[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.claimId !== 'string' || candidate.claimId.length < 1) {
      throw new MeetingRecordValidationError(`candidates[${index}].claimId is required`);
    }
    if (typeof candidate.statement !== 'string' || candidate.statement.trim().length < 1) {
      throw new MeetingRecordValidationError(`candidates[${index}].statement is required`);
    }
    if (typeof candidate.canonicalClaimId !== 'string' || candidate.canonicalClaimId.length < 1) {
      throw new MeetingRecordValidationError(`candidates[${index}].canonicalClaimId is required`);
    }
    assertSha256(candidate.identityBasisDigest, `candidates[${index}].identityBasisDigest`);
    assertSha256(candidate.candidateContentDigest, `candidates[${index}].candidateContentDigest`);
    if (!Array.isArray(candidate.evidenceRefs) || candidate.evidenceRefs.length < 1) {
      throw new MeetingRecordValidationError(`candidates[${index}].evidenceRefs is required`);
    }
    if (typeof candidate.claimKind !== 'string' || candidate.claimKind.length < 1) {
      throw new MeetingRecordValidationError(`candidates[${index}].claimKind is required`);
    }
    if (typeof candidate.semanticClass !== 'string' || candidate.semanticClass.length < 1) {
      throw new MeetingRecordValidationError(`candidates[${index}].semanticClass is required`);
    }
    return {
      claimId: candidate.claimId,
      canonicalClaimId: candidate.canonicalClaimId,
      identityBasisDigest: candidate.identityBasisDigest,
      candidateContentDigest: candidate.candidateContentDigest,
      evidenceRefs: candidate.evidenceRefs as string[],
      statement: candidate.statement,
      claimKind: candidate.claimKind,
      semanticClass: candidate.semanticClass,
    };
  });

  const parsed: ClaimCandidateSetV1 = {
    schemaVersion: '1.0',
    orgId: raw.orgId,
    candidateSetId: raw.candidateSetId,
    candidateSetDigest: raw.candidateSetDigest,
    candidates,
  };
  if (candidateSetDigest(parsed) !== parsed.candidateSetDigest) {
    throw new MeetingRecordValidationError('candidateSetDigest mismatch');
  }
  return parsed;
}

export function persistMeetingRecord(storeDir: string, record: Record<string, unknown>): Record<string, unknown> {
  assertMeetingRecord(record);
  ensureDir(storeDir);
  const canonicalMeetingId = record.canonicalMeetingId as string;
  const path = recordPath(storeDir, canonicalMeetingId);

  return withFileLockSync(storeDir, () => {
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      assertMeetingRecord(existing);
      const existingVersion = existing.recordVersion as number;
      const nextVersion = record.recordVersion as number;
      if (nextVersion === existingVersion) {
        if (existing.recordDigest !== record.recordDigest) {
          throw new MeetingRecordConflictError('same-version digest conflict');
        }
        return existing;
      }
      if (nextVersion < existingVersion) {
        throw new MeetingRecordConflictError('refusing a lower record version');
      }
      if (nextVersion !== existingVersion + 1) {
        throw new MeetingRecordConflictError('record version gap');
      }
      if (record.previousRecordDigest !== existing.recordDigest) {
        throw new MeetingRecordConflictError('previousRecordDigest does not match the stored record');
      }
    } else if ((record.recordVersion as number) !== 1) {
      throw new MeetingRecordConflictError('first persisted record must be version 1');
    }

    atomicWriteSync(path, JSON.stringify(record, null, 2));
    fsyncPath(path);
    return record;
  });
}

export function readMeetingRecord(storeDir: string, canonicalMeetingId: string): Record<string, unknown> {
  const path = recordPath(storeDir, canonicalMeetingId);
  if (!existsSync(path)) throw new MeetingRecordValidationError('meeting record not found');
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assertMeetingRecord(record);
  return record;
}

export function deliverRecordToSinks(input: DeliverRecordInput): void {
  assertMeetingRecord(input.record);
  const candidateSet = parseCandidateSet(input.candidateSet);

  if (typeof input.dispositionSet.dispositionSetDigest !== 'string') {
    throw new MeetingRecordValidationError('disposition set is required');
  }
  if (typeof input.authorityRegistry.registryDigest !== 'string') {
    throw new MeetingRecordValidationError('authority registry is required');
  }
  if (typeof input.authorityRoot.rootDigest !== 'string') {
    throw new MeetingRecordValidationError('authority root is required');
  }
  if (candidateSet.candidateSetDigest !== input.record.candidateSetDigest) {
    throw new MeetingRecordValidationError('candidate set is not bound to the record');
  }
  if (input.dispositionSet.dispositionSetDigest !== input.record.claimDispositionSetDigest) {
    throw new MeetingRecordValidationError('disposition set is not bound to the record');
  }
  if (input.authorityRegistry.registryDigest !== input.record.claimAuthorityRegistryDigest) {
    throw new MeetingRecordValidationError('authority registry is not bound to the record');
  }

  input.sinks.crm(input.record);
  input.sinks.lifecycle(input.record);
  input.sinks.draft(input.record);
  input.sinks.pa(input.record);
}

export function candidateSetFromRecordClaims(record: Record<string, unknown>): string {
  const claims = Array.isArray(record.claims) ? record.claims as Array<Record<string, unknown>> : [];
  const candidates = claims
    .map((claim) => ({
      claimId: claim.claimId,
      canonicalClaimId: claim.canonicalClaimId,
      identityBasisDigest: claim.identityBasisDigest,
      candidateContentDigest: claim.candidateContentDigest,
      evidenceRefs: [...(claim.evidenceRefs as string[])].sort(),
    }))
    .sort((left, right) => String(left.claimId).localeCompare(String(right.claimId)));
  return sha256Canonical(candidates);
}
