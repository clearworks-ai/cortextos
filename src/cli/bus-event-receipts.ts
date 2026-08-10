import { Command } from 'commander';
import { join } from 'path';
import { resolveEnv } from '../utils/env.js';
import {
  recordIngressReceipt,
  recordRejectedIngressReceipt,
  recordEventProcessingReceipt,
  recordEventRoutingReceipt,
  readEventReceipts,
} from '../bus/event-delivery.js';
import type { EventProcessingState, EventRoutingState } from '../bus/event-delivery.js';
import {
  appendCronOutcome,
  readCronOutcomes,
  reconcileCronOutcomes,
} from '../bus/cron-outcome.js';
import type { CronOutcomeState } from '../bus/cron-outcome.js';

function stateDirFrom(opts: { stateDir?: string }): string {
  if (opts.stateDir) return opts.stateDir;
  const env = resolveEnv();
  const root = env.ctxRoot || process.cwd();
  return join(root, 'state', env.agentName || 'default');
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 200;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  return limit;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('attempt must be a positive integer');
  return parsed;
}

export const eventReceiptsCommand = new Command('event-receipts')
  .description('Record and query redacted event and terminal cron receipts.');

eventReceiptsCommand
  .command('accept')
  .requiredOption('--provider <provider>', 'Provider code, never stored in cleartext')
  .requiredOption('--event-type <eventType>', 'Provider event type, never stored in cleartext')
  .requiredOption('--source-id <sourceId>', 'Provider source identity, hashed before storage')
  .option('--occurred-at <iso>', 'Provider occurrence timestamp')
  .option('--disabled', 'Record ignored_disabled instead of accepting')
  .option('--state-dir <path>', 'Receipt state directory')
  .action((opts: { provider: string; eventType: string; sourceId: string; occurredAt?: string; disabled?: boolean; stateDir?: string }) => {
    const receipt = recordIngressReceipt(stateDirFrom(opts), {
      provider: opts.provider,
      eventType: opts.eventType,
      sourceId: opts.sourceId,
      occurredAt: opts.occurredAt,
    }, !opts.disabled);
    console.log(JSON.stringify(receipt));
  });

eventReceiptsCommand
  .command('reject')
  .requiredOption('--provider <provider>', 'Provider code, never stored in cleartext')
  .requiredOption('--event-type <eventType>', 'Provider event type, never stored in cleartext')
  .requiredOption('--source-id <sourceId>', 'Provider source identity, hashed before storage')
  .requiredOption('--reason <code>', 'Redacted rejection reason code')
  .option('--occurred-at <iso>', 'Provider occurrence timestamp')
  .option('--state-dir <path>', 'Receipt state directory')
  .action((opts: { provider: string; eventType: string; sourceId: string; reason: string; occurredAt?: string; stateDir?: string }) => {
    console.log(JSON.stringify(recordRejectedIngressReceipt(stateDirFrom(opts), {
      provider: opts.provider,
      eventType: opts.eventType,
      sourceId: opts.sourceId,
      occurredAt: opts.occurredAt,
    }, opts.reason)));
  });

eventReceiptsCommand
  .command('route <eventId> <route> <state>')
  .option('--reason <code>', 'Redacted route reason code')
  .option('--state-dir <path>', 'Receipt state directory')
  .action((eventId: string, route: string, state: EventRoutingState, opts: { reason?: string; stateDir?: string }) => {
    if (!['proposed', 'attempted', 'failed'].includes(state)) throw new Error('invalid routing state');
    console.log(JSON.stringify(recordEventRoutingReceipt(stateDirFrom(opts), eventId, state, route, opts.reason)));
  });

eventReceiptsCommand
  .command('processing <eventId> <state>')
  .option('--route <route>', 'Redacted route code')
  .option('--reason <code>', 'Redacted processing reason code')
  .option('--state-dir <path>', 'Receipt state directory')
  .action((eventId: string, state: EventProcessingState, opts: { route?: string; reason?: string; stateDir?: string }) => {
    if (!['started', 'succeeded', 'failed', 'needs_human', 'resync_required', 'resynced'].includes(state)) throw new Error('invalid processing state');
    console.log(JSON.stringify(recordEventProcessingReceipt(stateDirFrom(opts), eventId, state, opts.route, opts.reason)));
  });

eventReceiptsCommand
  .command('list')
  .option('--limit <n>', 'Maximum event receipts to return', '200')
  .option('--state-dir <path>', 'Receipt state directory')
  .action((opts: { limit?: string; stateDir?: string }) => {
    console.log(JSON.stringify(readEventReceipts(stateDirFrom(opts), parseLimit(opts.limit)), null, 2));
  });

eventReceiptsCommand
  .command('cron-terminal <runId> <attempt> <agent> <cron> <state>')
  .option('--detail <code>', 'Redacted terminal outcome detail')
  .option('--state-dir <path>', 'Receipt state directory')
  .action((runId: string, attempt: string, agent: string, cron: string, state: CronOutcomeState, opts: { detail?: string; stateDir?: string }) => {
    if (!['succeeded', 'failed', 'skipped', 'needs_human'].includes(state)) throw new Error('cron-terminal requires a terminal worker state');
    console.log(JSON.stringify(appendCronOutcome(stateDirFrom(opts), { run_id: runId, attempt: parsePositiveInteger(attempt), agent, cron, state, detail: opts.detail })));
  });

eventReceiptsCommand
  .command('cron-list')
  .option('--limit <n>', 'Maximum cron outcomes to return', '200')
  .option('--state-dir <path>', 'Receipt state directory')
  .action((opts: { limit?: string; stateDir?: string }) => {
    console.log(JSON.stringify(readCronOutcomes(stateDirFrom(opts), parseLimit(opts.limit)), null, 2));
  });

eventReceiptsCommand
  .command('cron-reconcile')
  .option('--timeout-ms <n>', 'Missing-terminal timeout in milliseconds')
  .option('--state-dir <path>', 'Receipt state directory')
  .action((opts: { timeoutMs?: string; stateDir?: string }) => {
    const timeoutMs = opts.timeoutMs === undefined ? undefined : Number(opts.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('timeout-ms must be positive');
    console.log(JSON.stringify(reconcileCronOutcomes(stateDirFrom(opts), Date.now(), timeoutMs ?? 30 * 60_000), null, 2));
  });
