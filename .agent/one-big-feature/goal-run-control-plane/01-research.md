# Research — Durable `/goal` → Codex Goal-Run Control Plane

## Josh's Verbatim Requests
> "figure out how to do the design and goal right dont just stop"
> "we need our goal spec bilt"

## Current State Analysis

### Native `/goal` Behavior
- `/goal <objective>` sets a native thread goal in Codex App Server
- Goal visibility is tied to the current working directory thread
- No persistence across daemon restarts or session changes
- No atomic lease or claim mechanism
- No verification gate before completion

### Source Spec Analysis
From `.claude/orchestration-goal-run-control-plane/03-specs/01-goal-run-control-plane.md`:

**Key Requirements:**
1. Daemon-owned atomically written goal-run store beneath cortextOS state root
2. Each record includes: id, agentName, goal, repo, worktree, state, threadId, leaseOwner, leaseToken, leaseExpiresAt, attempt, maxAttempts, acceptanceChecks, artifacts, events, timestamps
3. All mutation serialized through lock/atomic-write protocol
4. Lease token validation on every mutation
5. Append-only event records preserving run/turn/error/verifier evidence

**State Machine:**
- `queued` → `claimed` → `running` → `verifying` → `done` (success path)
- `verifying` → `retry_wait` → `claimed` → `running` (retry path)
- `verifying` → `needs_human` / `exhausted` / `cancelled` (terminal states)

**Ingress Behavior:**
- `/goal <objective>` creates queued run, captures cwd as repo, requests dispatch
- `/goal` lists active runs for agent
- `/goal clear` cancels non-running run or confirmed human action

**Claim/Execution:**
1. Daemon tick reads candidate runs (queued, due retry_wait, expired lease)
2. Atomically claims with unique leaseOwner, leaseToken, bounded TTL
3. Creates dedicated App Server thread or resumes stored threadId
4. Persists turn events, lease renewal tied to active owner/token
5. Completed turn → verifying → bounded acceptance checks
6. Pass → done, retryable failure → retry_wait, exhausted/human → terminal

**Finish Pressure:**
- Dispatch prompt states goal, acceptanceChecks, attempt, artifact location, invariant
- Invariant: do not report completion until checks pass
- If blocked: name concrete human/approval dependency
- Otherwise: continue with next safe implementation or verification action
- Transient worker/process failure never marks run terminal

**Safety:**
- Compare-and-swap claim by lease token (no concurrent execution)
- Stale worker event/finalization rejected on mismatched token
- Finite maxAttempts, delay cap, per-check timeout (no unbounded loops)
- Execution stays within configured repo/worktree
- Acceptance checks are explicit commands, not shell fragments
- No automatic git push/merge/deploy/external comm/destructive op
- Approval bypass → needs_human with recorded action

**Required Source/Test Targets:**
- `src/pty/codex-app-server-pty.ts`: route `/goal` through durable control-plane
- `src/daemon/agent-process.ts` / `src/daemon/agent-manager.ts`: runner lifecycle, prompt injection, turn ownership, clean shutdown
- New daemon modules: store, state machine, lease protocol, verifier, runner (use existing atomic utilities)
- `tests/unit/pty/codex-app-server-pty.test.ts`: ingress/status/cancel coverage
- New unit tests: state transitions, atomic claim, stale-token rejection, lease-expiry reclaim, retry bound, verifier result mapping
- Extend mock/e2e lifecycle for dedicated thread resume and turn-event persistence

**Verification Steps:**
1. Unit: enqueue → claim → dedicated thread → event persistence → verifier pass → done
2. Unit: two contenders produce exactly one claim; stale-token finalization rejected
3. Unit: restart/expired lease reclaims and resumes stored thread, not different/latest cwd thread
4. Unit: retryable failure re-woken within policy; bound breach → exhausted; approval/human → needs_human
5. Regression: existing native goal set/get/clear and Codex lifecycle mock tests remain green
6. Full repository gate: `npm run build && npm test`

