import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MulticaHttpError,
  createMulticaClient,
  resolveMulticaConfig,
} from '../../../../src/bus/multica/client.js';
import { taskToIssuePayload } from '../../../../src/bus/multica/mapping.js';
import type { Task } from '../../../../src/types/index.js';
import type { MulticaConfig, MulticaIssue, MulticaPushPayload } from '../../../../src/bus/multica/types.js';

const config: MulticaConfig = {
  baseUrl: 'https://multica.example.com/',
  readApiToken: 'read-token',
  workspaceId: 'workspace-123',
  memberIdJosh: 'member-josh',
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_987_12345678',
    title: 'Bridge task',
    description: 'Ship the bridge core',
    type: 'agent',
    needs_approval: false,
    status: 'pending',
    assigned_to: 'human',
    created_by: 'codexer',
    org: 'clearworksai',
    priority: 'normal',
    project: '',
    kpi_key: null,
    created_at: '2026-07-29T07:00:00Z',
    updated_at: '2026-07-29T07:00:00Z',
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
}

function makePayload(): MulticaPushPayload {
  return taskToIssuePayload(makeTask(), {
    ...config,
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
  });
}

function makeIssueResponse(
  payload: MulticaPushPayload,
  overrides: Partial<MulticaIssue> = {},
): MulticaIssue {
  return {
    id: 'issue-real-1',
    identifier: 'CLE-34',
    workspace_id: payload.issue.workspace_id,
    project_id: payload.issue.project_id,
    title: payload.issue.title,
    description: payload.issue.description,
    status: payload.issue.status,
    priority: payload.issue.priority,
    assignee_type: payload.issue.assignee_type,
    assignee_id: payload.issue.assignee_id,
    context_refs: [],
    due_date: payload.issue.due_date,
    created_at: '2026-07-29T07:00:00Z',
    updated_at: '2026-07-29T07:00:00Z',
    ...overrides,
  };
}

describe('multica client', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('createIssue posts the flat issue body to the real REST endpoint', async () => {
    const payload = makePayload();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(makeIssueResponse(payload)),
      { status: 201 },
    ));
    const client = createMulticaClient(config, fetchMock as unknown as typeof fetch);

    const issue = await client.createIssue(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://multica.example.com/api/issues?workspace_id=workspace-123');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(payload.issue));

    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer read-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(issue.id).toBe('issue-real-1');
  });

  it('updateIssue puts the flat issue body to the real REST endpoint', async () => {
    const payload = makePayload();
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(makeIssueResponse(payload, {
        title: 'Bridge task updated',
        updated_at: '2026-07-29T08:00:00Z',
      })),
      { status: 200 },
    ));
    const client = createMulticaClient(config, fetchMock as unknown as typeof fetch);

    const issue = await client.updateIssue('issue-real-1', payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://multica.example.com/api/issues/issue-real-1?workspace_id=workspace-123');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify(payload.issue));

    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer read-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(issue.title).toBe('Bridge task updated');
  });

  it('createIssue rejects unparseable success bodies as typed errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    const client = createMulticaClient(config, fetchMock as unknown as typeof fetch);

    await expect(client.createIssue(makePayload())).rejects.toMatchObject({
      name: 'MulticaHttpError',
      endpoint: 'https://multica.example.com/api/issues?workspace_id=workspace-123',
    });
  });

  it.each([401, 400, 413])('surfaces HTTP %s failures as typed errors', async (status) => {
    const fetchMock = vi.fn(async () => new Response('nope', { status }));
    const client = createMulticaClient(config, fetchMock as unknown as typeof fetch);

    await expect(client.createIssue(makePayload())).rejects.toMatchObject({
      name: 'MulticaHttpError',
      status,
      endpoint: 'https://multica.example.com/api/issues?workspace_id=workspace-123',
    });
  });

  it('wraps transport failures with status 0', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const client = createMulticaClient(config, fetchMock as unknown as typeof fetch);

    await expect(client.listIssues()).rejects.toMatchObject({
      name: 'MulticaHttpError',
      status: 0,
      endpoint: 'https://multica.example.com/api/issues?workspace_id=workspace-123',
    });
  });

  it('listIssues accepts wrapped arrays and skips invalid items', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      issues: [
        {
          id: 'issue-1',
          workspace_id: 'workspace-123',
          project_id: null,
          title: 'Bridge task',
          description: null,
          status: 'todo',
          priority: 'high',
          assignee_type: 'member',
          assignee_id: 'member-josh',
          context_refs: [],
          due_date: null,
          created_at: '2026-07-29T07:00:00Z',
          updated_at: '2026-07-29T07:00:00Z',
        },
        {
          bogus: true,
        },
      ],
    }), { status: 200 }));
    const client = createMulticaClient(config, fetchMock as unknown as typeof fetch);

    const issues = await client.listIssues({ limit: 10, offset: 5 });
    const [endpoint] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(endpoint);

    expect(issues).toHaveLength(1);
    expect(url.searchParams.get('workspace_id')).toBe(config.workspaceId);
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('offset')).toBe('5');
    expect(issues[0].status).toBe('todo');
    expect(issues[0].priority).toBe('high');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('getTaskRuns accepts wrapped arrays', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      taskRuns: [
        {
          id: 'run-1',
          issue_id: 'issue-1',
          status: 'queued',
          extra: true,
        },
      ],
    }), { status: 200 }));
    const client = createMulticaClient(config, fetchMock as unknown as typeof fetch);

    const runs = await client.getTaskRuns('issue-1');

    expect(runs).toEqual([
      {
        id: 'run-1',
        issue_id: 'issue-1',
        status: 'queued',
        extra: true,
      },
    ]);
  });

  it('loads missing config values from org secrets.env and trims the base URL', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'multica-client-test-'));
    const orgDir = join(tempRoot, 'orgs', 'clearworksai');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'secrets.env'), [
      'MULTICA_BASE_URL="https://multica.example.com/"',
      'MULTICA_WORKSPACE_ID="workspace-from-file"',
      'MULTICA_MEMBER_ID_JOSH="member-from-file"',
      'MULTICA_READ_API_TOKEN="read-from-file"',
    ].join('\n'));

    const resolved = resolveMulticaConfig({
      CTX_ROOT: tempRoot,
    });

    expect(resolved).toEqual({
      baseUrl: 'https://multica.example.com',
      readApiToken: 'read-from-file',
      workspaceId: 'workspace-from-file',
      memberIdJosh: 'member-from-file',
    });
  });

  it('returns null and warns once when required keys are missing', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'multica-client-test-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const resolved = resolveMulticaConfig({
      CTX_ROOT: tempRoot,
    });

    expect(resolved).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('MULTICA_BASE_URL');
  });

  it('returns null and warns when the read token is missing', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'multica-client-test-'));
    const orgDir = join(tempRoot, 'orgs', 'clearworksai');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'secrets.env'), [
      'MULTICA_BASE_URL="https://multica.example.com/"',
      'MULTICA_WORKSPACE_ID="workspace-from-file"',
      'MULTICA_MEMBER_ID_JOSH="member-from-file"',
    ].join('\n'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const resolved = resolveMulticaConfig({
      CTX_ROOT: tempRoot,
    });

    expect(resolved).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('MULTICA_READ_API_TOKEN');
  });

  it('exports the typed error class for callers to catch', () => {
    const error = new MulticaHttpError('failed', 401, '/api/issues');
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(401);
    expect(error.endpoint).toBe('/api/issues');
  });
});
