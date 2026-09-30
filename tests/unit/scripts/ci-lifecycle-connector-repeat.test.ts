import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/** Reviewed 100x set from the 2026-09-28 catch-up plan. Not exhaustive. */
const REVIEWED_MANIFEST = [
  'tests/unit/daemon/agent-manager-map-entry-race.test.ts',
  'tests/unit/daemon/agent-manager-eviction-race-round4.test.ts',
  'tests/unit/daemon/agent-process-hermes.test.ts',
  'tests/unit/pty/pty-host-dispose.test.ts',
  'tests/unit/connectors',
] as const;

describe('ci-lifecycle-connector-repeat manifest', () => {
  const scriptPath = join(__dirname, '../../../scripts/ci-lifecycle-connector-repeat.sh');
  const src = readFileSync(scriptPath, 'utf8');
  const block = src.match(/files=\(\n([\s\S]*?)\n\)/);
  const files = (block?.[1] ?? '').trim().split(/\s+/).filter(Boolean);

  it('pins the reviewed race-sensitive 100x file list', () => {
    expect(files).toEqual([...REVIEWED_MANIFEST]);
  });

  it('every manifest path exists in this tree', () => {
    const root = join(__dirname, '../../..');
    for (const file of REVIEWED_MANIFEST) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });
});
