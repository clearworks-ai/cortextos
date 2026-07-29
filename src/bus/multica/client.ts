import { createHmac } from 'node:crypto';
import { join } from 'node:path';

import { loadEnvFileInto } from '../../utils/env.js';
import {
  MULTICA_ASSIGNEE_TYPES,
  MULTICA_ISSUE_STATUSES,
  MULTICA_PRIORITIES,
  MULTICA_SECRET_KEYS,
  type MulticaAssigneeType,
  type MulticaClient,
  type MulticaConfig,
  type MulticaIssue,
  type MulticaIssueStatus,
  type MulticaTaskRun,
} from './types.js';

const REQUIRED_CONFIG_KEYS = [
  'MULTICA_BASE_URL',
  'MULTICA_WEBHOOK_TOKEN',
  'MULTICA_WEBHOOK_SECRET',
  'MULTICA_WORKSPACE_ID',
  'MULTICA_MEMBER_ID_JOSH',
] as const;

const MULTICA_STATUS_SET = new Set<string>(MULTICA_ISSUE_STATUSES);
const MULTICA_PRIORITY_SET = new Set<string>(MULTICA_PRIORITIES);
const MULTICA_ASSIGNEE_SET = new Set<string>(MULTICA_ASSIGNEE_TYPES);

export class MulticaHttpError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly cause: unknown;

  constructor(message: string, status: number, endpoint: string, cause?: unknown) {
    super(message);
    this.name = 'MulticaHttpError';
    this.status = status;
    this.endpoint = endpoint;
    this.cause = cause;
  }
}

export function sign(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function resolveMulticaConfig(
  env: Record<string, string | undefined> = process.env,
): MulticaConfig | null {
  const resolved: Record<string, string> = {};

  for (const key of MULTICA_SECRET_KEYS) {
    const value = env[key];
    if (typeof value === 'string') {
      resolved[key] = value;
    }
  }

  const secretsPath = join(
    env.CTX_ROOT ?? process.env.CTX_ROOT ?? process.cwd(),
    'orgs',
    'clearworksai',
    'secrets.env',
  );
  const fileEnv: Record<string, string> = {};
  loadEnvFileInto(secretsPath, fileEnv);

  for (const key of MULTICA_SECRET_KEYS) {
    if (!hasResolvedValue(resolved[key]) && hasResolvedValue(fileEnv[key])) {
      resolved[key] = fileEnv[key];
    }
  }

  const missingKeys = REQUIRED_CONFIG_KEYS.filter((key) => !hasResolvedValue(resolved[key]));
  if (missingKeys.length > 0) {
    console.warn(`[multica] missing required config keys: ${missingKeys.join(', ')}`);
    return null;
  }

  const baseUrl = normalizeRequiredValue(resolved.MULTICA_BASE_URL);
  const webhookToken = normalizeRequiredValue(resolved.MULTICA_WEBHOOK_TOKEN);
  const webhookSecret = normalizeRequiredValue(resolved.MULTICA_WEBHOOK_SECRET);
  const workspaceId = normalizeRequiredValue(resolved.MULTICA_WORKSPACE_ID);
  const memberIdJosh = normalizeRequiredValue(resolved.MULTICA_MEMBER_ID_JOSH);
  const readApiToken = normalizeOptionalValue(resolved.MULTICA_READ_API_TOKEN);

  if (!baseUrl || !webhookToken || !webhookSecret || !workspaceId || !memberIdJosh) {
    const stillMissing = REQUIRED_CONFIG_KEYS.filter((key) => {
      const value = normalizeRequiredValue(resolved[key]);
      return value === null;
    });
    console.warn(`[multica] missing required config keys: ${stillMissing.join(', ')}`);
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    webhookToken,
    webhookSecret,
    readApiToken,
    workspaceId,
    memberIdJosh,
  };
}

export function createMulticaClient(
  config: MulticaConfig,
  fetchImpl: typeof fetch = fetch,
): MulticaClient {
  const normalizedConfig: MulticaConfig = {
    ...config,
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
  };

  return {
    async pushIssue(payload, idempotencyKey) {
      const endpoint = `${normalizedConfig.baseUrl}/api/webhooks/autopilots/${encodeURIComponent(normalizedConfig.webhookToken)}`;
      const rawBody = JSON.stringify(payload);
      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sign(rawBody, normalizedConfig.webhookSecret),
        'Idempotency-Key': idempotencyKey,
      });

      const response = await request(endpoint, fetchImpl, {
        method: 'POST',
        headers,
        body: rawBody,
      });

      return { status: response.status };
    },

    async listIssues(params) {
      const endpoint = new URL(`${normalizedConfig.baseUrl}/api/issues`);
      if (params?.limit !== undefined) endpoint.searchParams.set('limit', String(params.limit));
      if (params?.offset !== undefined) endpoint.searchParams.set('offset', String(params.offset));

      const payload = await requestJson(endpoint.toString(), fetchImpl, buildReadInit(normalizedConfig));
      return parseIssueArray(payload, endpoint.toString());
    },

    async getTaskRuns(issueId) {
      const endpoint = `${normalizedConfig.baseUrl}/api/issues/${encodeURIComponent(issueId)}/task-runs`;
      const payload = await requestJson(endpoint, fetchImpl, buildReadInit(normalizedConfig));
      return parseTaskRunArray(payload, endpoint);
    },
  };
}

