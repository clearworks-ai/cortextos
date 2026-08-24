import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import {
  DeliveryValidationError,
  acquireSinkLease,
  applySinkOutcome,
  deliveryManifestDigest,
  evaluatePaEligibility,
  persistDeliveryEnvelope,
  persistReplicationAck,
  upstreamSatisfied,
} from '../../../src/bus/meeting-delivery.js';

const CONTRACTS = join(__dirname, '..', '..', '..', 'state', 'specs', 'contracts');

function loadJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACTS, name), 'utf8')) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('meeting delivery envelope', () => {
  it('persists the golden envelope with the four required sinks and a matching Briefs ack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-delivery-'));
    try {
      const envelope = clone(loadJson('meeting-delivery-envelope-v1.golden.json'));
      const ack = clone(loadJson('projection-replication-ack-v1.golden.json'));
      const stored = persistDeliveryEnvelope(dir, envelope);
      const storedAck = persistReplicationAck(dir, ack);
      expect(stored.manifestDigest).toBe(envelope.manifestDigest);
      expect((stored.upstreamReceipts as Array<{ sink: string }>).map((item) => item.sink).sort()).toEqual([
        'briefs_projection',
        'crm_interaction',
        'followup_draft',
        'lifecycle_projection',
      ]);
      expect(upstreamSatisfied(stored)).toBe(true);
      expect(evaluatePaEligibility(stored).kind).toBe('normal_completion');
      expect(storedAck.ackDigest).toBe(ack.ackDigest);
      expect(storedAck.recordDigest).toBe(envelope.recordDigest);
      expect(storedAck.manifestDigest).toBe(envelope.manifestDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows SKIPPED_POLICY only on followup_draft and still satisfies upstream', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-delivery-skip-'));
    try {
      const envelope = clone(loadJson('meeting-delivery-envelope-v1.golden.json'));
      persistDeliveryEnvelope(dir, envelope);
      const skipped = applySinkOutcome(dir, envelope.canonicalMeetingId as string, 'followup_draft', {
        state: 'SKIPPED_POLICY',
        policyVersion: 'draft-applicability-v1',
        reason: 'no customer-facing recap required',
        readbackDigest: null,
        providerId: null,
      });
      expect(upstreamSatisfied(skipped)).toBe(true);
      expect(evaluatePaEligibility(skipped).kind).toBe('normal_completion');
      expect(() => applySinkOutcome(dir, envelope.canonicalMeetingId as string, 'crm_interaction', {
        state: 'SKIPPED_POLICY',
        policyVersion: 'draft-applicability-v1',
        reason: 'not allowed',
        readbackDigest: null,
        providerId: null,
      })).toThrow(DeliveryValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suppresses normal PA when a required sink is TERMINAL_FAILED or UNKNOWN_COMMIT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-delivery-fail-'));
    try {
      const envelope = clone(loadJson('meeting-delivery-envelope-v1.golden.json'));
      persistDeliveryEnvelope(dir, envelope);
      const failed = applySinkOutcome(dir, envelope.canonicalMeetingId as string, 'crm_interaction', {
        state: 'TERMINAL_FAILED',
        errorCode: 'crm_write_rejected',
        readbackDigest: null,
        providerId: null,
      });
      expect(upstreamSatisfied(failed)).toBe(false);
      expect(evaluatePaEligibility(failed)).toEqual({
        kind: 'terminal_exception',
        failedSink: 'crm_interaction',
      });
      expect(failed.paDeliveryReceipt).toBeNull();

      const unknownDir = mkdtempSync(join(tmpdir(), 'meeting-delivery-unknown-'));
      try {
        persistDeliveryEnvelope(unknownDir, clone(envelope));
        const unknown = applySinkOutcome(unknownDir, envelope.canonicalMeetingId as string, 'lifecycle_projection', {
          state: 'UNKNOWN_COMMIT',
          unknownProbeCount: 1,
          lastProbeAt: '2026-08-24T04:01:40Z',
        });
        expect(evaluatePaEligibility(unknown).kind).toBe('suppressed');
        expect(unknown.paDeliveryReceipt).toBeNull();
      } finally {
        rmSync(unknownDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leases a pending required sink and keeps normal PA suppressed until upstream is satisfied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-delivery-lease-'));
    try {
      const envelope = clone(loadJson('meeting-delivery-envelope-v1.golden.json'));
      for (const receipt of envelope.upstreamReceipts as Array<Record<string, unknown>>) {
        receipt.state = 'PENDING';
        receipt.previousState = null;
        receipt.attempt = 0;
        receipt.leaseVersion = 0;
        receipt.leaseOwner = null;
        receipt.leaseExpiresAt = null;
        receipt.nextAttemptAt = null;
        receipt.unknownProbeCount = 0;
        receipt.lastProbeAt = null;
      }
      envelope.manifestDigest = deliveryManifestDigest(envelope);
      persistDeliveryEnvelope(dir, envelope);
      expect(evaluatePaEligibility(envelope).kind).toBe('suppressed');
      const leased = acquireSinkLease(dir, envelope.canonicalMeetingId as string, 'crm_interaction', {
        owner: 'meeting-engine:demo',
        updatedAt: '2026-08-24T04:00:45Z',
        expiresAt: '2026-08-24T04:02:30Z',
      });
      const crm = (leased.upstreamReceipts as Array<Record<string, unknown>>)
        .find((item) => item.sink === 'crm_interaction');
      expect(crm?.state).toBe('LEASED');
      expect(crm?.leaseOwner).toBe('meeting-engine:demo');
      expect(evaluatePaEligibility(leased).kind).toBe('suppressed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
