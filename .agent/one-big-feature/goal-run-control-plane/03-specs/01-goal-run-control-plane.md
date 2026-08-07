# SPEC — Durable `/goal` → Codex Goal-Run Control Plane

Status: APPROVED by Larry

## Controlling Sources

- **Plan**: `.agent/one-big-feature/goal-run-control-plane/02-master-plan.md` 
- **Scope SHA**: `f5abb4505dd8811e9770365e6c493e6b4d3b69a58c2641e976bbde76296ddc08`
- **Framework**: `one-big-feature`

## Implementation Requirements

### Critical Contract 1: Cross-Process Exclusive CAS with Stale-Lock Recovery

**File**: `src/daemon/goal-lock.ts`

**Contract**: Portable atomic lockfile (O_EXCL/flock equivalent) with bounded stale-lock recovery. Prove concurrent claim has exactly one winner through explicit testing.

**Acceptance Criteria**:
- [x] O_EXCL semantics: fail if lock file exists (atomic lock acquisition)
- [x] Stale-lock detection: locks older than 5 minutes with dead processes are reclaimable
- [x] Process liveness check: portable process.alive() implementation
- [x] Concurrent claim test: 10 simultaneous claim attempts, exactly 1 succeeds
- [x] Process crash recovery: killed process locks become stale and reclaimable
- [x] Atomic unlock: only lock owner can release, no race conditions
- [x] Multiple run isolation: different runs don't interfere with each other's locks

**Test Requirements**:
```typescript
// tests/unit/daemon/goal-lock.test.ts
describe('GoalLock', () => {
  it('concurrent claim: exactly 1 winner out of 10 attempts', async () => {
    // Implementation: spawn 10 processes, all tryAcquireLock same runId
    // Assert: exactly 1 succeeds, 9 fail
  });
  
  it('stale lock recovery: abandoned lock reclaimable after timeout', async () => {
    // Implementation: acquire lock, kill process, wait > 5min, new claim succeeds
  });
  
  it('process crash: lock becomes stale and reclaimable', async () => {
    // Implementation: acquire lock, kill process (SIGKILL), verify reclaimable
  });
});
```

### Critical Contract 2: Bounded Periodic Runner Tick Plus Startup Resume

**File**: `src/daemon/goal-runner.ts`

**Contract**: Bounded periodic runner tick across all configured agents with startup resume for queued, retry_wait-after-backoff, and expired-lease orphan runs.

**Acceptance Criteria**:
- [x] Periodic tick: 30-second interval across all configured agents
- [x] Startup resume: orphaned runs reclaimed after daemon restart
- [x] Queued resume: all queued runs processed on startup
- [x] Retry_wait resume: backoff elapsed runs resumed after restart
- [x] Expired-lease reclaim: orphan runs with expired leases reclaimed
- [x] Bounded execution: 25-second tick timeout prevents starvation
- [x] Graceful shutdown: current processing completes before exit
- [x] Cross-agent coordination: multiple agents processed independently

**Test Requirements**:
```typescript
// tests/unit/daemon/goal-runner.test.ts
describe('GoalRunner startup resume', () => {
  it('queued runs resume after daemon restart', async () => {
    // Create queued runs, restart daemon, verify processing
  });
  
  it('retry_wait runs resume after backoff elapsed', async () => {
    // Create retry_wait run with elapsed backoff, restart, verify resume
  });
  
  it('expired-lease orphans reclaimed after restart', async () => {
    // Create running run with expired lease, restart, verify reclaim
  });
});

describe('GoalRunner periodic tick', () => {
  it('processes all configured agents', async () => {
    // Multiple agents with runs, verify all processed in tick
  });
  
  it('bounded execution: tick timeout prevents starvation', async () => {
    // Long-running operation, verify tick respects 25s timeout
  });
});
```

### Critical Contract 3: Parse Codex Turn/Blocker Output for needs_human Transitions

**File**: `src/daemon/goal-blocker-parser.ts`

**Contract**: Parse Codex turn/blocker output to detect approval, human, permission, and credential dependencies with explicit test for blocker detection and state transition.

**Acceptance Criteria**:
- [x] Blocker detection: identify approval, human, permission, credential blockers
- [x] Confidence scoring: calculate confidence > 0.7 for strong blockers
- [x] needs_human transition: detected blockers trigger needs_human state
- [x] Multiple blocker types: detect multiple blockers in single turn
- [x] Explicit blocker test: test with known blocker patterns
- [x] False positive prevention: weak indicators don't trigger transition

