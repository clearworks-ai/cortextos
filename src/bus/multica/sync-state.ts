import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { atomicWriteSync, ensureDir } from '../../utils/atomic.js';
import { withFileLockSync } from '../../utils/lock.js';
import type {
  MulticaIssueStatus,
  SyncLink,
  SyncState,
  SyncStateLoadResult,
  SyncStateStore,
} from './types.js';

export function createSyncStateStore(filePath = defaultSyncStateFilePath()): SyncStateStore {
  return {
    load(): SyncState {
      return this.loadWithStatus().state;
    },

    loadWithStatus(): SyncStateLoadResult {
      if (!existsSync(filePath)) {
        return { state: emptyState(), corrupt: false };
      }

      const primary = readStateFile(filePath, 'sync-state.json');
      if (primary !== null) {
        return { state: primary, corrupt: false };
      }

      const bakPath = `${filePath}.bak`;
      if (existsSync(bakPath)) {
        process.stderr.write('[multica-sync] WARNING: falling back to sync-state.json.bak\n');
        const backup = readStateFile(bakPath, 'sync-state.json.bak');
        if (backup !== null) {
          return { state: backup, corrupt: false };
        }
      }

      return { state: emptyState(), corrupt: true };
    },

    save(state: SyncState): void {
      state.updated_at = new Date().toISOString();
      atomicWriteSync(filePath, JSON.stringify(state, null, 2), true);
    },

    linkFor(taskId: string): SyncLink | undefined {
      return this.load().links[taskId];
    },

    upsertLink(taskId: string, patch: Partial<SyncLink>): void {
      const lockDir = lockDirFor(filePath);
      withFileLockSync(lockDir, () => {
        const state = this.load();
        const current = state.links[taskId] ?? emptyLink();
        state.links[taskId] = {
          ...current,
          ...patch,
        };
        this.save(state);
      });
    },
  };
}

function defaultSyncStateFilePath(): string {
  return join(
    process.env.CTX_ROOT ?? process.cwd(),
    'orgs',
    'clearworksai',
    'state',
    'multica-bridge',
    'sync-state.json',
  );
}

function lockDirFor(filePath: string): string {
  const dir = dirname(filePath);
  ensureDir(dir);
  return dir;
}

function emptyState(now = new Date().toISOString()): SyncState {
  return {
    schema_version: '1',
    updated_at: now,
    links: {},
  };
}

function emptyLink(): SyncLink {
  return {
    multica_issue_id: null,
    last_pushed_status: null,
    last_pushed_hash: null,
    last_seen_multica_status: null,
    last_seen_multica_assignee_id: null,
    idempotency_key: null,
  };
}

function readStateFile(filePath: string, label: string): SyncState | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (isSyncState(parsed)) {
      return parsed;
    }
    process.stderr.write(`[multica-sync] WARNING: invalid ${label} shape at "${filePath}"\n`);
  } catch (error) {
    process.stderr.write(
      `[multica-sync] WARNING: failed to read ${label} at "${filePath}" — ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  return null;
}

function isSyncState(value: unknown): value is SyncState {
  if (!isRecord(value)) {
    return false;
  }
  if (value.schema_version !== '1' || typeof value.updated_at !== 'string' || !isRecord(value.links)) {
    return false;
  }

  return Object.values(value.links).every(isSyncLink);
}

function isSyncLink(value: unknown): value is SyncLink {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNullableString(value.multica_issue_id) &&
    isNullableString(value.last_pushed_status) &&
    isNullableString(value.last_pushed_hash) &&
    isNullableString(value.last_seen_multica_status) &&
    isNullableString(value.last_seen_multica_assignee_id) &&
    isNullableString(value.idempotency_key) &&
    isNullableTaskStatus(value.last_pushed_status) &&
    isNullableMulticaStatus(value.last_seen_multica_status)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableTaskStatus(value: unknown): boolean {
  return (
    value === null ||
    value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'blocked' ||
    value === 'cancelled' ||
    value === 'waiting' ||
    value === 'someday'
  );
}

function isNullableMulticaStatus(value: unknown): value is MulticaIssueStatus | null {
  return (
    value === null ||
    value === 'backlog' ||
    value === 'todo' ||
    value === 'in_progress' ||
    value === 'in_review' ||
    value === 'done' ||
    value === 'blocked' ||
    value === 'cancelled'
  );
}
