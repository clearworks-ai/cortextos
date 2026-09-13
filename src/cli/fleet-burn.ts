import { Command } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolveInstanceId } from './resolve-instance-id.js';
import {
  computeWindowMetrics,
  detectBurnAnomaly,
  type TurnRow,
} from '../daemon/turn-metrics.js';

/**
 * `cortextos fleet-burn` — per-agent turn RATE and input-token burn.
 *
 * Exists because of the knox-codex incident (2026-09-08): knox stepped from a
 * 2-32 turns/hr baseline to 274-500/hr when sustained browser automation began,
 * at ~140K input tokens per turn (~1.4M/hr -> ~70M/hr), and held it overnight
 * with nothing surfacing it. The dashboard tracks daily SPEND — a total, not a
 * velocity — so a 50x rate change is invisible until the day's total lands.
 *
 * Each agent is judged against ITS OWN trailing baseline. A fleet-wide average
 * would alert constantly on the busy agents (larry legitimately runs 50-180/hr)
 * and never on the quiet ones.
 *
 * `new-tok/hr` is input NOT served from cache, which is what tracks cost.
 * Measured across this fleet 83-98.6% of input tokens are cache reads, so the
 * raw input figure overstates spend by up to ~50x and must not be read as one.
 * The anomaly verdict keys off turn RATE, which is unaffected by caching.
 */

const HOUR = 3_600_000;

function readTurnRows(path: string): TurnRow[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const rows: TurnRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const atMs = Date.parse(row.timestamp);
      if (Number.isNaN(atMs)) continue;
      rows.push({
        atMs,
        sessionId: String(row.session_id ?? ''),
        inputTokens: Number(row.input_tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      });
    } catch { /* truncated or interleaved write — skip */ }
  }
  return rows;
}

const fmt = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K`
  : String(Math.round(n));

export const fleetBurnCommand = new Command('fleet-burn')
  .description('Per-agent turn rate and input-token burn, with anomaly detection against each agent\'s own baseline')
  .option('--instance <id>', 'Instance ID')
  .option('--window <hours>', 'Recent window in hours', '1')
  .option('--baseline <hours>', 'Trailing baseline window in hours', '24')
  .option('--factor <n>', 'Multiple of baseline that counts as anomalous', '3')
  .option('--alert', 'Print only anomalies and exit non-zero if any are found (for cron)')
  .option('--format <format>', 'Output format: json or text', 'text')
  .action((options: {
    instance?: string; window: string; baseline: string; factor: string;
    alert?: boolean; format: string;
  }) => {
    const instanceId = resolveInstanceId(options.instance);
    const logsRoot = join(homedir(), '.cortextos', instanceId, 'logs');
    const windowMs = Number(options.window) * HOUR;
    const baselineMs = Number(options.baseline) * HOUR;
    const factor = Number(options.factor);
    const now = Date.now();

    let agents: string[] = [];
    try {
      agents = readdirSync(logsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      console.error(`Cannot read ${logsRoot}`);
      process.exit(1);
    }

    const results = [];
    for (const agent of agents) {
      const rows = readTurnRows(join(logsRoot, agent, 'codex-tokens.jsonl'));
      if (rows.length === 0) continue;

      const recent = computeWindowMetrics(rows, now, windowMs);
      // Baseline EXCLUDES the recent window, so a spike does not inflate the
      // very baseline it is being judged against.
      const baselineRows = rows.filter(r => r.atMs < now - windowMs);
      const baseline = computeWindowMetrics(baselineRows, now - windowMs, baselineMs);
      const anomaly = detectBurnAnomaly({
        recentTurnsPerHour: recent.turnsPerHour,
        baselineTurnsPerHour: baseline.turnsPerHour,
        factor,
      });

      results.push({ agent, recent, baseline, ...anomaly });
    }

    results.sort((a, b) => b.recent.turnsPerHour - a.recent.turnsPerHour);
    const shown = options.alert ? results.filter(r => r.anomalous) : results;

    if (options.format === 'json') {
      console.log(JSON.stringify(shown, null, 2));
    } else if (shown.length === 0) {
      console.log(options.alert
        ? `  No burn anomalies (>=${factor}x own baseline) in the last ${options.window}h.`
        : '  No agent turn activity found.');
    } else {
      console.log(`\n  Turn rate — last ${options.window}h vs own ${options.baseline}h baseline\n`);
      console.log(`  ${'AGENT'.padEnd(26)} ${'turns/hr'.padStart(9)} ${'base'.padStart(8)} ${'ratio'.padStart(7)} ${'new-tok/hr'.padStart(11)} ${'cached/hr'.padStart(10)}`);
      console.log(`  ${'-'.repeat(26)} ${'-'.repeat(9)} ${'-'.repeat(8)} ${'-'.repeat(7)} ${'-'.repeat(11)} ${'-'.repeat(10)}`);
      for (const r of shown) {
        const ratio = Number.isFinite(r.ratio) ? `${r.ratio.toFixed(1)}x` : 'new';
        console.log(
          `  ${(r.agent + (r.anomalous ? ' !' : '')).padEnd(26)} `
          + `${r.recent.turnsPerHour.toFixed(0).padStart(9)} `
          + `${r.baseline.turnsPerHour.toFixed(0).padStart(8)} `
          + `${ratio.padStart(7)} `
          + `${fmt(r.recent.uncachedInputTokensPerHour).padStart(11)} `
          + `${fmt(r.recent.inputTokensPerHour - r.recent.uncachedInputTokensPerHour).padStart(10)}`,
        );
      }
      const flagged = shown.filter(r => r.anomalous);
      if (flagged.length > 0) {
        console.log(`\n  ! ${flagged.length} agent(s) at >=${factor}x their own baseline: ${flagged.map(r => r.agent).join(', ')}`);
        console.log('    A spike is usually intentional. This is visibility, not a verdict.\n');
      } else {
        console.log('');
      }
    }

    if (options.alert && shown.some(r => r.anomalous)) process.exit(2);
  });
