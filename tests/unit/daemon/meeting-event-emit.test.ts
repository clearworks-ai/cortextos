import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  maybeEmitMeetingEvent,
  meetingEventPayloadPath,
  safeMeetingId,
  type MeetingEventPayload,
} from '../../../src/daemon/meeting-event-emit.js';

/**
 * FR-002 — unit tests for the deterministic meeting-event emit MECHANISM.
 * The helper is exercised directly with a temp payload file + a fake bus-send + a
 * fake dedup ledger. No worker is spawned.
 */

describe('meeting-event-emit — FR-002 mechanism', () => {
  let tmp: string;
  // Fake dedup ledger: a Set of source-keys already recorded (fire-once semantics).
  let ledger: Set<string>;
  let sends: Array<{ ctxRoot: string; org: string | undefined; text: string }>;

  const ctxRoot = '/tmp/fake-ctx';

  const recordEvent = (root: string, sourceKey: string): boolean => {
    if (ledger.has(sourceKey)) return false; // duplicate → do not surface
    ledger.add(sourceKey);
    return true; // first-seen → surface
  };
  const send = (root: string, org: string | undefined, text: string): void => {
    sends.push({ ctxRoot: root, org, text });
  };
  const deps = () => ({ recordEvent, send });

  function writePayload(meetingId: string, overrides: Partial<MeetingEventPayload> = {}): string {
    const p = join(tmp, `ff-meeting-event-${safeMeetingId(meetingId)}.json`);
    const payload: MeetingEventPayload = {
      meeting_id: meetingId,
      meeting_type: 'sales',
      attendees: ['alice@acme.com', 'josh@clearworks.ai'],
      client: 'Acme',
      commitmentIds: ['c1', 'c2'],
      writeback_ok: true,
      ...overrides,
    };
    writeFileSync(p, JSON.stringify(payload));
    return p;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ff-event-'));
    ledger = new Set();
    sends = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('safeMeetingId matches the webhook-bridge sanitization', () => {
    expect(safeMeetingId('ABC-123_xy')).toBe('abc-123_xy');
    expect(safeMeetingId('a!b@c#d')).toBe('abcd');
    expect(safeMeetingId('X'.repeat(60))).toHaveLength(40);
  });

  it('meetingEventPayloadPath honors FF_EVENT_PAYLOAD_PATH then CTX_TMP then /tmp', () => {
    expect(meetingEventPayloadPath('MTG1', { FF_EVENT_PAYLOAD_PATH: '/custom/p.json' })).toBe('/custom/p.json');
    expect(meetingEventPayloadPath('MTG1', { CTX_TMP: '/var/tmp' })).toBe('/var/tmp/ff-meeting-event-mtg1.json');
    expect(meetingEventPayloadPath('MTG1', {})).toBe('/tmp/ff-meeting-event-mtg1.json');
  });

  it('(a) exit 0 + writeback_ok → exactly one crm.meeting.completed with correct payload', () => {
    writePayload('MTG1');
    const res = maybeEmitMeetingEvent(
      { workerName: 'meeting-writeback-mtg1', exitCode: 0, extraEnv: { FF_MEETING_ID: 'MTG1', CTX_TMP: tmp }, ctxRoot },
      deps(),
    );
    expect(res.outcome).toBe('completed');
    expect(res.event).toBe('crm.meeting.completed');
    expect(res.sourceKey).toBe('crm.meeting.completed:MTG1');
    expect(sends).toHaveLength(1);
    expect(sends[0].text.startsWith('EVENT crm.meeting.completed — ')).toBe(true);
    const body = JSON.parse(sends[0].text.replace('EVENT crm.meeting.completed — ', ''));
    expect(body).toEqual({
      meeting_id: 'MTG1',
      meeting_type: 'sales',
      attendees: ['alice@acme.com', 'josh@clearworks.ai'],
      client: 'Acme',
      commitmentIds: ['c1', 'c2'],
    });
  });

  it('(b) re-invocation with same meeting_id → deduped, no second send', () => {
    writePayload('MTG1');
    const first = maybeEmitMeetingEvent(
      { workerName: 'meeting-writeback-mtg1', exitCode: 0, extraEnv: { FF_MEETING_ID: 'MTG1', CTX_TMP: tmp }, ctxRoot },
      deps(),
    );
    const second = maybeEmitMeetingEvent(
      { workerName: 'meeting-writeback-mtg1', exitCode: 0, extraEnv: { FF_MEETING_ID: 'MTG1', CTX_TMP: tmp }, ctxRoot },
      deps(),
    );
    expect(first.outcome).toBe('completed');
    expect(second.outcome).toBe('deduped');
    expect(sends).toHaveLength(1);
  });

  it('(c) exit≠0 → crm.meeting.failed, no completed', () => {
    writePayload('MTG1'); // payload exists but worker failed
    const res = maybeEmitMeetingEvent(
      { workerName: 'meeting-writeback-mtg1', exitCode: 1, extraEnv: { FF_MEETING_ID: 'MTG1', CTX_TMP: tmp }, ctxRoot },
      deps(),
    );
    expect(res.outcome).toBe('failed');
    expect(res.event).toBe('crm.meeting.failed');
    expect(sends).toHaveLength(1);
    const body = JSON.parse(sends[0].text.replace('EVENT crm.meeting.failed — ', ''));
    expect(body).toEqual({ meeting_id: 'MTG1', reason: 'worker-exit-1' });
    // no completed key recorded
    expect(ledger.has('crm.meeting.completed:MTG1')).toBe(false);
  });

  it('(d) missing payload → failed', () => {
    const res = maybeEmitMeetingEvent(
      { workerName: 'meeting-writeback-nope', exitCode: 0, extraEnv: { FF_MEETING_ID: 'NOPE', CTX_TMP: tmp }, ctxRoot },
      deps(),
    );
    expect(res.outcome).toBe('failed');
    expect(res.reason).toBe('no-writeback-payload');
    expect(sends).toHaveLength(1);
    expect(sends[0].text.startsWith('EVENT crm.meeting.failed — ')).toBe(true);
  });

  it('(d2) writeback_ok:false payload → failed', () => {
    writePayload('MTG1', { writeback_ok: false });
    const res = maybeEmitMeetingEvent(
      { workerName: 'meeting-writeback-mtg1', exitCode: 0, extraEnv: { FF_MEETING_ID: 'MTG1', CTX_TMP: tmp }, ctxRoot },
      deps(),
    );
    expect(res.outcome).toBe('failed');
    expect(res.reason).toBe('writeback-not-ok');
    expect(sends).toHaveLength(1);
  });

  it('(e) non-meeting worker name + no FF_MEETING_ID → no emit at all', () => {
    const res = maybeEmitMeetingEvent(
      { workerName: 'some-other-worker', exitCode: 0, extraEnv: {}, ctxRoot },
      deps(),
    );
    expect(res.outcome).toBe('skipped');
    expect(sends).toHaveLength(0);
    expect(ledger.size).toBe(0);
  });

  it('FF_MEETING_ID set on a non-prefixed worker name still emits (meeting worker by env)', () => {
    writePayload('MTG9');
    const res = maybeEmitMeetingEvent(
      { workerName: 'arbitrary-name', exitCode: 0, extraEnv: { FF_MEETING_ID: 'MTG9', CTX_TMP: tmp }, ctxRoot },
      deps(),
    );
    expect(res.outcome).toBe('completed');
    expect(sends).toHaveLength(1);
  });

  it('defaults meeting_type to "other" and empty arrays when payload fields absent', () => {
    // minimal payload: writeback_ok true, meeting_id only
    const p = join(tmp, `ff-meeting-event-${safeMeetingId('MTGM')}.json`);
    writeFileSync(p, JSON.stringify({ meeting_id: 'MTGM', writeback_ok: true }));
    const res = maybeEmitMeetingEvent(
      { workerName: 'meeting-writeback-mtgm', exitCode: 0, extraEnv: { FF_MEETING_ID: 'MTGM', CTX_TMP: tmp }, ctxRoot },
      deps(),
    );
    expect(res.outcome).toBe('completed');
    const body = JSON.parse(sends[0].text.replace('EVENT crm.meeting.completed — ', ''));
    expect(body.meeting_type).toBe('other');
    expect(body.attendees).toEqual([]);
    expect(body.commitmentIds).toEqual([]);
    expect(body.client).toBe('');
  });
});
