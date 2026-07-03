/**
 * WS7 — backup-hot-state.sh fixture tests.
 *
 * The script snapshots a cortextOS instance's hot state (config/, state/,
 * orgs/ — crons, tasks, memory, KB manifests) into a tarball. These tests
 * run it ONLY against a throwaway fixture tree under mkdtemp — never against
 * the real ~/.cortextos — and prove:
 *   1. `bash -n` syntax-checks clean.
 *   2. Dry-run (default) prints the plan and creates NOTHING.
 *   3. --run creates <dest>/<instance>-<UTC ts>.tar.gz containing config/ and
 *      state/ (+ orgs/), with chromadb dirs excluded but manifested.
 *   4. The source tree is byte-identical afterwards (strictly read-only).
 *   5. Instance resolution: --instance > ACTIVE_INSTANCE marker > cortextos1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';

const SCRIPT = join(__dirname, '../../../scripts/backup-hot-state.sh');

/** Recursively snapshot a tree as { relPath: content } for byte-identity checks. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out[relative(root, full) + '/'] = '<dir>';
        walk(full);
      } else {
        out[relative(root, full)] = readFileSync(full, 'latin1');
      }
    }
  };
  walk(root);
  return out;
}

function runScript(args: string[], env?: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 8000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('WS7: backup-hot-state.sh', () => {
  let tmp: string;
  let ctxHome: string;
  let dest: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cortextos-ws7-backup-'));
    ctxHome = join(tmp, 'ctx-home');
    dest = join(tmp, 'dest');

    // Fixture instance tree: cortextos1 with hot-state dirs + a chromadb dir.
    const inst = join(ctxHome, 'cortextos1');
    mkdirSync(join(inst, 'config'), { recursive: true });
    mkdirSync(join(inst, 'state', 'commander'), { recursive: true });
    mkdirSync(join(inst, 'orgs', 'testorg', 'tasks'), { recursive: true });
    mkdirSync(join(inst, 'state', 'kb', 'chromadb'), { recursive: true });
    writeFileSync(join(inst, 'config', 'crons.json'), '{"crons":[]}\n');
    writeFileSync(join(inst, 'state', 'commander', 'heartbeat.json'), '{"ok":true}\n');
    writeFileSync(join(inst, 'orgs', 'testorg', 'tasks', 'task_1.json'), '{"id":"task_1"}\n');
    writeFileSync(join(inst, 'state', 'kb', 'chromadb', 'chroma.sqlite3'), 'BINARYBLOB\n');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('passes bash -n (syntax check)', () => {
    const res = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf-8' });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });

  it('dry-run by default: prints the plan and creates nothing', () => {
    const before = snapshotTree(ctxHome);
    const { status, stdout } = runScript(['--home', ctxHome, '--dest', dest]);

    expect(status).toBe(0);
    expect(stdout).toContain('instance=cortextos1');
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toContain('config');
    expect(stdout).toContain('state');
    expect(stdout).toContain('chromadb');
    // Nothing created: no dest dir, no tarball anywhere under tmp.
    expect(existsSync(dest)).toBe(false);
    expect(snapshotTree(ctxHome)).toEqual(before);
  });

  it('--run creates a tarball in --dest containing config/ and state/, excluding chromadb', () => {
    const before = snapshotTree(ctxHome);
    const { status, stdout } = runScript(['--home', ctxHome, '--dest', dest, '--run']);

    expect(status).toBe(0);
    expect(stdout).toContain('Snapshot written:');

    const archives = readdirSync(dest).filter((f) => f.endsWith('.tar.gz'));
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^cortextos1-\d{8}T\d{6}Z\.tar\.gz$/);

    const list = spawnSync('tar', ['-tzf', join(dest, archives[0])], { encoding: 'utf-8' });
    expect(list.status).toBe(0);
    const members = list.stdout.split('\n');
    expect(members.some((m) => m.startsWith('config/'))).toBe(true);
    expect(members.some((m) => m.startsWith('state/'))).toBe(true);
    expect(members.some((m) => m.startsWith('orgs/'))).toBe(true);
    expect(members).toContain('EXCLUDED-PATHS.manifest');
    // chromadb binary dirs must NOT be in the archive...
    expect(members.some((m) => m.includes('chromadb'))).toBe(false);

    // ...but ARE recorded in the manifest.
    const extractDir = join(tmp, 'extract');
    mkdirSync(extractDir);
    const xt = spawnSync('tar', ['-xzf', join(dest, archives[0]), '-C', extractDir], {
      encoding: 'utf-8',
    });
    expect(xt.status).toBe(0);
    const manifest = readFileSync(join(extractDir, 'EXCLUDED-PATHS.manifest'), 'utf-8');
    expect(manifest).toContain(join('state', 'kb', 'chromadb'));
    // Archived hot-state content round-trips intact.
    expect(readFileSync(join(extractDir, 'config', 'crons.json'), 'utf-8')).toBe('{"crons":[]}\n');

    // STRICTLY READ-ONLY: source tree is byte-identical after --run.
    expect(snapshotTree(ctxHome)).toEqual(before);
  });

  it('resolves the instance from the ACTIVE_INSTANCE marker', () => {
    mkdirSync(join(ctxHome, 'staging_2', 'config'), { recursive: true });
    writeFileSync(join(ctxHome, 'staging_2', 'config', 'crons.json'), '{}\n');
    writeFileSync(join(ctxHome, 'ACTIVE_INSTANCE'), 'staging_2\n');

    const { status, stdout } = runScript(['--home', ctxHome, '--dest', dest]);
    expect(status).toBe(0);
    expect(stdout).toContain('instance=staging_2');
  });

  it('falls back to cortextos1 when the marker is invalid', () => {
    writeFileSync(join(ctxHome, 'ACTIVE_INSTANCE'), 'Bad Id!\n');
    const { status, stdout } = runScript(['--home', ctxHome, '--dest', dest]);
    expect(status).toBe(0);
    expect(stdout).toContain('instance=cortextos1');
  });

  it('--instance wins over the marker', () => {
    mkdirSync(join(ctxHome, 'other_inst', 'state'), { recursive: true });
    writeFileSync(join(ctxHome, 'other_inst', 'state', 'x.json'), '{}\n');
    writeFileSync(join(ctxHome, 'ACTIVE_INSTANCE'), 'cortextos1\n');

    const { status, stdout } = runScript([
      '--instance', 'other_inst', '--home', ctxHome, '--dest', dest,
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('instance=other_inst');
  });

  it('fails loudly (exit 1) when the instance dir does not exist', () => {
    const { status, stderr } = runScript([
      '--instance', 'missing_inst', '--home', ctxHome, '--dest', dest,
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain('Instance dir not found');
  });

  it('rejects an invalid --instance id (exit 2), before touching anything', () => {
    const { status, stderr } = runScript([
      '--instance', 'Bad Id!', '--home', ctxHome, '--dest', dest,
    ]);
    expect(status).toBe(2);
    expect(stderr).toContain('Invalid instance id');
    expect(existsSync(dest)).toBe(false);
  });

  it('source fixture stat mtimes are untouched by --run (no writes inside home)', () => {
    const file = join(ctxHome, 'cortextos1', 'config', 'crons.json');
    const mtimeBefore = statSync(file).mtimeMs;
    const { status } = runScript(['--home', ctxHome, '--dest', dest, '--run']);
    expect(status).toBe(0);
    expect(statSync(file).mtimeMs).toBe(mtimeBefore);
  });
});
