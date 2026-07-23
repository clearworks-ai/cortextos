import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CookieJar, loadScenario, runDrive } from '../../../../src/pipeline/staging-verify/drive.js';
import { RailwayCli } from '../../../../src/pipeline/staging-verify/railway.js';
import { readEndState } from '../../../../src/pipeline/staging-verify/state-read.js';
import type { RepoConfig, RunContext, Scenario } from '../../../../src/pipeline/staging-verify/types.js';
import { runVerifyCommand } from '../../../../src/pipeline/staging-verify/verify.js';

const repo: RepoConfig = {
  key: 'clearpath',
  localPath: '/tmp/clearpath',
  railwayProject: 'awake-recreation',
  stagingEnv: 'staging',
  prodEnvNames: ['production'],
  verifyCommand: 'npm test',
  healthPath: '/api/health',
  scenarioPath: '/tmp/clearpath/.staging-verify/scenario.json',
};

function createCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    slug: 'slug',
    repo,
    buildOutputPath: 'feature-branch',
    buildOutputSha256: 'sha',
    attempt: 1,
    maxAttempts: 3,
    runner: 'staging-verify-loop',
    evidenceDir: '/tmp/staging-verify',
    keepDeploy: false,
    log: () => {},
    stagingUrl: 'https://staging.example.com',
    ...overrides,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.STAGING_VERIFY_USER;
  delete process.env.STAGING_VERIFY_PASS;
});

