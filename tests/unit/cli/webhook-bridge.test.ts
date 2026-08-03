import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { type AddressInfo } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBridgeServer, webhookBridgeCommand } from '../../../src/cli/webhook-bridge';

interface ResponseShape {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: Record<string, unknown> | null;
}

let tempRoot = '';
let savedEnv: Record<string, string | undefined> = {};

function setupRegistry(root: string, agentName: string): void {
  const agentDir = join(root, 'orgs', 'clearworksai', 'agents', agentName);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'IDENTITY.md'), `# ${agentName}\n`, 'utf-8');
}

async function listen(server: ReturnType<typeof createBridgeServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://${address.address}:${address.port}`;
}

async function sendRequest(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<ResponseShape> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );

    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

function buildServer(now?: () => number) {
  return createBridgeServer({
    instanceId: 'test-instance',
    ctxRoot: tempRoot,
    frameworkRoot: tempRoot,
    org: 'clearworksai',
    bridgeSecret: 'top-secret',
    now,
  });
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'webhook-bridge-'));
  setupRegistry(tempRoot, 'crm');
  setupRegistry(tempRoot, 'pa');
  savedEnv = {
    CTX_FRAMEWORK_ROOT: process.env.CTX_FRAMEWORK_ROOT,
    CTX_PROJECT_ROOT: process.env.CTX_PROJECT_ROOT,
    CTX_ORG: process.env.CTX_ORG,
    CTX_ROOT: process.env.CTX_ROOT,
    CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID,
    WEBHOOK_BRIDGE_SECRET: process.env.WEBHOOK_BRIDGE_SECRET,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('webhook-bridge server', () => {
  it('binds the server to loopback when the caller listens on 127.0.0.1', async () => {
    const server = buildServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('serves /healthz and 404s GET /relay without touching the inbox', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);

    const healthz = await sendRequest(baseUrl, '/healthz');
    expect(healthz.status).toBe(200);
    expect(healthz.json).toEqual({ ok: true, service: 'webhook-bridge' });

    const relayGet = await sendRequest(baseUrl, '/relay/zoom-officehours');
    expect(relayGet.status).toBe(404);
    expect(existsSync(join(tempRoot, 'inbox', 'crm'))).toBe(false);

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('returns 401 for missing or wrong secrets and writes no inbox file', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);
    const body = JSON.stringify({
      integration: 'zoom-officehours',
      target: 'crm',
      event: 'meeting.registration_created',
    });

    const missingSecret = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      body,
    });
    expect(missingSecret.status).toBe(401);
    expect(missingSecret.json?.tier).toBe('auth');

    const wrongSecret = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'wrong-secret' },
      body,
    });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.json?.tier).toBe('auth');
    expect(existsSync(join(tempRoot, 'inbox', 'crm'))).toBe(false);

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects unknown integrations with 403', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);

    const response = await sendRequest(baseUrl, '/relay/not-allowed', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'top-secret' },
      body: JSON.stringify({
        integration: 'not-allowed',
        target: 'crm',
        event: 'meeting.registration_created',
      }),
    });

    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ error: 'unknown_integration', tier: 'integration' });

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rejects unknown target agents with 404', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);

    const response = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'top-secret' },
      body: JSON.stringify({
        integration: 'zoom-officehours',
        target: 'missing-agent',
        event: 'meeting.registration_created',
      }),
    });

    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: 'unknown_agent', tier: 'target' });

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('returns 400 for malformed JSON bodies', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);

    const response = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'top-secret' },
      body: '{"integration":',
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: 'invalid_json', tier: 'body' });

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('writes exactly one inbox file and one inbound log line on the happy path without tripping the build gate', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);

    const response = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'top-secret' },
      body: JSON.stringify({
        integration: 'zoom-officehours',
        target: 'crm',
        event: 'meeting.registration_created',
        meeting_id: '84893116740',
        registrant: {
          first_name: 'Jane',
          last_name: 'Doe',
          email: 'jane@example.com',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.json?.ok).toBe(true);

    const inboxDir = join(tempRoot, 'inbox', 'crm');
    const inboxFiles = readdirSync(inboxDir);
    expect(inboxFiles).toHaveLength(1);
    expect(inboxFiles[0]).toMatch(/^2-\d+-from-webhook-hub-[a-z0-9]+\.json$/);

    const inboxPayload = JSON.parse(readFileSync(join(inboxDir, inboxFiles[0]), 'utf-8')) as {
      text: string;
    };
    expect(inboxPayload.text.startsWith('WEBHOOK zoom-officehours meeting.registration_created')).toBe(true);
    expect(inboxPayload.text).toContain('jane@example.com');
    expect(inboxPayload.text).toContain('AMBIG/NOISE = do not auto-write.');

    const logFile = join(tempRoot, 'logs', 'crm', 'inbound-messages.jsonl');
    expect(existsSync(logFile)).toBe(true);
    const logLines = readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0])).toMatchObject({
      source: 'webhook-bridge',
      from_name: 'webhook-hub',
      agent: 'crm',
    });

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('relays fireflies meetings to pa with explicit single-meeting worker context', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);

    const response = await sendRequest(baseUrl, '/relay/fireflies', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'top-secret' },
      body: JSON.stringify({
        integration: 'fireflies',
        target: 'pa',
        event: 'transcription.completed',
        meeting_id: 'meeting-123',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.json?.ok).toBe(true);

    const inboxDir = join(tempRoot, 'inbox', 'pa');
    const inboxFiles = readdirSync(inboxDir);
    expect(inboxFiles).toHaveLength(1);

    const inboxPayload = JSON.parse(readFileSync(join(inboxDir, inboxFiles[0]), 'utf-8')) as {
      text: string;
    };
    expect(inboxPayload.text).toContain('WEBHOOK fireflies transcription.completed');
    expect(inboxPayload.text).toContain('meeting-123');
    expect(inboxPayload.text).toContain('meeting-commitments-worker');
    expect(inboxPayload.text).toContain('FF_MEETING_ID=meeting-123');
    expect(inboxPayload.text).toContain('--mode full --meeting-id meeting-123');

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('relays ops-check leads to crm with an instructive lead-magnet upsert message', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);

    const response = await sendRequest(baseUrl, '/relay/ops-check-lead', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'top-secret' },
      body: JSON.stringify({
        integration: 'ops-check-lead',
        target: 'crm',
        event: 'lead.submitted',
        occurred_at: '2026-07-28T21:15:00Z',
        contact: {
          name: 'Jordan Example',
          email: 'jordan@example.com',
          company: 'Example Co',
        },
        firmographic: {
          industry: 'AEC',
          teamSize: '11-50',
          role: 'COO',
        },
        openText: {
          keepsUpAtNight: 'Manual work is everywhere.',
          processDescription: 'Email, spreadsheets, and Slack.',
        },
        computed: {
          score: 64,
          band: 'Yellow',
          topGaps: [{ id: 'connected_systems', name: 'Connected systems', contribution: 12 }],
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.json?.ok).toBe(true);

    const inboxDir = join(tempRoot, 'inbox', 'crm');
    const inboxFiles = readdirSync(inboxDir);
    expect(inboxFiles).toHaveLength(1);

    const inboxPayload = JSON.parse(readFileSync(join(inboxDir, inboxFiles[0]), 'utf-8')) as {
      text: string;
    };
    expect(inboxPayload.text).toContain('WEBHOOK ops-check-lead lead.submitted');
    expect(inboxPayload.text).toContain('jordan@example.com');
    expect(inboxPayload.text).toContain('Score: 64');
    expect(inboxPayload.text).toContain('Band: Yellow');
    expect(inboxPayload.text).toContain('lead-magnet');
    expect(inboxPayload.text).toContain('upsert-contact.py');
    expect(inboxPayload.text).toContain('Manual work is everywhere.');
    expect(inboxPayload.text).toContain('Email, spreadsheets, and Slack.');
    expect(inboxPayload.text).toContain('```json');
    expect(inboxPayload.text).toContain('"integration": "ops-check-lead"');

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('relays degenerate ops-check leads without throwing while still allowing the integration', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);

    const response = await sendRequest(baseUrl, '/relay/ops-check-lead', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'top-secret' },
      body: JSON.stringify({
        integration: 'ops-check-lead',
        target: 'crm',
        event: 'lead.submitted',
        contact: {
          name: 'Jordan Example',
          email: 'jordan@example.com',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.json?.ok).toBe(true);

    const inboxDir = join(tempRoot, 'inbox', 'crm');
    const inboxFiles = readdirSync(inboxDir);
    expect(inboxFiles).toHaveLength(1);

    const inboxPayload = JSON.parse(readFileSync(join(inboxDir, inboxFiles[0]), 'utf-8')) as {
      text: string;
    };
    expect(inboxPayload.text).toContain('WEBHOOK ops-check-lead lead.submitted');
    expect(inboxPayload.text).toContain('Score: unknown');
    expect(inboxPayload.text).toContain('Keeps them up: n/a');
    expect(inboxPayload.text).toContain('```json');

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('rate-limits the 121st relay request in a fixed window and resets in the next window', async () => {
    let nowMs = 0;
    const server = buildServer(() => nowMs);
    const baseUrl = await listen(server);

    for (let i = 0; i < 120; i += 1) {
      const response = await sendRequest(baseUrl, '/relay/zoom-officehours', {
        method: 'POST',
        body: '{}',
      });
      expect(response.status).toBe(401);
    }

    const limited = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      body: '{}',
    });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');

    nowMs = RATE_LIMIT_RESET_MS;
    const reset = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      body: '{}',
    });
    expect(reset.status).toBe(401);

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('returns 413 when the request body exceeds 256KB', async () => {
    const server = buildServer();
    const baseUrl = await listen(server);

    const response = await sendRequest(baseUrl, '/relay/zoom-officehours', {
      method: 'POST',
      headers: { 'x-webhook-bridge-secret': 'top-secret' },
      body: 'x'.repeat(300 * 1024),
    });

    expect(response.status).toBe(413);
    expect(response.json).toMatchObject({ error: 'body_too_large', tier: 'body' });

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

describe('webhook-bridge command', () => {
  it('exits non-zero with a clear message when WEBHOOK_BRIDGE_SECRET is unavailable at startup', async () => {
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    process.env.CTX_PROJECT_ROOT = tempRoot;
    process.env.CTX_ORG = 'clearworksai';
    process.env.CTX_ROOT = tempRoot;
    process.env.CTX_INSTANCE_ID = 'test-instance';
    delete process.env.WEBHOOK_BRIDGE_SECRET;

    const exitSpy = mockExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      webhookBridgeCommand.parseAsync(['run', '--port', '20242'], { from: 'user' }),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toContain('WEBHOOK_BRIDGE_SECRET is required');
  });
});

const RATE_LIMIT_RESET_MS = 60_001;
