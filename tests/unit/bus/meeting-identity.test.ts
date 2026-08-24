import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  IdentityAmbiguityError,
  loadIdentityOverride,
  persistIdentityOverride,
  projectIdentities,
  selectCanonicalByEvidence,
  type SourceObservationInput,
} from '../../../src/bus/meeting-identity.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CALASIA_FIXTURE = join(__dirname, 'fixtures', 'calasia-identity-override-v1.json');
const IDENTITY_SRC = join(REPO_ROOT, 'src', 'bus', 'meeting-identity.ts');

function observation(sourceId: string, extras: Partial<SourceObservationInput> = {}): SourceObservationInput {
  return {
    sourceId,
    provider: 'fireflies',
    capturedAt: '2026-08-23T18:00:00Z',
    startedAt: '2026-08-23T17:00:00Z',
    transcriptState: 'available',
    transcriptDigest: 'aa'.repeat(32),
    evidenceDigest: 'bb'.repeat(32),
    segmentCount: 40,
    normalizedWordCount: 4000,
    durationSeconds: 2400,
    evidenceArtifactCount: 2,
    title: 'CalAsia workflow review',
    rawEvidence: { sourceId, bytes: `raw:${sourceId}` },
    ...extras,
  };
}

describe('meeting identity', () => {
  it('loads the approved IdentityOverrideV1 fixture and keeps GEY active, GEZA quarantined/tombstoned, and GE77 a distinct meeting', () => {
    const override = loadIdentityOverride(CALASIA_FIXTURE);
    const canonicalId = override.canonicalSourceId;
    const groupedIds = override.sourceIds;
    const distinctId = '01M0GE77CD5BSZDESG7Z5GPFTK';

    expect(groupedIds).toHaveLength(2);
    expect(groupedIds).toContain(canonicalId);
    expect(groupedIds).not.toContain(distinctId);

    const observations = [
      observation(canonicalId, { capturedAt: '2026-08-23T18:01:00Z', segmentCount: 52, normalizedWordCount: 5100, durationSeconds: 3300, evidenceArtifactCount: 3 }),
      observation(groupedIds.find((id) => id !== canonicalId)!, { capturedAt: '2026-08-23T18:00:30Z', segmentCount: 48, normalizedWordCount: 4800, durationSeconds: 3180, evidenceArtifactCount: 1 }),
      observation(distinctId, { title: 'CalAsia lead-in', capturedAt: '2026-08-23T17:30:00Z', startedAt: '2026-08-23T17:25:00Z', segmentCount: 12, normalizedWordCount: 900, durationSeconds: 420 }),
    ];

    const projection = projectIdentities(observations, [override]);

    expect(projection.meetings).toHaveLength(2);

    const canonicalMeeting = projection.meetings.find((meeting) => meeting.canonicalSourceId === canonicalId);
    const distinctMeeting = projection.meetings.find((meeting) => meeting.canonicalSourceId === distinctId);
    expect(canonicalMeeting).toBeDefined();
    expect(distinctMeeting).toBeDefined();

    const active = canonicalMeeting!.observations.find((item) => item.sourceId === canonicalId);
    const quarantinedId = groupedIds.find((id) => id !== canonicalId)!;
    const quarantined = canonicalMeeting!.observations.find((item) => item.sourceId === quarantinedId);
    expect(active?.state).toBe('active');
    expect(active?.supersededBy).toBeNull();
    expect(active?.tombstoneId).toBeNull();
    expect(active?.reingestAllowed).toBe(true);
    expect(active?.retiredIdentity).toBe(false);
    expect(active?.rawEvidence).toEqual(observations[0].rawEvidence);

    expect(quarantined?.state).toBe('quarantined');
    expect(quarantined?.supersededBy).toBe(canonicalId);
    expect(quarantined?.tombstoneId).toEqual(expect.stringMatching(/^tombstone:/));
    expect(quarantined?.reingestAllowed).toBe(false);
    expect(quarantined?.retiredIdentity).toBe(true);
    expect(quarantined?.lineageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(quarantined?.dispositionReason?.length).toBeGreaterThan(0);
    expect(quarantined?.rawEvidence).toEqual(observations[1].rawEvidence);

    expect(distinctMeeting!.observations).toHaveLength(1);
    expect(distinctMeeting!.observations[0].state).toBe('active');
    expect(distinctMeeting!.observations[0].sourceId).toBe(distinctId);

    const productionSource = readFileSync(IDENTITY_SRC, 'utf8');
    for (const sourceId of [...groupedIds, distinctId]) {
      expect(productionSource).not.toContain(sourceId);
    }
  });

  it('loads the S0 IdentityOverrideV1 golden without rewriting contract bytes', () => {
    const goldenPath = join(REPO_ROOT, 'state', 'specs', 'contracts', 'identity-override-v1.golden.json');
    const override = loadIdentityOverride(goldenPath);
    expect(override.overrideId).toBe('identity-override:demo-pair');
    expect(override.sourceIds).toEqual([
      '01DEMOACTIVE0000000000000000',
      '01DEMOSUPERSEDED000000000000',
    ]);
    expect(override.canonicalSourceId).toBe('01DEMOACTIVE0000000000000000');
  });

  it('keeps distinct source IDs as distinct meetings when no override exists', () => {
    const projection = projectIdentities([
      observation('src-a', { evidenceDigest: '11'.repeat(32) }),
      observation('src-b', { evidenceDigest: '22'.repeat(32) }),
    ]);
    expect(projection.meetings).toHaveLength(2);
    expect(projection.meetings.map((meeting) => meeting.canonicalSourceId).sort()).toEqual(['src-a', 'src-b']);
    expect(projection.meetings.every((meeting) => meeting.observations[0].state === 'active')).toBe(true);
  });

  it('treats a repeated provider source ID as the same observation', () => {
    const projection = projectIdentities([
      observation('src-same', { evidenceDigest: '33'.repeat(32), rawEvidence: { n: 1 } }),
      observation('src-same', { evidenceDigest: '33'.repeat(32), rawEvidence: { n: 1 } }),
    ]);
    expect(projection.meetings).toHaveLength(1);
    expect(projection.meetings[0].observations).toHaveLength(1);
  });

  it('fails closed when evidence tuples are equal and no override pins a canonical source', () => {
    expect(() => selectCanonicalByEvidence([
      observation('src-a', { evidenceDigest: '44'.repeat(32) }),
      observation('src-b', { evidenceDigest: '55'.repeat(32) }),
    ])).toThrow(IdentityAmbiguityError);
  });

  it('persists a versioned digest-bound override and reloads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-identity-'));
    try {
      const override = loadIdentityOverride(CALASIA_FIXTURE);
      const saved = persistIdentityOverride(dir, override);
      expect(loadIdentityOverride(saved)).toEqual(override);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
