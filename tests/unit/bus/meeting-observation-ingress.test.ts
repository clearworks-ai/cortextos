import { createHash, createHmac } from 'node:crypto';
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
const failureSchema = readJson<Record<string, unknown>>('pre-record-ingress-failure-v1.schema.json');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateObservation = ajv.compile(observationSchema);
const validateFailure = ajv.compile(failureSchema);

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

    const storedDir = join(storeDir, 'observations', 'clearworksai');
    const storedFiles = readdirSync(storedDir);
    expect(storedFiles).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(storedDir, storedFiles[0]), 'utf8'));
    expect(stored.relay.state).toBe('RELAY_PENDING');
    expect(stored.rawBodyDigest).toBe(EXPECTED_RAW_BODY_DIGEST);
    expect(validateObservation(stored)).toBe(true);

    const replay = accept();
    expect(replay.status).toBe(202);
    expect(replay.observation?.observationId).toBe(result.observation?.observationId);
    expect(readdirSync(join(storeDir, 'observations', 'clearworksai'))).toHaveLength(1);
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

  it('emits a PII-safe auth failure receipt with no quarantine and no observation', () => {
    const invalid = vectors.vectors.find((vector) => vector.name === 'wrong-prefix');
    if (!invalid) throw new Error('missing wrong-prefix vector');
    storeDir = mkdtempSync(join(tmpdir(), 'meeting-obs-auth-fail-'));
    const result = accept({
      rawBody: invalid.rawBodyUtf8,
      headerName: invalid.headerName,
      signatureHeader: invalid.headerValue,
    });
    expect(result.status).toBe(401);
    expect(result.observation).toBeUndefined();
    expect(existsSync(join(storeDir, 'observations'))).toBe(false);
    expect(result.failure?.stage).toBe('auth');
    expect(result.failure?.authenticationState).toBe('unverified');
    expect(result.failure?.errorCode).toBe('INGRESS_AUTH_FAILED');
    expect(result.failure?.encryptedQuarantine).toBeNull();
    expect(result.failure?.deletionReceipt).toBeNull();
    expect(result.failure?.piiSafeAlertReceipt.rawBodyIncluded).toBe(false);
    expect(result.failure?.piiSafeAlertReceipt.providerPayloadIncluded).toBe(false);
    expect(JSON.stringify(result.failure)).not.toContain(invalid.rawBodyUtf8);
    expect(existsSync(join(storeDir, 'quarantine'))).toBe(false);
    expect(validateFailure(result.failure)).toBe(true);
  });

  it('quarantines authenticated unpersistable bytes for 24 hours and never stores an observation', () => {
    const unpersistableBody = '{"event":"meeting.transcribed","timestamp":1787544000000}';
    const signature = `sha256=${createHmac('sha256', secrets.secretsByKeyId['fireflies-webhook-v2-test-key']).update(unpersistableBody, 'utf8').digest('hex')}`;
    storeDir = mkdtempSync(join(tmpdir(), 'meeting-obs-persist-fail-'));
    const result = accept({
      rawBody: unpersistableBody,
      signatureHeader: signature,
      quarantineKey: 'ingress-quarantine-test-secret-v1',
      requestId: 'request:fireflies:webhook:unpersistable',
    });
    expect(result.status).toBe(400);
    expect(result.observation).toBeUndefined();
    expect(existsSync(join(storeDir, 'observations'))).toBe(false);
    expect(result.failure?.stage).toBe('persist');
    expect(result.failure?.authenticationState).toBe('verified');
    expect(result.failure?.encryptedQuarantine?.state).toBe('ENCRYPTED');
    expect(result.failure?.encryptedQuarantine?.encryptionKeyId).toBe('ingress-quarantine-key-v1');
    const encryptedAt = Date.parse(result.failure!.encryptedQuarantine!.encryptedAt);
    const expiresAt = Date.parse(result.failure!.encryptedQuarantine!.expiresAt);
    expect(expiresAt - encryptedAt).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(expiresAt - Date.parse(result.failure!.sourceIdentity.receivedAt)).toBe(24 * 60 * 60 * 1000);
    expect(result.failure?.deletionReceipt?.state).toBe('SCHEDULED');
    expect(JSON.stringify(result.failure)).not.toContain(unpersistableBody);
    const quarantineFiles = readdirSync(join(storeDir, 'quarantine'));
    expect(quarantineFiles).toHaveLength(1);
    const ciphertext = readFileSync(join(storeDir, 'quarantine', quarantineFiles[0]));
    expect(ciphertext.toString('utf8')).not.toContain('meeting.transcribed');
    expect(validateFailure(result.failure)).toBe(true);
  });

  it('rejects a verification config bound to a different org', () => {
    const result = accept({
      verificationConfig: { ...verificationConfig, orgId: 'other-org' },
    });
    expect(result.status).toBe(401);
    expect(result.observation).toBeUndefined();
  });

  it('conflicts instead of overwriting a different body for the same observation id', () => {
    const first = accept();
    expect(first.status).toBe(202);
    const otherBody = validVector.rawBodyUtf8.replace('1787544000000', '1787544000001');
    const otherHmac = `sha256=${createHmac('sha256', secrets.secretsByKeyId['fireflies-webhook-v2-test-key']).update(otherBody, 'utf8').digest('hex')}`;
    const second = accept({
      rawBody: otherBody,
      signatureHeader: otherHmac,
    });
    expect(second.status).toBe(409);
    expect(second.observation?.rawBodyDigest).toBe(first.observation?.rawBodyDigest);
  });
});
