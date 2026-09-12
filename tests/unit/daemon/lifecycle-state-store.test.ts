import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import type { BusPaths } from '../../../src/types/index';
import type { LifecycleSnapshot } from '../../../src/daemon/lifecycle/types';
import { acquireStoreLock, releaseStoreLock } from '../../../src/daemon/lifecycle/store-lock';
import { LifecycleStateStore, admitDaemonWriter } from '../../../src/daemon/lifecycle/state-store';

function fakeBusPaths(ctxRoot: string, agentName: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(ctxRoot, 'orgs', 'x', 'tasks'),
    approvalDir: join(ctxRoot, 'orgs', 'x', 'approvals'),
    analyticsDir: join(ctxRoot, 'orgs', 'x', 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', 'x', 'deliverables'),
  };
}

describe('LifecycleStateStore', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-state-store-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function recordPath(paths: BusPaths): string {
    return join(paths.stateDir, 'lifecycle', 'supervisor.json');
  }

  it('load() reports not-yet-adopted before any record exists', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');
    const loaded = store.load();
    expect('corrupt' in loaded && loaded.corrupt).toBe(true);
    expect((loaded as { reason: string }).reason).toBe('not-yet-adopted');
  });

  it('adopt() creates the first record with the explicit initial desired state', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');

    const result = store.adopt('running', { desiredStateReason: 'onboarded', desiredStateRequestId: 'req-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.agentId).toBe('default/clearworks/knox');
    expect(result.snapshot.desiredState).toBe('running');
    expect(result.snapshot.desiredStateReason).toBe('onboarded');
    expect(result.snapshot.desiredStateRequestId).toBe('req-1');
    expect(result.snapshot.revision).toBe(1);

    const loaded = store.load();
    expect('corrupt' in loaded).toBe(false);
    expect((loaded as LifecycleSnapshot).desiredState).toBe('running');
  });

  it('adopt() blocks when a valid record already exists (conflicting legacy evidence)', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');

    const first = store.adopt('running');
    expect(first.ok).toBe(true);

    const second = store.adopt('stopped');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('STALE_REVISION');

    // Original record must be untouched.
    const loaded = store.load();
    expect('corrupt' in loaded).toBe(false);
    expect((loaded as LifecycleSnapshot).desiredState).toBe('running');
  });

  it('happy-path commit bumps revision; a second commit with stale expectation returns STALE_REVISION', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');
    store.adopt('running');

    const first = store.commit({ supervisorEpoch: 0, revision: 1 }, (draft) => {
      draft.phase = 'starting';
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.snapshot.revision).toBe(2);
    expect(first.snapshot.phase).toBe('starting');

    // Stale: still claims revision 1, but disk is now at revision 2.
    const stale = store.commit({ supervisorEpoch: 0, revision: 1 }, (draft) => {
      draft.phase = 'ready';
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe('STALE_REVISION');
  });

  it('commit() with a mismatched supervisorEpoch returns EPOCH_MISMATCH', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');
    store.adopt('running');

    const result = store.commit({ supervisorEpoch: 99, revision: 1 }, (draft) => {
      draft.phase = 'starting';
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('EPOCH_MISMATCH');
  });

  it('concurrent committers: exactly one wins, the loser gets STALE_REVISION', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const storeA = new LifecycleStateStore(paths, 'default/clearworks/knox');
    const storeB = new LifecycleStateStore(paths, 'default/clearworks/knox');
    storeA.adopt('running');

    const resultA = storeA.commit({ supervisorEpoch: 0, revision: 1 }, (draft) => {
      draft.phase = 'starting';
    });
    const resultB = storeB.commit({ supervisorEpoch: 0, revision: 1 }, (draft) => {
      draft.phase = 'ready';
    });

    const outcomes = [resultA.ok, resultB.ok];
    expect(outcomes.filter((ok) => ok === true)).toHaveLength(1);
    const loser = resultA.ok ? resultB : resultA;
    expect(loser.ok).toBe(false);
    if (loser.ok) return;
    expect(['STALE_REVISION', 'LOCK_UNAVAILABLE']).toContain(loser.code);
  });

  it('commit() returns LOCK_UNAVAILABLE when the store lock is already held externally', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');
    store.adopt('running');

    const lockRoot = join(paths.stateDir, 'lifecycle');
    const handle = acquireStoreLock(lockRoot, 'external-holder');
    expect(handle).not.toBeNull();

    try {
      const result = store.commit({ supervisorEpoch: 0, revision: 1 }, (draft) => {
        draft.phase = 'starting';
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('LOCK_UNAVAILABLE');
    } finally {
      releaseStoreLock(handle!);
    }
  });

  it('truncated JSON on disk is corrupt, owner blocked', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');
    mkdirSync(join(paths.stateDir, 'lifecycle'), { recursive: true });
    writeFileSync(recordPath(paths), '{ "agentId": "default/clearworks/knox", "revisi');

    const loaded = store.load();
    expect('corrupt' in loaded && loaded.corrupt).toBe(true);
    expect((loaded as { reason: string }).reason).toBe('json-parse-failed');

    const commitResult = store.commit({ supervisorEpoch: 0, revision: 1 }, () => {});
    expect(commitResult.ok).toBe(false);
    if (commitResult.ok) return;
    expect(commitResult.code).toBe('CORRUPT');
  });

  it('wrong schema version on disk is corrupt, owner blocked', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');
    store.adopt('running');

    const raw = JSON.parse(readFileSync(recordPath(paths), 'utf-8'));
    raw.schemaVersion = 999;
    writeFileSync(recordPath(paths), JSON.stringify(raw));

    const loaded = store.load();
    expect('corrupt' in loaded && loaded.corrupt).toBe(true);
    expect((loaded as { reason: string }).reason).toMatch(/schema-version-mismatch/);
  });

  it('non-object root on disk is corrupt, owner blocked', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');
    mkdirSync(join(paths.stateDir, 'lifecycle'), { recursive: true });
    writeFileSync(recordPath(paths), JSON.stringify('just a string'));

    const loaded = store.load();
    expect('corrupt' in loaded && loaded.corrupt).toBe(true);
    expect((loaded as { reason: string }).reason).toBe('non-object-root');
  });

  it('simulated persist failure returns PERSIST_FAILED and leaves prior state unchanged on subsequent load()', async () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const store = new LifecycleStateStore(paths, 'default/clearworks/knox');
    store.adopt('running');

    // Mock the durable-write primitive itself (rather than restrict
    // filesystem permissions) because the lock-acquire path used by
    // `commit()` also needs to create/rename directories inside the same
    // `lifecycle/` root, so a permission-based simulation would break lock
    // acquisition before the persist step under test is ever reached.
    const atomicModule = await import('../../../src/utils/atomic');
    const spy = vi.spyOn(atomicModule, 'atomicWriteDurableSync').mockImplementation(() => {
      throw new Error('simulated disk failure');
    });

    try {
      const result = store.commit({ supervisorEpoch: 0, revision: 1 }, (draft) => {
        draft.phase = 'starting';
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('PERSIST_FAILED');
    } finally {
      spy.mockRestore();
    }

    const loaded = store.load();
    expect('corrupt' in loaded).toBe(false);
    const snapshot = loaded as LifecycleSnapshot;
    expect(snapshot.revision).toBe(1);
    expect(snapshot.phase).toBe('absent');
  });

  it('two agents with the same name in different orgs (same stateDir) do not coalesce', () => {
    const paths = fakeBusPaths(ctxRoot, 'knox');
    const storeAcme = new LifecycleStateStore(paths, 'default/acme/knox');
    const storeBeta = new LifecycleStateStore(paths, 'default/beta/knox');

    const adoptResult = storeAcme.adopt('running');
    expect(adoptResult.ok).toBe(true);

    // storeBeta resolves to the identical record path (stateDir is derived
    // from agentName alone) but was constructed with a different agentId.
    const loadedByBeta = storeBeta.load();
    expect('corrupt' in loadedByBeta && loadedByBeta.corrupt).toBe(true);
    expect((loadedByBeta as { reason: string }).reason).toBe('agent-identity-mismatch');

    // Beta must not be able to silently overwrite Acme's record via adopt().
    const betaAdopt = storeBeta.adopt('stopped');
    expect(betaAdopt.ok).toBe(false);
    if (betaAdopt.ok) return;
    expect(betaAdopt.code).toBe('CORRUPT');

    // Beta must not be able to commit against it either.
    const betaCommit = storeBeta.commit({ supervisorEpoch: 0, revision: 1 }, () => {});
    expect(betaCommit.ok).toBe(false);
    if (betaCommit.ok) return;
    expect(betaCommit.code).toBe('CORRUPT');

    // Acme's record is untouched.
    const loadedByAcme = storeAcme.load();
    expect('corrupt' in loadedByAcme).toBe(false);
    expect((loadedByAcme as LifecycleSnapshot).agentId).toBe('default/acme/knox');
  });
});

