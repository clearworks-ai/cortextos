import { describe, it, expect, afterEach } from 'vitest';

// Change 3 added a `require.main === module` guard around main(), so importing
// this module does not run main(). isWorkerSession is a pure env predicate and
// is the only thing under test here.
import { isWorkerSession } from '../../../src/hooks/hook-permission-telegram';

describe('isWorkerSession', () => {
  const original = process.env.CTX_WORKER;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CTX_WORKER;
    } else {
      process.env.CTX_WORKER = original;
    }
  });

  it('returns true when CTX_WORKER is exactly "1"', () => {
    process.env.CTX_WORKER = '1';
    expect(isWorkerSession()).toBe(true);
  });

  it('returns false when CTX_WORKER is unset', () => {
    delete process.env.CTX_WORKER;
    expect(isWorkerSession()).toBe(false);
  });

  it('returns false when CTX_WORKER is "0"', () => {
    process.env.CTX_WORKER = '0';
    expect(isWorkerSession()).toBe(false);
  });

  it('returns false for any other value', () => {
    process.env.CTX_WORKER = 'true';
    expect(isWorkerSession()).toBe(false);
    process.env.CTX_WORKER = 'yes';
    expect(isWorkerSession()).toBe(false);
    process.env.CTX_WORKER = '';
    expect(isWorkerSession()).toBe(false);
  });
});
