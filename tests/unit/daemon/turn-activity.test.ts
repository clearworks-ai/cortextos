import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readCurrentSessionId,
  readLastTurnAtMs,
} from '../../../src/daemon/turn-activity.js';

/**
 * knox-codex, 2026-09-08 — why liveness cannot come from the conversation buffer.
 *
 * The wedge watchdog used conversation-buffer.jsonl's mtime as its staleness
 * clock. That file is touched ONLY on outbound Telegram sends, so an agent
 * working silently is indistinguishable from a wedged one. It force-restarted
 * agents for not having SPOKEN to Josh:
 *
 *   [frank2-codex] conversation buffer stale 3412min   (~57 hours)
 *   [larry-codex]  conversation buffer stale 2099min   (~35 hours)
 *
 * 229 force-restarts in one daemon log across the fleet.
 *
 * codex-tokens.jsonl carries one row per COMPLETED TURN, which is the actual
 * "is this agent doing work" signal. The session filter is mandatory, not
 * cosmetic: after a restart an orphaned previous-session process keeps appending
 * to the same file (observed at 18:16/18:18/18:20/18:25 on 2026-09-08, after the
 * 18:15 restart), so an unfiltered read would report a dead agent as alive using
 * the corpse's own turns.
 */

let dir: string;
const stateDir = () => join(dir, 'state');
const logDir = () => join(dir, 'logs');
const tokensPath = () => join(logDir(), 'codex-tokens.jsonl');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'turn-activity-'));
  mkdirSync(stateDir(), { recursive: true });
  mkdirSync(logDir(), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (sessionId: string, timestamp: string) =>
  JSON.stringify({ timestamp, session_id: sessionId, turn_id: 't', input_tokens: 1 });

describe('readCurrentSessionId', () => {
  it('prefers the thread file — it is stamped at session start', () => {
    // A freshly restarted agent has a new threadId but no completed turn yet, so
    // context_status.json still names the OLD session. Trusting that file would
    // make every fresh start look stale.
    writeFileSync(join(stateDir(), 'codex-app-server-thread.json'), JSON.stringify({ threadId: 'new-session' }));
    writeFileSync(join(stateDir(), 'context_status.json'), JSON.stringify({ session_id: 'old-session' }));

    expect(readCurrentSessionId(stateDir())).toBe('new-session');
  });

  it('falls back to context_status.json when there is no thread file', () => {
    writeFileSync(join(stateDir(), 'context_status.json'), JSON.stringify({ session_id: 'from-ctx' }));
    expect(readCurrentSessionId(stateDir())).toBe('from-ctx');
  });

  it('returns null when neither file exists', () => {
    expect(readCurrentSessionId(stateDir())).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing', () => {
    writeFileSync(join(stateDir(), 'codex-app-server-thread.json'), '{ not json');
    expect(readCurrentSessionId(stateDir())).toBeNull();
  });
});

describe('readLastTurnAtMs', () => {
  it('returns the timestamp of the newest turn for the given session', () => {
    writeFileSync(tokensPath(), [
      row('s1', '2026-09-08T10:00:00.000Z'),
      row('s1', '2026-09-08T10:05:00.000Z'),
      '',
    ].join('\n'));

    expect(readLastTurnAtMs(tokensPath(), 's1'))
      .toBe(Date.parse('2026-09-08T10:05:00.000Z'));
  });

  it('IGNORES turns from a previous session — the orphan-attribution trap', () => {
    // s_old is the leaked previous-session process, still emitting turns. It must
    // not count as liveness for s_new.
    writeFileSync(tokensPath(), [
      row('s_new', '2026-09-08T10:00:00.000Z'),
      row('s_old', '2026-09-08T11:00:00.000Z'),
      row('s_old', '2026-09-08T11:05:00.000Z'),
      '',
    ].join('\n'));

    expect(readLastTurnAtMs(tokensPath(), 's_new'))
      .toBe(Date.parse('2026-09-08T10:00:00.000Z'));
  });

  it('returns null when the session has no turns yet (fresh start)', () => {
    writeFileSync(tokensPath(), row('s_old', '2026-09-08T10:00:00.000Z') + '\n');
    expect(readLastTurnAtMs(tokensPath(), 's_new')).toBeNull();
  });

  it('returns null when the log does not exist', () => {
    expect(readLastTurnAtMs(join(logDir(), 'nope.jsonl'), 's1')).toBeNull();
  });

  it('skips malformed lines instead of throwing', () => {
    writeFileSync(tokensPath(), [
      row('s1', '2026-09-08T10:00:00.000Z'),
      '{ truncated write',
      'not json at all',
      row('s1', '2026-09-08T10:09:00.000Z'),
      '',
    ].join('\n'));

    expect(readLastTurnAtMs(tokensPath(), 's1'))
      .toBe(Date.parse('2026-09-08T10:09:00.000Z'));
  });

  it('skips rows with an unparseable timestamp', () => {
    writeFileSync(tokensPath(), [
      row('s1', '2026-09-08T10:00:00.000Z'),
      JSON.stringify({ timestamp: 'yesterday-ish', session_id: 's1' }),
      '',
    ].join('\n'));

    expect(readLastTurnAtMs(tokensPath(), 's1'))
      .toBe(Date.parse('2026-09-08T10:00:00.000Z'));
  });

  it('reads only the tail of a large log — this runs on every poll cycle', () => {
    // knox's log is ~667KB and grows unbounded; the watchdog must not read it all
    // every 30s. Rows far past the tail budget are not required to be seen, but
    // recent rows must be.
    const filler = Array.from({ length: 20_000 }, (_, i) =>
      row('s_ancient', `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`),
    );
    writeFileSync(tokensPath(), [...filler, row('s1', '2026-09-08T12:00:00.000Z'), ''].join('\n'));

    expect(readLastTurnAtMs(tokensPath(), 's1'))
      .toBe(Date.parse('2026-09-08T12:00:00.000Z'));
  });

  it('tolerates a tail read that slices mid-line', () => {
    // Seeking to a byte offset lands mid-row; that partial first line must be
    // discarded, not parsed.
    const big = Array.from({ length: 5_000 }, () => row('s1', '2026-09-08T09:00:00.000Z'));
    writeFileSync(tokensPath(), [...big, row('s1', '2026-09-08T13:00:00.000Z'), ''].join('\n'));

    expect(readLastTurnAtMs(tokensPath(), 's1'))
      .toBe(Date.parse('2026-09-08T13:00:00.000Z'));
  });
});
