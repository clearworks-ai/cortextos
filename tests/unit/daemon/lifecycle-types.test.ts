import { describe, expect, it } from 'vitest';
import {
  CAUSE_SEVERITY,
  canonicalAgentId,
  type AgentIdentity,
  type GenerationToken,
  type EffectToken,
  type LifecycleRequest,
  type RequestReceipt,
  type OwnedResource,
  type RetirementResult,
  type WorkRecord,
  type DispatchResult,
  type LifecycleSnapshot,
  type RequestCause,
} from '../../../src/daemon/lifecycle/types';

describe('canonicalAgentId', () => {
  it('joins instanceId/org/name in canonical order', () => {
    expect(canonicalAgentId({ instanceId: 'default', org: 'clearworks', name: 'knox' })).toBe(
      'default/clearworks/knox',
    );
  });

  it('throws on empty instanceId', () => {
    expect(() => canonicalAgentId({ instanceId: '', org: 'clearworks', name: 'knox' })).toThrow();
  });

  it('throws on empty org', () => {
    expect(() => canonicalAgentId({ instanceId: 'default', org: '', name: 'knox' })).toThrow();
  });

  it('throws on empty name', () => {
    expect(() => canonicalAgentId({ instanceId: 'default', org: 'clearworks', name: '' })).toThrow();
  });

  it('throws on whitespace-only instanceId', () => {
    expect(() => canonicalAgentId({ instanceId: '   ', org: 'clearworks', name: 'knox' })).toThrow();
  });

  it('throws on whitespace-only org', () => {
    expect(() => canonicalAgentId({ instanceId: 'default', org: '   ', name: 'knox' })).toThrow();
  });

  it('throws on whitespace-only name', () => {
    expect(() => canonicalAgentId({ instanceId: 'default', org: 'clearworks', name: '   ' })).toThrow();
  });
});

describe('compile-time fixture: one literal of every exported shape', () => {
  it('constructs AgentIdentity / GenerationToken / EffectToken', () => {
    const identity: AgentIdentity = { instanceId: 'default', org: 'clearworks', name: 'knox' };
    const genToken: GenerationToken = {
      agentId: canonicalAgentId(identity),
      supervisorEpoch: 1,
      generation: 1,
    };
    const effectToken: EffectToken = {
      ...genToken,
      intentRevision: 1,
      effectId: 'effect-1',
    };

    expect(identity.instanceId).toBeTypeOf('string');
    expect(genToken.agentId).toBeTypeOf('string');
    expect(effectToken.effectId).toBeTypeOf('string');
  });

  it('constructs LifecycleRequest and RequestReceipt', () => {
    const request: LifecycleRequest = {
      requestId: 'req-1',
      kind: 'start',
      cause: 'manual-cli',
      mode: 'fresh',
      observedGeneration: null,
      userInitiated: true,
      evidence: { note: 'test', count: 1, flag: true, missing: null },
      requestedAtMs: Date.now(),
    };

    const receipt: RequestReceipt = {
      requestId: request.requestId,
      operationId: 'op-1',
      accepted: true,
      desiredState: 'running',
      phase: 'starting',
      generation: 1,
      blockedReason: null,
      coalescedWith: [],
    };

    expect(request.requestId).toBeTypeOf('string');
    expect(receipt.operationId).toBeTypeOf('string');
  });

  it('constructs OwnedResource', () => {
    const resource: OwnedResource = {
      resourceId: 'res-1',
      owner: { agentId: 'default/clearworks/knox', supervisorEpoch: 1, generation: 1 },
      kind: 'runtime',
      state: 'acquired',
      pid: 1234,
      processBirth: '2026-09-11T00:00:00.000Z',
      location: '/tmp/whatever',
    };

    expect(resource.resourceId).toBeTypeOf('string');
  });

  it('constructs both RetirementResult variants', () => {
    const retired: RetirementResult = { status: 'retired', released: [] };
    const blocked: RetirementResult = {
      status: 'blocked',
      released: [],
      unresolved: [],
      reason: 'still draining',
    };

    expect(retired.status).toBe('retired');
    expect(blocked.status).toBe('blocked');
  });

  it('constructs WorkRecord', () => {
    const work: WorkRecord = {
      workId: 'work-1',
      sourceKey: 'source-1',
      payloadDigest: 'digest-1',
      payloadRef: 'ref-1',
      owner: { agentId: 'default/clearworks/knox', supervisorEpoch: 1, generation: 1 },
      phase: 'accepted',
      batchId: null,
      runtimeTurnId: null,
      outcome: null,
      retryOf: null,
      acceptedAtMs: Date.now(),
      lastTransitionAtMs: Date.now(),
    };

    expect(work.workId).toBeTypeOf('string');
  });

  it('constructs all four DispatchResult variants', () => {
    const ok: DispatchResult = { ok: true, workIds: ['work-1'], batchId: 'batch-1' };
    const notRunning: DispatchResult = {
      ok: false,
      code: 'NOT_RUNNING',
      retryable: true,
      message: 'agent not running',
    };
    const duplicate: DispatchResult = {
      ok: false,
      code: 'DUPLICATE',
      retryable: false,
      existingWorkIds: ['work-1'],
      message: 'already dispatched',
    };
    const revokedOrFailed: DispatchResult = {
      ok: false,
      code: 'REVOKED',
      retryable: false,
      message: 'revoked',
    };

    expect(ok.ok).toBe(true);
    expect(notRunning.ok).toBe(false);
    expect(duplicate.ok).toBe(false);
    expect(revokedOrFailed.ok).toBe(false);
  });

  it('constructs LifecycleSnapshot', () => {
    const snapshot: LifecycleSnapshot = {
      agentId: 'default/clearworks/knox',
      schemaVersion: 1,
      revision: 1,
      supervisorEpoch: 1,
      desiredState: 'running',
      desiredStateReason: null,
      desiredStateRequestId: null,
      intentRevision: 1,
      currentGeneration: 1,
      nextGeneration: 2,
      phase: 'ready',
      resources: [],
      retiringResources: [],
      outstandingWork: [],
      pendingRequests: [],
      recoveryBudgets: {
        crash: { count: 0, windowStartMs: Date.now(), pausedUntilMs: null },
      },
      blockedReason: null,
    };

    expect(snapshot.agentId).toBeTypeOf('string');
  });
});

describe('CAUSE_SEVERITY completeness', () => {
  const ALL_REQUEST_CAUSES: RequestCause[] = [
    'crash', 'clean-exit', 'startup-failure', 'image-poison',
    'opencode-continuation', 'context-soft-handoff', 'context-hard-full',
    'session-age', 'wedge-alert', 'manual-cli', 'manual-ipc',
    'dashboard', 'cron', 'boot-self-heal', 'bus-self-restart',
    'bus-hard-restart', 'reaper', 'daemon-shutdown',
  ];

  it('has exactly 18 distinct RequestCause members', () => {
    expect(new Set(ALL_REQUEST_CAUSES).size).toBe(18);
    expect(ALL_REQUEST_CAUSES.length).toBe(18);
  });

  it('defines a CAUSE_SEVERITY entry for every RequestCause member', () => {
    for (const cause of ALL_REQUEST_CAUSES) {
      expect(CAUSE_SEVERITY[cause]).not.toBeUndefined();
      expect(CAUSE_SEVERITY[cause]).toBeTypeOf('number');
    }
  });

  it('has exactly 18 keys in CAUSE_SEVERITY, matching RequestCause 1:1', () => {
    expect(Object.keys(CAUSE_SEVERITY).length).toBe(18);
  });
});
