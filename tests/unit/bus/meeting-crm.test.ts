import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { digestWithout } from '../../../src/bus/meeting-identity.js';
import {
  CrmWriteConflictError,
  CrmWriteValidationError,
  acceptServiceExactIntent,
  applyIntentWithReadback,
  persistCrmWriteIntent,
  persistCrmWriteSet,
  persistCrmWriteIntentRequest,
  submitCrmWriteIntentRequest,
} from '../../../src/bus/meeting-crm.js';

const CONTRACTS = join(__dirname, '..', '..', '..', 'state', 'specs', 'contracts');

function loadJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACTS, name), 'utf8')) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('meeting CRM write intents', () => {
  it('persists the golden system_exact request and accepts a CRM-owned pending intent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-crm-'));
    try {
      const request = clone(loadJson('crm-write-intent-request-v1.golden.json'));
      const pending = clone(loadJson('crm-write-intent-v1.pending.golden.json'));
      const snapshot = clone(loadJson('crm-projection-snapshot-v1.golden.json'));

      const storedRequest = persistCrmWriteIntentRequest(dir, request);
      expect(storedRequest.requestDigest).toBe(request.requestDigest);

      const accepted = acceptServiceExactIntent(dir, {
        request,
        intentId: pending.intentId as string,
        acceptedAt: pending.acceptedAt as string,
        updatedAt: pending.updatedAt as string,
      });
      expect(accepted.state).toBe('accepted_pending');
      expect(accepted.intentId).toBe(pending.intentId);
      expect(accepted.intentDigest).toBe(pending.intentDigest);
      expect(accepted.authoritativeReadbackVersion).toBeNull();

      const applied = applyIntentWithReadback(dir, accepted.intentId as string, snapshot);
      expect(applied.state).toBe('applied');
      expect(applied.authoritativeReadbackVersion).toBe(snapshot.sourceVersion);
      expect(applied.authoritativeReadbackDigest).toBe(snapshot.sourceDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects browser system_exact writes and idempotency-key digest conflicts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-crm-reject-'));
    try {
      const request = clone(loadJson('crm-write-intent-request-v1.golden.json'));
      expect(() => submitCrmWriteIntentRequest(dir, request, 'browser')).toThrow(CrmWriteValidationError);

      persistCrmWriteIntentRequest(dir, request);
      const conflict = clone(request);
      conflict.operation = 'upsert_account';
      conflict.requestDigest = digestWithout(conflict, 'requestDigest');
      expect(() => persistCrmWriteIntentRequest(dir, conflict)).toThrow(CrmWriteConflictError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists the exact five-write CRM set bound to the record digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-crm-set-'));
    try {
      const writeSet = clone(loadJson('crm-write-set-v1.golden.json'));
      const artifacts = clone(loadJson('crm-write-set-artifacts-v1.golden.json')) as {
        requests: Record<string, unknown>[];
        intents: Record<string, unknown>[];
      };
      const stored = persistCrmWriteSet(dir, writeSet, artifacts.requests, artifacts.intents);
      expect(stored.writeSetDigest).toBe(writeSet.writeSetDigest);
      expect((stored.expectedWrites as unknown[]).length).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a stored CRM intent with a different digest at the same state version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-crm-cas-'));
    try {
      const pending = clone(loadJson('crm-write-intent-v1.pending.golden.json'));
      persistCrmWriteIntent(dir, pending);
      const mutated = clone(pending);
      mutated.rejectionCode = 'mutated';
      mutated.intentDigest = digestWithout(mutated, 'intentDigest');
      expect(() => persistCrmWriteIntent(dir, mutated)).toThrow(CrmWriteConflictError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
