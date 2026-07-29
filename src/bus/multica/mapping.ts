import { createHash } from 'node:crypto';

import type { Priority, Task, TaskStatus } from '../../types/index.js';
import type {
  MulticaConfig,
  MulticaIssueStatus,
  MulticaPriority,
  MulticaPushAction,
  MulticaPushPayload,
  MulticaProvenance,
} from './types.js';

export const BUS_TO_MULTICA_STATUS: Record<TaskStatus, MulticaIssueStatus> = {
  pending: 'todo',
  in_progress: 'in_progress',
  completed: 'done',
  blocked: 'blocked',
  cancelled: 'cancelled',
  waiting: 'backlog',
  someday: 'backlog',
};

export const MULTICA_TO_BUS_STATUS: Record<MulticaIssueStatus, TaskStatus> = {
  backlog: 'pending',
  todo: 'pending',
  in_progress: 'in_progress',
  in_review: 'in_progress',
  done: 'completed',
  blocked: 'blocked',
  cancelled: 'cancelled',
};

export const BUS_TO_MULTICA_PRIORITY: Record<Priority, MulticaPriority> = {
  urgent: 'urgent',
  high: 'high',
  normal: 'medium',
  low: 'low',
};

export function taskToIssuePayload(
  task: Task,
  config: MulticaConfig,
  provenance: MulticaProvenance = 'bus',
  action: MulticaPushAction = 'create',
): MulticaPushPayload {
  const assignToJosh = task.assigned_to === 'human' || task.assigned_to === 'user';
  const assignment = assignToJosh
    ? {
        assignee_type: 'member' as const,
        assignee_id: config.memberIdJosh,
        project_id: null,
      }
    : {
        // v1 does not ship an agent-id map, so agent-owned tasks stay unassigned in Multica.
        assignee_type: null,
        assignee_id: null,
        project_id: null,
      };

  return {
    source: 'cortextos-bus',
    provenance,
    bus_task_id: task.id,
    action,
    issue: {
      workspace_id: config.workspaceId,
      title: task.title,
      description: task.description ?? '',
      status: BUS_TO_MULTICA_STATUS[task.status],
      priority: BUS_TO_MULTICA_PRIORITY[task.priority],
      assignee_type: assignment.assignee_type,
      assignee_id: assignment.assignee_id,
      project_id: assignment.project_id,
      due_date: task.due_date,
    },
  };
}

export function hashMappedFields(payload: MulticaPushPayload): string {
  const canonicalFields = {
    // Fixed key order is part of the bridge contract for deterministic hashing.
    title: payload.issue.title,
    description: payload.issue.description,
    status: payload.issue.status,
    priority: payload.issue.priority,
    assignee_type: payload.issue.assignee_type,
    assignee_id: payload.issue.assignee_id,
    project_id: payload.issue.project_id,
    due_date: payload.issue.due_date,
  };

  return createHash('sha256').update(JSON.stringify(canonicalFields)).digest('hex');
}

export function idempotencyKeyFor(busTaskId: string, fieldHash: string): string {
  return `cortextos-bus:${busTaskId}:${fieldHash.slice(0, 16)}`;
}
