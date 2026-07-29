import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSyncStateStore } from '../../../../src/bus/multica/sync-state.js';
import type { SyncState } from '../../../../src/bus/multica/types.js';

describe('multica sync state store', () => {
  let testDir: string;
  let filePath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'multica-sync-state-'));
    filePath = join(testDir, 'sync-state.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_ROOT;
  });

  it('saves and loads state without losing link data', () => {
    const store = createSyncStateStore(filePath);
    const state: SyncState = {
      schema_version: '1',
      updated_at: '2026-07-29T07:00:00Z',
      links: {
        'task-1': {
          multica_issue_id: 'issue-1',
          last_pushed_status: 'pending',
          last_pushed_hash: 'hash-1',
          last_seen_multica_status: 'todo',
          last_seen_multica_assignee_id: 'member-1',
          idempotency_key: 'key-1',
        },
      },
    };

    store.save(state);
    const loaded = store.load();

    expect(loaded.schema_version).toBe('1');
    expect(loaded.links).toEqual(state.links);
    expect(typeof loaded.updated_at).toBe('string');
    expect(readFileSync(filePath, 'utf-8')).toContain('"schema_version": "1"');
  });

  it('upsertLink merges patch fields without dropping existing values', () => {
    const store = createSyncStateStore(filePath);
    store.save({
      schema_version: '1',
      updated_at: '2026-07-29T07:00:00Z',
      links: {
        'task-1': {
          multica_issue_id: 'issue-1',
          last_pushed_status: 'pending',
          last_pushed_hash: 'hash-1',
          last_seen_multica_status: 'todo',
          last_seen_multica_assignee_id: 'member-1',
          idempotency_key: 'key-1',
        },
      },
    });

    store.upsertLink('task-1', {
      last_pushed_hash: 'hash-2',
    });

    expect(store.linkFor('task-1')).toEqual({
      multica_issue_id: 'issue-1',
      last_pushed_status: 'pending',
      last_pushed_hash: 'hash-2',
      last_seen_multica_status: 'todo',
      last_seen_multica_assignee_id: 'member-1',
      idempotency_key: 'key-1',
    });
  });

  it('returns undefined when a task has no sync link', () => {
    const store = createSyncStateStore(filePath);
    expect(store.linkFor('missing-task')).toBeUndefined();
  });

  it('treats a missing file as an empty non-corrupt state', () => {
    const store = createSyncStateStore(filePath);
    const result = store.loadWithStatus();

    expect(result.corrupt).toBe(false);
    expect(result.state.links).toEqual({});
    expect(result.state.schema_version).toBe('1');
  });

  it('falls back to the .bak file when the primary file is corrupt', () => {
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const store = createSyncStateStore(filePath);

    store.save({
      schema_version: '1',
      updated_at: '2026-07-29T07:00:00Z',
      links: {
        'task-a': {
          multica_issue_id: 'issue-a',
          last_pushed_status: 'pending',
          last_pushed_hash: 'hash-a',
          last_seen_multica_status: 'todo',
          last_seen_multica_assignee_id: 'member-a',
          idempotency_key: 'key-a',
        },
      },
    });

    store.save({
      schema_version: '1',
      updated_at: '2026-07-29T08:00:00Z',
      links: {
        'task-b': {
          multica_issue_id: 'issue-b',
          last_pushed_status: 'completed',
          last_pushed_hash: 'hash-b',
          last_seen_multica_status: 'done',
          last_seen_multica_assignee_id: 'member-b',
          idempotency_key: 'key-b',
        },
      },
    });

    writeFileSync(filePath, '{not json');

    const result = store.loadWithStatus();

    expect(result.corrupt).toBe(false);
    expect(result.state.links).toHaveProperty('task-a');
    expect(result.state.links).not.toHaveProperty('task-b');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('degrades to an empty corrupt state when both primary and backup are unusable', () => {
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const store = createSyncStateStore(filePath);

    writeFileSync(filePath, '{broken json');

    const result = store.loadWithStatus();

    expect(result.corrupt).toBe(true);
    expect(result.state.links).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it('uses the default clearworksai ledger path when CTX_ROOT is set', () => {
    process.env.CTX_ROOT = testDir;
    const store = createSyncStateStore();

    store.save({
      schema_version: '1',
      updated_at: '2026-07-29T07:00:00Z',
      links: {},
    });

    const defaultPath = join(testDir, 'orgs', 'clearworksai', 'state', 'multica-bridge', 'sync-state.json');
    expect(existsSync(defaultPath)).toBe(true);
  });
});
