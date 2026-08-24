import { createHash, createHmac } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { acceptFirefliesIngress, canonicalJson, sha256Hex } from '../../../src/bus/meeting-observation-ingress';
import {
  acceptInternalRelay,
  signInternalRelayRequest,
} from '../../../src/bus/meeting-observation-relay';

const contractsRoot = join(import.meta.dirname, '../../../state/specs/contracts');

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(contractsRoot, name), 'utf8')) as T;
}

const vectors = readJson<{
  vectors: Array<{ name: string; rawBodyUtf8: string; headerName: string; headerValue: string }>;
}>('fireflies-webhook-v2-test-vectors.json');
const firefliesSecrets = readJson<{ secretsByKeyId: Record<string, string> }>(
  'fireflies-webhook-v2.test-secrets.json',
);
const relaySecrets = readJson<{
  secretsByKeyId: Record<string, string>;
  maximumClockSkewSeconds: number;
  replayWindowSeconds: number;
}>('relay-auth-v1.test-secrets.json');
const verificationConfig = readJson<Record<string, unknown>>('fireflies-verification-config-v1.golden.json');
const verificationConfigDigest = readJson<{ verificationConfigDigest: string }>(
  'fireflies-verification-config-pin-v1.json',
).verificationConfigDigest;
const authorityRoot = readJson<{ relayInternalAuthKeyIds: string[] }>('meeting-authority-root-v1.golden.json');
const observationSchema = readJson<Record<string, unknown>>('meeting-observation-v1.schema.json');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateObservation = ajv.compile(observationSchema);

const validVector = vectors.vectors.find((vector) => vector.name === 'valid-raw-body');
if (!validVector) throw new Error('missing valid-raw-body vector');

const RELAY_KEY_ID = 'cortext-relay-key-v1';
const RELAY_SECRET = relaySecrets.secretsByKeyId[RELAY_KEY_ID];
const FIXED_RECEIVED = new Date('2026-08-24T04:00:00.000Z');
const FIXED_RELAY = new Date('2026-08-24T04:00:01.000Z');

let storeDir = '';

afterEach(() => {
  if (storeDir && existsSync(storeDir)) rmSync(storeDir, { recursive: true, force: true });
  storeDir = '';
});

function persistPending() {
  storeDir = storeDir || mkdtempSync(join(tmpdir(), 'meeting-relay-'));
  return acceptFirefliesIngress({
    rawBody: validVector.rawBodyUtf8,
    headerName: validVector.headerName,
    signatureHeader: validVector.headerValue,
    orgId: 'clearworksai',
    now: () => FIXED_RECEIVED,
    storeDir,
    secretsByKeyId: firefliesSecrets.secretsByKeyId,
    verificationConfig,
    verificationConfigDigest,
  });
}

