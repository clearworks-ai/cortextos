import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MeetingRecordConflictError,
  MeetingRecordValidationError,
  deliverRecordToSinks,
  meetingRecordDigest,
  persistMeetingRecord,
  readMeetingRecord,
} from '../../../src/bus/meeting-record.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONTRACTS = join(REPO_ROOT, 'state', 'specs', 'contracts');

function loadJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACTS, name), 'utf8')) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('meeting record', () => {
  it('persists MeetingRecordV1 with monotonic CAS and claim lineage', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'meeting-record-'));
    const record = clone(loadJson('meeting-record-v1.golden.json'));

    try {
      const first = persistMeetingRecord(storeDir, record);
      const again = persistMeetingRecord(storeDir, record);
      expect(again.recordDigest).toBe(first.recordDigest);
      expect(readMeetingRecord(storeDir, record.canonicalMeetingId as string).recordDigest).toBe(
        record.recordDigest,
      );

      const v2 = clone(record);
      v2.recordVersion = 2;
      v2.previousRecordDigest = record.recordDigest;
      v2.recordDigest = '0'.repeat(64);
      expect(() => persistMeetingRecord(storeDir, v2)).toThrow(MeetingRecordValidationError);

      const conflict = clone(record);
      (conflict.meeting as { title: string }).title = 'mutated without a new version';
      conflict.recordDigest = meetingRecordDigest(conflict);
      expect(() => persistMeetingRecord(storeDir, conflict)).toThrow(MeetingRecordConflictError);

      const gap = clone(record);
      gap.recordVersion = 3;
      gap.previousRecordDigest = record.recordDigest;
      gap.recordDigest = meetingRecordDigest(gap);
      expect(() => persistMeetingRecord(storeDir, gap)).toThrow(MeetingRecordConflictError);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('keeps candidate, disposition, and root authority separate and never delivers an invalid candidate to sinks', () => {
    const record = clone(loadJson('meeting-record-v1.golden.json'));
    const disposition = clone(loadJson('claim-disposition-set-v1.golden.json'));
    const registry = clone(loadJson('claim-authority-registry-v1.golden.json'));
    const root = clone(loadJson('meeting-authority-root-v1.golden.json'));
    const sinks = {
      crm: vi.fn(),
      lifecycle: vi.fn(),
      draft: vi.fn(),
      pa: vi.fn(),
    };

    const invalidCandidate = {
      schemaVersion: '1.0',
      orgId: 'clearworksai',
      candidateSetId: 'candidates:invalid',
      candidateSetDigest: '00'.repeat(32),
      candidates: [
        {
          claimId: 'claim:bad',
          statement: '',
          claimKind: 'fact',
        },
      ],
    };

    expect(() => deliverRecordToSinks({
      record,
      candidateSet: invalidCandidate,
      dispositionSet: disposition,
      authorityRegistry: registry,
      authorityRoot: root,
      sinks,
    })).toThrow(MeetingRecordValidationError);

    expect(sinks.crm).not.toHaveBeenCalled();
    expect(sinks.lifecycle).not.toHaveBeenCalled();
    expect(sinks.draft).not.toHaveBeenCalled();
    expect(sinks.pa).not.toHaveBeenCalled();
  });
});