describe('drive and read-state', () => {
  it('captures session cookies from a 302 form-login and replays them on later steps', async () => {
    let sawCookie = false;
    const server = await startServer(async (req, res) => {
      if (req.url === '/login' && req.method === 'POST') {
        await readBody(req);
        res.statusCode = 302;
        res.setHeader('set-cookie', 'sid=session-1; Path=/');
        res.setHeader('location', '/dashboard');
        res.end();
        return;
      }
      if (req.url === '/dashboard') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html');
        res.end('<html></html>');
        return;
      }
      if (req.url === '/api/private') {
        sawCookie = req.headers.cookie === 'sid=session-1';
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    process.env.STAGING_VERIFY_USER = 'user@example.com';
    process.env.STAGING_VERIFY_PASS = 'secret';

    const scenario: Scenario = {
      name: 'cookie-flow',
      auth: {
        kind: 'form-login',
        path: '/login',
        usernameEnv: 'STAGING_VERIFY_USER',
        passwordEnv: 'STAGING_VERIFY_PASS',
        bodyTemplate: { email: '$USERNAME', password: '$PASSWORD' },
        successStatus: [302, 200],
      },
      steps: [{
        name: 'private',
        method: 'GET',
        path: '/api/private',
        expectStatus: [200],
      }],
      assertions: [],
    };

    const result = await runDrive(createCtx({ stagingUrl: server.url }), scenario);

    expect(result.kind).toBe('ok');
    expect(sawCookie).toBe(true);
    await server.close();
  });

  it('names missing auth env vars without leaking values', async () => {
    const scenario: Scenario = {
      name: 'missing-auth',
      auth: {
        kind: 'form-login',
        path: '/login',
        usernameEnv: 'STAGING_VERIFY_USER',
        passwordEnv: 'STAGING_VERIFY_PASS',
        bodyTemplate: { email: '$USERNAME', password: '$PASSWORD' },
        successStatus: [200],
      },
      steps: [],
      assertions: [],
    };

    process.env.STAGING_VERIFY_USER = 'user@example.com';
    delete process.env.STAGING_VERIFY_PASS;

    const result = await runDrive(createCtx(), scenario);

    expect(result).toEqual({
      kind: 'fatal',
      detail: 'Missing environment variable STAGING_VERIFY_PASS',
    });
    expect(JSON.stringify(result)).not.toContain('user@example.com');
  });

  it('classifies step failures and supports one in-place 500 retry', async () => {
    const transient = await runDrive(createCtx(), {
      name: 'transient',
      steps: [{ name: '503', method: 'GET', path: '/health', expectStatus: [200] }],
      assertions: [],
    }, vi.fn(async () => new Response('oops', { status: 503 })));
    expect(transient.kind).toBe('transient');

    const fatal = await runDrive(createCtx(), {
      name: 'fatal',
      steps: [{ name: '404', method: 'GET', path: '/missing', expectStatus: [200] }],
      assertions: [],
    }, vi.fn(async () => new Response('nope', { status: 404 })));
    expect(fatal.kind).toBe('fatal');

    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('retry', { status: 500 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const promise = runDrive(createCtx(), {
      name: 'retry',
      steps: [{ name: '500-then-200', method: 'GET', path: '/retry', expectStatus: [200] }],
      assertions: [],
    }, fetchImpl);
    await vi.advanceTimersByTimeAsync(5_000);
    const ok = await promise;
    expect(ok.kind).toBe('ok');
  });

  it('captures JSON values and substitutes them into later step paths', async () => {
    const seenUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrls.push(url);
      if (url.endsWith('/api/items')) {
        return new Response('{"id":"abc123"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await runDrive(createCtx(), {
      name: 'capture',
      steps: [
        {
          name: 'create',
          method: 'POST',
          path: '/api/items',
          contentType: 'application/json',
          body: { name: 'demo' },
          expectStatus: [200],
          captureJson: { itemId: 'id' },
        },
        {
          name: 'read',
          method: 'GET',
          path: '/api/items/$itemId',
          expectStatus: [200],
        },
      ],
      assertions: [],
    }, fetchImpl);

    expect(result.kind).toBe('ok');
    expect(seenUrls.at(-1)).toContain('/api/items/abc123');
  });

  it('evaluates json-api and db assertions and records actual values', async () => {
    const scenario: Scenario = {
      name: 'assertions',
      steps: [],
      assertions: [
        { name: 'json', source: 'json-api', endpoint: '/api/state', jsonPath: 'count', op: 'eq', expected: 3 },
        { name: 'db', source: 'db', queryScript: 'query.js', op: 'gte', expected: 10 },
      ],
    };
    const railway = new RailwayCli({
      exec: vi.fn(async (_cmd: string, args: string[]) => {
        if (args[0] === 'run') {
          return { code: 0, stdout: '{"value":12}\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }),
      repo,
    });
    const pass = await readEndState(createCtx(), scenario, {
      fetchImpl: vi.fn(async () => new Response('{"count":3}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
      jar: new CookieJar(),
      railway,
      worktree: '/tmp/worktree',
    });
    const fail = await readEndState(createCtx(), {
      ...scenario,
      assertions: [{ name: 'json', source: 'json-api', endpoint: '/api/state', jsonPath: 'count', op: 'eq', expected: 4 }],
    }, {
      fetchImpl: vi.fn(async () => new Response('{"count":3}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
      jar: new CookieJar(),
      railway,
      worktree: '/tmp/worktree',
    });
    const garbage = await readEndState(createCtx(), {
      ...scenario,
      assertions: [{ name: 'db', source: 'db', queryScript: 'query.js', op: 'eq', expected: 1 }],
    }, {
      fetchImpl: vi.fn(),
      jar: new CookieJar(),
      railway: new RailwayCli({
        exec: vi.fn(async () => ({ code: 0, stdout: 'not-json\n', stderr: '' })),
        repo,
      }),
      worktree: '/tmp/worktree',
    });

    expect(pass.outcome.kind).toBe('ok');
    expect(fail.outcome.kind).toBe('fatal');
    expect(fail.results[0]).toMatchObject({ actual: 3, pass: false });
    expect(garbage.results[0]).toMatchObject({
      actual: null,
      pass: false,
      detail: expect.stringContaining('db query emitted non-JSON terminal line'),
    });
  });

  it('rejects HTML capture responses, preserves verify commands, and falls back to a minimal scenario', async () => {
    const htmlCapture = await runDrive(createCtx(), {
      name: 'html-capture',
      steps: [{
        name: 'html',
        method: 'GET',
        path: '/html',
        expectStatus: [200],
        captureJson: { id: 'id' },
      }],
      assertions: [],
    }, vi.fn(async () => new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));

    const verify = await runVerifyCommand(createCtx({
      repo: { ...repo, verifyCommand: 'npm test' },
    }), {
      exec: vi.fn(async () => ({ code: 2, stdout: 'bad', stderr: '' })),
      worktree: '/tmp/worktree',
    });

    const root = mkdtempSync(join(tmpdir(), 'staging-verify-scenario-'));
    const minimalRepo = {
      ...repo,
      localPath: root,
      scenarioPath: join(root, '.staging-verify', 'scenario.json'),
    };
    const minimal = loadScenario(minimalRepo);
    const minimalDrive = await runDrive(createCtx({
      repo: minimalRepo,
      stagingUrl: 'https://staging.example.com',
    }), minimal, vi.fn(async () => new Response('{"status":"ok"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    expect(htmlCapture.kind).toBe('fatal');
    expect(verify.outcome.kind).toBe('fatal');
    expect(verify.command).toBe('npm test');
    expect(verify.exitCode).toBe(2);
    expect(minimal.name).toBe('minimal');
    expect(minimalDrive.kind).toBe('ok');

    rmSync(root, { recursive: true, force: true });
  });

  it('describes invalid scenario JSON instead of surfacing a raw parse error', () => {
    const root = mkdtempSync(join(tmpdir(), 'staging-verify-scenario-invalid-'));
    const scenarioDir = join(root, '.staging-verify');
    const scenarioFile = join(scenarioDir, 'scenario.json');
    mkdirSync(scenarioDir, { recursive: true });
    writeFileSync(scenarioFile, '{not-json', 'utf-8');

    expect(() => loadScenario({
      ...repo,
      localPath: root,
      scenarioPath: scenarioFile,
    })).toThrow(/is not valid JSON/);

    rmSync(root, { recursive: true, force: true });
  });
});
