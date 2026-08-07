import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  appendEventReceipt,
  canonicalEventId,
  readEventReceipts,
  recordIngressReceipt,
  recordRejectedIngressReceipt,
} from '../../../src/bus/event-delivery';
import { ShadowRouter } from '../../../src/bus/shadow-router';
import { advanceNumericEventCursor, compareCanonicalNumericCursors, getEventCursor } from '../../../src/bus/event-receipt-index';
import { appendCronOutcome, cronRunId, getActiveCronOutcome, reconcileCronOutcomes, readCronOutcomes, MAX_CRON_OUTCOME_INDEX_RECORDS } from '../../../src/bus/cron-outcome';
import { inventoryCrons } from '../../../src/bus/cron-inventory';
import type { CronDefinition } from '../../../src/types/index';
import { gatherDeclaredAgents } from '../../../src/cli/bus-reconcile';
import { readCronDefinitions } from '../../../src/cli/bus-cron-inventory';

describe('event and cron receipt foundation', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-event-cron-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const event = { provider: 'calendar', eventType: 'meeting.created', sourceId: 'secret@example.com', occurredAt: '2026-08-07T00:00:00.000Z' };

  it('records accepted, duplicate, and rejected ingress without persisting raw provider identity', () => {
    const accepted = recordIngressReceipt(stateDir, event);
    const duplicate = recordIngressReceipt(stateDir, event);
    const rejected = recordRejectedIngressReceipt(stateDir, event, 'invalid_signature');

    expect(accepted.disposition).toBe('accepted');
    expect(duplicate.disposition).toBe('duplicate');
    expect(rejected.disposition).toBe('rejected');
    expect(accepted.event_id).toBe(canonicalEventId(stateDir, event));
    expect(JSON.stringify(readEventReceipts(stateDir))).not.toContain(event.sourceId);
  });

  it('rolls back an accepted dedup claim when the receipt append fails', () => {
    mkdirSync(join(stateDir, 'event-receipts.jsonl'));
    expect(() => recordIngressReceipt(stateDir, event)).toThrow();
    rmSync(join(stateDir, 'event-receipts.jsonl'), { recursive: true, force: true });
    expect(recordIngressReceipt(stateDir, event).disposition).toBe('accepted');
  });

  it('returns the durable accepted receipt when its index write fails, then heals before reporting duplicate', () => {
    const accepted = recordIngressReceipt(stateDir, event, true, { writeIndex: () => { throw new Error('injected index fault'); } });
    expect(accepted.disposition).toBe('accepted');
    const router = new ShadowRouter('shadow', { stateDir });
    expect(router.route(accepted, 'larry', 'policy_match').proposed).toBe(true);

    expect(recordIngressReceipt(stateDir, event).disposition).toBe('duplicate');
    expect(readEventReceipts(stateDir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ receipt_id: accepted.receipt_id, disposition: 'accepted' }),
      expect.objectContaining({ event_id: accepted.event_id, routing_state: 'proposed' }),
    ]));
  });

  it('preserves dedup across a fresh read of the persistent index', () => {
    recordIngressReceipt(stateDir, event);
    expect(recordIngressReceipt(stateDir, event).disposition).toBe('duplicate');
    expect(existsSync(join(stateDir, 'event-receipt-index.json'))).toBe(true);
  });

  it('accepts exactly one copy under concurrent duplicate submissions', async () => {
    const receipts = await Promise.all(
      Array.from({ length: 20 }, async () => recordIngressReceipt(stateDir, event)),
    );
    expect(receipts.filter(receipt => receipt.disposition === 'accepted')).toHaveLength(1);
    expect(receipts.filter(receipt => receipt.disposition === 'duplicate')).toHaveLength(19);
  });

  it('compares and persists arbitrary-precision canonical numeric cursors', () => { expect(compareCanonicalNumericCursors('9', '10')).toBeLessThan(0); expect(compareCanonicalNumericCursors('9'.repeat(100), '1' + '0'.repeat(100))).toBeLessThan(0); expect(advanceNumericEventCursor(stateDir, 'gmail.shadow.notification_high_water', '9')).toBe(true); expect(advanceNumericEventCursor(stateDir, 'gmail.shadow.notification_high_water', '10')).toBe(true); expect(advanceNumericEventCursor(stateDir, 'gmail.shadow.notification_high_water', '9')).toBe(false); expect(getEventCursor(stateDir, 'gmail.shadow.notification_high_water')).toBe('10'); for (const invalid of ['', '01', '-1', '+1', '1.0', ' 1', '1 '.padEnd(129, '0')]) expect(() => advanceNumericEventCursor(stateDir, 'numeric', invalid)).toThrow('invalid numeric'); });

  it('does not invoke a route sink when the acceptance receipt cannot be written', () => {
    const router = new ShadowRouter('shadow', { stateDir });
    mkdirSync(join(stateDir, 'event-receipts.jsonl'));
    let receipt;
    try {
      receipt = recordIngressReceipt(stateDir, event);
    } catch {
      receipt = undefined;
    }
    if (receipt) router.route(receipt, 'larry', 'policy_match');
    rmSync(join(stateDir, 'event-receipts.jsonl'), { recursive: true, force: true });
    expect(readEventReceipts(stateDir)).toEqual([]);
  });

  it('shadow routing only records a proposal and never delivers it', () => {
    const router = new ShadowRouter('shadow', { stateDir });
    const receipt = recordIngressReceipt(stateDir, event);
    expect(router.route(receipt, 'larry', 'policy_match')).toEqual({ mode: 'shadow', proposed: true, delivered: false });
    expect(readEventReceipts(stateDir).filter(row => row.stage === 'routing')).toEqual([
      expect.objectContaining({ event_id: receipt.event_id, routing_state: 'proposed', route: 'larry' }),
    ]);
    expect(() => new ShadowRouter('shadow', { stateDir, deliver: () => undefined })).toThrow('delivery capability');
  });

  it('deduplicates shadow proposals durably beyond the receipt tail and across router restart', () => {
    const receipt = recordIngressReceipt(stateDir, event);
    expect(new ShadowRouter('shadow', { stateDir }).route(receipt, 'larry', 'policy_match').proposed).toBe(true);
    for (let index = 0; index < 2_100; index += 1) {
      recordRejectedIngressReceipt(stateDir, { provider: 'noise', eventType: 'notification', sourceId: `noise-${index}` }, 'noise');
    }
    expect(new ShadowRouter('shadow', { stateDir }).route(receipt, 'larry', 'policy_match')).toEqual({ mode: 'shadow', proposed: false, delivered: false });
    const index = JSON.parse(readFileSync(join(stateDir, 'event-receipt-index.json'), 'utf8')) as { proposedRoutes: Record<string, string> };
    expect(Object.keys(index.proposedRoutes)).toEqual([`${receipt.event_id}:larry`]);
  });

  it('heals route-proposal crashes before and after the durable receipt append', () => {
    const ingress = recordIngressReceipt(stateDir, event);
    for (const [route, receiptAlreadyAppended] of [['larry', false], ['maven', true]] as const) {
      const proposal = { version: 2 as const, receipt_id: randomUUID(), event_id: ingress.event_id, at: new Date().toISOString(), stage: 'routing' as const, routing_state: 'proposed' as const, route, reason: 'policy_match' };
      if (receiptAlreadyAppended) appendEventReceipt(stateDir, proposal);
      writeFileSync(join(stateDir, 'event-route-proposal-tx.json'), JSON.stringify({ version: 1, receipt: proposal }));
      expect(new ShadowRouter('shadow', { stateDir }).route(ingress, route, 'policy_match').proposed).toBe(false);
      expect(readEventReceipts(stateDir).filter((entry) => entry.stage === 'routing' && entry.route === route)).toHaveLength(1);
      expect(existsSync(join(stateDir, 'event-route-proposal-tx.json'))).toBe(false);
    }
  });

  it('reconciles a dispatched run to timed_out without treating dispatch as success', () => {
    const runId = cronRunId(stateDir, 'larry', 'hourly-check', '2026-08-07T00:00:00.000Z');
    appendCronOutcome(stateDir, { run_id: runId, attempt: 1, agent: 'larry', cron: 'hourly-check', state: 'scheduled', at: '2026-08-07T00:00:00.000Z', detail: 'scheduler_due' });
    appendCronOutcome(stateDir, { run_id: runId, attempt: 1, agent: 'larry', cron: 'hourly-check', state: 'started', at: '2026-08-07T00:00:01.000Z', detail: 'scheduler_dispatch' });
    appendCronOutcome(stateDir, { run_id: runId, attempt: 1, agent: 'larry', cron: 'hourly-check', state: 'dispatched', at: '2026-08-07T00:00:02.000Z', detail: 'worker_receipt_pending' });

    const timedOut = reconcileCronOutcomes(stateDir, Date.parse('2026-08-07T01:00:00.000Z'), 60_000);
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].state).toBe('timed_out');
    expect(readCronOutcomes(stateDir).map(row => row.state)).not.toContain('succeeded');
  });

  it('reconciles a stale scheduled run to timed_out', () => {
    const scheduledAt = '2026-08-07T00:00:00.000Z';
    const runId = cronRunId(stateDir, 'larry', 'stale-scheduled', scheduledAt);
    appendCronOutcome(stateDir, { run_id: runId, attempt: 1, agent: 'larry', cron: 'stale-scheduled', state: 'scheduled', at: scheduledAt });
    expect(reconcileCronOutcomes(stateDir, Date.parse('2026-08-07T01:00:00.000Z'), 60_000)).toEqual([
      expect.objectContaining({ run_id: runId, state: 'timed_out' }),
    ]);
  });

  it('selects multiple unfinished runs oldest-first without stranding earlier work', () => {
    const olderAt = '2026-08-07T00:00:00.000Z';
    const newerAt = '2026-08-07T00:10:00.000Z';
    const newerRun = cronRunId(stateDir, 'larry', 'ordered', newerAt);
    const olderRun = cronRunId(stateDir, 'larry', 'ordered', olderAt);
    for (const [runId, scheduledAt] of [[newerRun, newerAt], [olderRun, olderAt]]) {
      appendCronOutcome(stateDir, { run_id: runId, attempt: 1, agent: 'larry', cron: 'ordered', state: 'scheduled', at: scheduledAt, scheduled_at: scheduledAt });
      appendCronOutcome(stateDir, { run_id: runId, attempt: 1, agent: 'larry', cron: 'ordered', state: 'started', at: scheduledAt, scheduled_at: scheduledAt });
    }
    expect(getActiveCronOutcome(stateDir, 'larry', 'ordered')?.run_id).toBe(olderRun);
    appendCronOutcome(stateDir, { run_id: olderRun, attempt: 1, agent: 'larry', cron: 'ordered', state: 'dispatched', scheduled_at: olderAt });
    expect(getActiveCronOutcome(stateDir, 'larry', 'ordered')?.run_id).toBe(newerRun);
  });

  it('prunes completed cron runs when the idempotency index reaches its bound', () => {
    const oldRunId = 'cron_v1_' + '1'.repeat(32);
    const oldReceipt = {
      version: 2,
      receipt_id: '00000000-0000-4000-8000-000000000000',
      run_id: oldRunId,
      attempt: 1,
      agent: 'agent_v1_' + '2'.repeat(32),
      cron: 'cron_v1_' + '3'.repeat(32),
      state: 'succeeded',
      at: '2026-08-07T00:00:00.000Z',
      scheduled_at: '2026-08-07T00:00:00.000Z',
    };
    const idempotent = Object.fromEntries(Array.from({ length: MAX_CRON_OUTCOME_INDEX_RECORDS }, (_, index) => [oldRunId + '\u0000old\u0000' + index, oldReceipt]));
    writeFileSync(join(stateDir, 'cron-outcome-secret'), '0'.repeat(64));
    writeFileSync(join(stateDir, 'cron-outcome-index.json'), JSON.stringify({ version: 1, latest: { [oldRunId]: oldReceipt }, nonterminal: {}, idempotent }));
    const newRunId = cronRunId(stateDir, 'larry', 'new-run', '2026-08-08T00:00:00.000Z');
    expect(appendCronOutcome(stateDir, { run_id: newRunId, attempt: 1, agent: 'larry', cron: 'new-run', state: 'scheduled' }).run_id).toBe(newRunId);
  });

  it('reports malformed inputs and declaration/runtime/schedule drift without repairing anything', () => {
    const cron: CronDefinition = { name: 'hourly-check', prompt: 'check', schedule: '1h', enabled: true, created_at: '2026-08-07T00:00:00.000Z' };
    const report = inventoryCrons({
      declared: { larry: [cron], pa: [{ ...cron, name: 'declared-only' }] },
      runtime: { larry: ['orphan-run'] },
      scheduled: { larry: [{ ...cron, prompt: 'changed' }, { ...cron, name: 'scheduled-only' }] },
      malformed: ['crons.json: malformed JSON'],
      unreadable: ['daemon schedule: unavailable'],
    });
    expect(report.findings.map(finding => finding.kind)).toEqual(expect.arrayContaining([
      'malformed_input', 'unreadable_input', 'declared_only', 'definition_mismatch', 'runtime_only', 'scheduled_only',
    ]));
  });

  it('detects fire_at and manual-fire definition drift', () => {
    const cron: CronDefinition = { name: 'one-shot', prompt: 'check', schedule: '1h', enabled: true, created_at: '2026-08-07T00:00:00.000Z', fire_at: '2026-08-08T00:00:00.000Z', manualFireDisabled: true };
    const report = inventoryCrons({ declared: { larry: [cron] }, runtime: {}, scheduled: { larry: [{ ...cron, fire_at: '2026-08-09T00:00:00.000Z', manualFireDisabled: false }] } });
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'definition_mismatch', cron: 'one-shot' }));
  });

  it('classifies malformed cron JSON separately from unreadable input', () => {
    const path = join(stateDir, 'crons.json');
    writeFileSync(path, '{broken', 'utf-8');
    const unreadable: string[] = [];
    const malformed: string[] = [];
    expect(readCronDefinitions(path, unreadable, malformed)).toEqual([]);
    expect(malformed).toHaveLength(1);
    expect(unreadable).toEqual([]);
  });

  it('surfaces malformed agent configuration during fleet reconciliation discovery', () => {
    const frameworkRoot = join(stateDir, 'framework');
    const agentDir = join(frameworkRoot, 'orgs', 'clearworksai', 'agents', 'broken');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), '{broken', 'utf-8');
    expect(() => gatherDeclaredAgents(frameworkRoot)).toThrow('Malformed agent config');
  });
});