### Existing Infrastructure

**CortextOS State Root:**
- Location: `~/.cortextos/{instance}`
- Already used for agent state, logs, etc.
- Atomic write utilities available in framework

**Atomic Utilities:**
- Framework has atomic file write patterns
- Can leverage for goal-run store persistence

**Codex App Server:**
- `src/pty/codex-app-server-pty.ts` handles `/goal` routing
- Native goal RPC exists as thread projection
- Can extend for durability layer

**Daemon Lifecycle:**
- `src/daemon/agent-process.ts` manages agent processes
- `src/daemon/agent-manager.ts` handles agent lifecycle
- Can attach runner tick and prompt injection

### Technical Approach

**Data Model Implementation:**
```typescript
interface GoalRun {
  id: string;                           // UUID
  agentName: string;
  goal: string;
  repo: string;                         // Current cwd
  worktree?: string;                    // Optional worktree path
  state: 'queued' | 'claimed' | 'running' | 'verifying' | 'retry_wait' | 'done' | 'needs_human' | 'exhausted' | 'cancelled';
  threadId?: string;                    // Dedicated Codex thread ID
  leaseOwner?: string;                  // Claiming runner ID
  leaseToken?: string;                  // Compare-and-swap token
  leaseExpiresAt?: string;              // ISO timestamp
  attempt: number;
  maxAttempts: number;
  acceptanceChecks: GoalAcceptanceCheck[];
  artifacts: GoalArtifact[];
  events: GoalRunEvent[];
  createdAt: string;                    // ISO timestamp
  updatedAt: string;                    // ISO timestamp
}
```

**State Machine Transitions:**
- Compare-and-swap on lease token for all state changes
- Append-only event logging (never delete or modify events)
- Bounded retry with exponential backoff
- Explicit terminal states (done, needs_human, exhausted, cancelled)

**Storage Strategy:**
- One JSON file per goal-run in state root
- File name: `goal-runs/{agentName}/{id}.json`
- Atomic writes via framework utilities
- Directory structure: `goal-runs/{agentName}/` for query efficiency

**Lease Protocol:**
- Claim: generate unique leaseOwner + leaseToken, set leaseExpiresAt = now + TTL
- Renew: update leaseExpiresAt on same owner/token
- Reclaim: if leaseExpiresAt < now, allow new claim
- Validate: every mutation checks leaseOwner + leaseToken match

**Verification Gate:**
- Bounded acceptance checks with timeout per check
- Capture stdout/stderr as artifacts
- Pass all required checks → transition to done
- Fail check → retry_wait if retryable, needs_human/exhausted otherwise

**Integration Points:**
- `/goal` command → enqueue run in durable store
- Daemon tick → claim and dispatch to dedicated thread
- Thread lifecycle → persist turn events, lease renewal
- Completion → verification gate → terminal state

## Open Questions

1. **Acceptance Check Definition:** What constitutes a bounded acceptance check? Timeout value? Exit code interpretation?
2. **Retry Policy Defaults:** What are sensible defaults for maxAttempts, delay cap, per-check timeout?
3. **Lease TTL:** What is appropriate lease duration? How often should lease renewal occur?
4. **Thread ID Management:** How are dedicated thread IDs generated and persisted?
5. **Event Volume:** How many events per run? Retention policy for completed runs?
6. **Cross-Agent Querying:** Can agents query each other's goal runs? Scoping rules?
7. **Cleanup Policy:** When should completed goal runs be archived or deleted?

## Research Next Steps

1. Define concrete acceptance check format and timeout defaults
2. Specify retry policy parameters (maxAttempts, delay cap, backoff strategy)
3. Determine lease TTL and renewal cadence
4. Design thread ID generation and persistence strategy
5. Event retention and archival policy
6. Cross-agent visibility and scoping rules
7. Integration testing strategy with existing Codex App Server
