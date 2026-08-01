import type { BusPaths, Task } from '../../types/index.js';
import { listTasks, OPEN_TASK_STATUSES } from '../task.js';
import { hashMappedFields, idempotencyKeyFor, taskToIssuePayload } from './mapping.js';
import type { MulticaClient, MulticaConfig, MulticaIssue, SyncStateStore } from './types.js';

export interface OutboundPushOptions {
  dryRun?: boolean;
  limit?: number;
  provenanceFor?: (task: Task) => 'meeting-pipeline' | 'bus';
}

export interface OutboundPlanEntry {
  bus_task_id: string;
  title: string;
  action: 'create' | 'update' | 'skip';
  reason: 'new_task' | 'hash_changed' | 'hash_unchanged' | 'not_pushable' | 'push_failed' | 'recovered_orphan';
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
  // Issue ids already claimed by any bus task — orphan adoption must never
  // steal an issue that belongs to a different task.
  const linkedIssueIds = new Set<string>();
  for (const existing of Object.values(state.links)) {
    if (existing.multica_issue_id !== null) {
      linkedIssueIds.add(existing.multica_issue_id);
    }
  }
  // Fetched at most once per run, and only when a pending marker forces it.
  let remoteIssues: MulticaIssue[] | null = null;

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

    let existingIssueId = link?.multica_issue_id ?? null;
    let recovered = false;

    // A linked task should never carry a pending marker; clear strays.
    if (existingIssueId !== null && link?.pending_create) {
      try {
        store.upsertLink(task.id, { pending_create: null });
      } catch (error) {
        console.warn(
          `[multica-sync] failed to clear stale pending_create for ${task.id}: ${truncateErrorMessage(error)}`,
        );
      }
    }

    // Recovery: a durable pending_create marker with no linked issue means a
    // prior create may have landed on Multica without a ledger write. Look
    // for the orphan before issuing a new create.
    if (!dryRun && existingIssueId === null && link?.pending_create) {
      const marker = link.pending_create;
      try {
        if (remoteIssues === null) {
          remoteIssues = await listAllIssues(client);
        }
      } catch (error) {
        result.errors += 1;
        const message = truncateErrorMessage(error);
        result.plan.push({
          bus_task_id: task.id,
          title: task.title,
          action: 'create',
          reason: 'push_failed',
          outcome: 'error',
          field_hash: marker.field_hash,
          idempotency_key: marker.idempotency_key,
          error: message,
        });
        console.warn(`[multica-sync] orphan reconcile fetch failed for ${task.id}: ${message}`);
        continue; // Do NOT create blindly — that is exactly the duplicate path.
      }

      const candidates = remoteIssues
        .filter((issue) => issue.title === marker.title && !linkedIssueIds.has(issue.id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));

      if (candidates.length > 0) {
        const adopted = candidates[0];
        try {
          store.upsertLink(task.id, { multica_issue_id: adopted.id, pending_create: null });
        } catch (error) {
          result.errors += 1;
          const message = truncateErrorMessage(error);
          result.plan.push({
            bus_task_id: task.id,
            title: task.title,
            action: 'create',
            reason: 'push_failed',
            outcome: 'error',
            field_hash: marker.field_hash,
            idempotency_key: marker.idempotency_key,
            error: message,
          });
          console.warn(`[multica-sync] orphan adoption ledger write failed for ${task.id}: ${message}`);
          continue; // Marker survives; retried next run.
        }
        linkedIssueIds.add(adopted.id);
        existingIssueId = adopted.id;
        recovered = true;
      }
      // Zero candidates: the prior create never landed. Fall through to a
      // fresh create — the write-ahead marker below is refreshed first.
    }

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

    const reason: OutboundPlanEntry['reason'] = recovered
      ? 'recovered_orphan'
      : action === 'create' ? 'new_task' : 'hash_changed';
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

    if (action === 'create') {
      // Write-ahead intent: persist the marker BEFORE the create so a
      // crash/ledger failure after a successful create is detectable and
      // reconciled on the next run instead of blindly retried.
      try {
        store.upsertLink(task.id, {
          pending_create: {
            idempotency_key: idempotencyKey,
            title: payload.issue.title,
            field_hash: fieldHash,
            attempted_at: new Date().toISOString(),
          },
        });
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
        console.warn(`[multica-sync] pending_create write failed for ${task.id}, create aborted: ${message}`);
        continue; // No marker => no create => no orphan possible.
      }
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
        pending_create: null,
      });
      linkedIssueIds.add(issue.id);

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
      // Create failures leave the write-ahead pending_create marker in the
      // ledger; the next run reconciles against Multica before re-creating.
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

const RECONCILE_PAGE_SIZE = 100;
const RECONCILE_MAX_PAGES = 10;

async function listAllIssues(client: MulticaClient): Promise<MulticaIssue[]> {
  const issues: MulticaIssue[] = [];
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const batch = await client.listIssues({
      limit: RECONCILE_PAGE_SIZE,
      offset: page * RECONCILE_PAGE_SIZE,
    });
    issues.push(...batch);
    if (batch.length < RECONCILE_PAGE_SIZE) {
      break;
    }
  }
  return issues;
}