**Test Requirements**:
```typescript
// tests/unit/daemon/goal-blocker-parser.test.ts
describe('GoalBlockerParser', () => {
  it('detects approval blocker: "Need approval from Josh"', () => {
    const blockers = detectBlockers('Need approval from Josh');
    assert(blockers.some(b => b.type === 'approval' && b.confidence > 0.8));
  });
  
  it('detects credential blocker: "Missing API key"', () => {
    const blockers = detectBlockers('Missing API key for service');
    assert(blockers.some(b => b.type === 'credential' && b.confidence > 0.7));
  });
  
  it('detects multiple blockers: human + credentials', () => {
    const blockers = detectBlockers('Need human approval and valid API key');
    assert(blockers.length === 2);
    assert(blockers.some(b => b.type === 'human'));
    assert(blockers.some(b => b.type === 'credential'));
  });
  
  it('no blockers: normal output', () => {
    const blockers = detectBlockers('Implementation complete, tests passing');
    assert(blockers.length === 0);
    assert(!shouldTransitionToNeedsHuman('Implementation complete, tests passing'));
  });
});
```

### Critical Contract 4: Per-Goal Validation Profiles with Safe Default

**File**: `src/daemon/goal-validation-profiles.ts`

**Contract**: Support intentional, explicit per-goal validation profile selection while retaining safe default. Prevent repo-wide npm test dependency by supporting per-goal validation.

**Acceptance Criteria**:
- [x] Default profile: safe default with build + test for goals without --profile
- [x] Explicit profiles: --profile build-only, typecheck-only, lint-only, minimal
- [x] Profile selection: /goal "objective" --profile build-only uses build-only profile
- [x] Invalid profile: unknown profile falls back to default with warning
- [x] No repo-wide npm test: goals can use build-only without test dependency
- [x] Failure/retry: failed validation checks trigger retry_wait state

**Test Requirements**:
```typescript
// tests/unit/daemon/goal-validation-profiles.test.ts
describe('GoalValidationProfiles', () => {
  it('default profile: build + test for goals without --profile', () => {
    const profile = getProfile(undefined);
    assert(profile.id === 'default');
    assert(profile.acceptanceChecks.length === 2);
  });
  
  it('explicit profile: --profile build-only uses correct profile', () => {
    const { profileId } = parseProfileFromGoal('/goal objective --profile build-only');
    assert(profileId === 'build-only');
    const profile = getProfile(profileId);
    assert(profile.acceptanceChecks.length === 1);
  });
  
  it('invalid profile: falls back to default with warning', () => {
    const profile = getProfile('unknown-profile');
    assert(profile.id === 'default');
  });
});
```

### Critical Contract 5: Retention/Pruning for Events and Artifacts

**File**: `src/daemon/goal-retention.ts`

**Contract**: Automatic pruning of events and inline stdout/stderr artifacts using eventRetentionDays configuration.

**Acceptance Criteria**:
- [x] Event retention: prune events older than eventRetentionDays
- [x] Artifact pruning: remove old stdout/stderr artifacts
- [x] Terminal preservation: preserve terminal state events (done, needs_human, etc.)
- [x] Recent preservation: preserve events/artifacts within retention period
- [x] Configurable: respect eventRetentionDays from GoalConfig
- [x] Atomic operations: pruning doesn't corrupt run data
- [x] Statistics: accurate counts of total vs pruned content

**Test Requirements**:
```typescript
// tests/unit/daemon/goal-retention.test.ts
describe('GoalRetention', () => {
  it('prunes old events, preserves terminal/recent', async () => {
    // Create run with old events, prune, verify correct preservation
  });
  
  it('prunes old stdout/stderr artifacts', async () => {
    // Create run with old artifacts, prune, verify stdout/stderr removed
  });
  
  it('respects eventRetentionDays configuration', async () => {
    // Test with different retention days, verify different pruning behavior
  });
});
```

### Core Components Implementation

#### Data Model & Types

**File**: `src/types/goal-run.ts`

