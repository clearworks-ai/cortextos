import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectLifecycleBuckets } from '../../../src/bus/meeting-lifecycle.js';

const CONTRACTS = join(__dirname, '..', '..', '..', 'state', 'specs', 'contracts');

describe('meeting lifecycle projection', () => {
  it('maps accepted work-item claims onto the golden dashboard buckets', () => {
    const record = JSON.parse(readFileSync(join(CONTRACTS, 'meeting-record-v1.golden.json'), 'utf8')) as {
      lifecycle: {
        myTasks: string[];
        waitingOnThem: string[];
        completedClosed: string[];
        notTasks: string[];
      };
      claims: Array<Record<string, unknown>>;
    };
    const projected = projectLifecycleBuckets(record);
    expect(projected.myTasks).toEqual(record.lifecycle.myTasks);
    expect(projected.waitingOnThem).toEqual(record.lifecycle.waitingOnThem);
    expect(projected.completedClosed).toEqual(record.lifecycle.completedClosed);
    expect(projected.notTasks).toEqual(record.lifecycle.notTasks);
  });
});
