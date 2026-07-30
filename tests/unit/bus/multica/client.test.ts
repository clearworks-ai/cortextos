import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MulticaHttpError,
  createMulticaClient,
  resolveMulticaConfig,
  sign,
} from '../../../../src/bus/multica/client.js';
import { taskToIssuePayload } from '../../../../src/bus/multica/mapping.js';
import type { Task } from '../../../../src/types/index.js';
import type { MulticaConfig } from '../../../../src/bus/multica/types.js';

const config: MulticaConfig = {
  baseUrl: 'https://multica.example.com/',
  webhookToken: 'webhook-token',
  webhookSecret: 'webhook-secret',
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

describe('multica client', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('signs with the expected Multica header prefix', () => {
    expect(sign('{"a":1}', 'testsecret')).toBe(
      'sha256=0f4a604a9e9ad182034b3224fb61724a9ef127c2d5de3554995cc31f9cc3c499',
    );
  });

  it('pushIssue signs the exact request body and includes the idempotency key', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = createMulticaClient(config, fetchMock as unknown as typeof fetch);
    const payload = taskToIssuePayload(makeTask(), {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
    });

    await client.pushIssue(payload, 'idempotency-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://multica.example.com/api/webhooks/autopilots/webhook-token');
    expect(init.body).toBe(JSON.stringify(payload));

    const headers = new Headers(init.headers);
    expect(headers.get('Idempotency-Key')).toBe('idempotency-123');
    expect(headers.get('X-Hub-Signature-256')).toBe(
      sign(JSON.stringify(payload), config.webhookSecret),
    );
  });

  it.each([401, 400, 413])('surfaces HTTP %s failures as typed errors', async (status) => {
    const fetchMock = vi.fn(async () => new Response('nope', { status }));
    const client = createMulticaClient(config, fetchMock as unknown as typeof fetch);

    await expect(client.pushIssue(taskToIssuePayload(makeTask(), config), 'idempotency-123')).rejects
      .toMatchObject({
        name: 'MulticaHttpError',
        status,
        endpoint: 'https://multica.example.com/api/webhooks/autopilots/webhook-token',
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
      endpoint: 'https://multica.example.com/api/issues',
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

    expect(issues).toHaveLength(1);
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
      'MULTICA_WEBHOOK_TOKEN="token-from-file"',
      'MULTICA_WEBHOOK_SECRET="secret-from-file"',
      'MULTICA_WORKSPACE_ID="workspace-from-file"',
      'MULTICA_MEMBER_ID_JOSH="member-from-file"',
      'MULTICA_READ_API_TOKEN="read-from-file"',
    ].join('\n'));

    const resolved = resolveMulticaConfig({
      CTX_ROOT: tempRoot,
    });

    expect(resolved).toEqual({
      baseUrl: 'https://multica.example.com',
      webhookToken: 'token-from-file',
      webhookSecret: 'secret-from-file',
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

  it('exports the typed error class for callers to catch', () => {
    const error = new MulticaHttpError('failed', 401, '/api/issues');
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(401);
    expect(error.endpoint).toBe('/api/issues');
  });
});
