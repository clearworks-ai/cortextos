import { homedir } from 'os';
import { join, sep } from 'path';
import type { AgentProcess } from '../agent-process.js';
import type { AgentConfig, CtxEnv } from '../../types/index.js';
import type { RuntimeAdapter } from './supervisor.js';
import type { LifecycleStateStore } from './state-store.js';
import { getProcessBirthEvidence } from './state-store.js';
import type {
  DispatchResult,
  EffectToken,
  GenerationToken,
  OwnedResource,
  ResourceKind,
  RetirementResult,
  StartMode,
} from './types.js';

/**
 * Task 2.1: `AgentProcessRuntimeAdapter implements RuntimeAdapter` (the
 * interface Task 1.5 defined in `./supervisor.ts`).
 *
 * This is the ONLY production caller of `AgentProcess.startImplFenced()` /
 * `AgentProcess.runStopFenced()` — the fenced low-level entry points added in
 * this task. It does not import `AgentManager` or `FastChecker` (would create
 * an upward/circular dependency); `AgentManager` wires one adapter per agent
 * into its `AgentLifecycleSupervisor` in Task 2.5.
 *
 * NOT wired into any live call path yet — `AgentProcess.start()`/`.stop()`/
 * `.sessionRefresh()` remain the production entry points until Tasks 2.4/2.5
 * rewire them to submit requests through the supervisor instead.
 */