```typescript
export interface GoalRun {
  id: string;                                    // UUID v4
  agentName: string;
  goal: string;
  repo: string;                                  // Current cwd at /goal invocation
  worktree?: string;                             // Optional worktree path
  state: GoalRunState;
  threadId?: string;                             // Dedicated Codex thread ID
  leaseOwner?: string;                           // Claiming runner ID
  leaseToken?: string;                           // Compare-and-swap token (UUID v4)
  leaseExpiresAt?: string;                       // ISO 8601 timestamp
  attempt: number;
  maxAttempts: number;
  acceptanceChecks: GoalAcceptanceCheck[];
  artifacts: GoalArtifact[];
  events: GoalRunEvent[];
  createdAt: string;                             // ISO 8601 timestamp
  updatedAt: string;                             // ISO 8601 timestamp
}

export type GoalRunState =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'verifying'
  | 'retry_wait'
  | 'done'
  | 'needs_human'
  | 'exhausted'
  | 'cancelled';

export interface GoalAcceptanceCheck {
  id: string;
  command: string[];
  timeoutMs: number;
  required: boolean;
  description?: string;
}

export interface GoalArtifact {
  id: string;
  type: 'stdout' | 'stderr' | 'file' | 'custom';
  content?: string;
  filePath?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface GoalRunEvent {
  id: string;
  type: 'run_created' | 'claimed' | 'turn_started' | 'turn_completed' | 'error' | 'verifying' | 'check_passed' | 'check_failed' | 'state_changed';
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface GoalConfig {
  maxAttempts: number;
  leaseTtlMs: number;
  retryDelayMs: number;
  retryMaxDelayMs: number;
  checkTimeoutMs: number;
  eventRetentionDays: number;
}

export const DEFAULT_GOAL_CONFIG: GoalConfig = {
  maxAttempts: 3,
  leaseTtlMs: 5 * 60 * 1000, // 5 minutes
  retryDelayMs: 60 * 1000, // 1 minute
  retryMaxDelayMs: 10 * 60 * 1000, // 10 minutes
  checkTimeoutMs: 30 * 1000, // 30 seconds
  eventRetentionDays: 30
};
```

#### Goal-Run Store with Atomic Operations

**File**: `src/daemon/goal-run-store.ts`

**Contract**: Atomic CRUD operations with compare-and-swap updates and file locking for concurrent access safety.

```typescript
export class GoalRunStore {
  private stateRoot: string;
  private goalRunsDir: string;

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    this.goalRunsDir = path.join(stateRoot, 'goal-runs');
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.goalRunsDir, { recursive: true });
  }

  async create(run: GoalRun): Promise<void> {
    const agentDir = path.join(this.goalRunsDir, run.agentName);
    await fs.promises.mkdir(agentDir, { recursive: true });

    const filePath = this.getRunFilePath(run.agentName, run.id);
    const tempPath = `${filePath}.tmp`;

    await fs.promises.writeFile(tempPath, JSON.stringify(run, null, 2));
    await fs.promises.rename(tempPath, filePath);
  }

  async get(agentName: string, id: string): Promise<GoalRun | null> {
    const filePath = this.getRunFilePath(agentName, id);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as GoalRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async update(agentName: string, id: string, leaseToken: string, updater: (run: GoalRun) => GoalRun): Promise<void> {
    const current = await this.get(agentName, id);
    if (!current) {
      throw new Error(`Goal run ${id} not found`);
    }
    if (current.leaseToken !== leaseToken) {
      throw new Error(`Lease token mismatch for ${id}`);
    }

    const updated = updater(current);
    updated.updatedAt = new Date().toISOString();

    await this.atomicWrite(agentName, id, updated);
  }

  async list(agentName: string, state?: GoalRunState): Promise<GoalRun[]> {
    const agentDir = path.join(this.goalRunsDir, agentName);
    try {
      const files = await fs.promises.readdir(agentDir);
      const runs: GoalRun[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(agentDir, file);
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const run = JSON.parse(content) as GoalRun;

        if (!state || run.state === state) {
          runs.push(run);
        }
      }

      return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private getRunFilePath(agentName: string, id: string): string {
    return path.join(this.goalRunsDir, agentName, `${id}.json`);
  }

  private async atomicWrite(agentName: string, id: string, run: GoalRun): Promise<void> {
    const filePath = this.getRunFilePath(agentName, id);
    const tempPath = `${filePath}.tmp`;

    await fs.promises.writeFile(tempPath, JSON.stringify(run, null, 2));
    await fs.promises.rename(tempPath, filePath);
  }
}
```

#### State Machine

**File**: `src/daemon/goal-state-machine.ts`

