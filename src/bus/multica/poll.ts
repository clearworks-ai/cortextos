import { readFileSync } from 'node:fs';

import type { BusPaths, Task, TaskStatus } from '../../types/index.js';
import {
  cancelTask, claimTask, completeTask, createTask, findTaskFile, listTasks, updateTask,
} from '../task.js';
import { listPendingApprovals, updateApproval } from '../approval.js';
import { MulticaHttpError } from './client.js';
import {
  BUS_TO_MULTICA_STATUS,
  MULTICA_TO_BUS_PRIORITY,
  MULTICA_TO_BUS_STATUS,
  hashMappedFields,
  idempotencyKeyFor,
  taskToIssuePayload,
} from './mapping.js';
import type {
  MulticaClient,
  MulticaConfig,
  MulticaIssue,
  SyncLink,
  SyncState,
  SyncStateStore,
} from './types.js';

export const POLL_PAGE_SIZE = 100;
export const POLL_MAX_PAGES = 20;

export interface InboundImportIdentity {
  agentName: string;
  org: string;
}

export interface InboundAction {
  bus_task_id: string;                                    // '' for dry-run import previews
  multica_issue_id: string;
  kind: 'status' | 'claim' | 'resolve_id' | 'import' | 'approval-resolution';     // 'import' is NEW
  from?: TaskStatus;
  to?: TaskStatus;
  approval_id?: string;                                    // NEW for approval-resolution
}

export interface InboundPollResult {
  wrote_back: number;
  resolved_ids: number;
  imported: number;                                        // NEW
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
  options?: { dryRun?: boolean; importIdentity?: InboundImportIdentity },
): Promise<InboundPollResult> {
  const dryRun = options?.dryRun === true;
  const result = createResult(dryRun);

  try {
    const issues = await fetchAllIssues(client, config);
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
            // Check if there's a linked approval before calling applyStatusWriteBack
            // to avoid double-resolution (applyStatusWriteBack calls completeTask,
            // and resolveLinkedApproval also calls completeTask via updateApproval)
            const pendingApprovals = listPendingApprovals(paths);
            const linkedApproval = pendingApprovals.find(
              (approval) => approval.linked_task_id === taskId,
            );

if (linkedApproval && (targetStatus === 'completed' || targetStatus === 'cancelled')) {
              // Let resolveLinkedApproval handle both the approval resolution and task completion
              resolveLinkedApproval(paths, taskId, targetStatus, issue.id, result);
            } else {
              // No linked approval or not a terminal status - use normal write-back
              applyStatusWriteBack(paths, taskId, targetStatus);
              result.wrote_back += 1;
            }
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

    runReverseImport(
      paths,
      config,
      store,
      state,
      busById,
      issueById,
      resolvedMatches,
      result,
      dryRun,
      options?.importIdentity,
    );

    return result;
  } catch (error) {
    result.errors += 1;
    console.warn(`[multica] inbound poll failed unexpectedly: ${formatError(error)}`);
    return result;
  }
}

