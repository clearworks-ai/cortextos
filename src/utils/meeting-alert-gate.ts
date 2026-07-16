import { checkAndRecordSourceEvent } from './event-dedup.js';

export interface MeetingAlertInput {
  eventId?: string;
  subject?: string;
  date?: string;
}

export interface MeetingAlertDecision {
  surface: boolean;
  reason: string;
  key: string | null;
}

export const DEFAULT_MEETING_TTL_SEC = 7 * 86400;

const EVENT_ID_ALLOWED_CHARS = /[^A-Za-z0-9_/+=@.<>-]/g;
const MEETING_SUBJECT_PREFIX = /^(re|fwd|fw)\s*:\s*/i;
const MEETING_SUBJECT_ALLOWED_CHARS = /[^a-z0-9]/g;
const STRICT_LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeMeetingSubject(subject: string): string {
  let normalized = subject.trim().toLowerCase();
  while (true) {
    const stripped = normalized.replace(MEETING_SUBJECT_PREFIX, '').trim();
    if (stripped === normalized) {
      break;
    }
    normalized = stripped;
  }

  return normalized.replace(MEETING_SUBJECT_ALLOWED_CHARS, '').slice(0, 100);
}

export function deriveMeetingKey(input: MeetingAlertInput): string | null {
  const rawEventId = typeof input.eventId === 'string' ? input.eventId.trim() : '';
  if (rawEventId) {
    const sanitizedEventId = rawEventId.replace(EVENT_ID_ALLOWED_CHARS, '').slice(0, 200);
    if (sanitizedEventId) {
      return `meeting:evt-${sanitizedEventId}`;
    }
  }

  const token = typeof input.subject === 'string'
    ? normalizeMeetingSubject(input.subject)
    : '';
  const date = typeof input.date === 'string' ? input.date : '';
  if (token && STRICT_LOCAL_DATE.test(date)) {
    return `meeting:subj-${token}-${date}`;
  }

  return null;
}

export function evaluateMeetingAlert(
  ctxRoot: string,
  input: MeetingAlertInput,
  opts?: { ttlSec?: number },
): MeetingAlertDecision {
  const key = deriveMeetingKey(input);
  if (key === null) {
    return {
      surface: true,
      reason: 'surface: no derivable meeting key (fail-open)',
      key: null,
    };
  }

  const result = checkAndRecordSourceEvent(ctxRoot, key, {
    ttlSec: opts?.ttlSec ?? DEFAULT_MEETING_TTL_SEC,
  });
  if (result.surface) {
    return {
      surface: true,
      reason: 'surface: first alert for this meeting',
      key,
    };
  }

  return {
    surface: false,
    reason: `skip: meeting already alerted (${result.ageSec ?? 0}s ago)`,
    key,
  };
}
