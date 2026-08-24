import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateDraftPolicy } from '../../../src/bus/meeting-draft.js';

describe('meeting follow-up draft policy', () => {
  it('returns SKIPPED_POLICY with sendAuthorized=false when the policy does not require a draft', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-draft-'));
    try {
      const receipt = evaluateDraftPolicy(dir, {
        recordDigest: 'be66407f98eeb28dc3063c31f800096f8bb3ab06681a56b415f57ca83f1833ba',
        canonicalMeetingId: 'meeting_demo_2026_08_24_01',
        required: false,
        policyVersion: 'draft-applicability-v1',
        reason: 'no customer-facing recap required',
      });
      expect(receipt.state).toBe('SKIPPED_POLICY');
      expect(receipt.sink).toBe('followup_draft');
      expect(receipt.sendAuthorized).toBe(false);
      expect(receipt.policyVersion).toBe('draft-applicability-v1');
      expect(receipt.draftId).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invokes the draft runner once per record digest and never authorizes send', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-draft-run-'));
    const calls: string[] = [];
    try {
      const runner = (recordDigest: string) => {
        calls.push(recordDigest);
        return { draftId: 'draft:demo', subject: 'Follow-up', bodyDigest: 'aa'.repeat(32) };
      };
      const first = evaluateDraftPolicy(dir, {
        recordDigest: '11'.repeat(32),
        canonicalMeetingId: 'meeting-demo',
        required: true,
        policyVersion: 'draft-applicability-v1',
        reason: 'required',
        runner,
      });
      const second = evaluateDraftPolicy(dir, {
        recordDigest: '11'.repeat(32),
        canonicalMeetingId: 'meeting-demo',
        required: true,
        policyVersion: 'draft-applicability-v1',
        reason: 'required',
        runner,
      });
      expect(calls).toHaveLength(1);
      expect(first.state).toBe('SUCCEEDED');
      expect(first.sendAuthorized).toBe(false);
      expect(first.draftId).toBe('draft:demo');
      expect(second.draftId).toBe(first.draftId);
      expect(second.bodyDigest).toBe(first.bodyDigest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
