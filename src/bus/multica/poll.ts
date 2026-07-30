import type { BusPaths, Task, TaskStatus } from '../../types/index.js';
import { cancelTask, claimTask, completeTask, listTasks, updateTask } from '../task.js';
import { MulticaHttpError } from './client.js';
import { BUS_TO_MULTICA_STATUS, MULTICA_TO_BUS_STATUS } from './mapping.js';
import type {
  MulticaClient,
  MulticaConfig,
  MulticaIssue,
  SyncLink,
  SyncStateStore,
} from './types.js';

export const POLL_PAGE_SIZE = 100;
export const POLL_MAX_PAGES = 20;

export interface InboundAction {
  bus_task_id: string;
  multica_issue_id: string;
  kind: 'status' | 'claim' | 'resolve_id';
  from?: TaskStatus;
  to?: TaskStatus;
}

export interface InboundPollResult {
  wrote_back: number;
  resolved_ids: number;
  skipped: number;
  skipped_assignee: number;
  errors: number;
  dry_run: boolean;
  actions: InboundAction[];
}

interface ResolvedIssueMatch {
  idPatch: Pick<SyncLink, 'multica_issue_id'>;
  issue: MulticaIssue;
}

export async function runInboundPoll(
  paths: BusPaths,
  config: MulticaConfig,
  client: MulticaClient,
  store: SyncStateStore,
  options?: { dryRun?: boolean },
): Promise<InboundPollResult> {
  const dryRun = options?.dryRun === true;
  const result = createResult(dryRun);

  try {
    const issues = await fetchAllIssues(client);
    if (issues === null) {
      result.errors += 1;
      return result;
    }

    const state = store.load();
    const busById = new Map<string, Task>(listTasks(paths).map((task) => [task.id, task]));
    const issueById = new Map<string, MulticaIssue>(issues.map((issue) => [issue.id, issue]));
    const resolvedMatches = new Map<string, ResolvedIssueMatch>();

    for (const [taskId, link] of Object.entries(state.links)) {
      if (link.multica_issue_id !== null) {
        continue;
      }

      const matchedIssue = resolveIssueForTaskId(taskId, issues);
      if (matchedIssue === null) {
        continue;
      }

      resolvedMatches.set(taskId, {
        idPatch: { multica_issue_id: matchedIssue.id },
        issue: matchedIssue,
      });
      result.resolved_ids += 1;
      result.actions.push({
        bus_task_id: taskId,
        multica_issue_id: matchedIssue.id,
        kind: 'resolve_id',
      });
    }

    for (const [taskId, link] of Object.entries(state.links)) {
      const resolvedMatch = resolvedMatches.get(taskId);
      const issueId = link.multica_issue_id ?? resolvedMatch?.issue.id ?? null;
      const issue = issueId === null ? null : issueById.get(issueId) ?? resolvedMatch?.issue ?? null;

      if (issue === null) {
        result.skipped += 1;
        continue;
      }

      const idPatch = resolvedMatch?.idPatch;
      const task = busById.get(taskId);
      if (!task) {
        result.skipped += 1;
        refreshObservedLink(store, taskId, issue, idPatch, dryRun);
        continue;
      }

      if (task.status === 'completed') {
        result.skipped += 1;
        refreshObservedLink(store, taskId, issue, idPatch, dryRun);
        continue;
      }

      const polledStatus = issue.status;
      const polledAssignee = issue.assignee_id;
      const targetStatus = MULTICA_TO_BUS_STATUS[polledStatus];
      const expectedFromPush = link.last_pushed_status === null
        ? null
        : BUS_TO_MULTICA_STATUS[link.last_pushed_status];

      const statusChangedSinceLastSeen = polledStatus !== link.last_seen_multica_status;
      const statusNotOwnPushEcho = expectedFromPush === null || polledStatus !== expectedFromPush;
      const statusNeedsWriteBack = targetStatus !== task.status;
      const shouldWriteStatus = (
        statusChangedSinceLastSeen &&
        statusNotOwnPushEcho &&
        statusNeedsWriteBack
      );

      const assigneeChangedSinceLastSeen = polledAssignee !== link.last_seen_multica_assignee_id;
      const assigneeMapsToHuman = polledAssignee === config.memberIdJosh;
      // The ledger has no last_pushed_assignee, so convergence on a human-owned task
      // is the assignee-side echo suppressor.
      const assigneeNeedsWriteBack = task.assigned_to !== 'human' && task.assigned_to !== 'user';
      const assigneeClaimPreconditions = task.status === 'pending' && targetStatus === 'in_progress';
      const shouldClaim = (
        shouldWriteStatus &&
        targetStatus === 'in_progress' &&
        assigneeChangedSinceLastSeen &&
        assigneeMapsToHuman &&
        assigneeNeedsWriteBack &&
        assigneeClaimPreconditions
      );
      const shouldWarnSkippedAssignee = (
        assigneeChangedSinceLastSeen &&
        assigneeMapsToHuman &&
        assigneeNeedsWriteBack &&
        !assigneeClaimPreconditions
      );

      if (shouldClaim) {
        result.actions.push({
          bus_task_id: taskId,
          multica_issue_id: issue.id,
          kind: 'claim',
          from: task.status,
          to: 'in_progress',
        });

        if (!dryRun) {
          try {
            claimTask(paths, taskId, 'human');
            result.wrote_back += 1;
          } catch (error) {
            result.errors += 1;
            console.warn(
              `[multica] failed to claim task ${taskId} from issue ${issue.id}: ${formatError(error)}`,
            );
          }
        }
      } else if (shouldWriteStatus) {
        result.actions.push({
          bus_task_id: taskId,
          multica_issue_id: issue.id,
          kind: 'status',
          from: task.status,
          to: targetStatus,
        });

        if (!dryRun) {
          try {
            applyStatusWriteBack(paths, taskId, targetStatus);
            result.wrote_back += 1;
          } catch (error) {
            result.errors += 1;
            console.warn(
              `[multica] failed to update task ${taskId} from issue ${issue.id}: ${formatError(error)}`,
            );
          }
        }
      }

      if (shouldWarnSkippedAssignee) {
        result.skipped_assignee += 1;
        console.warn(
          `[multica] skipped assignee write-back for task ${taskId}: ` +
            `Josh-assigned issue ${issue.id} does not satisfy A4 ` +
            `(task.status=${task.status}, polled_status=${polledStatus})`,
        );
      }

      refreshObservedLink(store, taskId, issue, idPatch, dryRun);
    }

    return result;
  } catch (error) {
    result.errors += 1;
    console.warn(`[multica] inbound poll failed unexpectedly: ${formatError(error)}`);
    return result;
  }
}

