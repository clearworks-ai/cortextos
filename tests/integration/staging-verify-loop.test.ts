import { createServer } from 'http';
import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitLedgerRow, verifyChainDetailed } from '../../src/pipeline/ledger.js';
import { main } from '../../src/pipeline/staging-verify/cli.js';

function transcriptLine(sessionId: string, block: Record<string, unknown>, type: 'assistant' | 'user' = 'assistant'): string {
  return JSON.stringify({
    type,
    timestamp: '2026-07-23T00:00:00.000Z',
    sessionId,
    isSidechain: true,
    message: {
      role: type,
      content: [block],
    },
  });
}

function writeWriteTranscript(path: string, sessionId: string, filePath: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    transcriptLine(sessionId, {
      type: 'tool_use',
      id: `toolu_${sessionId}`,
      name: 'Write',
      input: { file_path: filePath, content },
    }),
    transcriptLine(sessionId, {
      type: 'tool_result',
      tool_use_id: `toolu_${sessionId}`,
      content: 'ok',
    }, 'user'),
  ].join('\n') + '\n', 'utf-8');
}

async function invokeCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 0;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    return undefined as never;
  }) as never);
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as never);

  try {
    await main(args);
  } finally {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { code: exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

let root = '';
let oldPath = '';

afterEach(() => {
  if (oldPath) process.env.PATH = oldPath;
  delete process.env.STAGING_VERIFY_FIXTURE_USER;
  delete process.env.STAGING_VERIFY_FIXTURE_PASSWORD;
  delete process.env.PIPELINE_TRANSCRIPT_ROOT_OVERRIDE;
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
  oldPath = '';
});

describe('staging-verify loop', () => {
  it('runs the full loop, emits a signed staging-verify row, and self-verifies with the gate command', async () => {
    root = mkdtempSync(join(tmpdir(), 'staging-verify-integration-'));
    const repoRoot = join(root, 'repo');
    const ledgerPath = join(root, 'pipeline-ledger.jsonl');
    const secretPath = join(root, '.pipeline-secret');
    const evidenceDir = join(root, 'evidence');
    const fakeRailwayLog = join(root, 'railway.log');
    const fakeRailway = join(root, 'railway');
    const configPath = join(root, 'repos.json');
    const projectsRoot = join(root, 'projects');
    const featureRoot = join(root, '.agent', 'one-big-feature', 'test-slug');
    const researchPath = join(featureRoot, '01-research.md');
    const planPath = join(featureRoot, '02-master-plan.md');
    const specsDir = join(featureRoot, '03-specs');
    const specPath = join(specsDir, '01-spec.md');
    const reviewPath = join(featureRoot, '04-review.md');

    mkdirSync(join(repoRoot, '.staging-verify'), { recursive: true });
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(secretPath, `${'ab'.repeat(32)}\n`, 'utf-8');
    writeFileSync(researchPath, '# research\n', 'utf-8');
    writeFileSync(planPath, '# plan\n', 'utf-8');
    writeFileSync(specPath, '# specs\n', 'utf-8');
    writeFileSync(reviewPath, '# review\n', 'utf-8');

    writeFileSync(join(repoRoot, 'verify.js'), 'process.exit(0);\n', 'utf-8');
    writeFileSync(join(repoRoot, 'migrate.js'), 'console.log("migrated");\n', 'utf-8');
    writeFileSync(join(repoRoot, 'seed.js'), 'console.log("seeded");\n', 'utf-8');
    writeFileSync(join(repoRoot, 'query-state.js'), 'console.log(JSON.stringify({ value: 1 }));\n', 'utf-8');
    writeFileSync(join(repoRoot, '.staging-verify', 'scenario.json'), JSON.stringify({
      name: 'fixture',
      auth: {
        kind: 'form-login',
        path: '/login',
        usernameEnv: 'STAGING_VERIFY_FIXTURE_USER',
        passwordEnv: 'STAGING_VERIFY_FIXTURE_PASSWORD',
        bodyTemplate: { email: '$USERNAME', password: '$PASSWORD' },
        successStatus: [200, 302],
      },
      steps: [
        {
          name: 'create-item',
          method: 'POST',
          path: '/api/items',
          contentType: 'application/json',
          body: { name: 'demo' },
          expectStatus: [200],
          captureJson: { itemId: 'id' },
        },
        {
          name: 'read-item',
          method: 'GET',
          path: '/api/items/$itemId',
          expectStatus: [200],
        },
      ],
      assertions: [
        { name: 'json-count', source: 'json-api', endpoint: '/api/state', jsonPath: 'count', op: 'eq', expected: 1 },
        { name: 'db-count', source: 'db', queryScript: 'query-state.js', op: 'eq', expected: 1 },
      ],
    }, null, 2), 'utf-8');

    spawnSync('git', ['init'], { cwd: repoRoot, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, encoding: 'utf-8' });
    spawnSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf-8' });
    spawnSync('git', ['branch', 'feature-build'], { cwd: repoRoot, encoding: 'utf-8' });

    const sessions = [
      { stage: 'plan', session: 'plan-session', artifact: planPath, runner: 'fable-lean' },
      { stage: 'specs', session: 'specs-session', artifact: specPath, runner: 'architect' },
      { stage: 'review', session: 'review-session', artifact: reviewPath, runner: 'larry' },
    ] as const;
    for (const { session, artifact } of sessions) {
      writeWriteTranscript(join(projectsRoot, 'larry', session, 'subagents', `${session}.jsonl`), session, artifact, readFileSync(artifact, 'utf-8'));
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    emitLedgerRow({ slug: 'test-slug', stage: 'research', artifactPath: researchPath, ledgerPath, secretPath, nowSeconds: nowSeconds - 40 });
    emitLedgerRow({
      slug: 'test-slug',
      stage: 'plan',
      artifactPath: planPath,
      runner: 'fable-lean',
      sessionId: 'plan-session',
      transcriptPath: join(projectsRoot, 'larry', 'plan-session', 'subagents', 'plan-session.jsonl'),
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: nowSeconds - 30,
    });
    emitLedgerRow({
      slug: 'test-slug',
      stage: 'specs',
      artifactPath: specsDir,
      runner: 'architect',
      sessionId: 'specs-session',
      transcriptPath: join(projectsRoot, 'larry', 'specs-session', 'subagents', 'specs-session.jsonl'),
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: nowSeconds - 20,
    });
    emitLedgerRow({
      slug: 'test-slug',
      stage: 'review',
      artifactPath: reviewPath,
      runner: 'larry',
      sessionId: 'review-session',
      transcriptPath: join(projectsRoot, 'larry', 'review-session', 'subagents', 'review-session.jsonl'),
      transcriptRoot: projectsRoot,
      ledgerPath,
      secretPath,
      nowSeconds: nowSeconds - 10,
    });

    let nextId = 1;
    const sessionsMap = new Set<string>();
    const server = createServer(async (req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.url === '/login' && req.method === 'POST') {
        res.writeHead(302, {
          'set-cookie': 'sid=test-session; Path=/',
          location: '/dashboard',
        });
        res.end();
        return;
      }
      if (req.url === '/dashboard') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>ok</html>');
        return;
      }
      if (req.url === '/api/items' && req.method === 'POST') {
        if (req.headers.cookie !== 'sid=test-session') {
          res.writeHead(401);
          res.end();
          return;
        }
        const id = `item-${nextId++}`;
        sessionsMap.add(id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id }));
        return;
      }
      if (req.url?.startsWith('/api/items/') && req.method === 'GET') {
        const id = req.url.split('/').pop() ?? '';
        if (req.headers.cookie !== 'sid=test-session' || !sessionsMap.has(id)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id }));
        return;
      }
      if (req.url === '/api/state') {
        if (req.headers.cookie !== 'sid=test-session') {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"count":1}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server address');
    const serverUrl = `http://127.0.0.1:${address.port}`;

    writeFileSync(fakeRailway, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${fakeRailwayLog}"
case "$1" in
  environment)
    echo '["staging","production"]'
    ;;
  up)
    echo 'ok'
    ;;
  status)
    printf '{"services":[{"domains":["%s"]}]}' "${serverUrl}"
    ;;
  domain)
    printf '%s' "${serverUrl}"
    ;;
  run)
    shift
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  down)
    exit 0
    ;;
  *)
    echo "unexpected railway command: $*" >&2
    exit 1
    ;;
