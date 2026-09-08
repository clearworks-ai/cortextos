/**
 * turn-metrics — per-agent turn RATE and input-token burn.
 *
 * WHY THIS EXISTS (knox-codex, 2026-09-08). Each codex agent sends its full
 * standing prompt on every turn — knox ~130-144K input tokens, identical on a
 * 3.6-day-old session and a fresh one, so it is prompt size, not context growth.
 * That makes turn RATE the cost multiplier:
 *
 *     baseline   10 turns/hr  ~=  1.4M input tok/hr
 *     browser   500 turns/hr  ~=   70M input tok/hr
 *
 * When sustained browser automation started, knox stepped from a 2-32/hr
 * baseline to 274-500/hr and held it overnight. Nothing surfaced it: the
 * dashboard tracks daily SPEND, a total rather than a velocity, so a 50x rate
 * change stays invisible until the day's total lands.
 *
 * THE CUMULATIVE TRAP. `input_tokens` in codex-tokens.jsonl is cumulative PER
 * SESSION (see the writer at src/pty/codex-app-server-pty.ts). Per-turn cost is
 * the delta between consecutive rows of the same session, and a new session
 * resets the counter — so a naive read reports knox's 1.8-billion cumulative
 * total as a single turn, and a naive delta across a session boundary goes
 * hugely negative.
 */

export interface TurnRow {
  atMs: number;
  sessionId: string;
  /** CUMULATIVE input tokens for the session, as written to the log. */
  inputTokens: number;
  /** CUMULATIVE cache-read tokens for the session. */
  cacheReadTokens: number;
}

export interface WindowMetrics {
  turns: number;
  /** Input tokens actually spent in the window (deltas, not cumulatives). */
  inputTokens: number;
  /** Of those, tokens served from cache. */
  cacheReadTokens: number;
  /**
   * Input that was NOT served from cache — the number that tracks cost.
   *
   * Measured across the real fleet, 83-98.6% of input tokens are cache reads, so
   * raw input overstates spend by up to ~50x. One 58-turn burst spent 11,853,518
   * input tokens of which 11,798,656 were cache reads.
   */
  uncachedInputTokens: number;
  turnsPerHour: number;
  inputTokensPerHour: number;
  uncachedInputTokensPerHour: number;
}

/**
 * Turn count and real input-token spend within `windowMs` of `nowMs`,
 * plus both scaled to per-hour rates.
 */
export function computeWindowMetrics(rows: TurnRow[], nowMs: number, windowMs: number): WindowMetrics {
  const cutoff = nowMs - windowMs;
  const sorted = [...rows].sort((a, b) => a.atMs - b.atMs);

  // Walk in order, tracking each session's previous cumulative value so a delta
  // is only ever taken between consecutive rows of the SAME session.
  const prevBySession = new Map<string, { input: number; cache: number }>();
  let turns = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;

  for (const row of sorted) {
    const prev = prevBySession.get(row.sessionId);
    prevBySession.set(row.sessionId, { input: row.inputTokens, cache: row.cacheReadTokens ?? 0 });
    if (row.atMs < cutoff) continue;
    turns += 1;
    // No previous row for this session inside our data = this is the session's
    // first observed turn; its cumulative value is not a delta we can attribute,
    // so it contributes no spend rather than its whole running total.
    if (prev === undefined) continue;
    const delta = row.inputTokens - prev.input;
    if (delta > 0) inputTokens += delta; // negative = session reset; ignore
    const cacheDelta = (row.cacheReadTokens ?? 0) - prev.cache;
    if (cacheDelta > 0) cacheReadTokens += cacheDelta;
  }

  const hours = windowMs / 3_600_000;
  // The two counters are reported independently by the runtime and can drift, so
  // clamp rather than emitting a negative "uncached" figure.
  const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens);
  return {
    turns,
    inputTokens,
    cacheReadTokens,
    uncachedInputTokens,
    turnsPerHour: hours > 0 ? turns / hours : 0,
    inputTokensPerHour: hours > 0 ? inputTokens / hours : 0,
    uncachedInputTokensPerHour: hours > 0 ? uncachedInputTokens / hours : 0,
  };
}

/**
 * Minimum recent rate before an anomaly can be declared. A near-zero baseline
 * makes any activity an infinite ratio, so an idle agent picking up a trickle of
 * work would otherwise page someone.
 */
const MIN_RECENT_TURNS_PER_HOUR = 20;

export interface BurnAnomalyInput {
  recentTurnsPerHour: number;
  /**
   * The agent's OWN trailing rate. Comparing against a fleet average would
   * alert constantly on the busy agents (larry legitimately runs 50-180/hr) and
   * never on the quiet ones.
   */
  baselineTurnsPerHour: number;
  /** Multiple of baseline that counts as anomalous. */
  factor: number;
}

export function detectBurnAnomaly(input: BurnAnomalyInput): { anomalous: boolean; ratio: number } {
  const { recentTurnsPerHour, baselineTurnsPerHour, factor } = input;
  const ratio = baselineTurnsPerHour > 0
    ? recentTurnsPerHour / baselineTurnsPerHour
    : (recentTurnsPerHour > 0 ? Infinity : 0);

  if (recentTurnsPerHour < MIN_RECENT_TURNS_PER_HOUR) {
    return { anomalous: false, ratio };
  }
  return { anomalous: ratio >= factor, ratio };
}
