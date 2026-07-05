import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync } from 'fs';
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
