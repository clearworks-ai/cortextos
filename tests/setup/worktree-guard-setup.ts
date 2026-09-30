import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function trackedCronDrift(): string {
  try {
    return execSync(
      'git diff --name-only -- .cortextOS && git diff --name-only --cached -- .cortextOS',
      { encoding: 'utf-8' },
    ).trim();
  } catch {
    return '';
  }
}

/** Unique per process; never a fixed /tmp path (parallel worktrees would collide). */
export default function globalSetup(ctx?: {
  provide?: (key: string, value: string) => void;
}): () => void {
  const runTmp = mkdtempSync(join(tmpdir(), `cortextos-vitest-run-${process.pid}-`));
  ctx?.provide?.('cortextosVitestRunTmp', runTmp);
  process.env.CORTEXTOS_VITEST_RUN_TMP = runTmp;

  const fingerprintPath = join(runTmp, 'fingerprint.txt');
  const porcelain = execSync('git status --porcelain --untracked-files=normal', {
    encoding: 'utf-8',
  });
  writeFileSync(fingerprintPath, porcelain);

  return function globalTeardown(): void {
    try {
      const before = existsSync(fingerprintPath) ? readFileSync(fingerprintPath, 'utf-8') : '';
      const after = execSync('git status --porcelain --untracked-files=normal', {
        encoding: 'utf-8',
      });
      const cronDrift = trackedCronDrift();
      const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
      const dataAtRoot = existsSync(join(repoRoot, '.data'));

      const failures: string[] = [];
      if (before !== after) {
        failures.push(
          `git status --porcelain changed by tests\n--- before ---\n${before || '(empty)'}\n--- after ---\n${after || '(empty)'}`,
        );
      }
      if (cronDrift) {
        failures.push(`tracked .cortextOS mutated:\n${cronDrift}`);
      }
      if (dataAtRoot) {
        failures.push('repo-root .data exists after tests (dashboard sqlite cwd fallback)');
      }
      if (failures.length) {
        throw new Error(`test isolation gate failed:\n${failures.join('\n\n')}`);
      }
    } finally {
      // Own temp root only. Never git restore — drift must fail, not look clean.
      rmSync(runTmp, { recursive: true, force: true });
    }
  };
}