function buildReadInit(config: MulticaConfig): RequestInit {
  if (!config.readApiToken) {
    return {};
  }

  return {
    headers: {
      Authorization: `Bearer ${config.readApiToken}`,
    },
  };
}

async function request(endpoint: string, fetchImpl: typeof fetch, init: RequestInit): Promise<Response> {
  try {
    const response = await fetchImpl(endpoint, init);
    if (!response.ok) {
      throw new MulticaHttpError(
        `Multica request failed with status ${response.status}`,
        response.status,
        endpoint,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof MulticaHttpError) {
      throw error;
    }
    throw new MulticaHttpError('Multica request failed', 0, endpoint, error);
  }
}

async function requestJson(
  endpoint: string,
  fetchImpl: typeof fetch,
  init: RequestInit,
): Promise<unknown> {
  const response = await request(endpoint, fetchImpl, init);
  try {
    return await response.json();
  } catch (error) {
    throw new MulticaHttpError('Failed to parse Multica JSON response', response.status, endpoint, error);
  }
}

function parseIssueArray(payload: unknown, endpoint: string): MulticaIssue[] {
  const rawItems = extractArrayEnvelope(payload, ['issues', 'data', 'items']);
  if (rawItems === null) {
    console.warn(`[multica] unexpected issues response envelope from ${endpoint}`);
    return [];
  }

  const issues: MulticaIssue[] = [];
  for (const item of rawItems) {
    const parsed = toMulticaIssue(item);
    if (parsed === null) {
      console.warn(`[multica] skipping invalid issue payload from ${endpoint}`);
      continue;
    }
    issues.push(parsed);
  }
  return issues;
}

function parseTaskRunArray(payload: unknown, endpoint: string): MulticaTaskRun[] {
  const rawItems = extractArrayEnvelope(payload, ['task_runs', 'taskRuns', 'data', 'items']);
  if (rawItems === null) {
    console.warn(`[multica] unexpected task-runs response envelope from ${endpoint}`);
    return [];
  }

  const taskRuns: MulticaTaskRun[] = [];
  for (const item of rawItems) {
    const parsed = toMulticaTaskRun(item);
    if (parsed === null) {
      console.warn(`[multica] skipping invalid task-run payload from ${endpoint}`);
      continue;
    }
    taskRuns.push(parsed);
  }
  return taskRuns;
}

function extractArrayEnvelope(payload: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isRecord(payload)) {
    return null;
  }

  for (const key of keys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return null;
}

function toMulticaIssue(value: unknown): MulticaIssue | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.status !== 'string') {
    return null;
  }
  if (!MULTICA_STATUS_SET.has(value.status)) {
    return null;
  }

  const status = value.status as MulticaIssueStatus;
  const priority = normalizePriority(value.priority);
  const assigneeType = normalizeAssigneeType(value.assignee_type);
  const issue: MulticaIssue = {
    ...value,
    id: value.id,
    workspace_id: typeof value.workspace_id === 'string' ? value.workspace_id : '',
    project_id: nullableString(value.project_id),
    title: typeof value.title === 'string' ? value.title : '',
    description: nullableString(value.description),
    status,
    priority,
    assignee_type: assigneeType,
    assignee_id: nullableString(value.assignee_id),
    context_refs: Array.isArray(value.context_refs) ? value.context_refs : [],
    due_date: nullableString(value.due_date),
    created_at: typeof value.created_at === 'string' ? value.created_at : '',
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : '',
  };
  return issue;
}

function toMulticaTaskRun(value: unknown): MulticaTaskRun | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.issue_id !== 'string') {
    return null;
  }

  const taskRun: MulticaTaskRun = {
    ...value,
    id: value.id,
    issue_id: value.issue_id,
    status: typeof value.status === 'string' ? value.status : '',
  };
  return taskRun;
}

function normalizePriority(value: unknown): MulticaIssue['priority'] {
  if (typeof value === 'string' && MULTICA_PRIORITY_SET.has(value)) {
    return value as MulticaIssue['priority'];
  }
  return 'none';
}

function normalizeAssigneeType(value: unknown): MulticaAssigneeType | null {
  if (typeof value === 'string' && MULTICA_ASSIGNEE_SET.has(value)) {
    return value as MulticaAssigneeType;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function hasResolvedValue(value: string | undefined): value is string {
  return normalizeRequiredValue(value) !== null;
}

function normalizeRequiredValue(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('op://')) {
    return null;
  }
  return trimmed;
}

function normalizeOptionalValue(value: string | undefined): string | null {
  return normalizeRequiredValue(value);
}
