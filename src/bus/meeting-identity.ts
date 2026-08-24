import { createHash } from 'crypto';
import { closeSync, fsyncSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export type TranscriptState = 'available' | 'missing' | 'unavailable';
export type ObservationState = 'active' | 'superseded' | 'quarantined';
export type OverrideAuthorityKind = 'user' | 'admin';

export interface IdentityOverrideAuthority {
  kind: OverrideAuthorityKind;
  actorId: string;
  policyVersion: string;
  decisionDigest: string;
  decidedAt: string;
}

export interface IdentityOverrideV1 {
  schemaVersion: '1.0';
  orgId: string;
  overrideId: string;
  overrideVersion: number;
  overrideDigest: string;
  supersedesOverrideDigest: string | null;
  sourceIds: string[];
  canonicalSourceId: string;
  reason: string;
  selectionPolicyVersion: string;
  authority: IdentityOverrideAuthority;
  createdAt: string;
}

export interface SourceObservationInput {
  sourceId: string;
  provider: 'fireflies';
  capturedAt: string;
  startedAt: string;
  transcriptState: TranscriptState;
  transcriptDigest: string | null;
  evidenceDigest: string;
  segmentCount: number | null;
  normalizedWordCount: number | null;
  durationSeconds: number | null;
  evidenceArtifactCount: number | null;
  title: string | null;
  rawEvidence: unknown;
}

export interface ProjectedObservation extends SourceObservationInput {
  state: ObservationState;
  supersededBy: string | null;
  lineageDigest: string;
  dispositionReason: string | null;
  tombstoneId: string | null;
  reingestAllowed: boolean;
  retiredIdentity: boolean;
}

export interface IdentityMeeting {
  canonicalSourceId: string;
  overrideId: string | null;
  overrideVersion: number | null;
  overrideDigest: string | null;
  observations: ProjectedObservation[];
}

export interface IdentityProjection {
  meetings: IdentityMeeting[];
}

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export class IdentityAmbiguityError extends IdentityError {
  constructor(message = 'ambiguous evidence tuple') {
    super(message);
    this.name = 'IdentityAmbiguityError';
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function digestWithout(value: Record<string, unknown>, field: string): string {
  const payload = structuredClone(value);
  delete payload[field];
  return sha256Canonical(payload);
}

export function identityOverrideDigest(override: IdentityOverrideV1): string {
  return digestWithout(override as unknown as Record<string, unknown>, 'overrideDigest');
}

export function identityDecisionDigest(override: IdentityOverrideV1): string {
  return sha256Canonical({
    orgId: override.orgId,
    overrideId: override.overrideId,
    overrideVersion: override.overrideVersion,
    supersedesOverrideDigest: override.supersedesOverrideDigest,
    sourceIds: [...override.sourceIds].sort(),
    canonicalSourceId: override.canonicalSourceId,
    reason: override.reason,
    selectionPolicyVersion: override.selectionPolicyVersion,
    kind: override.authority.kind,
    actorId: override.authority.actorId,
    policyVersion: override.authority.policyVersion,
    decidedAt: override.authority.decidedAt,
  });
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new IdentityError(`${label} must be a sha256 hex digest`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1) {
    throw new IdentityError(`${label} must be a non-empty string`);
  }
}

function assertDateTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DATETIME_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new IdentityError(`${label} must be an RFC 3339 timestamp`);
  }
}

export function parseIdentityOverride(value: unknown): IdentityOverrideV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityError('identity override must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== '1.0') throw new IdentityError('unsupported identity override schemaVersion');
  assertNonEmptyString(raw.orgId, 'orgId');
  assertNonEmptyString(raw.overrideId, 'overrideId');
  if (!Number.isInteger(raw.overrideVersion) || (raw.overrideVersion as number) < 1) {
    throw new IdentityError('overrideVersion must be an integer >= 1');
  }
  assertSha256(raw.overrideDigest, 'overrideDigest');
  if (raw.supersedesOverrideDigest !== null) assertSha256(raw.supersedesOverrideDigest, 'supersedesOverrideDigest');
  if (!Array.isArray(raw.sourceIds) || raw.sourceIds.length < 2) {
    throw new IdentityError('sourceIds must contain at least two source IDs');
  }
  const sourceIds = raw.sourceIds.map((id, index) => {
    assertNonEmptyString(id, `sourceIds[${index}]`);
    return id;
  });
  if (new Set(sourceIds).size !== sourceIds.length) throw new IdentityError('sourceIds must be unique');
  assertNonEmptyString(raw.canonicalSourceId, 'canonicalSourceId');
  if (!sourceIds.includes(raw.canonicalSourceId)) {
    throw new IdentityError('canonicalSourceId must be a member of sourceIds');
  }
  assertNonEmptyString(raw.reason, 'reason');
  assertNonEmptyString(raw.selectionPolicyVersion, 'selectionPolicyVersion');
  assertDateTime(raw.createdAt, 'createdAt');
  if (!raw.authority || typeof raw.authority !== 'object' || Array.isArray(raw.authority)) {
    throw new IdentityError('authority must be an object');
  }
  const authorityRaw = raw.authority as Record<string, unknown>;
  if (authorityRaw.kind !== 'user' && authorityRaw.kind !== 'admin') {
    throw new IdentityError('authority.kind must be user or admin');
  }
  assertNonEmptyString(authorityRaw.actorId, 'authority.actorId');
  assertNonEmptyString(authorityRaw.policyVersion, 'authority.policyVersion');
  assertSha256(authorityRaw.decisionDigest, 'authority.decisionDigest');
  assertDateTime(authorityRaw.decidedAt, 'authority.decidedAt');

  const override: IdentityOverrideV1 = {
    schemaVersion: '1.0',
    orgId: raw.orgId,
    overrideId: raw.overrideId,
    overrideVersion: raw.overrideVersion as number,
    overrideDigest: raw.overrideDigest,
    supersedesOverrideDigest: raw.supersedesOverrideDigest as string | null,
    sourceIds,
    canonicalSourceId: raw.canonicalSourceId,
    reason: raw.reason,
    selectionPolicyVersion: raw.selectionPolicyVersion,
    authority: {
      kind: authorityRaw.kind,
      actorId: authorityRaw.actorId,
      policyVersion: authorityRaw.policyVersion,
      decisionDigest: authorityRaw.decisionDigest,
      decidedAt: authorityRaw.decidedAt,
    },
    createdAt: raw.createdAt,
  };

  if (identityOverrideDigest(override) !== override.overrideDigest) {
    throw new IdentityError('overrideDigest mismatch');
  }
  if (identityDecisionDigest(override) !== override.authority.decisionDigest) {
    throw new IdentityError('identity decisionDigest mismatch');
  }
  return override;
}

export function loadIdentityOverride(filePath: string): IdentityOverrideV1 {
  return parseIdentityOverride(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
}

function fsyncPath(filePath: string): void {
  const fd = openSync(filePath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function persistIdentityOverride(storeDir: string, override: IdentityOverrideV1): string {
  const valid = parseIdentityOverride(override);
  ensureDir(storeDir);
  const filePath = join(
    storeDir,
    `${valid.overrideId.replace(/[^a-zA-Z0-9._:-]/g, '_')}.v${valid.overrideVersion}.json`,
  );
  withFileLockSync(storeDir, () => {
    atomicWriteSync(filePath, JSON.stringify(valid, null, 2));
    fsyncPath(filePath);
  });
  return filePath;
}

function transcriptRank(state: TranscriptState): number {
  return state === 'available' ? 0 : 1;
}

function availableNumber(value: number | null): { available: boolean; value: number } {
  return value === null || Number.isNaN(value)
    ? { available: false, value: Number.NEGATIVE_INFINITY }
    : { available: true, value };
}

export function compareEvidenceQuality(left: SourceObservationInput, right: SourceObservationInput): number {
  const transcript = transcriptRank(left.transcriptState) - transcriptRank(right.transcriptState);
  if (transcript !== 0) return transcript;

  const numericDesc = (a: number | null, b: number | null): number => {
    const av = availableNumber(a);
    const bv = availableNumber(b);
    if (av.available !== bv.available) return av.available ? -1 : 1;
    return bv.value - av.value;
  };

  const artifacts = numericDesc(left.evidenceArtifactCount, right.evidenceArtifactCount);
  if (artifacts !== 0) return artifacts;
  const segments = numericDesc(left.segmentCount, right.segmentCount);
  if (segments !== 0) return segments;
  const words = numericDesc(left.normalizedWordCount, right.normalizedWordCount);
  if (words !== 0) return words;
  const duration = numericDesc(left.durationSeconds, right.durationSeconds);
  if (duration !== 0) return duration;
  return left.capturedAt.localeCompare(right.capturedAt);
}

export function compareEvidenceTuple(left: SourceObservationInput, right: SourceObservationInput): number {
  const quality = compareEvidenceQuality(left, right);
  if (quality !== 0) return quality;
  return left.sourceId.localeCompare(right.sourceId);
}

export function selectCanonicalByEvidence(observations: SourceObservationInput[]): SourceObservationInput {
  if (observations.length === 0) throw new IdentityError('no observations to select');
  if (observations.length === 1) return observations[0];
  const ranked = [...observations].sort(compareEvidenceTuple);
  if (compareEvidenceQuality(ranked[0], ranked[1]) === 0) {
    throw new IdentityAmbiguityError('equal evidence tuples fail closed');
  }
  return ranked[0];
}

function projectOne(
  observation: SourceObservationInput,
  state: ObservationState,
  canonicalSourceId: string,
  override: IdentityOverrideV1 | null,
): ProjectedObservation {
  const retired = state !== 'active';
  return {
    ...observation,
    state,
    supersededBy: retired ? canonicalSourceId : null,
    lineageDigest: sha256Canonical({
      sourceId: observation.sourceId,
      canonicalSourceId,
      state,
      overrideDigest: override?.overrideDigest ?? null,
      evidenceDigest: observation.evidenceDigest,
    }),
    dispositionReason: retired ? (override?.reason ?? 'superseded by evidence tuple') : null,
    tombstoneId: retired ? `tombstone:${override?.overrideId ?? 'evidence'}:${observation.sourceId}` : null,
    reingestAllowed: !retired,
    retiredIdentity: retired,
  };
}

export function projectIdentities(
  observations: SourceObservationInput[],
  overrides: IdentityOverrideV1[] = [],
): IdentityProjection {
  const parsedOverrides = overrides.map((override) => parseIdentityOverride(override));
  const bySourceId = new Map<string, SourceObservationInput>();
  for (const observation of observations) {
    const existing = bySourceId.get(observation.sourceId);
    if (existing) {
      if (existing.evidenceDigest !== observation.evidenceDigest) {
        throw new IdentityError(`conflicting evidence for sourceId ${observation.sourceId}`);
      }
      continue;
    }
    bySourceId.set(observation.sourceId, observation);
  }

  const assigned = new Set<string>();
  const meetings: IdentityMeeting[] = [];

  for (const override of parsedOverrides) {
    const members = override.sourceIds
      .map((sourceId) => bySourceId.get(sourceId))
      .filter((item): item is SourceObservationInput => item !== undefined);
    if (members.length === 0) continue;
    if (!bySourceId.get(override.canonicalSourceId)) {
      throw new IdentityError('override canonical source is missing from observations');
    }
    for (const sourceId of override.sourceIds) assigned.add(sourceId);
    meetings.push({
      canonicalSourceId: override.canonicalSourceId,
      overrideId: override.overrideId,
      overrideVersion: override.overrideVersion,
      overrideDigest: override.overrideDigest,
      observations: members.map((member) => projectOne(
        member,
        member.sourceId === override.canonicalSourceId ? 'active' : 'quarantined',
        override.canonicalSourceId,
        override,
      )),
    });
  }

  for (const observation of [...bySourceId.values()].filter((item) => !assigned.has(item.sourceId))) {
    meetings.push({
      canonicalSourceId: observation.sourceId,
      overrideId: null,
      overrideVersion: null,
      overrideDigest: null,
      observations: [projectOne(observation, 'active', observation.sourceId, null)],
    });
  }

  meetings.sort((left, right) => left.canonicalSourceId.localeCompare(right.canonicalSourceId));
  return { meetings };
}
