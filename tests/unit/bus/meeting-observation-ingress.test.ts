import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { acceptFirefliesIngress } from '../../../src/bus/meeting-observation-ingress';

const contractsRoot = join(import.meta.dirname, '../../../state/specs/contracts');

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(contractsRoot, name), 'utf8')) as T;
}

const vectors = readJson<{
  vectors: Array<{
    name: string;
    rawBodyUtf8: string;
    headerName: string;
    headerValue: string;
    expected: 'accept' | 'reject';
  }>;
}>('fireflies-webhook-v2-test-vectors.json');
const secrets = readJson<{ secretsByKeyId: Record<string, string> }>('fireflies-webhook-v2.test-secrets.json');
const verificationConfig = readJson<Record<string, unknown>>('fireflies-verification-config-v1.golden.json');
const verificationConfigDigest = readJson<{ verificationConfigDigest: string }>(
  'fireflies-verification-config-pin-v1.json',
).verificationConfigDigest;
const observationSchema = readJson<Record<string, unknown>>('meeting-observation-v1.schema.json');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateObservation = ajv.compile(observationSchema);

const validVector = vectors.vectors.find((vector) => vector.name === 'valid-raw-body');
if (!validVector) throw new Error('missing valid-raw-body vector');

const FIXED_NOW = new Date('2026-08-24T04:00:00.000Z');
const EXPECTED_RAW_BODY_DIGEST = createHash('sha256').update(validVector.rawBodyUtf8, 'utf8').digest('hex');

let storeDir = '';

afterEach(() => {
  if (storeDir && existsSync(storeDir)) rmSync(storeDir, { recursive: true, force: true });
});

function accept(overrides: Partial<Parameters<typeof acceptFirefliesIngress>[0]> = {}) {
  storeDir = storeDir || mkdtempSync(join(tmpdir(), 'meeting-obs-'));
  return acceptFirefliesIngress({
    rawBody: validVector.rawBodyUtf8,
    headerName: validVector.headerName,
    signatureHeader: validVector.headerValue,
    orgId: 'clearworksai',
    now: () => FIXED_NOW,
    storeDir,
    secretsByKeyId: secrets.secretsByKeyId,
    verificationConfig,
    verificationConfigDigest,
    ...overrides,
  });
}

describe('Fireflies ingress observation seam', () => {
  it('persists a RELAY_PENDING MeetingObservationV1 with fsync receipt before returning 2xx', () => {
    const result = accept();

    expect(result.status).toBe(202);
    expect(result.observation).toBeDefined();
    expect(result.observation?.relay.state).toBe('RELAY_PENDING');
    expect(result.observation?.providerSourceId).toBe('demo');
    expect(result.observation?.rawBodyDigest).toBe(EXPECTED_RAW_BODY_DIGEST);
    expect(result.observation?.relay.durableReceipt.durability).toBe('fsync_committed');
    expect(result.observation?.signatureVerification.verificationConfigDigest).toBe(verificationConfigDigest);
    expect(result.observation?.relay.internalAuth).toBeNull();
    expect(result.observation?.relay.replayReceipt).toBeNull();
    expect(result.observation?.relay.firstAttemptAt).toBeNull();
    expect(validateObservation(result.observation)).toBe(true);

    const storedFiles = readdirSync(join(storeDir, 'observations'));
    expect(storedFiles).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(storeDir, 'observations', storedFiles[0]), 'utf8'));
    expect(stored.relay.state).toBe('RELAY_PENDING');
    expect(stored.rawBodyDigest).toBe(EXPECTED_RAW_BODY_DIGEST);
    expect(validateObservation(stored)).toBe(true);

    const replay = accept();
    expect(replay.status).toBe(202);
    expect(replay.observation?.observationId).toBe(result.observation?.observationId);
    expect(readdirSync(join(storeDir, 'observations'))).toHaveLength(1);
  });

  it('rejects each official invalid Fireflies vector with no accepted observation', () => {
    for (const vector of vectors.vectors.filter((item) => item.expected === 'reject')) {
      storeDir = mkdtempSync(join(tmpdir(), 'meeting-obs-reject-'));
      const result = accept({
        rawBody: vector.rawBodyUtf8,
        headerName: vector.headerName,
        signatureHeader: vector.headerValue,
        verificationConfig: {
          ...verificationConfig,
          scheme: vector.scheme,
        } as typeof verificationConfig,
      });
      expect(result.status, vector.name).toBe(401);
      expect(result.observation, vector.name).toBeUndefined();
      expect(existsSync(join(storeDir, 'observations')), vector.name).toBe(false);
      rmSync(storeDir, { recursive: true, force: true });
      storeDir = '';
    }
  });
});
