export type DesiredState = 'running' | 'stopped' | 'halted' | 'quarantined';
export type ObservedPhase = 'absent' | 'starting' | 'ready' | 'retiring' | 'blocked';
export type StartMode = 'continue' | 'fresh';
export type WorkPhase =
  | 'accepted' | 'dispatched' | 'runtime-accepted' | 'executing'
  | 'completed' | 'failed' | 'cancelled' | 'needs-review';

export type RequestCause =
  | 'crash' | 'clean-exit' | 'startup-failure' | 'image-poison'
  | 'opencode-continuation' | 'context-soft-handoff' | 'context-hard-full'
  | 'session-age' | 'wedge-alert' | 'manual-cli' | 'manual-ipc'
  | 'dashboard' | 'cron' | 'boot-self-heal' | 'bus-self-restart'
  | 'bus-hard-restart' | 'reaper' | 'daemon-shutdown';

/**
 * RESOLVED (Josh, 2026-09-11): arbitration among simultaneous AUTONOMOUS causes
 * landing in the same transition window is severity-wins, causes-retained —
 * NOT first-arrival, NOT a rigid priority list. Higher number = higher severity.
 * Absolutes from PRD §Open-Questions still sit above this table and are not
 * overridden by it: explicit stop/HALT/quarantine beats every autonomous cause
 * regardless of this ranking; fresh intent is sticky against a later `continue`.
 */
export const CAUSE_SEVERITY: Record<RequestCause, number> = {
  'daemon-shutdown': 0, 'boot-self-heal': 1, 'reaper': 1,
  'wedge-alert': 2, 'clean-exit': 2, 'opencode-continuation': 2,
  'session-age': 3, 'context-soft-handoff': 3,
  'startup-failure': 4, 'context-hard-full': 5, 'image-poison': 5,
  'crash': 6,
  'cron': 7, 'bus-self-restart': 7, 'bus-hard-restart': 7,
  'manual-cli': 8, 'manual-ipc': 8, 'dashboard': 8,
};

export interface AgentIdentity { instanceId: string; org: string; name: string; }

/** Canonical agent id string: `${instanceId}/${org}/${name}`. */
export type AgentId = string;

export interface GenerationToken {
  agentId: AgentId;
  supervisorEpoch: number;   // persisted daemon-owner term, NOT a PID
  generation: number;        // monotonic agent incarnation
}

export interface EffectToken extends GenerationToken {
  intentRevision: number;    // stop/halt advances this, revoking pending effects
  effectId: string;
}

export interface LifecycleRequest {
  requestId: string;
  kind: 'start' | 'stop' | 'restart' | 'refresh' | 'halt' | 'resume';
  cause: RequestCause;
  mode: StartMode | null;            // null for stop/halt
  observedGeneration: number | null; // null = "whatever is current"
  userInitiated: boolean;
  evidence: Record<string, string | number | boolean | null>;
  requestedAtMs: number;
}

export interface RequestReceipt {
  requestId: string;
  operationId: string;
  accepted: boolean;                 // DURABLY accepted, never "completed"
  desiredState: DesiredState;
  phase: ObservedPhase;
  generation: number | null;
  blockedReason: string | null;
  coalescedWith: string[];           // other requestIds folded into this operation
}

export type ResourceKind =
  | 'runtime' | 'pty-host' | 'descendant' | 'session'
  | 'socket' | 'checker' | 'poller' | 'scheduler' | 'dispatch' | 'handoff-lease';

export interface OwnedResource {
  resourceId: string;
  owner: GenerationToken;
  kind: ResourceKind;
  state: 'reserved' | 'acquired' | 'retiring' | 'released' | 'unknown';
  pid: number | null;
  processBirth: string | null;       // OS birth evidence; PID alone is not proof
  location: string | null;           // path/socket/handle ref — never authority by name alone
}

export type RetirementResult =
  | { status: 'retired'; released: OwnedResource[] }
  | { status: 'blocked'; released: OwnedResource[]; unresolved: OwnedResource[]; reason: string };

export interface WorkRecord {
  workId: string;
  sourceKey: string;                 // stable ingress idempotency key
  payloadDigest: string;
  payloadRef: string;                // durable immutable payload ref
  owner: GenerationToken;
  phase: WorkPhase;
  batchId: string | null;
  runtimeTurnId: string | null;
  outcome: string | null;
  retryOf: string | null;
  acceptedAtMs: number;
  lastTransitionAtMs: number;
}

export type DispatchResult =
  | { ok: true; workIds: string[]; batchId: string }
  | { ok: false; code: 'NOT_RUNNING'; retryable: true; message: string }
  | { ok: false; code: 'DUPLICATE'; retryable: false; existingWorkIds: string[]; message: string }
  | { ok: false; code: 'REVOKED' | 'FAILED'; retryable: false; message: string };

export interface LifecycleSnapshot {
  agentId: AgentId;
  schemaVersion: number;
  revision: number;
  supervisorEpoch: number;
  desiredState: DesiredState;
  desiredStateReason: string | null;
  desiredStateRequestId: string | null;
  intentRevision: number;
  currentGeneration: number | null;
  nextGeneration: number;
  phase: ObservedPhase;
  resources: OwnedResource[];
  retiringResources: OwnedResource[];
  outstandingWork: WorkRecord[];
  pendingRequests: LifecycleRequest[];
  recoveryBudgets: Record<string, { count: number; windowStartMs: number; pausedUntilMs: number | null }>;
  blockedReason: string | null;
}

export function canonicalAgentId(identity: AgentIdentity): AgentId {
  const { instanceId, org, name } = identity;
  for (const [label, value] of [['instanceId', instanceId], ['org', org], ['name', name]] as const) {
    if (!value || value.trim().length === 0) {
      throw new Error(`canonicalAgentId: ${label} must be a non-empty, non-whitespace string`);
    }
  }
  return `${instanceId}/${org}/${name}`;
}
