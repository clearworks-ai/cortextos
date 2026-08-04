import { join } from 'node:path';

import type { BusPaths } from '../../types/index.js';
import { ensureDir } from '../../utils/atomic.js';
import { withFileLockAsync } from '../../utils/lock.js';
import { createMulticaClient, resolveMulticaConfig } from './client.js';
import { runInboundPoll } from './poll.js';
import { runOutboundPush } from './push.js';
import { createSyncStateStore, defaultMulticaBridgeDir } from './sync-state.js';
import type { SyncDirection, SyncSummary } from './types.js';

function createEmptySummary(direction: SyncDirection, dryRun: boolean): SyncSummary {
  return {
    direction,
    pushed_creates: 0,
    pushed_updates: 0,
    skipped: 0,
    wrote_back: 0,
    imported: 0,
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
  options: {
    direction: SyncDirection;
    dryRun?: boolean;
    limit?: number;
    agentName?: string;   // NEW
    org?: string;         // NEW
    taskIds?: string[];   // Real-time mirror: scope the outbound push to these task ids only
  },
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
      const scopedTaskIds = options.taskIds && options.taskIds.length > 0
        ? options.taskIds
        : undefined;

      const doPush = () => runOutboundPush(paths, client, store, config, {
        dryRun,
        limit: options.limit,
        onlyTaskIds: scopedTaskIds ? new Set(scopedTaskIds) : undefined,
      });

      // Real-time single-task mirror: create + update can fire two concurrent
      // mirrors for the same task. Without a lock both load the ledger, see no
      // link yet, and each POST a create → duplicate issues. Serialize them on a
      // per-task lock so the second run observes the first's link and updates.
      let pushResult;
      if (scopedTaskIds && !dryRun) {
        const lockDir = join(
          defaultMulticaBridgeDir(),
          'locks',
          `mirror-${[...scopedTaskIds].sort().join('_')}`,
        );
        ensureDir(lockDir);
        pushResult = await withFileLockAsync(lockDir, doPush, { timeoutMs: 15_000 });
      } else {
        pushResult = await doPush();
      }

      summary.pushed_creates = pushResult.pushed_creates;
      summary.pushed_updates = pushResult.pushed_updates;
      summary.skipped += pushResult.skipped;
      summary.errors += pushResult.errors;
    }

    if (options.direction === 'in' || options.direction === 'both') {
      const importIdentity = options.agentName !== undefined && options.org !== undefined
        ? { agentName: options.agentName, org: options.org }
        : undefined;
      const pollResult = await runInboundPoll(paths, config, client, store, {
        dryRun,
        importIdentity,
      });
      summary.wrote_back = pollResult.wrote_back;
      summary.imported = pollResult.imported;
      summary.skipped += pollResult.skipped + pollResult.skipped_assignee;
      summary.errors += pollResult.errors;
    }
  } catch (error) {
    summary.errors += 1;
    console.warn(`[multica-sync] unexpected sync failure: ${formatUnexpectedError(error)}`);
  }

  return summary;
}