function expectedCanonicalPayload(observation: {
  orgId: string;
  observationId: string;
  provider: string;
  providerSourceId: string;
  rawBodyDigest: string;
  relay: { idempotencyKey: string; intentDigest: string };
}, auth: { method: string; path: string; timestamp: string; nonce: string; bodyDigest: string }): string {
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

function expectedIntentDigest(observation: {
  orgId: string;
  observationId: string;
  provider: string;
  providerSourceId: string;
  rawBodyDigest: string;
}): string {
  return sha256Hex(canonicalJson({
    orgId: observation.orgId,
    observationId: observation.observationId,
    provider: observation.provider,
    providerSourceId: observation.providerSourceId,
    rawBodyDigest: observation.rawBodyDigest,
  }));
}

function observationPath(observationId: string): string {
  return join(storeDir, 'observations', `${observationId.replaceAll(':', '_')}.json`);
}

function storedObservation(observationId?: string) {
  if (observationId) {
    return JSON.parse(readFileSync(observationPath(observationId), 'utf8'));
  }
  const files = readdirSync(join(storeDir, 'observations'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(storeDir, 'observations', files[0]), 'utf8'));
}

function relayInput(
  headers: Record<string, string | undefined>,
  now = FIXED_RELAY,
  observationId?: string,
) {
  return {
    storeDir,
    observationId: observationId ?? (storedObservation().observationId as string),
    method: 'POST',
    path: '/internal/v1/meeting-observations',
    rawBody: validVector.rawBodyUtf8,
    headers,
    now: () => now,
    secretsByKeyId: relaySecrets.secretsByKeyId,
    trustedKeyIds: authorityRoot.relayInternalAuthKeyIds,
    trustedOrgId: 'clearworksai',
    replayWindowSeconds: relaySecrets.replayWindowSeconds,
    maximumClockSkewSeconds: relaySecrets.maximumClockSkewSeconds,
  };
}

describe('internal org-bound meeting observation relay', () => {
  it('signs and accepts a valid org-bound HMAC, then stores RELAYED with nonce receipt', () => {
    const pending = persistPending();
    expect(pending.status).toBe(202);
    expect(pending.observation?.relay.state).toBe('RELAY_PENDING');
    expect(pending.observation?.relay.intentDigest).toBe(expectedIntentDigest(pending.observation!));
    expect(validateObservation(pending.observation)).toBe(true);

    const signed = signInternalRelayRequest({
      observation: pending.observation!,
      keyId: RELAY_KEY_ID,
      secret: RELAY_SECRET,
      timestamp: FIXED_RELAY.toISOString(),
      nonce: 'relay_nonce_demo_0001',
    });
    const payload = expectedCanonicalPayload(pending.observation!, {
      method: 'POST',
      path: '/internal/v1/meeting-observations',
      timestamp: FIXED_RELAY.toISOString(),
      nonce: 'relay_nonce_demo_0001',
      bodyDigest: pending.observation!.rawBodyDigest,
    });
    expect(signed.macHex).toBe(createHmac('sha256', RELAY_SECRET).update(payload).digest('hex'));
    expect(signed.canonicalRequestDigest).toBe(createHash('sha256').update(payload).digest('hex'));

    const accepted = acceptInternalRelay(relayInput(signed.headers));
    expect(accepted.status).toBe(202);
    expect(accepted.observation.relay.state).toBe('RELAYED');
    expect(accepted.observation.relay.internalAuth?.keyId).toBe(RELAY_KEY_ID);
    expect(accepted.observation.relay.internalAuth?.macHex).toBe(signed.macHex);
    expect(accepted.observation.relay.relayReceiptDigest).toBe(signed.macHex);
    expect(accepted.observation.relay.replayReceipt?.decision).toBe('accepted_new');
    expect(accepted.observation.relay.replayReceipt?.storeId).toBe('meeting-relay-nonce-store-v1');
    expect(validateObservation(accepted.observation)).toBe(true);

    const stored = storedObservation();
    expect(stored.relay.state).toBe('RELAYED');
    expect(stored.observationDigest).toBe(accepted.observation.observationDigest);
    expect(readdirSync(join(storeDir, 'nonces'))).toHaveLength(1);
  });

  it('rejects missing, invalid, stale, replayed, and wrong-org HMAC without leaving pending', () => {
    const pending = persistPending();
    const signed = signInternalRelayRequest({
      observation: pending.observation!,
      keyId: RELAY_KEY_ID,
      secret: RELAY_SECRET,
      timestamp: FIXED_RELAY.toISOString(),
      nonce: 'relay_nonce_demo_0002',
    });

    const missing = acceptInternalRelay(relayInput({
      ...signed.headers,
      'X-Request-Signature': undefined,
    }));
    expect(missing.status).toBe(401);
    expect(storedObservation().relay.state).toBe('RELAY_PENDING');
    expect(storedObservation().relay.internalAuth).toBeNull();

    const invalid = acceptInternalRelay(relayInput({
      ...signed.headers,
      'X-Request-Signature': 'ab'.repeat(32),
    }));
    expect(invalid.status).toBe(401);
    expect(storedObservation().relay.state).toBe('RELAY_PENDING');

    const wrongOrgHeaders = { ...signed.headers, 'X-Org-Id': 'attacker-org' };
    const wrongOrg = acceptInternalRelay(relayInput(wrongOrgHeaders));
    expect(wrongOrg.status).toBe(401);
    expect(storedObservation().relay.state).toBe('RELAY_PENDING');

    const staleSigned = signInternalRelayRequest({
      observation: pending.observation!,
      keyId: RELAY_KEY_ID,
      secret: RELAY_SECRET,
      timestamp: new Date('2026-08-24T04:10:00.000Z').toISOString(),
      nonce: 'relay_nonce_stale_0003',
    });
    const stale = acceptInternalRelay(relayInput(staleSigned.headers, new Date('2026-08-24T04:10:00.000Z')));
    expect(stale.status).toBe(401);
    expect(storedObservation(pending.observation!.observationId).relay.state).toBe('RELAY_PENDING');

    const first = acceptInternalRelay(relayInput(signed.headers));
    expect(first.status).toBe(202);
    expect(first.observation.relay.state).toBe('RELAYED');
    const replay = acceptInternalRelay(relayInput(signed.headers));
    expect(replay.status).toBe(202);
    expect(replay.observation.observationId).toBe(first.observation.observationId);
    expect(replay.observation.observationDigest).toBe(first.observation.observationDigest);

    const otherBody = validVector.rawBodyUtf8.replace('"meeting_id":"demo"', '"meeting_id":"other"');
    const otherSignature = `sha256=${createHmac('sha256', firefliesSecrets.secretsByKeyId['fireflies-webhook-v2-test-key']).update(otherBody, 'utf8').digest('hex')}`;
    const otherPending = acceptFirefliesIngress({
      rawBody: otherBody,
      headerName: validVector.headerName,
      signatureHeader: otherSignature,
      orgId: 'clearworksai',
      now: () => FIXED_RECEIVED,
      storeDir,
      secretsByKeyId: firefliesSecrets.secretsByKeyId,
      verificationConfig,
      verificationConfigDigest,
    });
    expect(otherPending.status).toBe(202);
    const reusedNonce = signInternalRelayRequest({
      observation: otherPending.observation!,
      keyId: RELAY_KEY_ID,
      secret: RELAY_SECRET,
      timestamp: FIXED_RELAY.toISOString(),
      nonce: 'relay_nonce_demo_0002',
    });
    const nonceReplay = acceptInternalRelay({
      ...relayInput(reusedNonce.headers, FIXED_RELAY, otherPending.observation!.observationId),
      rawBody: otherBody,
    });
    expect(nonceReplay.status).toBe(401);
    expect(storedObservation(otherPending.observation!.observationId).relay.state).toBe('RELAY_PENDING');
    expect(storedObservation(pending.observation!.observationId).relay.state).toBe('RELAYED');
    expect(readdirSync(join(storeDir, 'observations'))).toHaveLength(2);
  });

  it('refuses to enable relay without an org-bound key, nonce store, or five-minute window', () => {
    const pending = persistPending();
    const signed = signInternalRelayRequest({
      observation: pending.observation!,
      keyId: RELAY_KEY_ID,
      secret: RELAY_SECRET,
      timestamp: FIXED_RELAY.toISOString(),
      nonce: 'relay_nonce_disabled_01',
    });

    const noSecret = acceptInternalRelay({
      ...relayInput(signed.headers),
      secretsByKeyId: {},
    });
    expect(noSecret.status).toBe(503);
    expect(storedObservation().relay.state).toBe('RELAY_PENDING');

    const noWindow = acceptInternalRelay({
      ...relayInput(signed.headers),
      replayWindowSeconds: undefined,
    });
    expect(noWindow.status).toBe(503);
    expect(storedObservation().relay.state).toBe('RELAY_PENDING');

    const oversizeWindow = acceptInternalRelay({
      ...relayInput(signed.headers),
      replayWindowSeconds: 301,
    });
    expect(oversizeWindow.status).toBe(503);
    expect(storedObservation().relay.state).toBe('RELAY_PENDING');
  });

  it('preserves one observation identity across twenty concurrent relays without losing unfinished work', async () => {
    const pending = persistPending();
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const nonce = String(request.headers['x-request-nonce'] ?? '');
        const signed = signInternalRelayRequest({
          observation: pending.observation!,
          keyId: RELAY_KEY_ID,
          secret: RELAY_SECRET,
          timestamp: FIXED_RELAY.toISOString(),
          nonce,
        });
        const result = acceptInternalRelay(relayInput(signed.headers));
        response.statusCode = result.status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          observationId: result.observation?.observationId,
          state: result.observation?.relay.state,
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listen address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) => {
        const nonce = `relay_nonce_conc_${String(index).padStart(2, '0')}`;
        return new Promise<{ status: number; body: { observationId: string; state: string } }>((resolve, reject) => {
          const req = httpRequest(baseUrl, {
            method: 'POST',
            headers: { 'x-request-nonce': nonce },
          }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                  observationId: string;
                  state: string;
                },
              });
            });
          });
          req.on('error', reject);
          req.end();
        });
      }));

      expect(results.every((result) => result.status === 202)).toBe(true);
      expect(new Set(results.map((result) => result.body.observationId)).size).toBe(1);
      expect(results.every((result) => result.body.state === 'RELAYED')).toBe(true);
      expect(storedObservation().observationId).toBe(pending.observation?.observationId);
      expect(readdirSync(join(storeDir, 'observations'))).toHaveLength(1);
      expect(storedObservation().relay.state).toBe('RELAYED');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
