# Spec 01 — `src/utils/meeting-alert-gate.ts` + `bus meeting-alert-gate` command

**Pattern to mirror:** `src/utils/ci-alert-gate.ts` (pure evaluate fn, typed decision) and
its CLI handler at `src/cli/bus.ts:2972-2996`. Ledger reuse:
`checkAndRecordSourceEvent` from `src/utils/event-dedup.ts:91-131`
(ledger file `state/comms-event-dedup.json`; key must satisfy
`SOURCE_KEY_PATTERN` at `src/utils/event-dedup.ts:22` —
`/^[a-z0-9_-]{1,32}:[A-Za-z0-9_/+=@.<>-]{1,512}$/`; note the id portion allows NO spaces
and NO colon).

## New file: `src/utils/meeting-alert-gate.ts`

```ts
import { checkAndRecordSourceEvent } from './event-dedup.js';

export interface MeetingAlertInput {
  eventId?: string;   // calendar event id, preferred identity
  subject?: string;   // meeting title / email thread subject (fallback identity)
  date?: string;      // meeting LOCAL date, strict YYYY-MM-DD (fallback identity)
}

export interface MeetingAlertDecision {
  surface: boolean;
  reason: string;
  key: string | null; // derived ledger key, for debuggability
}

export const DEFAULT_MEETING_TTL_SEC = 7 * 86400; // 604800

export function normalizeMeetingSubject(subject: string): string;
export function deriveMeetingKey(input: MeetingAlertInput): string | null;
export function evaluateMeetingAlert(
  ctxRoot: string,
  input: MeetingAlertInput,
  opts?: { ttlSec?: number }
): MeetingAlertDecision;
```

### `normalizeMeetingSubject(subject)` — deterministic, no LLM

1. Lowercase; trim.
2. Repeatedly strip leading reply/forward prefixes: `/^(re|fwd|fw)\s*:\s*/i` (loop until no match).
3. Remove every character NOT in `[a-z0-9]` (kills spaces, punctuation, hyphens, unicode).
4. Truncate to 100 chars.
5. Return the token ('' when nothing survives).

Result: `"Re: E-Rate for Scholarship Prep!"` → `erateforscholarshipprep` — identical to
`"E-rate for scholarship prep"`.

### `deriveMeetingKey(input)` — precedence rules

1. **eventId path:** if `input.eventId` is a non-empty string after trim: strip every char
   NOT matching `[A-Za-z0-9_/+=@.<>-]`, truncate to 200. If non-empty →
   `` `meeting:evt-${sanitized}` ``.
2. **subject+date fallback:** else if `input.subject` normalizes (via
   `normalizeMeetingSubject`) to a non-empty token AND `input.date` matches
   `/^\d{4}-\d{2}-\d{2}$/` strictly → `` `meeting:subj-${token}-${input.date}` ``.
3. Else → `null`.

The `evt-` / `subj-` prefixes prevent collisions between the two identity spaces. All
produced keys satisfy `SOURCE_KEY_PATTERN` by construction (namespace `meeting` ≤32
lowercase chars; id portion ≤ 200+4 or 100+5+11 chars from the allowed class).

### `evaluateMeetingAlert(ctxRoot, input, opts)`

1. `const key = deriveMeetingKey(input)`.
2. If `key === null` → `{ surface: true, reason: 'surface: no derivable meeting key (fail-open)', key: null }`.
   (Fail-open matches event-dedup invalid-key behavior at `src/utils/event-dedup.ts:100-102`;
   a duplicate ping beats a dropped meeting notice.)
3. `const result = checkAndRecordSourceEvent(ctxRoot, key, { ttlSec: opts?.ttlSec ?? DEFAULT_MEETING_TTL_SEC })`.
   Do NOT pass `fireOnce` — TTL semantics, so a recurring meeting sharing a base
   calendar eventId re-surfaces after the window.
4. Map: `result.surface === true` →
   `{ surface: true, reason: 'surface: first alert for this meeting', key }`;
   else `{ surface: false, reason: \`skip: meeting already alerted (${result.ageSec ?? 0}s ago)\`, key }`.

No `any`, no `console.log` in the util. Pure except the ledger write inside
`checkAndRecordSourceEvent`.

## `src/cli/bus.ts` — new `meeting-alert-gate` command

