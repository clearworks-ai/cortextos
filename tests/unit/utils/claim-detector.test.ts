import { describe, expect, it } from 'vitest';
import { detectsCompletionClaim } from '../../../src/utils/claim-detector.js';

describe('detectsCompletionClaim - positive (completion claims)', () => {
  const positives = [
    'Done.',
    'All done — the branch is merged.',
    'Shipped the fix.',
    "It's live now.",
    'The dashboard is live.',
    'Deployed to production.',
    'Fixed the crash.',
    'PR merged.',
    'Task completed successfully.',
    'It works now.',
    'Verified via curl 200.',
    'Build passing, tests passed.',
    'The service is up and running.',
    'All set, good to go.',
    'Taken care of.',
    'Resolved the ci-alert-gate flake.',
  ];

  for (const text of positives) {
    it(`fires on: ${text}`, () => {
      expect(detectsCompletionClaim(text)).toBe(true);
    });
  }
});

describe('detectsCompletionClaim - negative (non-claims)', () => {
  const negatives = [
    'Working on the deploy now.',
    'Trying to get it working.',
    'Going to ship this shortly.',
    'About to merge the PR.',
    'I will deploy after review.',
    'Not yet deployed.',
    'The build is not fixed yet.',
    'Should I deploy this?',
    'Do you want me to merge?',
    'Can you send me the link?',
    'Is it deployed?',
    "I haven't verified this yet.",
    "I can't reproduce the bug.",
    'Still working on the fix.',
    'This needs to be fixed before we ship.',
    'What time is the meeting?',
    '',
    '   ',
  ];

  for (const text of negatives) {
    it(`does not fire on: ${JSON.stringify(text)}`, () => {
      expect(detectsCompletionClaim(text)).toBe(false);
    });
  }
});

describe('detectsCompletionClaim - word-boundary safety', () => {
  it('does not fire on substrings like "abandoned" or "prefixed"', () => {
    expect(detectsCompletionClaim('The project was abandoned.')).toBe(false);
    expect(detectsCompletionClaim('The route is prefixed with /api.')).toBe(false);
  });

  it('tolerates non-string / nullish input', () => {
    // @ts-expect-error runtime guard test
    expect(detectsCompletionClaim(undefined)).toBe(false);
    // @ts-expect-error runtime guard test
    expect(detectsCompletionClaim(null)).toBe(false);
  });
});
