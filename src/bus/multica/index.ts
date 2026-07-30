import type { BusPaths } from '../../types/index.js';
import { createMulticaClient, resolveMulticaConfig } from './client.js';
import { runInboundPoll } from './poll.js';
import { runOutboundPush } from './push.js';
import { createSyncStateStore } from './sync-state.js';
import type { SyncDirection, SyncSummary } from './types.js';

function createEmptySummary(direction: SyncDirection, dryRun: boolean): SyncSummary {
  return {
    direction,
    pushed_creates: 0,
    pushed_updates: 0,
    skipped: 0,
    wrote_back: 0,
    errors: 0,
    dry_run: dryRun,
  };
}

function formatUnexpectedError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export async function runMulticaSync(
  paths: BusPaths,
  options: { direction: SyncDirection; dryRun?: boolean },
): Promise<SyncSummary> {
  const dryRun = options.dryRun === true;
  const summary = createEmptySummary(options.direction, dryRun);
  const config = resolveMulticaConfig();

  if (config === null) {
    return summary;
  }

  try {
    const client = createMulticaClient(config);
    const store = createSyncStateStore();

    if (options.direction === 'out' || options.direction === 'both') {
      const pushResult = await runOutboundPush(paths, client, store, config, { dryRun });
      summary.pushed_creates = pushResult.pushed_creates;
      summary.pushed_updates = pushResult.pushed_updates;
      summary.skipped += pushResult.skipped;
      summary.errors += pushResult.errors;
    }

    if (options.direction === 'in' || options.direction === 'both') {
      const pollResult = await runInboundPoll(paths, config, client, store, { dryRun });
      summary.wrote_back = pollResult.wrote_back;
      summary.skipped += pollResult.skipped + pollResult.skipped_assignee;
      summary.errors += pollResult.errors;
    }
  } catch (error) {
    summary.errors += 1;
    console.warn(`[multica-sync] unexpected sync failure: ${formatUnexpectedError(error)}`);
  }

  return summary;
}
