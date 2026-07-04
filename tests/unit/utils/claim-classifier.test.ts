import { describe, expect, it } from 'vitest';
import { classifyClaim } from '../../../src/utils/claim-classifier.js';

// ---------------------------------------------------------------------------
// Claim classifier tests — verifies class assignment and rung mapping
// ---------------------------------------------------------------------------

describe('classifyClaim — external-send (block rung)', () => {
  it('"sent to the client" → external-send/block', () => {
    const r = classifyClaim('Sent to the client — they should have it now.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('external-send');
    expect(r!.rung).toBe('block');
  });

  it('"invoice sent" → external-send/block', () => {
    const r = classifyClaim('Invoice sent to Matt.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('external-send');
    expect(r!.rung).toBe('block');
  });

  it('"emailed the client" → external-send/block', () => {
    const r = classifyClaim('Emailed the client the proposal.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('external-send');
    expect(r!.rung).toBe('block');
  });

  it('"proposal sent" → external-send/block', () => {
    const r = classifyClaim('Proposal sent.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('external-send');
    expect(r!.rung).toBe('block');
  });

  it('"contract sent" → external-send/block', () => {
    const r = classifyClaim('Contract sent and done.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('external-send');
    expect(r!.rung).toBe('block');
  });
});

describe('classifyClaim — merge (require-confirm rung)', () => {
  it('"merged to main" → merge/require-confirm', () => {
    const r = classifyClaim('PR merged to main — build is green.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('merge');
    expect(r!.rung).toBe('require-confirm');
  });

  it('"merged to production" → merge/require-confirm', () => {
    const r = classifyClaim('Feature branch merged to production.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('merge');
    expect(r!.rung).toBe('require-confirm');
  });

  it('"PR was merged" → merge/require-confirm', () => {
    const r = classifyClaim('PR was merged and the pipeline passed.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('merge');
    expect(r!.rung).toBe('require-confirm');
  });
});

describe('classifyClaim — deploy (require-confirm rung)', () => {
  it('"deployed to production" → deploy/require-confirm', () => {
    const r = classifyClaim('Deployed to production — Railway shows green.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('deploy');
    expect(r!.rung).toBe('require-confirm');
  });

  it('"pushed to prod" → deploy/require-confirm', () => {
    const r = classifyClaim('Pushed to prod and it is live.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('deploy');
    expect(r!.rung).toBe('require-confirm');
  });

  it('"deployed" alone → deploy/require-confirm', () => {
    const r = classifyClaim('Deployed and verified.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('deploy');
    expect(r!.rung).toBe('require-confirm');
  });
});

describe('classifyClaim — generic (warn rung)', () => {
  it('"Done." → generic/warn', () => {
    const r = classifyClaim('Done.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('generic');
    expect(r!.rung).toBe('warn');
  });

  it('"it works now" → generic/warn', () => {
    const r = classifyClaim('It works now — tested locally.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('generic');
    expect(r!.rung).toBe('warn');
  });

  it('"all set" → generic/warn', () => {
    const r = classifyClaim('All set, good to go.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('generic');
    expect(r!.rung).toBe('warn');
  });

  it('"fixed" → generic/warn', () => {
    const r = classifyClaim('Fixed the bug you flagged.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('generic');
    expect(r!.rung).toBe('warn');
  });
});

describe('classifyClaim — null (no claim)', () => {
  it('"about to deploy" → null (negated high-stakes)', () => {
    expect(classifyClaim('About to deploy — will let you know.')).toBeNull();
  });

  it('"not yet merged" → null', () => {
    expect(classifyClaim('Not yet merged — still waiting on review.')).toBeNull();
  });

  it('"should I email the client?" → null', () => {
    // question form — detectsCompletionClaim returns false (trailing ?)
    expect(classifyClaim('Should I email the client?')).toBeNull();
  });

  it('"working on the deploy" → null', () => {
    expect(classifyClaim('Working on the deploy now.')).toBeNull();
  });

  it('"going to deploy later" → null', () => {
    expect(classifyClaim('Going to deploy later today.')).toBeNull();
  });

  it('empty string → null', () => {
    expect(classifyClaim('')).toBeNull();
  });

  it('non-claim sentence → null', () => {
    expect(classifyClaim('Here is an update on the project progress.')).toBeNull();
  });

  it('"haven\'t merged yet" → null', () => {
    expect(classifyClaim("Haven't merged the branch yet.")).toBeNull();
  });
});

describe('classifyClaim — precedence: external-send beats merge/deploy', () => {
  it('message with both "merged" and "sent to client" → external-send/block', () => {
    const r = classifyClaim('Merged the branch and sent to the client.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('external-send');
    expect(r!.rung).toBe('block');
  });

  it('message with "deployed" and "sent to client" → external-send/block', () => {
    const r = classifyClaim('Deployed and sent to client.');
    expect(r).not.toBeNull();
    expect(r!.cls).toBe('external-send');
    expect(r!.rung).toBe('block');
  });
});