describe('admitDaemonWriter', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-lifecycle-daemon-election-test-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('first-ever admission writes epoch 1', () => {
    const result = admitDaemonWriter(ctxRoot, 'daemon-uuid-a');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.epoch).toBe(1);

    const raw = JSON.parse(readFileSync(join(ctxRoot, 'lifecycle-daemon.json'), 'utf-8'));
    expect(raw.daemonUuid).toBe('daemon-uuid-a');
    expect(raw.epoch).toBe(1);
  });

  it('rejects takeover when the previous daemon PID is live (no timeout-based theft)', () => {
    const first = admitDaemonWriter(ctxRoot, 'daemon-uuid-a');
    expect(first.ok).toBe(true);

    // The recorded pid is this test process's own pid -- definitely alive.
    const raw = JSON.parse(readFileSync(join(ctxRoot, 'lifecycle-daemon.json'), 'utf-8'));
    expect(raw.pid).toBe(process.pid);

    const second = admitDaemonWriter(ctxRoot, 'daemon-uuid-b');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/alive/);

    // Epoch must not have advanced.
    const rawAfter = JSON.parse(readFileSync(join(ctxRoot, 'lifecycle-daemon.json'), 'utf-8'));
    expect(rawAfter.epoch).toBe(1);
    expect(rawAfter.daemonUuid).toBe('daemon-uuid-a');
  });

  it('rejects takeover on ambiguous liveness (EPERM), distinct from a live process', () => {
    admitDaemonWriter(ctxRoot, 'daemon-uuid-a');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const result = admitDaemonWriter(ctxRoot, 'daemon-uuid-b');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/ambiguous/);

    killSpy.mockRestore();
  });

  it('admits a new daemon and increments the epoch when the previous PID is definitively dead', () => {
    admitDaemonWriter(ctxRoot, 'daemon-uuid-a');

    // Guaranteed-dead PID: spawnSync blocks until the child exits.
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid;
    expect(typeof deadPid).toBe('number');

    const recordPath = join(ctxRoot, 'lifecycle-daemon.json');
    const raw = JSON.parse(readFileSync(recordPath, 'utf-8'));
    raw.pid = deadPid;
    writeFileSync(recordPath, JSON.stringify(raw));

    const result = admitDaemonWriter(ctxRoot, 'daemon-uuid-b');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.epoch).toBe(2);

    const rawAfter = JSON.parse(readFileSync(recordPath, 'utf-8'));
    expect(rawAfter.daemonUuid).toBe('daemon-uuid-b');
    expect(rawAfter.epoch).toBe(2);
  });

  it('refuses admission when the existing election record is corrupt', () => {
    mkdirSync(ctxRoot, { recursive: true });
    writeFileSync(join(ctxRoot, 'lifecycle-daemon.json'), '{ not valid json ::');

    const result = admitDaemonWriter(ctxRoot, 'daemon-uuid-b');
    expect(result.ok).toBe(false);
  });
});
