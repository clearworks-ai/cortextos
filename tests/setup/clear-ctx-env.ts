// Neutralize live-agent-shell env leakage so tests never inherit CTX_* paths
// that trip the sandbox/live isolation guard in src/utils/env.ts. Then pin a
// unique temp CTX_ROOT so crons I/O and dashboard sqlite cannot fall back to
// process.cwd() (tracked .cortextOS fixtures / repo-root .data).
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

for (const k of ['CTX_AGENT_DIR', 'CTX_PROJECT_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_ROOT', 'CTX_INSTANCE_ID']) {
  delete process.env[k];
}

function runTmpParent(): string {
  try {
    // Bound to this vitest process via globalSetup provide; fallback is os.tmpdir().
    const { inject } = require('vitest') as { inject: (key: string) => string | undefined };
    const injected = inject('cortextosVitestRunTmp');
    if (injected) return injected;
  } catch {
    /* inject unavailable in some isolated loaders */
  }
  return process.env.CORTEXTOS_VITEST_RUN_TMP || tmpdir();
}

const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? String(process.pid);
process.env.CTX_ROOT = mkdtempSync(join(runTmpParent(), `w${worker}-`));
process.env.CTX_INSTANCE_ID = 'vitest';