async function fetchAllIssues(client: MulticaClient, config: MulticaConfig): Promise<MulticaIssue[] | null> {
  const issues: MulticaIssue[] = [];
  let offset = 0;

  try {
    for (let pageNumber = 0; pageNumber < POLL_MAX_PAGES; pageNumber += 1) {
      const page = await client.listIssues({ limit: POLL_PAGE_SIZE, offset });
      // Filter to only issues in this workspace — avoid cross-workspace imports
      const workspaceFiltered = page.filter(issue => issue.workspace_id === config.workspaceId);
      issues.push(...workspaceFiltered);

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

function resolveLinkedApproval(
  paths: BusPaths,
  taskId: string,
  targetStatus: 'completed' | 'cancelled',
  multicaIssueId: string,
  result: InboundPollResult,
): void {
  try {
    const pendingApprovals = listPendingApprovals(paths);
    const linkedApproval = pendingApprovals.find((approval) => approval.linked_task_id === taskId);

    if (linkedApproval) {
      // Resolve the approval — updateApproval owns the ONLY completeTask/cancelTask call
      // Binding decision: treat Multica 'completed' as 'approved', 'cancelled' as 'rejected'
      // Use Multica sync attribution, NOT Josh's name
      updateApproval(
        paths,
        linkedApproval.id,
        targetStatus === 'completed' ? 'approved' : 'rejected',
        targetStatus === 'completed'
          ? 'resolved via Multica inbound sync (completed)'
          : 'resolved via Multica inbound sync (cancelled)',
      );

      result.actions.push({
        bus_task_id: taskId,
        multica_issue_id: multicaIssueId,
        kind: 'approval-resolution',
        approval_id: linkedApproval.id,
      });
    }
  } catch (approvalError) {
    // Approval-resolution failure must not fail or abort the poll loop
    console.warn(
      `[multica] failed to resolve approval for task ${taskId}: ${formatError(approvalError)}`,
    );
  }
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
    imported: 0,
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

const IMPORT_MARKER_PREFIX = '[multica-import:';

function importMarkerFor(issueId: string): string {
  return `${IMPORT_MARKER_PREFIX}${issueId}]`;
}

function runReverseImport(
  paths: BusPaths,
  config: MulticaConfig,
  store: SyncStateStore,
  state: SyncState,
  busById: Map<string, Task>,
  issueById: Map<string, MulticaIssue>,
  resolvedMatches: Map<string, ResolvedIssueMatch>,
  result: InboundPollResult,
  dryRun: boolean,
  identity: InboundImportIdentity | undefined,
): void {
  const linkedIssueIds = new Set<string>();
  for (const link of Object.values(state.links)) {
    if (link.multica_issue_id !== null) {
      linkedIssueIds.add(link.multica_issue_id);
    }
  }
  for (const match of resolvedMatches.values()) {
    linkedIssueIds.add(match.issue.id);
  }

  let warnedNoIdentity = false;

  for (const issue of issueById.values()) {
    if (linkedIssueIds.has(issue.id)) continue;
    // Never import terminal issues — historical closed work is not a new bus task.
    if (issue.status === 'done' || issue.status === 'cancelled') continue;

    // Crash-window heal: task was created on a prior run but the link write never
    // landed. Re-link instead of duplicating.
    const marker = importMarkerFor(issue.id);
    const orphanTask = [...busById.values()].find(
      (task) => typeof task.description === 'string' && task.description.startsWith(marker),
    );
    if (orphanTask !== undefined) {
      result.resolved_ids += 1;
      result.actions.push({
        bus_task_id: orphanTask.id,
        multica_issue_id: issue.id,
        kind: 'resolve_id',
      });
      if (!dryRun) {
        const createdTask = readTaskById(paths, orphanTask.id);
        const hash = hashMappedFields(taskToIssuePayload(createdTask, config, 'bus', 'update'));
        store.upsertLink(orphanTask.id, {
          multica_issue_id: issue.id,
          last_pushed_status: createdTask.status,
          last_pushed_hash: hash,
          last_seen_multica_status: issue.status,
          last_seen_multica_assignee_id: issue.assignee_id,
          idempotency_key: idempotencyKeyFor(orphanTask.id, hash),
        });
      }
      continue;
    }

    if (identity === undefined) {
      if (!warnedNoIdentity) {
        warnedNoIdentity = true;
        console.warn(
          '[multica] unlinked Multica issues found but no import identity provided; skipping reverse import',
        );
      }
      continue;
    }

    const targetStatus = MULTICA_TO_BUS_STATUS[issue.status]; // pending | in_progress | blocked

    if (dryRun) {
      result.actions.push({
        bus_task_id: '',
        multica_issue_id: issue.id,
        kind: 'import',
        to: targetStatus,
      });
      continue;
    }

    try {
      const description = `${marker} ${issue.description ?? ''}`.trimEnd();
      const assignee = issue.assignee_id === config.memberIdJosh ? 'human' : identity.agentName;
      const taskId = createTask(paths, identity.agentName, identity.org, issue.title, {
        description,
        assignee,
        priority: MULTICA_TO_BUS_PRIORITY[issue.priority],
        ...(issue.due_date !== null ? { dueDate: issue.due_date } : {}),
      });

      if (targetStatus !== 'pending') {
        applyStatusWriteBack(paths, taskId, targetStatus);
      }

      const createdTask = readTaskById(paths, taskId);
      const hash = hashMappedFields(taskToIssuePayload(createdTask, config, 'bus', 'update'));
      store.upsertLink(taskId, {
        multica_issue_id: issue.id,
        last_pushed_status: createdTask.status,
        last_pushed_hash: hash,
        last_seen_multica_status: issue.status,
        last_seen_multica_assignee_id: issue.assignee_id,
        idempotency_key: idempotencyKeyFor(taskId, hash),
      });

      result.imported += 1;
      result.actions.push({
        bus_task_id: taskId,
        multica_issue_id: issue.id,
        kind: 'import',
        to: targetStatus,
      });
    } catch (error) {
      result.errors += 1;
      console.warn(
        `[multica] failed to import issue ${issue.id} as a bus task: ${formatError(error)}`,
      );
    }
  }
}

function readTaskById(paths: BusPaths, taskId: string): Task {
  const filePath = findTaskFile(paths, taskId);
  if (filePath === null) {
    throw new Error(`imported task ${taskId} not found on disk after create`);
  }
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
}