**Insert location:** immediately after the `event-dedup` command block (ends at
`src/cli/bus.ts:3025`), before the `comms-filter` block (starts :3027).
**Import:** add `evaluateMeetingAlert` to the imports next to the existing dedup imports
(`src/cli/bus.ts:40-41`), e.g.
`import { evaluateMeetingAlert } from '../utils/meeting-alert-gate.js';`.

```
cortextos bus meeting-alert-gate [--event-id <id>] [--subject <s>] [--date <YYYY-MM-DD>] [--ttl-sec <n>] [--json]
```

Handler (mirror the `event-dedup` handler shape at `src/cli/bus.ts:3005-3025`):

- `.description('Deterministically decide whether a meeting notification should be surfaced — fires once per meeting identity (SURFACE/SKIP)')`
- Options: `--event-id <id>` (calendar event id, preferred), `--subject <subject>`
  (meeting title or thread subject, fallback), `--date <YYYY-MM-DD>` (the MEETING's
  local date, fallback), `--ttl-sec <n>` (suppression window, default 604800 = 7d;
  validate exactly like event-dedup's ttl parse at :3007-3015 — non-positive/NaN →
  `console.error` + fall back to default), `--json`.
- `const env = resolveEnv();`
  `const result = evaluateMeetingAlert(env.ctxRoot ?? '', { eventId: opts.eventId, subject: opts.subject, date: opts.date }, { ttlSec });`
- Output contract: with `--json` print exactly one line
  `JSON.stringify(result)` → `{"surface":true|false,"reason":"...","key":"meeting:..."|null}`.
  Without `--json` print `SURFACE` or `SKIP`. Exit code 0 in all cases (decision is in
  the output, same as ci-alert-gate/event-dedup).

## Unit tests — NEW `tests/unit/utils/meeting-alert-gate.test.ts`

Mirror `tests/unit/utils/ci-alert-gate.test.ts` (vitest; `mkdtempSync` ctxRoot per test,
`rmSync` in `afterEach`; exercise the REAL `checkAndRecordSourceEvent` ledger — no mocks
of the ledger). Required cases:

1. **first-surface=true** — `evaluateMeetingAlert(ctxRoot, { eventId: 'abc123@google.com' })`
   → `surface: true`, key `meeting:evt-abc123@google.com`; ledger file contains the key.
2. **second-same-meeting=false even when reworded** —
   a) same eventId twice → second call `surface: false`;
   b) fallback path: `{ subject: 'E-Rate for Scholarship Prep meeting tomorrow', date: '2026-07-16' }`
      then `{ subject: 'Re: E-rate, for SCHOLARSHIP prep!!', date: '2026-07-16' }` — wait:
      these normalize to `erateforscholarshipprepmeetingtomorrow` vs `erateforscholarshipprep`,
      which are DIFFERENT tokens. Use rewordings that differ only in case/punctuation/
      prefixes of the same title: `'E-Rate for Scholarship Prep'`,
      `'Re: E-rate for scholarship prep!'`, `'FWD: e rate for scholarship prep'` — all
      three must derive the SAME key; calls 2 and 3 → `surface: false`.
3. **two-distinct-meetings both=true** —
   a) two different eventIds → both `surface: true`;
   b) different subjects, same date → both true;
   c) same subject, different dates (`2026-07-16` vs `2026-07-23`) → both true.
4. **no-eventid fallback path** — `{ subject, date }` with no eventId derives
   `meeting:subj-<token>-<date>` and gates correctly (first true, repeat false).
5. **derivation edge table** (`deriveMeetingKey` direct):
   eventId with illegal chars sanitized; eventId empty-after-sanitize falls through to
   subject+date; bad date (`'7/16/2026'`, `'2026-7-16'`) → null when no eventId;
   empty/punctuation-only subject → null; null-input → null.
6. **fail-open** — `evaluateMeetingAlert` with `{}` → `surface: true`,
   reason contains `fail-open`, `key: null`, and NOTHING is written to the ledger.
7. **TTL expiry re-surfaces** — seed ledger entry with `firstSeenAt` older than ttl
   (mock `Date.now` like `tests/unit/utils/event-dedup.test.ts:16`) → `surface: true`.

## Acceptance

- `npm run build` clean (TS strict, no `any`).
- `npm test` green including the new file.
- CLI smoke: two identical invocations of
  `node dist/cli.js bus meeting-alert-gate --subject "E-Rate for Scholarship Prep" --date 2026-07-16 --json`
  print `"surface":true` then `"surface":false`.
