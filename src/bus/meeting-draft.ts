import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

export class DraftPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftPolicyError';
  }
}

export interface DraftRunnerResult {
  draftId: string;
  subject: string;
  bodyDigest: string;
}

export type DraftRunner = (recordDigest: string) => DraftRunnerResult;

export interface DraftPolicyInput {
  recordDigest: string;
  canonicalMeetingId: string;
  required: boolean;
  policyVersion: string;
  reason: string;
  runner?: DraftRunner;
}

export interface DraftReceipt {
  sink: 'followup_draft';
  state: 'SKIPPED_POLICY' | 'SUCCEEDED';
  sendAuthorized: false;
  policyVersion: string;
  reason: string;
  recordDigest: string;
  canonicalMeetingId: string;
  draftId: string | null;
  subject: string | null;
  bodyDigest: string | null;
}

function fsyncPath(filePath: string): void {
  const fd = openSync(filePath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function receiptPath(storeDir: string, recordDigest: string): string {
  return join(storeDir, `${recordDigest}.json`);
}

export function evaluateDraftPolicy(storeDir: string, input: DraftPolicyInput): DraftReceipt {
  if (!/^[0-9a-f]{64}$/.test(input.recordDigest)) {
    throw new DraftPolicyError('recordDigest must be a sha256 hex digest');
  }
  ensureDir(storeDir);
  return withFileLockSync(storeDir, () => {
    const path = receiptPath(storeDir, input.recordDigest);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8')) as DraftReceipt;
    }

    const base = {
      sink: 'followup_draft' as const,
      sendAuthorized: false as const,
      policyVersion: input.policyVersion,
      reason: input.reason,
      recordDigest: input.recordDigest,
      canonicalMeetingId: input.canonicalMeetingId,
    };

    const receipt: DraftReceipt = input.required
      ? (() => {
        if (!input.runner) throw new DraftPolicyError('draft runner is required when policy requires a draft');
        const drafted = input.runner(input.recordDigest);
        return {
          ...base,
          state: 'SUCCEEDED',
          draftId: drafted.draftId,
          subject: drafted.subject,
          bodyDigest: drafted.bodyDigest,
        };
      })()
      : {
        ...base,
        state: 'SKIPPED_POLICY',
        draftId: null,
        subject: null,
        bodyDigest: null,
      };

    atomicWriteSync(path, JSON.stringify(receipt, null, 2));
    fsyncPath(path);
    return receipt;
  });
}
