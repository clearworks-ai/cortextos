import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const repoRoot = process.cwd();
const mmragPath = join(repoRoot, 'knowledge-base', 'scripts', 'mmrag.py');

function buildEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

describe('mmrag.py MMRAG_DIR guard', () => {
  it('exits non-zero with an actionable message when MMRAG_DIR is unset', () => {
    const result = spawnSync('python3', [mmragPath, '--help'], {
      encoding: 'utf-8',
      env: buildEnv({
        MMRAG_DIR: undefined,
        MMRAG_CONFIG: undefined,
        MMRAG_CHROMADB_DIR: undefined,
      }),
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('MMRAG_DIR is not set');
    expect(result.stderr).toContain("cortextos bus kb-query '<question>' --org <org>");
  });

  it('runs normally when MMRAG_DIR is explicitly set', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mmrag-dir-guard-'));
    const result = spawnSync('python3', [mmragPath, '--help'], {
      encoding: 'utf-8',
      env: buildEnv({
        MMRAG_DIR: tempDir,
        MMRAG_CONFIG: undefined,
        MMRAG_CHROMADB_DIR: undefined,
      }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Query the knowledge base');
    expect(result.stderr).toBe('');
  });
});

describe('mmrag.py native hold CLI', () => {
  it('exclusive hold refuses query with exit 3 and STORE_QUARANTINED JSON', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mmrag-native-hold-'));
    writeFileSync(join(tempDir, 'NATIVE_HOLD'), '{"mode":"exclusive"}\n');
    const result = spawnSync('python3', [mmragPath, 'query', 'hello', '--json'], {
      encoding: 'utf-8',
      env: buildEnv({
        MMRAG_DIR: tempDir,
        MMRAG_CHROMADB_DIR: join(tempDir, 'chromadb'),
        MMRAG_CONFIG: undefined,
        MMRAG_SIDE_CHROMADB_DIR: undefined,
      }),
    });

    expect(result.status).toBe(3);
    const payload = JSON.parse(result.stdout.trim().split('\n')[0]);
    expect(payload.result).toBe('STORE_QUARANTINED');
    expect(payload.hold_mode).toBe('exclusive');
    expect(payload.operation).toBe('query');
  });
});
