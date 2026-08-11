import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { checkAndRecordSourceEvent } from '../utils/event-dedup.js';
import { sendMessage } from '../bus/message.js';
import { resolvePaths } from '../utils/paths.js';

/**
 * FR-002 — deterministic `crm.meeting.completed` emit (daemon on-worker-success hook).
 *
 * This module owns the emit MECHANISM. It replaces the old SKILL-prose emit (a separate
 * bash fence that lost WRITEBACK_RC across the worker's separate Bash tool-calls → silent
 * no-emit). The daemon calls `maybeEmitMeetingEvent` from the worker `onDone(name, exitCode)`
 * hook. Logic is kept pure + dependency-injectable so it is unit-testable without spawning
 * a real worker.
 *
 * commitmentIds are passed THROUGH from the per-meeting payload file (whatever array is
 * present) — this lane does NOT derive them (that is FR-003/FR-004).
 */

/** Shape of the per-meeting payload the writeback SKILL heredoc writes on success. */
export interface MeetingEventPayload {
  meeting_id: string;
  meeting_type: string;
  attendees: string[];
  client: string;
  commitmentIds: string[];
  writeback_ok: boolean;
}

/** Injectable side-effects so the hook is testable without touching the real bus/ledger. */
export interface MeetingEventDeps {
  /**
   * Dedup gate. Must return true ONLY the first time this source-key is seen (so a
   * re-spawn for the same meeting_id emits exactly once). Defaults to the shared
   * event-dedup ledger via checkAndRecordSourceEvent(fireOnce).
   */
  recordEvent: (ctxRoot: string, sourceKey: string) => boolean;
  /** Send a bus message from `pa` → `crm`. Defaults to bus/message.sendMessage. */
  send: (ctxRoot: string, org: string | undefined, text: string) => void;
  /** existsSync override (tests). */
  exists?: (path: string) => boolean;
  /** readFileSync-as-utf8 override (tests). */
  readFile?: (path: string) => string;
}

export interface MeetingEventResult {
  /** 'completed' | 'failed' | 'deduped' | 'skipped' (not a meeting worker). */
  outcome: 'completed' | 'failed' | 'deduped' | 'skipped';
  event?: 'crm.meeting.completed' | 'crm.meeting.failed';
  sourceKey?: string;
  meetingId?: string;
  /** Meeting type from the writeback payload — surfaced so the consumer dispatch (FR-004+) can gate on it. */
  meetingType?: string;
  reason?: string;
}

/**
 * Sanitize a Fireflies meeting id into the safeId used for the worker name AND the
 * per-meeting payload filename. MUST match `planMeetingWritebackSpawn` in
 * src/cli/webhook-bridge.ts so the daemon hook and the SKILL heredoc agree on the path.
 */
