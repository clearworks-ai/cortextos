import type { BusPaths, Task } from '../../types/index.js';
import { listTasks, OPEN_TASK_STATUSES } from '../task.js';
import { hashMappedFields, idempotencyKeyFor, taskToIssuePayload } from './mapping.js';
import type { MulticaClient, MulticaConfig, SyncStateStore } from './types.js';

export interface OutboundPushOptions {
  dryRun?: boolean;
  limit?: number;
  provenanceFor?: (task: Task) => 'meeting-pipeline' | 'bus';
}

export interface OutboundPlanEntry {
  bus_task_id: string;
  title: string;
  action: 'create' | 'update' | 'skip';
  reason: 'new_task' | 'hash_changed' | 'hash_unchanged' | 'not_pushable' | 'push_failed';
  outcome: 'pushed' | 'planned' | 'skipped' | 'error';
  field_hash: string | null;
  idempotency_key: string | null;
  error: string | null;
}

export interface OutboundPushResult {
  pushed_creates: number;
  pushed_updates: number;
  skipped: number;
  errors: number;
  dry_run: boolean;
  plan: OutboundPlanEntry[];
}

export async function runOutboundPush(
  paths: BusPaths,
  client: MulticaClient,
  store: SyncStateStore,
  config: MulticaConfig,
  options: OutboundPushOptions = {},
): Promise<OutboundPushResult> {
  const dryRun = options.dryRun === true;
  const limit = options.limit;
  // Callers can opt specific tasks into meeting-pipeline provenance without
  // adding any detection heuristic to this module.
  const provenanceFor = options.provenanceFor ?? (() => 'bus' as const);
  const state = store.load();
  const visible = listTasks(paths);
  const cancelled = listTasks(paths, { status: 'cancelled' });
  // listTasks returns newest-first; reverse for a deterministic oldest-first run.
  const universe = [...visible, ...cancelled].reverse();

  const result: OutboundPushResult = {
    pushed_creates: 0,
    pushed_updates: 0,
    skipped: 0,
    errors: 0,
    dry_run: dryRun,
    plan: [],
  };

  // Archived or compacted tasks never appear in the task universe. Leave their
  // ledger links untouched here; future ledger GC is a separate concern.
  for (const task of universe) {
    if (hasReachedPushLimit(result, limit)) {
      break;
    }

    const link = state.links[task.id];

    if (!link && !OPEN_TASK_STATUSES.has(task.status)) {
      result.skipped += 1;
      result.plan.push({
        bus_task_id: task.id,
        title: task.title,
        action: 'skip',
        reason: 'not_pushable',
        outcome: 'skipped',
        field_hash: null,
        idempotency_key: null,
        error: null,
      });
      continue;
    }

    const existingIssueId = link?.multica_issue_id ?? null;
    const action = existingIssueId === null ? 'create' : 'update';
    const payload = taskToIssuePayload(task, config, provenanceFor(task), action);
    const fieldHash = hashMappedFields(payload);

    if (existingIssueId !== null && link?.last_pushed_hash === fieldHash) {
      result.skipped += 1;
      result.plan.push({
        bus_task_id: task.id,
        title: task.title,
        action: 'skip',
        reason: 'hash_unchanged',
        outcome: 'skipped',
        field_hash: fieldHash,
        idempotency_key: null,
        error: null,
      });
      continue;
    }

    const reason = action === 'create' ? 'new_task' : 'hash_changed';
    const idempotencyKey = idempotencyKeyFor(task.id, fieldHash);

    if (dryRun) {
      incrementPushCount(result, action);
      result.plan.push({
        bus_task_id: task.id,
        title: task.title,
        action,
        reason,
        outcome: 'planned',
        field_hash: fieldHash,
        idempotency_key: idempotencyKey,
        error: null,
      });
      if (hasReachedPushLimit(result, limit)) {
        break;
      }
      continue;
    }

    try {
      const issue = existingIssueId === null
        ? await client.createIssue(payload)
        : await client.updateIssue(existingIssueId, payload);

      store.upsertLink(task.id, {
        multica_issue_id: issue.id,
        last_pushed_hash: fieldHash,
        last_pushed_status: task.status,
        idempotency_key: idempotencyKey,
      });

      incrementPushCount(result, action);
      result.plan.push({
        bus_task_id: task.id,
        title: task.title,
        action,
        reason,
        outcome: 'pushed',
        field_hash: fieldHash,
        idempotency_key: idempotencyKey,
        error: null,
      });
      if (hasReachedPushLimit(result, limit)) {
        break;
      }
    } catch (error) {
      result.errors += 1;
      const message = truncateErrorMessage(error);
      result.plan.push({
        bus_task_id: task.id,
        title: task.title,
        action,
        reason: 'push_failed',
        outcome: 'error',
        field_hash: fieldHash,
        idempotency_key: idempotencyKey,
        error: message,
      });
      console.warn(`[multica-sync] outbound push failed for ${task.id} (${task.status}): ${message}`);
      // REST creates have no server-side idempotency today. If a create succeeds
      // but the ledger write fails, the next run can create a duplicate issue.
      continue;
    }
  }

  return result;
}

function incrementPushCount(
  result: OutboundPushResult,
  action: 'create' | 'update',
): void {
  if (action === 'create') {
    result.pushed_creates += 1;
    return;
  }

  result.pushed_updates += 1;
}

function hasReachedPushLimit(
  result: OutboundPushResult,
  limit: number | undefined,
): boolean {
  return typeof limit === 'number'
    && Number.isFinite(limit)
    && result.pushed_creates + result.pushed_updates >= limit;
}

function truncateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 300 ? message : `${message.slice(0, 297)}...`;
}