export class AgentProcessRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly process: AgentProcess,
    private readonly store: LifecycleStateStore,
    private readonly runtimeKind: AgentConfig['runtime'],
    private readonly env: CtxEnv,
  ) {}

  /**
   * Step 1 (reservation before spawn): mint resource IDs for every kind this
   * generation might acquire and persist them as `state: 'reserved'` via a
   * store commit BEFORE calling the real spawn path. If the spawn fails, the
   * reservation is left exactly as committed here — never promoted to
   * 'acquired', never deleted — so a subsequent successful attempt for the
   * SAME generation is distinguishable from a phantom acquired resource.
   *
   * The returned `OwnedResource[]` (on success) are always tagged with the
   * `GenerationToken` derived from THIS call's `effect` argument — never
   * re-derived from whatever the store's live `currentGeneration` happens to
   * be by the time this promise resolves. This is what makes a spawn that
   * completes after the effect's own intent was superseded still resolve to
   * the OUTGOING generation's resources (Step 4) rather than silently losing
   * them: the supervisor (Task 1.5, already built) is the one that decides
   * whether to promote a result to "current" or retire it as stale — this
   * adapter's only job is to never mislabel which generation actually owns
   * what it captured.
   */
  async startGeneration(
    effect: EffectToken,
    _mode: StartMode,
  ): Promise<{ ok: boolean; resources: OwnedResource[]; error?: string }> {
    const owner: GenerationToken = {
      agentId: effect.agentId,
      supervisorEpoch: effect.supervisorEpoch,
      generation: effect.generation,
    };

    const reserved = mintReservedBundle(owner);
    const reservation = this.persistReservation(effect, reserved);
    if (!reservation.ok) {
      return { ok: false, resources: [], error: `reservation persist failed: ${reservation.error}` };
    }

    try {
      await this.process.startImplFenced();
    } catch (err) {
      // startImpl() is documented to swallow its own spawn errors internally
      // (sets status='crashed', never rejects) — this catch is defensive only,
      // in case a future change to startImpl regresses that contract.
      return { ok: false, resources: [], error: err instanceof Error ? err.message : String(err) };
    }

    const status = this.process.getStatus();
    if (status.status !== 'running') {
      // Reservation stays exactly as committed above — 'reserved', not
      // touched again — per the acceptance criterion.
      return { ok: false, resources: [], error: `spawn did not reach running (status: ${status.status})` };
    }

    return { ok: true, resources: this.buildAcquiredBundle(owner) };
  }

  /**
   * Step 2 wiring: reachable only through this adapter. Task 2.6 upgrades
   * this to interpret `runStop()`'s actual descendant-sweep outcome into a
   * real `'blocked'`/`unresolved` result — this task only makes the teardown
   * reachable and returns the resources it was handed as `'retired'`, since
   * `runStop()` itself still returns `void` and gives no structured signal
   * yet to distinguish "confirmed gone" from "signalled, unconfirmed".
   */
  async retireGeneration(_token: GenerationToken, resources: OwnedResource[]): Promise<RetirementResult> {
    await this.process.runStopFenced();
    return { status: 'retired', released: resources };
  }

  /**
   * Not this task's focus (Phase 3 owns real work-record correlation) — a
   * direct, honest mapping onto `injectMessageDetailed()`'s existing
   * structured result so the `RuntimeAdapter` contract is fully implemented.
   */
  async deliver(effect: EffectToken, payload: string, workIds: string[]): Promise<DispatchResult> {
    const result = this.process.injectMessageDetailed(payload);
    if (result.ok) {
      return { ok: true, workIds, batchId: effect.effectId };
    }
    if (result.code === 'NOT_RUNNING') {
      return { ok: false, code: 'NOT_RUNNING', retryable: true, message: result.message };
    }
    return { ok: false, code: 'DUPLICATE', retryable: false, existingWorkIds: workIds, message: result.message };
  }

  // --- Internal ------------------------------------------------------------

  /** Bounded compare-and-commit retry, local to this adapter (deliberately
   * not reusing `AgentLifecycleSupervisor`'s private `commitWithRetry` — that
   * method is private to Task 1.5's class; duplicating this small retry loop
   * here keeps the adapter free of any dependency on the supervisor's
   * internals, only on the store it's handed). */
  private persistReservation(
    effect: EffectToken,
    reserved: OwnedResource[],
  ): { ok: true } | { ok: false; error: string } {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const loaded = this.store.load();
      if ('corrupt' in loaded) {
        return { ok: false, error: `store unavailable: ${loaded.reason}` };
      }
      const result = this.store.commit(
        { supervisorEpoch: effect.supervisorEpoch, revision: loaded.revision },
        (draft) => {
          draft.resources = [...draft.resources, ...reserved];
        },
      );
      if (result.ok) return { ok: true };
      if (result.code === 'STALE_REVISION') continue;
      return { ok: false, error: `${result.code}: ${result.message}` };
    }
    return { ok: false, error: 'exhausted retry attempts on STALE_REVISION' };
  }

  /**
   * Step 3: build the final captured bundle after a successful spawn.
   *
   * `pty-host` and `socket` are OMITTED from the returned array (not
   * included as a null/placeholder entry) when not applicable — pty-host
   * when `getHostPid()`/`getPtyHostPid()` both return null, socket for any
   * runtime other than `codex-app-server` (its native IPC socket has no
   * analog on the other runtimes). `descendant` is always present but empty
   * (`'reserved'`) — it is only populated once `snapshotDescendants()` runs
   * during retirement (Task 2.6 territory). `checker`/`poller`/`scheduler`/
   * `dispatch`/`handoff-lease` stay honestly `'reserved'` placeholders —
   * Tasks 2.5/2.7/3.x are what actually own and populate them.
   */
  private buildAcquiredBundle(owner: GenerationToken): OwnedResource[] {
    const resources: OwnedResource[] = [
      {
        resourceId: resourceId(owner, 'runtime'),
        owner,
        kind: 'runtime',
        state: 'acquired',
        pid: null,
        processBirth: null,
        location: resourceId(owner, 'runtime'),
      },
    ];

    const hostPid = this.process.getHostPid() ?? this.process.getPtyHostPid();
    if (hostPid !== null) {
      resources.push({
        resourceId: resourceId(owner, 'pty-host'),
        owner,
        kind: 'pty-host',
        state: 'acquired',
        pid: hostPid,
        // Best-effort OS process-birth evidence, reusing the same
        // platform-conditional logic Task 1.4's daemon election uses
        // (`getProcessBirthEvidence`): a real kernel `starttime` on Linux,
        // `null` on macOS (no /proc filesystem equivalent — a documented
        // platform limitation, not an oversight). Never null out of laziness
        // on a platform where real evidence IS obtainable; and PID alone is
        // never, on any platform, treated as ownership proof by this adapter.
        processBirth: getProcessBirthEvidence(hostPid),
        location: null,
      });
    }

    resources.push({
      resourceId: resourceId(owner, 'descendant'),
      owner,
      kind: 'descendant',
      state: 'reserved',
      pid: null,
      processBirth: null,
      location: null,
    });

    resources.push({
      resourceId: resourceId(owner, 'session'),
      owner,
      kind: 'session',
      state: 'acquired',
      pid: null,
      processBirth: null,
      location: this.resolveSessionLocation(),
    });

    if (this.runtimeKind === 'codex-app-server') {
      resources.push({
        resourceId: resourceId(owner, 'socket'),
        owner,
        kind: 'socket',
        state: 'acquired',
        pid: null,
        processBirth: null,
        location: join(this.env.ctxRoot, 'state', this.process.name, 'codex-app-server-thread.json'),
      });
    }

    for (const kind of ['checker', 'poller', 'scheduler', 'dispatch', 'handoff-lease'] as const) {
      resources.push({
        resourceId: resourceId(owner, kind),
        owner,
        kind,
        state: 'reserved',
        pid: null,
        processBirth: null,
        location: null,
      });
    }

    return resources;
  }

  /**
   * Native session identity, resolved the same way `AgentProcess.shouldContinue()`
   * (L1155) branches on `this.config.runtime` — Claude's `.claude/projects/`
   * JSONL directory, Hermes's SQLite DB path, the Codex app-server thread
   * marker, or the OpenCode session marker.
   */
  private resolveSessionLocation(): string {
    const name = this.process.name;
    switch (this.runtimeKind) {
      case 'hermes':
        return join(process.env['HERMES_HOME'] || join(homedir(), '.hermes'), 'state.db');
      case 'codex-app-server':
        return join(this.env.ctxRoot, 'state', name, 'codex-app-server-thread.json');
      case 'opencode':
        return join(this.env.ctxRoot, 'state', name, 'opencode-session.json');
      default: {
        const launchDir = this.env.agentDir;
        return join(homedir(), '.claude', 'projects', launchDir.split(sep).join('-'));
      }
    }
  }
}

const ALL_RESOURCE_KINDS: ResourceKind[] = [
  'runtime',
  'pty-host',
  'descendant',
  'session',
  'socket',
  'checker',
  'poller',
  'scheduler',
  'dispatch',
  'handoff-lease',
];

function resourceId(owner: GenerationToken, kind: ResourceKind): string {
  return `${owner.agentId}#${kind}#${owner.generation}`;
}

function mintReservedBundle(owner: GenerationToken): OwnedResource[] {
  return ALL_RESOURCE_KINDS.map((kind) => ({
    resourceId: resourceId(owner, kind),
    owner,
    kind,
    state: 'reserved',
    pid: null,
    processBirth: null,
    location: null,
  }));
}