```typescript
export class GoalStateMachine {
  static canTransition(from: GoalRunState, to: GoalRunState): boolean {
    const transitions: Record<GoalRunState, GoalRunState[]> = {
      'queued': ['claimed', 'cancelled'],
      'claimed': ['running', 'cancelled'],
      'running': ['verifying', 'retry_wait', 'needs_human', 'exhausted', 'cancelled'],
      'verifying': ['done', 'retry_wait', 'needs_human', 'exhausted'],
      'retry_wait': ['claimed'],
      'done': [],
      'needs_human': [],
      'exhausted': [],
      'cancelled': []
    };

    return transitions[from]?.includes(to) ?? false;
  }

  static transition(run: GoalRun, to: GoalRunState, eventData?: Record<string, unknown>): GoalRun {
    if (!this.canTransition(run.state, to)) {
      throw new Error(`Invalid state transition: ${run.state} → ${to}`);
    }

    const updated = { ...run, state: to, updatedAt: new Date().toISOString() };

    updated.events.push({
      id: uuidv4(),
      type: 'state_changed',
      timestamp: new Date().toISOString(),
      data: {
        from: run.state,
        to,
        ...eventData
      }
    });

    return updated;
  }

  static isTerminal(state: GoalRunState): boolean {
    return ['done', 'needs_human', 'exhausted', 'cancelled'].includes(state);
  }

  static canRetry(state: GoalRunState): boolean {
    return state === 'retry_wait';
  }
}
```

#### Ingress Integration with Native Fallback

**File**: `src/pty/codex-app-server-pty.ts`

**Contract**: Preserve native /goal fallback, arg-array command spawning, no auto push/merge/deploy, atomic data writes, no shell interpolation.

```typescript
// Extend existing CodexAppServerPty class
async handleGoalCommand(objective: string): Promise<void> {
  if (!this.goalRunStore) {
    return this.handleNativeGoal(objective); // Preserve native fallback
  }

  // Parse validation profile from goal
  const { goal, profileId } = GoalValidationProfiles.parseProfileFromGoal(objective);
  const profile = GoalValidationProfiles.getProfile(profileId);

  const run: GoalRun = {
    id: uuidv4(),
    agentName: this.getAgentName(),
    goal,
    repo: process.cwd(),
    worktree: undefined,
    state: 'queued',
    threadId: undefined,
    leaseOwner: undefined,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    attempt: 0,
    maxAttempts: this.config.maxAttempts,
    acceptanceChecks: profile.acceptanceChecks, // Use profile checks
    artifacts: [],
    events: [{
      id: uuidv4(),
      type: 'run_created',
      timestamp: new Date().toISOString(),
      data: { objective: goal, profileId: profile.id }
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await this.goalRunStore.create(run);
  console.log(`Goal run queued: ${run.id} (profile: ${profile.id})`);
}

// Arg-array spawning: commands executed as arrays, no shell interpolation
private async executeCheck(check: GoalAcceptanceCheck, run: GoalRun): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(check.command[0], check.command.slice(1), {
      cwd: run.repo,
      timeout: check.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
      // No shell: no shell interpolation, safer execution
    });

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Check exited with code ${code}: ${stderr || stdout}`));
      }
    });
  });
}
```

### Success Criteria

1. **Functional**: `/goal` creates durable runs, state machine executes correctly
2. **Reliable**: No data corruption, no lost events, lease protocol robust
3. **Tested**: All tests green, regression verified, >90% coverage
4. **Performant**: No significant overhead on existing Codex App Server
5. **Observable**: Events logged, state transitions tracked
6. **Safe**: No automatic destructive operations, human dependencies explicit
7. **Portable**: Cross-platform file locking, process liveness detection
8. **Resilient**: Startup resume handles all orphaned states correctly

### Non-Goals

- No auto push/merge/deploy: all git operations require explicit human approval
- No shell interpolation: commands executed as arg arrays for safety
- No repo-wide test dependencies: per-goal validation profiles prevent this
- No breaking changes: native /goal behavior preserved as fallback

### Implementation Phases

1. **Phase 1** (Days 1-3): Core data model, store, atomic operations
2. **Phase 2** (Days 4-6): State machine, lease protocol, cross-process CAS, blocker parser
3. **Phase 3** (Days 7-8): Verification gate, validation profiles
4. **Phase 4** (Day 9): Event logging, retention/pruning
5. **Phase 5** (Days 10-11): Thread management
6. **Phase 6** (Days 12-14): Runner integration, periodic tick, startup resume
7. **Phase 7** (Days 15-16): Ingress integration, PTY commands
8. **Phase 8** (Days 17-18): End-to-end testing, regression verification

### Rollout Strategy

1. **Phase 1**: Feature flag behind `CXR_GOAL_DURABLE=true`
2. **Phase 2**: Internal testing with development team
3. **Phase 3**: Beta testing with select users
4. **Phase 4**: Gradual rollout by user tier
5. **Phase 5**: Default on, opt-out available
6. **Phase 6**: Remove opt-out after monitoring period