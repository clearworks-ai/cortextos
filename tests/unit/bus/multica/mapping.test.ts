import { describe, expect, it } from 'vitest';

import type { Task, TaskStatus } from '../../../../src/types/index.js';
import {
  BUS_TO_MULTICA_PRIORITY,
  BUS_TO_MULTICA_STATUS,
  MULTICA_TO_BUS_STATUS,
  hashMappedFields,
  idempotencyKeyFor,
  taskToIssuePayload,
} from '../../../../src/bus/multica/mapping.js';
import type { MulticaConfig } from '../../../../src/bus/multica/types.js';

const config: MulticaConfig = {
  baseUrl: 'https://multica.example.com',
  readApiToken: 'read-token',
  workspaceId: 'workspace-123',
  memberIdJosh: 'member-josh',
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_123_45678901',
    title: 'Bridge task',
    description: 'Ship the bridge core',
    type: 'agent',
    needs_approval: false,
    status: 'pending',
    assigned_to: 'larry',
    created_by: 'codexer',
    org: 'clearworksai',
    priority: 'normal',
    project: '',
    kpi_key: null,
    created_at: '2026-07-29T07:00:00Z',
    updated_at: '2026-07-29T07:00:00Z',
    completed_at: null,
    due_date: '2026-08-01T12:00:00Z',
    archived: false,
    ...overrides,
  };
}

describe('multica mapping', () => {
  it('covers every locked status and priority mapping', () => {
    expect(BUS_TO_MULTICA_STATUS).toEqual({
      pending: 'todo',
      in_progress: 'in_progress',
      completed: 'done',
      blocked: 'blocked',
      cancelled: 'cancelled',
      waiting: 'backlog',
      someday: 'backlog',
    });

    expect(MULTICA_TO_BUS_STATUS).toEqual({
      backlog: 'pending',
      todo: 'pending',
      in_progress: 'in_progress',
      in_review: 'in_progress',
      done: 'completed',
      blocked: 'blocked',
      cancelled: 'cancelled',
    });

    expect(BUS_TO_MULTICA_PRIORITY).toEqual({
      urgent: 'urgent',
      high: 'high',
      normal: 'medium',
      low: 'low',
    });

    const expectedRoundTrips: Record<TaskStatus, TaskStatus> = {
      pending: 'pending',
      in_progress: 'in_progress',
      completed: 'completed',
      blocked: 'blocked',
      cancelled: 'cancelled',
      waiting: 'pending',
      someday: 'pending',
    };

    for (const [busStatus, multicaStatus] of Object.entries(BUS_TO_MULTICA_STATUS) as Array<
      [TaskStatus, (typeof BUS_TO_MULTICA_STATUS)[TaskStatus]]
    >) {
      expect(MULTICA_TO_BUS_STATUS[multicaStatus]).toBe(expectedRoundTrips[busStatus]);
    }
  });

  it('maps Josh-owned tasks to member and leaves id-less agent tasks fully unassigned (Multica rejects a type without an id)', () => {
    const humanPayload = taskToIssuePayload(
      makeTask({
        assigned_to: 'human',
        priority: 'high',
      }),
      config,
    );

    expect(humanPayload).toMatchObject({
      source: 'cortextos-bus',
      provenance: 'bus',
      bus_task_id: 'task_123_45678901',
      action: 'create',
      issue: {
        workspace_id: 'workspace-123',
        title: 'Bridge task',
        description: 'Ship the bridge core',
        status: 'todo',
        priority: 'high',
        assignee_type: 'member',
        assignee_id: 'member-josh',
        project_id: null,
        due_date: '2026-08-01',
      },
    });

    const agentPayload = taskToIssuePayload(
      makeTask({
        assigned_to: 'larry',
        due_date: null,
      }),
      config,
      'meeting-pipeline',
      'update',
    );

    expect(agentPayload.issue.assignee_type).toBeNull();
    expect(agentPayload.issue.assignee_id).toBeNull();
    expect(agentPayload.issue.project_id).toBeNull();
    expect(agentPayload.issue.due_date).toBeNull();
    expect(agentPayload.provenance).toBe('meeting-pipeline');
    expect(agentPayload.action).toBe('update');
    expect(agentPayload.issue.priority).not.toBe('none');

    // Human-type non-Josh task: neither Josh nor agent branch → fully unassigned.
    const humanTypePayload = taskToIssuePayload(
      makeTask({
        type: 'human',
        assigned_to: 'larry',
      }),
      config,
    );

    expect(humanTypePayload.issue.assignee_type).toBeNull();
    expect(humanTypePayload.issue.assignee_id).toBeNull();
  });

  it('truncates ISO due dates to YYYY-MM-DD and preserves null due dates', () => {
    expect(taskToIssuePayload(
      makeTask({
        due_date: '2026-08-01T23:06:17Z',
      }),
      config,
    ).issue.due_date).toBe('2026-08-01');

    expect(taskToIssuePayload(
      makeTask({
        due_date: null,
      }),
      config,
    ).issue.due_date).toBeNull();
  });

  it('produces deterministic field hashes and idempotency keys', () => {
    const payload = taskToIssuePayload(makeTask(), config);
    const samePayload = taskToIssuePayload(makeTask(), config);
    const changedPayload = taskToIssuePayload(
      makeTask({
        title: 'Bridge task v2',
      }),
      config,
    );

    const hashA = hashMappedFields(payload);
    const hashB = hashMappedFields(samePayload);
    const hashC = hashMappedFields(changedPayload);

    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);
    expect(idempotencyKeyFor(payload.bus_task_id, hashA)).toBe(
      `cortextos-bus:${payload.bus_task_id}:${hashA.slice(0, 16)}`,
    );
  });
});