async function fetchAllIssues(client: MulticaClient): Promise<MulticaIssue[] | null> {
  const issues: MulticaIssue[] = [];
  let offset = 0;

  try {
    for (let pageNumber = 0; pageNumber < POLL_MAX_PAGES; pageNumber += 1) {
      const page = await client.listIssues({ limit: POLL_PAGE_SIZE, offset });
      issues.push(...page);

      if (page.length < POLL_PAGE_SIZE) {
        return issues;
      }

      offset += POLL_PAGE_SIZE;
    }
  } catch (error) {
    if (error instanceof MulticaHttpError) {
      console.warn(
        `[multica] inbound poll listIssues failed ` +
          `(status=${error.status}, endpoint=${error.endpoint}): ${error.message}`,
      );
      return null;
    }

    console.warn(`[multica] inbound poll listIssues failed: ${formatError(error)}`);
    return null;
  }

  console.warn(
    `[multica] inbound poll reached pagination cap ` +
      `(${POLL_MAX_PAGES} pages at ${POLL_PAGE_SIZE} issues/page); proceeding with partial results`,
  );
  return issues;
}

function applyStatusWriteBack(
  paths: BusPaths,
  taskId: string,
  targetStatus: TaskStatus,
): void {
  if (targetStatus === 'completed') {
    completeTask(paths, taskId, 'completed via Multica inbound sync');
    return;
  }

  if (targetStatus === 'cancelled') {
    cancelTask(paths, taskId, 'cancelled via Multica inbound sync');
    return;
  }

  updateTask(paths, taskId, targetStatus);
}

function resolveIssueForTaskId(taskId: string, issues: readonly MulticaIssue[]): MulticaIssue | null {
  const matches = issues.filter((issue) => issueMatchesTaskId(issue, taskId));
  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    console.warn(
      `[multica] multiple issues matched task ${taskId}; ` +
        `selecting earliest created_at from: ${matches.map((issue) => issue.id).join(', ')}`,
    );
  }

  return [...matches].sort(compareIssueCreatedAt)[0] ?? null;
}

function issueMatchesTaskId(issue: MulticaIssue, taskId: string): boolean {
  return JSON.stringify(issue.context_refs).includes(taskId) || issue.title.includes(taskId);
}

function compareIssueCreatedAt(left: MulticaIssue, right: MulticaIssue): number {
  const leftEpoch = issueCreatedAtEpoch(left);
  const rightEpoch = issueCreatedAtEpoch(right);
  if (leftEpoch !== rightEpoch) {
    return leftEpoch - rightEpoch;
  }

  return left.id.localeCompare(right.id);
}

function issueCreatedAtEpoch(issue: MulticaIssue): number {
  const epoch = Date.parse(issue.created_at);
  return Number.isNaN(epoch) ? Number.POSITIVE_INFINITY : epoch;
}

function refreshObservedLink(
  store: SyncStateStore,
  taskId: string,
  issue: MulticaIssue,
  idPatch: Pick<SyncLink, 'multica_issue_id'> | undefined,
  dryRun: boolean,
): void {
  if (dryRun) {
    return;
  }

  const patch: Partial<SyncLink> = {
    last_seen_multica_status: issue.status,
    last_seen_multica_assignee_id: issue.assignee_id,
    ...(idPatch ?? {}),
  };
  store.upsertLink(taskId, patch);
}

function createResult(dryRun: boolean): InboundPollResult {
  return {
    wrote_back: 0,
    resolved_ids: 0,
    skipped: 0,
    skipped_assignee: 0,
    errors: 0,
    dry_run: dryRun,
    actions: [],
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
