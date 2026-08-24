import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

describe('meeting-intelligence contract foundation', () => {
  it('validates the producer contract with real Draft 2020-12 semantics', () => {
    const stdout = execFileSync(
      process.execPath,
      ['scripts/validate-meeting-intelligence-draft-2020-12.mjs'],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const result = JSON.parse(stdout);

    expect(result).toMatchObject({
      draft: '2020-12',
      schemasCompiled: 23,
      negativeCasesRejected: 53,
      producerVersion: 'meeting-intelligence-v1',
      nMinus1: true,
      promotionAuthority: false,
    });
  });

  it('proves the Briefs consumer is byte-equal to the producer authority', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        'scripts/verify-meeting-intelligence-cross-repo.mjs',
        '/Users/joshweiss/code/briefs-worktrees/meeting-intelligence-s0-20260824',
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const result = JSON.parse(stdout);

    expect(result).toMatchObject({
      direction: 'cortextos-to-briefs',
      contractsEqual: 61,
      productArtifactsEqual: 10,
      promotionAuthority: false,
    });
  });
});