esac
`, 'utf-8');
    chmodSync(fakeRailway, 0o755);

    writeFileSync(configPath, JSON.stringify([{
      key: 'clearpath',
      localPath: repoRoot,
      railwayProject: 'fixture-project',
      stagingEnv: 'staging',
      prodEnvNames: ['production'],
      verifyCommand: 'node verify.js',
      migrateCommand: 'node migrate.js',
      seedCommand: 'node seed.js',
      healthPath: '/api/health',
      scenarioPath: join(repoRoot, '.staging-verify', 'scenario.json'),
    }], null, 2), 'utf-8');

    oldPath = process.env.PATH ?? '';
    process.env.PATH = `${root}:${oldPath}`;
    process.env.STAGING_VERIFY_FIXTURE_USER = 'user@example.com';
    process.env.STAGING_VERIFY_FIXTURE_PASSWORD = 'secret';
    process.env.PIPELINE_TRANSCRIPT_ROOT_OVERRIDE = projectsRoot;

    const cli = await invokeCli([
      '--slug', 'test-slug',
      '--repo', 'clearpath',
      '--build-output', 'feature-build',
      '--config', configPath,
      '--ledger', ledgerPath,
      '--secret', secretPath,
      '--evidence-dir', evidenceDir,
      '--json',
    ]);

    server.close();

    if (cli.code !== 0) {
      throw new Error(`CLI failed with ${cli.code}\nSTDOUT:\n${cli.stdout}\nSTDERR:\n${cli.stderr}`);
    }
    expect(cli.code).toBe(0);
    const parsed = JSON.parse(cli.stdout.trim()) as { ok: boolean; evidencePath?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.evidencePath).toBe(join(evidenceDir, 'test-slug.json'));

    const verified = verifyChainDetailed({
      slug: 'test-slug',
      throughStage: 'staging-verify',
      maxAgeSeconds: 86_400,
      ledgerPath,
      secretPath,
      transcriptRoot: projectsRoot,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.terminal.evidence_path).toBe(join(evidenceDir, 'test-slug.json'));

    const gateVerify = spawnSync('bash', [
      resolve(__dirname, '../../bin/pipeline-stage-emit'),
      '--verify',
      '--slug', 'test-slug',
      '--through', 'staging-verify',
      '--max-age', '86400',
      '--ledger', ledgerPath,
      '--secret', secretPath,
    ], {
      cwd: resolve(__dirname, '../..'),
      encoding: 'utf-8',
    });
    expect(gateVerify.status).toBe(0);
    expect(JSON.parse(gateVerify.stdout.trim()).evidence_path).toBe(join(evidenceDir, 'test-slug.json'));
  });

  it('fails in preflight without a review row and never deploys', async () => {
    root = mkdtempSync(join(tmpdir(), 'staging-verify-no-review-'));
    const repoRoot = join(root, 'repo');
    const ledgerPath = join(root, 'pipeline-ledger.jsonl');
    const secretPath = join(root, '.pipeline-secret');
    const evidenceDir = join(root, 'evidence');
    const configPath = join(root, 'repos.json');
    const fakeRailwayLog = join(root, 'railway.log');
    const fakeRailway = join(root, 'railway');

    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(secretPath, `${'ab'.repeat(32)}\n`, 'utf-8');
    writeFileSync(join(repoRoot, 'verify.js'), 'process.exit(0);\n', 'utf-8');
    spawnSync('git', ['init'], { cwd: repoRoot, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, encoding: 'utf-8' });
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n', 'utf-8');
    spawnSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf-8' });
    spawnSync('git', ['branch', 'feature-build'], { cwd: repoRoot, encoding: 'utf-8' });

    writeFileSync(fakeRailway, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${fakeRailwayLog}"
if [[ "$1" == "environment" ]]; then
  echo '["staging","production"]'
  exit 0
fi
echo 'should not deploy' >&2
exit 1
`, 'utf-8');
    chmodSync(fakeRailway, 0o755);

    writeFileSync(configPath, JSON.stringify([{
      key: 'clearpath',
      localPath: repoRoot,
      railwayProject: 'fixture-project',
      stagingEnv: 'staging',
      prodEnvNames: ['production'],
      verifyCommand: 'node verify.js',
      healthPath: '/api/health',
    }], null, 2), 'utf-8');

    oldPath = process.env.PATH ?? '';
    process.env.PATH = `${root}:${oldPath}`;
    process.env.PIPELINE_TRANSCRIPT_ROOT_OVERRIDE = root;
    const cli = await invokeCli([
      '--slug', 'test-slug',
      '--repo', 'clearpath',
      '--build-output', 'feature-build',
      '--config', configPath,
      '--ledger', ledgerPath,
      '--secret', secretPath,
      '--evidence-dir', evidenceDir,
      '--json',
    ]);

    expect(cli.code).toBe(2);
    if (existsSync(fakeRailwayLog)) {
      expect(readFileSync(fakeRailwayLog, 'utf-8')).not.toContain('up --ci');
    }
  });
});
