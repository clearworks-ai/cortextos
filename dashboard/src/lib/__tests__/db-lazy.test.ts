import { afterEach, describe, expect, it, vi } from 'vitest';

describe('db lazy initialization', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as { __cortextos_db?: unknown }).__cortextos_db;
  });

  it('does not construct the database on import', async () => {
    const databaseCtor = vi.fn(() => ({
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn(),
    }));

    vi.doMock('better-sqlite3', () => ({
      default: databaseCtor,
    }));

    await import('../db');

    expect(databaseCtor).not.toHaveBeenCalled();
  });
});
