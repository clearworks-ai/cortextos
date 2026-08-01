import type { TaskStatus } from '../../types/index.js';

export const MULTICA_SECRET_KEYS = [
  'MULTICA_BASE_URL',
  'MULTICA_READ_API_TOKEN',
  'MULTICA_WORKSPACE_ID',
  'MULTICA_MEMBER_ID_JOSH',
] as const;

export const MULTICA_ISSUE_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
] as const;

export const MULTICA_PRIORITIES = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
] as const;

export const MULTICA_ASSIGNEE_TYPES = ['member', 'agent'] as const;

export type MulticaSecretKey = typeof MULTICA_SECRET_KEYS[number];
export type MulticaIssueStatus = typeof MULTICA_ISSUE_STATUSES[number];
export type MulticaPriority = typeof MULTICA_PRIORITIES[number];
export type MulticaAssigneeType = typeof MULTICA_ASSIGNEE_TYPES[number];
export type MulticaProvenance = 'meeting-pipeline' | 'bus';
export type MulticaPushAction = 'create' | 'update';
export type SyncDirection = 'out' | 'in' | 'both';

export interface MulticaIssue {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  status: MulticaIssueStatus;
  priority: MulticaPriority;
  assignee_type: MulticaAssigneeType | null;
  assignee_id: string | null;
  context_refs: unknown[];
  due_date: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface MulticaTaskRun {
  id: string;
  issue_id: string;
  status: string;
  [key: string]: unknown;
}

export interface MulticaPushPayload {
  source: 'cortextos-bus';
  provenance: MulticaProvenance;
  bus_task_id: string;
  action: MulticaPushAction;
  // The envelope fields stay local to cortextOS bookkeeping; only issue is sent on the wire.
  issue: {
    workspace_id: string;
    title: string;
    description: string;
    status: MulticaIssueStatus;
    priority: Exclude<MulticaPriority, 'none'>;
    assignee_type: MulticaAssigneeType | null;
    assignee_id: string | null;
    project_id: string | null;
    due_date: string | null;
  };
}

export interface MulticaConfig {
  baseUrl: string;
  readApiToken: string;
  workspaceId: string;
  memberIdJosh: string;
}

export interface PendingCreate {
  idempotency_key: string;
  title: string;
  field_hash: string;
  attempted_at: string;
}

export interface SyncLink {
  multica_issue_id: string | null;
  last_pushed_status: TaskStatus | null;
  last_pushed_hash: string | null;
  last_seen_multica_status: MulticaIssueStatus | null;
  last_seen_multica_assignee_id: string | null;
  idempotency_key: string | null;
  pending_create?: PendingCreate | null;
}

export interface SyncState {
  schema_version: '1';
  updated_at: string;
  links: Record<string, SyncLink>;
}

export interface SyncStateLoadResult {
  state: SyncState;
  corrupt: boolean;
}

export interface SyncStateStore {
  load(): SyncState;
  loadWithStatus(): SyncStateLoadResult;
  save(state: SyncState): void;
  linkFor(taskId: string): SyncLink | undefined;
  upsertLink(taskId: string, patch: Partial<SyncLink>): void;
}

export interface MulticaClient {
  createIssue(payload: MulticaPushPayload): Promise<MulticaIssue>;
  updateIssue(issueId: string, payload: MulticaPushPayload): Promise<MulticaIssue>;
  listIssues(params?: { limit?: number; offset?: number }): Promise<MulticaIssue[]>;
  getTaskRuns(issueId: string): Promise<MulticaTaskRun[]>;
}

export interface SyncSummary {
  direction: SyncDirection;
  pushed_creates: number;
  pushed_updates: number;
  skipped: number;
  wrote_back: number;
  errors: number;
  dry_run: boolean;
}