export function safeMeetingId(meetingId: string): string {
  return meetingId.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

/**
 * Derive the per-meeting payload path. Honors FF_EVENT_PAYLOAD_PATH if set (env override
 * agreed with the SKILL); otherwise `${CTX_TMP:-/tmp}/ff-meeting-event-<safeId>.json`.
 * The per-meeting path (never a shared /tmp file) is what makes concurrent meetings safe.
 */
export function meetingEventPayloadPath(
  meetingId: string,
  env: Record<string, string | undefined> = {},
): string {
  const override = env.FF_EVENT_PAYLOAD_PATH;
  if (override && override.trim()) return override.trim();
  const tmp = env.CTX_TMP && env.CTX_TMP.trim() ? env.CTX_TMP.trim() : '/tmp';
  return join(tmp, `ff-meeting-event-${safeMeetingId(meetingId)}.json`);
}

/** Default dedup: shared event-dedup ledger, fire-once, keyed by source. */
function defaultRecordEvent(ctxRoot: string, sourceKey: string): boolean {
  return checkAndRecordSourceEvent(ctxRoot, sourceKey, { fireOnce: true }).surface;
}

/** Default send: `pa` → `crm`, normal priority, via bus/message. */
function defaultSend(ctxRoot: string, org: string | undefined, text: string): void {
  const paths = resolvePaths('crm', undefined, org);
  // sendMessage only reads paths.ctxRoot; align it with the daemon's ctxRoot so the
  // message lands in the same instance's inbox regardless of instanceId defaulting.
  sendMessage({ ...paths, ctxRoot }, 'pa', 'crm', 'normal', text);
}

/** Compact single-line JSON for the message body (matches the old SKILL emit convention). */
function compact(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Core emit decision. Given a finished worker's identity + exit code + its captured env,
 * emit exactly one of `crm.meeting.completed` / `crm.meeting.failed` (or nothing for a
 * non-meeting worker). Deduped by meeting_id so a re-spawn emits exactly once.
 *
 * @param params.workerName    the finished worker's name
 * @param params.exitCode      worker exit code (0 = success path)
 * @param params.extraEnv      the env injected at spawn (must carry FF_MEETING_ID for meeting workers)
 * @param params.ctxRoot       daemon ctxRoot (for the dedup ledger + inbox)
 * @param params.org           org for path resolution (crm inbox)
 */
export function maybeEmitMeetingEvent(
  params: {
    workerName: string;
    exitCode: number;
    extraEnv?: Record<string, string | undefined>;
    ctxRoot: string;
    org?: string;
  },
  deps: Partial<MeetingEventDeps> = {},
): MeetingEventResult {
  const env = params.extraEnv ?? {};
  const ffMeetingId = env.FF_MEETING_ID;
  const isMeetingWorker = params.workerName.startsWith('meeting-writeback-') || !!(ffMeetingId && ffMeetingId.trim());
  if (!isMeetingWorker) {
    return { outcome: 'skipped', reason: 'not-a-meeting-worker' };
  }

  const recordEvent = deps.recordEvent ?? defaultRecordEvent;
  const send = deps.send ?? defaultSend;
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));

  // meeting_id used for path + source-key: prefer the env FF_MEETING_ID (drives the path);
  // fall back to the payload's meeting_id if for some reason the env is absent.
  const payloadPath = ffMeetingId ? meetingEventPayloadPath(ffMeetingId, env) : undefined;

  let payload: MeetingEventPayload | undefined;
  if (payloadPath && exists(payloadPath)) {
    try {
      const parsed = JSON.parse(readFile(payloadPath)) as unknown;
      if (parsed && typeof parsed === 'object') {
        payload = parsed as MeetingEventPayload;
      }
    } catch {
      payload = undefined;
    }
  }

  const meetingId = (payload?.meeting_id && String(payload.meeting_id).trim())
    || (ffMeetingId ? String(ffMeetingId).trim() : '');

  const success = params.exitCode === 0 && !!payload && payload.writeback_ok === true;

  if (success && payload) {
    const sourceKey = `crm.meeting.completed:${meetingId}`;
    if (!recordEvent(params.ctxRoot, sourceKey)) {
      return { outcome: 'deduped', event: 'crm.meeting.completed', sourceKey, meetingId };
    }
    const body: Record<string, unknown> = {
      meeting_id: meetingId,
      meeting_type: payload.meeting_type ?? 'other',
      attendees: Array.isArray(payload.attendees) ? payload.attendees : [],
      client: payload.client ?? '',
      commitmentIds: Array.isArray(payload.commitmentIds) ? payload.commitmentIds : [],
    };
    send(params.ctxRoot, params.org, `EVENT crm.meeting.completed — ${compact(body)}`);
    return {
      outcome: 'completed',
      event: 'crm.meeting.completed',
      sourceKey,
      meetingId,
      meetingType: (payload.meeting_type ?? 'other') as string,
    };
  }

  // Failure path: exit≠0, or missing/invalid payload, or writeback_ok !== true.
  const reason = params.exitCode !== 0
    ? `worker-exit-${params.exitCode}`
    : !payload
      ? 'no-writeback-payload'
      : 'writeback-not-ok';
  const sourceKey = `crm.meeting.failed:${meetingId}`;
  if (!recordEvent(params.ctxRoot, sourceKey)) {
    return { outcome: 'deduped', event: 'crm.meeting.failed', sourceKey, meetingId, reason };
  }
  send(
    params.ctxRoot,
    params.org,
    `EVENT crm.meeting.failed — ${compact({ meeting_id: meetingId, reason })}`,
  );
  return { outcome: 'failed', event: 'crm.meeting.failed', sourceKey, meetingId, reason };
}
