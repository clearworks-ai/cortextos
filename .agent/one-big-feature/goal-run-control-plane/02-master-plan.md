# Master Plan — Durable `/goal` → Codex Goal-Run Control Plane

## Overview

This plan implements a durable goal-run control plane for Codex App Server, replacing the ephemeral native `/goal` behavior with a daemon-owned, atomically persisted state machine. The implementation provides lease-based execution, verification gates, retry logic, and crash recovery while preserving native goal visibility as a thread projection.

**Source backing**: Based on research in `01-research.md` and approved spec in `03-specs/01-goal-run-control-plane.md`

## Implementation Architecture

### Component Map

| Component | Location | Responsibility |
|-----------|----------|----------------|
| **GoalRun Store** | `src/daemon/goal-run-store.ts` | Atomic persistence, CRUD operations, file locking |
| **State Machine** | `src/daemon/goal-state-machine.ts` | State transitions, validation, invariant enforcement |
| **Lease Protocol** | `src/daemon/goal-lease-protocol.ts` | Claim/reclaim, token validation, expiry management |
| **Verifier** | `src/daemon/goal-verifier.ts` | Acceptance check execution, artifact capture, result mapping |
| **Event Logger** | `src/daemon/goal-event-logger.ts` | Append-only event persistence, query operations |
| **Thread Manager** | `src/daemon/goal-thread-manager.ts` | Dedicated thread lifecycle, resume logic |
| **Runner** | `src/daemon/goal-runner.ts` | Daemon tick integration, candidate selection, dispatch |
| **Config** | `src/daemon/goal-config.ts` | Retry policy, lease TTL, timeout defaults |
| **Types** | `src/types/goal-run.ts` | TypeScript interfaces for all goal-run entities |
| **Ingress Integration** | `src/pty/codex-app-server-pty.ts` | `/goal` command routing, status listing, cancellation |

### Data Model

From spec `03-specs/01-goal-run-control-plane.md`:

```typescript
// src/types/goal-run.ts
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
```

## Phase 1: Core Data Model & Store (Days 1-3)

### 1.1 TypeScript Interfaces

**File**: `src/types/goal-run.ts`

**Implementation**:
1. Define all interfaces as specified above
2. Add JSDoc comments with state machine documentation
3. Export validation functions for state transitions
4. Add type guards for state-specific fields

**Verification**: TypeScript compilation passes, interfaces export correctly

### 1.2 Atomic Goal-Run Store

**File**: `src/daemon/goal-run-store.ts`

**Implementation**:
```typescript
export class GoalRunStore {
  private stateRoot: string;
  private goalRunsDir: string;

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    this.goalRunsDir = path.join(stateRoot, 'goal-runs');
  }

  // Initialize directory structure
  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.goalRunsDir, { recursive: true });
  }

  // Create new goal run with atomic write
  async create(run: GoalRun): Promise<void> {
    const agentDir = path.join(this.goalRunsDir, run.agentName);
    await fs.promises.mkdir(agentDir, { recursive: true });

    const filePath = this.getRunFilePath(run.agentName, run.id);
    const tempPath = `${filePath}.tmp`;

    // Atomic write: temp → rename
    await fs.promises.writeFile(tempPath, JSON.stringify(run, null, 2));
    await fs.promises.rename(tempPath, filePath);
  }

  // Read goal run by ID
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

  // Compare-and-swap update with lease validation
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

  // List runs for agent with optional state filter
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

  // Delete goal run (for cleanup/archival)
  async delete(agentName: string, id: string): Promise<void> {
    const filePath = this.getRunFilePath(agentName, id);
    await fs.promises.unlink(filePath);
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

**Verification**: Unit tests for atomic create, compare-and-swap update, list filtering

### 1.3 Store Unit Tests

**File**: `tests/unit/daemon/goal-run-store.test.ts`

**Test coverage**:
1. `create` - atomic write, directory creation, proper serialization
2. `get` - retrieval by ID, null for non-existent
3. `update` - compare-and-swap validation, lease token mismatch rejection
4. `list` - all runs, state filtering, chronological sorting
5. `delete` - file removal, error handling
6. `concurrent access` - two processes cannot corrupt state

**Success criteria**: All tests pass, no race conditions in concurrent access

## Phase 2: State Machine & Lease Protocol (Days 4-6)

### 2.0 Critical Contract: Cross-Process Exclusive CAS

**File**: `src/daemon/goal-lock.ts`

**Implementation Requirements**:
- **Portable atomic lockfile**: O_EXCL/flock equivalent for cross-process coordination
- **Bounded stale-lock recovery**: Detect and recover from abandoned locks
- **Prove concurrent claim has exactly one winner**: Test with simultaneous claim attempts
- **File-based persistence**: Lock state survives process crashes
- **Automatic cleanup**: Remove lockfiles after successful completion or timeout

```typescript
export class GoalLock {
  private lockDir: string;
  private static readonly LOCK_TIMEOUT_MS = 30 * 1000; // 30 seconds
  private static readonly STALE_LOCK_MS = 5 * 60 * 1000; // 5 minutes

  constructor(stateRoot: string) {
    this.lockDir = path.join(stateRoot, 'goal-locks');
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.lockDir, { recursive: true });
  }

  // Try to acquire exclusive lock with O_EXCL semantics
  async tryAcquireLock(runId: string, ownerId: string): Promise<boolean> {
    const lockPath = this.getLockPath(runId);
    const lockData = {
      ownerId,
      acquiredAt: Date.now(),
      processId: process.pid
    };

    try {
      // O_EXCL: fail if file exists (atomic lock acquisition)
      await fs.promises.writeFile(lockPath, JSON.stringify(lockData), { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock exists - check if stale
        return await this.tryReclaimStaleLock(runId, ownerId);
      }
      throw error;
    }
  }

  // Check if lock is stale and safe to reclaim
  private async tryReclaimStaleLock(runId: string, newOwnerId: string): Promise<boolean> {
    const lockPath = this.getLockPath(runId);
    
    try {
      const content = await fs.promises.readFile(lockPath, 'utf-8');
      const lockData = JSON.parse(content);
      const age = Date.now() - lockData.acquiredAt;

      // Only reclaim if lock is stale AND original process is dead
      if (age > this.STALE_LOCK_MS && !this.isProcessAlive(lockData.processId)) {
        await fs.promises.unlink(lockPath);
        // Retry acquisition after cleanup
        return await this.tryAcquireLock(runId, newOwnerId);
      }

      return false;
    } catch (error) {
      // If we can't read the lock file, assume it's corrupted and reclaim
      await fs.promises.unlink(lockPath).catch(() => {});
      return await this.tryAcquireLock(runId, newOwnerId);
    }
  }

  // Release lock atomically
  async releaseLock(runId: string, ownerId: string): Promise<void> {
    const lockPath = this.getLockPath(runId);
    
    try {
      const content = await fs.promises.readFile(lockPath, 'utf-8');
      const lockData = JSON.parse(content);

      // Only release if we own the lock
      if (lockData.ownerId === ownerId) {
        await fs.promises.unlink(lockPath);
      }
    } catch (error) {
      // Lock file doesn't exist or is corrupted - consider it released
    }
  }

  // Check if process is still alive (portable implementation)
  private isProcessAlive(pid: number): boolean {
    try {
      // Send signal 0 - doesn't actually kill the process
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private getLockPath(runId: string): string {
    return path.join(this.lockDir, `${runId}.lock`);
  }
}
```

**Verification**: 
- Concurrent claim test: 10 processes try simultaneously, exactly 1 succeeds
- Stale lock recovery: abandon lock, wait past timeout, new claim succeeds
- Process crash: kill locked process, lock becomes stale and reclaimable
- File system atomicity: no race conditions in lock acquisition

### 2.1 State Machine Implementation

**File**: `src/daemon/goal-state-machine.ts`

**Implementation**:
```typescript
export class GoalStateMachine {
  // Validate state transition
  static canTransition(from: GoalRunState, to: GoalRunState): boolean {
    const transitions: Record<GoalRunState, GoalRunState[]> = {
      'queued': ['claimed', 'cancelled'],
      'claimed': ['running', 'cancelled'],
      'running': ['verifying', 'retry_wait', 'needs_human', 'exhausted', 'cancelled'],
      'verifying': ['done', 'retry_wait', 'needs_human', 'exhausted'],
      'retry_wait': ['claimed'],
      'done': [], // terminal
      'needs_human': [], // terminal
      'exhausted': [], // terminal
      'cancelled': [] // terminal
    };

    return transitions[from]?.includes(to) ?? false;
  }

  // Execute validated state transition
  static transition(run: GoalRun, to: GoalRunState, eventData?: Record<string, unknown>): GoalRun {
    if (!this.canTransition(run.state, to)) {
      throw new Error(`Invalid state transition: ${run.state} → ${to}`);
    }

    const updated = { ...run, state: to, updatedAt: new Date().toISOString() };

    // Add transition event
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

  // Check if state is terminal
  static isTerminal(state: GoalRunState): boolean {
    return ['done', 'needs_human', 'exhausted', 'cancelled'].includes(state);
  }

  // Check if state allows retry
  static canRetry(state: GoalRunState): boolean {
    return state === 'retry_wait';
  }
}
```

**Verification**: All valid transitions succeed, invalid transitions throw

### 2.2 Lease Protocol Implementation

**File**: `src/daemon/goal-lease-protocol.ts`

**Implementation**:
```typescript
export class GoalLeaseProtocol {
  private static readonly DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly LEASE_GRACE_MS = 30 * 1000; // 30 seconds grace

  // Generate new lease with owner and token
  static generateLease(owner: string): {
    leaseOwner: string;
    leaseToken: string;
    leaseExpiresAt: string;
  } {
    return {
      leaseOwner: owner,
      leaseToken: uuidv4(),
      leaseExpiresAt: new Date(Date.now() + this.DEFAULT_LEASE_TTL_MS).toISOString()
    };
  }

  // Check if lease is valid (not expired, token matches)
  static isValid(run: GoalRun, expectedToken: string): boolean {
    if (!run.leaseToken || run.leaseToken !== expectedToken) {
      return false;
    }

    if (!run.leaseExpiresAt) {
      return false;
    }

    const expiry = new Date(run.leaseExpiresAt).getTime();
    const now = Date.now();

    return now < (expiry + this.LEASE_GRACE_MS);
  }

  // Check if lease is expired (allowing reclaim)
  static isExpired(run: GoalRun): boolean {
    if (!run.leaseExpiresAt) {
      return true;
    }

    const expiry = new Date(run.leaseExpiresAt).getTime();
    return Date.now() >= expiry;
  }

  // Renew existing lease
  static renew(run: GoalRun): GoalRun {
    if (!run.leaseOwner || !run.leaseToken) {
      throw new Error('Cannot renew lease: no active lease');
    }

    if (this.isExpired(run)) {
      throw new Error('Cannot renew expired lease');
    }

    return {
      ...run,
      leaseExpiresAt: new Date(Date.now() + this.DEFAULT_LEASE_TTL_MS).toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  // Clear lease (for cancellation or completion)
  static clear(run: GoalRun): GoalRun {
    return {
      ...run,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString()
    };
  }
}
```

### 2.3 Critical Contract: Parse Codex Turn/Blocker Output for needs_human Transitions

**File**: `src/daemon/goal-blocker-parser.ts`

**Implementation Requirements**:
- Parse Codex turn output for human dependency indicators
- Detect approval, human, permission, and credential blockers
- Explicit test for blocker detection and state transition
- Support multiple blocker types in single turn

```typescript
export type BlockerType = 'approval' | 'human' | 'permission' | 'credential';

export interface DetectedBlocker {
  type: BlockerType;
  description: string;
  confidence: number;
}

export class GoalBlockerParser {
  // Parse Codex turn output for human dependency indicators
  static detectBlockers(turnOutput: string): DetectedBlocker[] {
    const blockers: DetectedBlocker[] = [];
    const lowerOutput = turnOutput.toLowerCase();

    // Approval blockers
    if (this.matchesPattern(lowerOutput, ['approval', 'approve', 'sign-off', 'authorized'])) {
      blockers.push({
        type: 'approval',
        description: this.extractBlockerDescription(turnOutput, 'approval'),
        confidence: this.calculateConfidence(lowerOutput, 'approval')
      });
    }

    // Human blockers
    if (this.matchesPattern(lowerOutput, ['human', 'person', 'manual', 'someone'])) {
      blockers.push({
        type: 'human',
        description: this.extractBlockerDescription(turnOutput, 'human'),
        confidence: this.calculateConfidence(lowerOutput, 'human')
      });
    }

    // Permission blockers
    if (this.matchesPattern(lowerOutput, ['permission', 'access', 'privilege', 'rights'])) {
      blockers.push({
        type: 'permission',
        description: this.extractBlockerDescription(turnOutput, 'permission'),
        confidence: this.calculateConfidence(lowerOutput, 'permission')
      });
    }

    // Credential blockers
    if (this.matchesPattern(lowerOutput, ['credential', 'api key', 'token', 'password', 'secret'])) {
      blockers.push({
        type: 'credential',
        description: this.extractBlockerDescription(turnOutput, 'credential'),
        confidence: this.calculateConfidence(lowerOutput, 'credential')
      });
    }

    return blockers;
  }

  // Determine if goal run should transition to needs_human
  static shouldTransitionToNeedsHuman(turnOutput: string): boolean {
    const blockers = this.detectBlockers(turnOutput);
    return blockers.length > 0 && blockers.some(b => b.confidence > 0.7);
  }

  // Extract human-readable blocker description
  private static extractBlockerDescription(turnOutput: string, type: string): string {
    // Simple extraction: find sentences containing the blocker type
    const sentences = turnOutput.split(/[.!?]+/);
    const relevantSentences = sentences.filter(s => 
      s.toLowerCase().includes(type)
    );
    return relevantSentences.length > 0 
      ? relevantSentences[0].trim() 
      : `Detected ${type} dependency`;
  }

  // Calculate confidence score for blocker detection
  private static calculateConfidence(text: string, type: string): number {
    const indicators = {
      approval: ['need approval', 'requires approval', 'awaiting approval'],
      human: ['need human', 'requires human', 'manual intervention'],
      permission: ['need permission', 'access denied', 'insufficient privileges'],
      credential: ['api key', 'credential', 'authentication', 'unauthorized']
    };

    const typeIndicators = indicators[type as keyof typeof indicators] || [];
    let confidence = 0;

    for (const indicator of typeIndicators) {
      if (text.includes(indicator)) {
        confidence += 0.3;
      }
    }

    return Math.min(confidence, 1.0);
  }

  // Check if text matches any of the patterns
  private static matchesPattern(text: string, patterns: string[]): boolean {
    return patterns.some(pattern => text.includes(pattern));
  }
}
```

**Verification**:
- Test with explicit approval blocker: "Need approval from Josh" → detected, confidence > 0.8
- Test with credential blocker: "Missing API key" → detected as credential blocker
- Test with multiple blockers: "Need human approval and valid credentials" → both detected
- Test with no blockers: normal output → no blockers detected, no state transition
- Test confidence threshold: weak indicators don't trigger transition

### 2.4 State Machine & Lease Unit Tests

**File**: `tests/unit/daemon/goal-state-machine.test.ts`

**Test coverage**:
1. Valid transitions: queued→claimed, running→verifying, verifying→done
2. Invalid transitions throw errors
3. Terminal state detection
4. Retry state detection
5. Lease generation and validation
6. Lease expiry detection
7. Lease renewal (valid and expired cases)
8. Lease clearing

**Success criteria**: All transitions validated, lease protocol robust

## Phase 3: Verification Gate (Days 7-8)

### 3.0 Critical Contract: Per-Goal Validation Profiles

**File**: `src/daemon/goal-validation-profiles.ts`

**Implementation Requirements**:
- **Explicit validation profiles**: Support intentional per-goal validation profile selection
- **Safe default**: Retain safe default profile for goals without explicit profile
- **Profile selection**: Test selection and failure/retry behavior
- **No repo-wide npm test dependency**: Support intentional, explicit per-goal validation

```typescript
export interface GoalValidationProfile {
  id: string;
  name: string;
  description: string;
  acceptanceChecks: GoalAcceptanceCheck[];
  isDefault: boolean;
}

export class GoalValidationProfiles {
  private static profiles: Map<string, GoalValidationProfile> = new Map();

  // Initialize built-in profiles
  static initialize(): void {
    this.registerProfile({
      id: 'default',
      name: 'Default Safe Profile',
      description: 'Safe default validation with build and test',
      acceptanceChecks: [
        {
          id: 'build',
          command: ['npm', 'run', 'build'],
          timeoutMs: 5 * 60 * 1000, // 5 minutes
          required: true,
          description: 'Project builds successfully'
        },
        {
          id: 'test',
          command: ['npm', 'test'],
          timeoutMs: 10 * 60 * 1000, // 10 minutes
          required: true,
          description: 'All tests pass'
        }
      ],
      isDefault: true
    });

    this.registerProfile({
      id: 'build-only',
      name: 'Build Only',
      description: 'Validation without test suite',
      acceptanceChecks: [
        {
          id: 'build',
          command: ['npm', 'run', 'build'],
          timeoutMs: 5 * 60 * 1000,
          required: true,
          description: 'Project builds successfully'
        }
      ],
      isDefault: false
    });

    this.registerProfile({
      id: 'typecheck-only',
      name: 'Typecheck Only',
      description: 'TypeScript type checking without build',
      acceptanceChecks: [
        {
          id: 'typecheck',
          command: ['npx', 'tsc', '--noEmit'],
          timeoutMs: 3 * 60 * 1000,
          required: true,
          description: 'TypeScript type checking passes'
        }
      ],
      isDefault: false
    });

    this.registerProfile({
      id: 'lint-only',
      name: 'Lint Only',
      description: 'Linting without build or test',
      acceptanceChecks: [
        {
          id: 'lint',
          command: ['npm', 'run', 'lint'],
          timeoutMs: 2 * 60 * 1000,
          required: true,
          description: 'Linting passes'
        }
      ],
      isDefault: false
    });

    this.registerProfile({
      id: 'minimal',
      name: 'Minimal Validation',
      description: 'No validation checks for emergency fixes',
      acceptanceChecks: [],
      isDefault: false
    });
  }

  // Register a custom profile
  static registerProfile(profile: GoalValidationProfile): void {
    this.profiles.set(profile.id, profile);
  }

  // Get profile by ID, return default if not found
  static getProfile(profileId?: string): GoalValidationProfile {
    if (!profileId) {
      return this.getDefaultProfile();
    }

    const profile = this.profiles.get(profileId);
    if (profile) {
      return profile;
    }

    console.warn(`Validation profile '${profileId}' not found, using default`);
    return this.getDefaultProfile();
  }

  // Get default profile
  static getDefaultProfile(): GoalValidationProfile {
    const defaultProfile = Array.from(this.profiles.values()).find(p => p.isDefault);
    if (!defaultProfile) {
      throw new Error('No default validation profile configured');
    }
    return defaultProfile;
  }

  // List all available profiles
  static listProfiles(): GoalValidationProfile[] {
    return Array.from(this.profiles.values());
  }

  // Parse profile from goal input (e.g., "/goal objective --profile build-only")
  static parseProfileFromGoal(goal: string): { goal: string; profileId?: string } {
    const profileMatch = goal.match(/--profile\s+(\S+)/);
    if (profileMatch) {
      const profileId = profileMatch[1];
      const cleanedGoal = goal.replace(/--profile\s+\S+/, '').trim();
      return { goal: cleanedGoal, profileId };
    }
    return { goal, profileId: undefined };
  }
}
```

**Verification**:
- Test default profile selection: goal without --profile uses default
- Test explicit profile selection: "/goal objective --profile build-only" uses build-only profile
- Test invalid profile: unknown profile falls back to default with warning
- Test profile behavior: different profiles execute different acceptance checks
- Test failure/retry: failed validation checks trigger retry_wait state

### 3.1 Verifier Implementation

**File**: `src/daemon/goal-verifier.ts`

**Implementation**:
```typescript
export class GoalVerifier {
  private config: GoalConfig;

  constructor(config: GoalConfig) {
    this.config = config;
  }

  // Execute all acceptance checks for a goal run
  async verify(run: GoalRun): Promise<{
    passed: boolean;
    results: Array<{
      checkId: string;
      passed: boolean;
      duration: number;
      output: string;
      error?: string;
    }>;
    artifacts: GoalArtifact[];
  }> {
    const results: Array<{
      checkId: string;
      passed: boolean;
      duration: number;
      output: string;
      error?: string;
    }> = [];
    const artifacts: GoalArtifact[] = [];

    for (const check of run.acceptanceChecks) {
      const startTime = Date.now();
      let passed = false;
      let output = '';
      let error: string | undefined;

      try {
        output = await this.executeCheck(check, run);
        passed = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        output = error;
        passed = false;
      }

      const duration = Date.now() - startTime;

      results.push({
        checkId: check.id,
        passed,
        duration,
        output,
        error
      });

      // Capture stdout/stderr as artifacts
      artifacts.push({
        id: uuidv4(),
        type: 'stdout',
        content: output,
        timestamp: new Date().toISOString(),
        metadata: {
          checkId: check.id,
          duration,
          passed
        }
      });

      // Fail fast if required check fails
      if (!passed && check.required) {
        break;
      }
    }

    const allRequiredPassed = results.every(r => {
      const check = run.acceptanceChecks.find(c => c.id === r.checkId);
      return !check?.required || r.passed;
    });

    return {
      passed: allRequiredPassed,
      results,
      artifacts
    };
  }

  private async executeCheck(check: GoalAcceptanceCheck, run: GoalRun): Promise<string> {
    const { command, timeoutMs } = check;
    const { spawn } = require('child_process');

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const child = spawn(command[0], command.slice(1), {
        cwd: run.repo,
        timeout: timeoutMs
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

      child.on('error', (err: Error) => {
        reject(new Error(`Check execution failed: ${err.message}`));
      });
    });
  }

  // Determine next state based on verification results
  determineNextState(run: GoalRun, results: Array<{ checkId: string; passed: boolean }>): GoalRunState {
    // Check if exhausted
    if (run.attempt >= run.maxAttempts) {
      return 'exhausted';
    }

    // Check if any required check failed
    const failedRequired = results.some(r => {
      const check = run.acceptanceChecks.find(c => c.id === r.checkId);
      return check?.required && !r.passed;
    });

    if (failedRequired) {
      return 'retry_wait';
    }

    // All checks passed
    return 'done';
  }
}
```

**Verification**: Check execution, timeout handling, artifact capture, state determination

### 3.2 Configuration Defaults

**File**: `src/daemon/goal-config.ts`

**Implementation**:
```typescript
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

export function loadGoalConfig(configPath?: string): GoalConfig {
  // Load from config file if provided, otherwise use defaults
  return { ...DEFAULT_GOAL_CONFIG };
}
```

**Verification**: Config loading, default values, validation

### 3.3 Verifier Unit Tests

**File**: `tests/unit/daemon/goal-verifier.test.ts`

**Test coverage**:
1. Single check execution (pass/fail)
2. Multiple checks with required/optional
3. Timeout enforcement
4. Artifact capture (stdout/stderr)
5. State determination logic
6. Exhaustion detection
7. Error handling

**Success criteria**: All checks execute correctly, timeouts work, artifacts captured

## Phase 4: Event Logging & Retention (Day 9)

### 4.0 Critical Contract: Retention/Pruning for Events and Artifacts

**File**: `src/daemon/goal-retention.ts`

**Implementation Requirements**:
- **Event retention**: Automatic pruning of events older than eventRetentionDays
- **Artifact pruning**: Remove inline stdout/stderr artifacts based on retention policy
- **Configurable retention**: Use eventRetentionDays from GoalConfig
- **Selective pruning**: Preserve terminal state events, prune intermediate events
- **Safe cleanup**: Atomic operations to prevent data loss

```typescript
export class GoalRetention {
  private store: GoalRunStore;
  private config: GoalConfig;

  constructor(store: GoalRunStore, config: GoalConfig) {
    this.store = store;
    this.config = config;
  }

  // Prune old events and artifacts for all runs
  async pruneAllRuns(agentName: string): Promise<{
    eventsPruned: number;
    artifactsPruned: number;
    runsProcessed: number;
  }> {
    const allRuns = await this.store.list(agentName);
    
    let eventsPruned = 0;
    let artifactsPruned = 0;
    let runsProcessed = 0;

    for (const run of allRuns) {
      // Skip terminal runs that are recent
      if (GoalStateMachine.isTerminal(run.state) && this.isRecent(run)) {
        continue;
      }

      try {
        const result = await this.pruneRun(agentName, run.id, run.leaseToken || '');
        eventsPruned += result.eventsPruned;
        artifactsPruned += result.artifactsPruned;
        runsProcessed++;
      } catch (error) {
        console.error(`Failed to prune run ${run.id}:`, error);
      }
    }

    return { eventsPruned, artifactsPruned, runsProcessed };
  }

  // Prune events and artifacts for a specific run
  async pruneRun(agentName: string, runId: string, leaseToken: string): Promise<{
    eventsPruned: number;
    artifactsPruned: number;
  }> {
    const run = await this.store.get(agentName, runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const cutoffDate = new Date(Date.now() - this.config.eventRetentionDays * 24 * 60 * 60 * 1000);
    
    // Preserve terminal events and recent events
    const terminalEventTypes = ['run_created', 'done', 'needs_human', 'exhausted', 'cancelled'];
    const eventsToKeep = run.events.filter(event => 
      terminalEventTypes.includes(event.type) || new Date(event.timestamp) >= cutoffDate
    );

    // Prune old inline artifacts (stdout/stderr)
    const artifactsToKeep = run.artifacts.filter(artifact => 
      artifact.type !== 'stdout' && artifact.type !== 'stderr' || 
      new Date(artifact.timestamp) >= cutoffDate
    );

    const eventsPruned = run.events.length - eventsToKeep.length;
    const artifactsPruned = run.artifacts.length - artifactsToKeep.length;

    if (eventsPruned > 0 || artifactsPruned > 0) {
      await this.store.update(agentName, runId, leaseToken, (current) => ({
        ...current,
        events: eventsToKeep,
        artifacts: artifactsToKeep,
        updatedAt: new Date().toISOString()
      }));
    }

    return { eventsPruned, artifactsPruned };
  }

  // Check if run is recent (within retention period)
  private isRecent(run: GoalRun): boolean {
    const retentionMs = this.config.eventRetentionDays * 24 * 60 * 60 * 1000;
    const runAge = Date.now() - new Date(run.createdAt).getTime();
    return runAge < retentionMs;
  }

  // Get retention statistics
  async getRetentionStats(agentName: string): Promise<{
    totalRuns: number;
    runsWithPrunedEvents: number;
    totalEvents: number;
    prunedEvents: number;
    totalArtifacts: number;
    prunedArtifacts: number;
  }> {
    const allRuns = await this.store.list(agentName);
    
    let totalEvents = 0;
    let totalArtifacts = 0;
    let prunedEvents = 0;
    let prunedArtifacts = 0;
    let runsWithPrunedEvents = 0;

    for (const run of allRuns) {
      totalEvents += run.events.length;
      totalArtifacts += run.artifacts.length;

      // Estimate pruned content based on run age
      if (!this.isRecent(run)) {
        const oldEvents = run.events.filter(e => 
          new Date(e.timestamp) < new Date(Date.now() - this.config.eventRetentionDays * 24 * 60 * 60 * 1000)
        );
        const oldArtifacts = run.artifacts.filter(a => 
          (a.type === 'stdout' || a.type === 'stderr') &&
          new Date(a.timestamp) < new Date(Date.now() - this.config.eventRetentionDays * 24 * 60 * 60 * 1000)
        );

        prunedEvents += oldEvents.length;
        prunedArtifacts += oldArtifacts.length;

        if (oldEvents.length > 0 || oldArtifacts.length > 0) {
          runsWithPrunedEvents++;
        }
      }
    }

    return {
      totalRuns: allRuns.length,
      runsWithPrunedEvents,
      totalEvents,
      prunedEvents,
      totalArtifacts,
      prunedArtifacts
    };
  }
}
```

**Verification**:
- Test event pruning: old events removed, terminal/recent events preserved
- Test artifact pruning: old stdout/stderr removed, file artifacts preserved
- Test retention stats: accurate counts of total vs pruned content
- Test config respect: different eventRetentionDays values produce different pruning behavior
- Test atomic operations: pruning doesn't corrupt run data

### 4.1 Event Logger Implementation

**File**: `src/daemon/goal-event-logger.ts`

**Implementation**:
```typescript
export class GoalEventLogger {
  // Append event to run (via store update)
  static async logEvent(store: GoalRunStore, agentName: string, runId: string, leaseToken: string, event: Omit<GoalRunEvent, 'id' | 'timestamp'>): Promise<void> {
    await store.update(agentName, runId, leaseToken, (run) => {
      const newEvent: GoalRunEvent = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        ...event
      };

      return {
        ...run,
        events: [...run.events, newEvent],
        updatedAt: new Date().toISOString()
      };
    });
  }

  // Query events by type
  static async getEventsByType(store: GoalRunStore, agentName: string, runId: string, eventType: GoalRunEvent['type']): Promise<GoalRunEvent[]> {
    const run = await store.get(agentName, runId);
    if (!run) return [];

    return run.events.filter(e => e.type === eventType);
  }

  // Get recent events (for debugging/status)
  static async getRecentEvents(store: GoalRunStore, agentName: string, runId: string, limit: number = 10): Promise<GoalRunEvent[]> {
    const run = await store.get(agentName, runId);
    if (!run) return [];

    return run.events.slice(-limit);
  }
}
```

**Verification**: Event appending, type filtering, recent events query

### 4.2 Event Logger Unit Tests

**File**: `tests/unit/daemon/goal-event-logger.test.ts`

**Test coverage**:
1. Event appending with lease validation
2. Event type filtering
3. Recent events limiting
4. Event preservation across state changes

**Success criteria**: Events persist correctly, queries work as expected

## Phase 5: Thread Management (Days 10-11)

### 5.1 Thread Manager Implementation

**File**: `src/daemon/goal-thread-manager.ts`

**Implementation**:
```typescript
export class GoalThreadManager {
  private codexApi: any; // Codex App Server API client

  constructor(codexApi: any) {
    this.codexApi = codexApi;
  }

  // Create dedicated thread for new run
  async createThread(run: GoalRun): Promise<string> {
    const thread = await this.codexApi.createThread({
      goal: run.goal,
      repo: run.repo,
      worktree: run.worktree
    });

    return thread.id;
  }

  // Resume existing thread by ID
  async resumeThread(threadId: string): Promise<void> {
    await this.codexApi.resumeThread(threadId);
  }

  // Set native goal on thread (projection)
  async setThreadGoal(threadId: string, goal: string): Promise<void> {
    await this.codexApi.setThreadGoal(threadId, goal);
  }

  // Get thread status
  async getThreadStatus(threadId: string): Promise<{
    active: boolean;
    goal: string | null;
    lastActivity: string;
  }> {
    return await this.codexApi.getThreadStatus(threadId);
  }
}
```

**Verification**: Thread creation, resume, goal setting, status checking

### 5.2 Thread Manager Unit Tests

**File**: `tests/unit/daemon/goal-thread-manager.test.ts`

**Test coverage**:
1. Thread creation with goal/repo/worktree
2. Thread resume by ID
3. Native goal setting
4. Thread status retrieval
5. Error handling for invalid thread IDs

**Success criteria**: Thread lifecycle management works correctly

## Phase 6: Runner Integration (Days 12-14)

### 6.0 Critical Contract: Bounded Periodic Runner Tick Plus Startup Resume

**File**: `src/daemon/goal-runner.ts`

**Implementation Requirements**:
- **Periodic tick**: Bounded interval execution across all configured agents
- **Startup resume**: Queued, retry_wait-after-backoff, and expired-lease orphan runs resume after restart
- **Cross-agent coordination**: Support multiple agents with separate run queues
- **Bounded execution**: Tick duration limits to prevent starvation
- **Graceful shutdown**: Complete current processing before exit

```typescript
export class GoalRunner {
  private store: GoalRunStore;
  private stateMachine: typeof GoalStateMachine;
  private leaseProtocol: typeof GoalLeaseProtocol;
  private verifier: GoalVerifier;
  private threadManager: GoalThreadManager;
  private config: GoalConfig;
  private runnerId: string;
  private tickIntervalMs: number;
  private tickTimeoutMs: number;
  private isRunning: boolean = false;
  private tickTimer?: NodeJS.Timeout;
  private configuredAgents: string[];

  constructor(
    store: GoalRunStore,
    config: GoalConfig,
    threadManager: GoalThreadManager,
    configuredAgents: string[]
  ) {
    this.store = store;
    this.config = config;
    this.threadManager = threadManager;
    this.runnerId = `runner-${uuidv4()}`;
    this.verifier = new GoalVerifier(config);
    this.tickIntervalMs = 30 * 1000; // 30 seconds
    this.tickTimeoutMs = 25 * 1000; // 25 seconds (leave 5s buffer)
    this.configuredAgents = configuredAgents;
  }

  // Start periodic tick processing
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    
    // Immediate startup resume
    await this.performStartupResume();
    
    // Start periodic tick
    this.tickTimer = setInterval(() => {
      this.processTickSafe().catch(error => {
        console.error('Tick processing error:', error);
      });
    }, this.tickIntervalMs);
  }

  // Stop periodic tick processing gracefully
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }

    // Wait for current tick to complete (bounded wait)
    await new Promise(resolve => setTimeout(resolve, this.tickTimeoutMs + 1000));
  }

  // Startup resume: reclaim orphaned runs after restart
  private async performStartupResume(): Promise<void> {
    console.log('Performing startup resume for orphaned runs...');
    
    for (const agentName of this.configuredAgents) {
      try {
        await this.resumeAgentRuns(agentName);
      } catch (error) {
        console.error(`Failed to resume runs for agent ${agentName}:`, error);
      }
    }
  }

  // Resume orphaned runs for a specific agent
  private async resumeAgentRuns(agentName: string): Promise<void> {
    const allRuns = await this.store.list(agentName);
    
    for (const run of allRuns) {
      // Skip terminal states
      if (GoalStateMachine.isTerminal(run.state)) {
        continue;
      }

      // Resume queued runs
      if (run.state === 'queued') {
        console.log(`Resuming queued run: ${run.id}`);
        continue;
      }

      // Resume retry_wait runs where backoff has elapsed
      if (run.state === 'retry_wait') {
        const retryAt = this.calculateRetryAt(run);
        if (new Date() >= retryAt) {
          console.log(`Resuming retry_wait run: ${run.id}`);
        }
        continue;
      }

      // Reclaim expired-lease orphan runs
      if (run.leaseOwner && GoalLeaseProtocol.isExpired(run)) {
        console.log(`Reclaiming expired-lease orphan run: ${run.id}`);
        
        // Clear expired lease to allow re-claim
        await this.store.update(agentName, run.id, run.leaseToken || '', (current) => {
          const cleared = GoalLeaseProtocol.clear(current);
          // Transition back to queued for re-claim
          return GoalStateMachine.transition(cleared, 'queued', {
            reason: 'expired_lease_reclaim'
          });
        });
      }
    }
  }

  // Safe tick processing with timeout guard
  private async processTickSafe(): Promise<void> {
    const tickStart = Date.now();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Tick timeout')), this.tickTimeoutMs)
    );

    try {
      await Promise.race([
        this.processAllAgents(),
        timeoutPromise
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === 'Tick timeout') {
        console.warn('Tick processing exceeded timeout, will retry next interval');
      } else {
        throw error;
      }
    } finally {
      const tickDuration = Date.now() - tickStart;
      if (tickDuration > this.tickTimeoutMs / 2) {
        console.warn(`Tick processing took ${tickDuration}ms, approaching timeout`);
      }
    }
  }

  // Process all configured agents
  private async processAllAgents(): Promise<void> {
    for (const agentName of this.configuredAgents) {
      await this.processTick(agentName);
    }
  }

  // Main daemon tick: find and process candidate runs
  async processTick(agentName: string): Promise<void> {
    const candidates = await this.findCandidateRuns(agentName);

    for (const run of candidates) {
      try {
        await this.processRun(run);
      } catch (error) {
        console.error(`Failed to process run ${run.id}:`, error);
        // Log error event but continue with other candidates
        await this.logErrorEvent(run, error);
      }
    }
  }

  // Find candidate runs for processing
  private async findCandidateRuns(agentName: string): Promise<GoalRun[]> {
    const allRuns = await this.store.list(agentName);
    const now = new Date();

    return allRuns.filter(run => {
      // Queued runs
      if (run.state === 'queued') {
        return true;
      }

      // Retry-wait runs where delay has elapsed
      if (run.state === 'retry_wait') {
        const retryAt = this.calculateRetryAt(run);
        return now >= retryAt;
      }

      // Expired lease runs
      if (GoalLeaseProtocol.isExpired(run)) {
        return !GoalStateMachine.isTerminal(run.state);
      }

      return false;
    });
  }

  // Process a single run
  private async processRun(run: GoalRun): Promise<void> {
    // Claim the run
    const claimed = await this.claimRun(run);
    if (!claimed) {
      return; // Already claimed by another runner
    }

    try {
      // Execute based on state
      switch (claimed.state) {
        case 'claimed':
          await this.executeClaimed(claimed);
          break;
        case 'retry_wait':
          await this.executeRetry(claimed);
          break;
        default:
          console.warn(`Unexpected state for claimed run: ${claimed.state}`);
      }
    } finally {
      // Always clear lease when done
      await this.clearLease(claimed);
    }
  }

  // Claim a run with lease
  private async claimRun(run: GoalRun): Promise<GoalRun | null> {
    const lease = GoalLeaseProtocol.generateLease(this.runnerId);

    try {
      return await this.store.update(run.agentName, run.id, run.leaseToken || '', (current) => {
        // Validate no one else claimed it
        if (current.leaseToken && current.leaseToken !== run.leaseToken) {
          throw new Error('Run already claimed by another runner');
        }

        // Transition to claimed
        const updated = GoalStateMachine.transition(current, 'claimed', {
          leaseOwner: lease.leaseOwner,
          leaseToken: lease.leaseToken
        });

        return {
          ...updated,
          leaseOwner: lease.leaseOwner,
          leaseToken: lease.leaseToken,
          leaseExpiresAt: lease.leaseExpiresAt
        };
      });
    } catch (error) {
      // Claim failed (race condition or invalid transition)
      return null;
    }
  }

  // Execute newly claimed run
  private async executeClaimed(run: GoalRun): Promise<void> {
    // Create or resume thread
    let threadId = run.threadId;
    if (!threadId) {
      threadId = await this.threadManager.createThread(run);

      // Update run with thread ID
      run = await this.store.update(run.agentName, run.id, run.leaseToken!, (current) => ({
        ...current,
        threadId,
        updatedAt: new Date().toISOString()
      }));
    } else {
      await this.threadManager.resumeThread(threadId);
    }

    // Set native goal (projection)
    await this.threadManager.setThreadGoal(threadId, run.goal);

    // Transition to running
    run = await this.store.update(run.agentName, run.id, run.leaseToken!, (current) =>
      GoalStateMachine.transition(current, 'running')
    );

    // Dispatch prompt with goal context
    await this.dispatchPrompt(run);

    // Transition to verifying
    run = await this.store.update(run.agentName, run.id, run.leaseToken!, (current) =>
      GoalStateMachine.transition(current, 'verifying')
    );

    // Execute verification
    const verification = await this.verifier.verify(run);

    // Determine next state
    const nextState = this.verifier.determineNextState(run, verification.results);

    // Transition to final state
    run = await this.store.update(run.agentName, run.id, run.leaseToken!, (current) =>
      GoalStateMachine.transition(current, nextState, {
        verificationResults: verification.results,
        artifacts: verification.artifacts
      })
    );
  }

  // Execute retry run
  private async executeRetry(run: GoalRun): Promise<void> {
    // Increment attempt
    run = await this.store.update(run.agentName, run.id, run.leaseToken!, (current) => ({
      ...current,
      attempt: current.attempt + 1,
      updatedAt: new Date().toISOString()
    }));

    // Execute as claimed run
    await this.executeClaimed(run);
  }

  // Dispatch prompt to thread
  private async dispatchPrompt(run: GoalRun): Promise<void> {
    const prompt = this.buildDispatchPrompt(run);
    // Send to Codex App Server for execution
    // Implementation depends on Codex API
  }

  // Build dispatch prompt with finish pressure
  private buildDispatchPrompt(run: GoalRun): string {
    const checks = run.acceptanceChecks.map(c =>
      `- ${c.required ? '[REQUIRED]' : '[OPTIONAL]'} ${c.command.join(' ')} (timeout: ${c.timeoutMs}ms)`
    ).join('\n');

    return `You are working on goal: "${run.goal}"

This is attempt ${run.attempt + 1} of ${run.maxAttempts}.

ACCEPTANCE CHECKS:
${checks}

ARTIFACT LOCATION: ${run.repo}

INVARIANT: Do not report completion until all required acceptance checks pass.
If blocked, name the concrete human/approval dependency.
Otherwise, continue by taking the next safe implementation or verification action.

Continue working until the goal is complete or you hit a blocker.`;
  }

  // Calculate retry timestamp with exponential backoff
  private calculateRetryAt(run: GoalRun): Date {
    const delay = Math.min(
      this.config.retryDelayMs * Math.pow(2, run.attempt),
      this.config.retryMaxDelayMs
    );
    return new Date(Date.now() + delay);
  }

  // Clear lease when done
  private async clearLease(run: GoalRun): Promise<void> {
    await this.store.update(run.agentName, run.id, run.leaseToken!, (current) =>
      GoalLeaseProtocol.clear(current)
    );
  }

  // Log error event
  private async logErrorEvent(run: GoalRun, error: unknown): Promise<void> {
    await GoalEventLogger.logEvent(this.store, run.agentName, run.id, run.leaseToken!, {
      type: 'error',
      data: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    });
  }
}
```

**Verification**: Candidate selection, claim execution, retry logic, dispatch prompting

### 6.2 Runner Unit Tests

**File**: `tests/unit/daemon/goal-runner.test.ts`

**Test coverage**:
1. Candidate run selection (queued, retry_wait, expired lease)
2. Run claiming with lease
3. Claim race condition rejection
4. Thread creation and resume
5. Dispatch prompt generation
6. Retry delay calculation
7. Verification state transitions
8. Error handling and logging

**Success criteria**: Runner processes runs correctly, lease protocol works, retries function

## Phase 7: Ingress Integration (Days 15-16)

### 7.1 `/goal` Command Extension

**File**: `src/pty/codex-app-server-pty.ts`

**Implementation**:
Extend existing `/goal` command routing to use durable control plane:

```typescript
// Add to existing CodexAppServerPty class
private goalRunStore?: GoalRunStore;
private goalRunner?: GoalRunner;

// Initialize during startup
async initializeGoalIntegration(): Promise<void> {
  const stateRoot = this.getStateRoot(); // Get from daemon config
  const config = loadGoalConfig();

  this.goalRunStore = new GoalRunStore(stateRoot);
  await this.goalRunStore.initialize();

  // Thread manager would be initialized with Codex API
  // const threadManager = new GoalThreadManager(this.codexApi);
  // this.goalRunner = new GoalRunner(this.goalRunStore, config, threadManager);
}

// Handle `/goal <objective>` command
async handleGoalCommand(objective: string): Promise<void> {
  if (!this.goalRunStore) {
    // Fallback to native goal if daemon integration unavailable
    return this.handleNativeGoal(objective);
  }

  const run: GoalRun = {
    id: uuidv4(),
    agentName: this.getAgentName(), // Get from context
    goal: objective,
    repo: process.cwd(), // Current working directory
    worktree: undefined, // Could be detected from git worktree
    state: 'queued',
    threadId: undefined,
    leaseOwner: undefined,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    attempt: 0,
    maxAttempts: DEFAULT_GOAL_CONFIG.maxAttempts,
    acceptanceChecks: this.getDefaultAcceptanceChecks(),
    artifacts: [],
    events: [{
      id: uuidv4(),
      type: 'run_created',
      timestamp: new Date().toISOString(),
      data: { objective }
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await this.goalRunStore.create(run);
  console.log(`Goal run queued: ${run.id}`);

  // Request dispatch by signaling daemon
  await this.requestDispatch(run);
}

// Handle `/goal` (no arguments) - list active runs
async handleGoalList(): Promise<void> {
  if (!this.goalRunStore) {
    return this.handleNativeGoalList();
  }

  const agentName = this.getAgentName();
  const activeRuns = await this.goalRunStore.list(agentName);

  if (activeRuns.length === 0) {
    console.log('No active goal runs');
    return;
  }

  console.log('Active goal runs:');
  for (const run of activeRuns) {
    const age = Math.floor((Date.now() - new Date(run.createdAt).getTime()) / 1000 / 60);
    console.log(`- ${run.id}: ${run.goal} (${run.state}, ${age}m ago)`);
  }
}

// Handle `/goal clear` - cancel non-running run
async handleGoalClear(runId?: string): Promise<void> {
  if (!this.goalRunStore) {
    return this.handleNativeGoalClear();
  }

  const agentName = this.getAgentName();

  if (runId) {
    // Cancel specific run
    const run = await this.goalRunStore.get(agentName, runId);
    if (!run) {
      console.log(`Run ${runId} not found`);
      return;
    }

    if (run.state === 'running') {
      console.log(`Cannot cancel running run ${runId}. Use /goal clear ${runId} --force to confirm.`);
      return;
    }

    await this.goalRunStore.update(agentName, runId, run.leaseToken || '', (current) =>
      GoalStateMachine.transition(current, 'cancelled')
    );

    console.log(`Cancelled run ${runId}`);
  } else {
    // List active runs for selection
    const activeRuns = await this.goalRunStore.list(agentName);
    const nonRunning = activeRuns.filter(r => r.state !== 'running');

    if (nonRunning.length === 0) {
      console.log('No non-running goal runs to cancel');
      return;
    }

    console.log('Non-running goal runs:');
    for (const run of nonRunning) {
      console.log(`- ${run.id}: ${run.goal} (${run.state})`);
    }
    console.log('Use /goal clear <id> to cancel a specific run');
  }
}

// Get default acceptance checks for repo
private getDefaultAcceptanceChecks(): GoalAcceptanceCheck[] {
  // Could be detected from repo type, tests, etc.
  return [
    {
      id: 'build',
      command: ['npm', 'run', 'build'],
      timeoutMs: DEFAULT_GOAL_CONFIG.checkTimeoutMs,
      required: true,
      description: 'Project builds successfully'
    },
    {
      id: 'test',
      command: ['npm', 'test'],
      timeoutMs: DEFAULT_GOAL_CONFIG.checkTimeoutMs,
      required: true,
      description: 'All tests pass'
    }
  ];
}
```

**Verification**: Goal creation, listing, cancellation, backward compatibility

### 7.2 Ingress Unit Tests

**File**: `tests/unit/pty/codex-app-server-pty.test.ts`

**Test coverage** (extend existing tests):
1. `/goal <objective>` creates queued run
2. `/goal` lists active runs
3. `/goal clear` cancels non-running run
4. `/goal clear <id>` cancels specific run
5. `/goal clear` rejects running run without force
6. Default acceptance checks generation
7. Fallback to native goal when daemon unavailable
8. Repo detection from cwd

**Success criteria**: All ingress operations work, backward compatibility maintained

## Phase 8: End-to-End Testing (Days 17-18)

### 8.1 Integration Tests

**File**: `tests/integration/goal-run-control-plane.test.ts`

**Test scenarios**:
1. **Full lifecycle**: enqueue → claim → execute → verify → done
2. **Concurrent claims**: two runners compete for same run, only one succeeds
3. **Stale token rejection**: worker with old lease token cannot update run
4. **Lease expiry reclaim**: expired lease allows new claim
5. **Retry flow**: failure → retry_wait → re-claim → execute → done
6. **Exhaustion**: max attempts reached → exhausted state
7. **Human dependency**: approval required → needs_human state
8. **Thread resume**: restart reclaims and resumes stored thread
9. **Cancellation**: non-running run cancelled successfully
10. **Error recovery**: process crash during running → re-claim → resume

**Success criteria**: All integration scenarios pass, state consistency verified

### 8.2 Regression Tests

**Verification**: Existing tests remain green
- Native goal set/get/clear functionality
- Codex lifecycle mock tests
- App Server PTY routing
- No breaking changes to existing behavior

**Success criteria**: `npm run build && npm test` passes completely

## Implementation Verification Matrix

| Component | Unit Tests | Integration Tests | Regression Tests |
|-----------|------------|-------------------|------------------|
| **Store** | ✅ CRUD operations, atomic writes | ✅ Concurrent access, file locking | ✅ No breaking changes |
| **Lock (CAS)** | ✅ O_EXCL semantics, stale-lock recovery, process liveness | ✅ Concurrent claim test (exactly 1 winner), process crash recovery | ✅ No deadlocks, no orphaned locks |
| **State Machine** | ✅ All transitions, validation | ✅ End-to-end state flows | ✅ Native goal behavior |
| **Lease Protocol** | ✅ Generation, validation, expiry | ✅ Claim competition, reclaim | ✅ No deadlocks |
| **Blocker Parser** | ✅ Parse Codex output, detect blockers, confidence scoring | ✅ needs_human transition, multiple blocker types | ✅ No false positives/negatives |
| **Verifier** | ✅ Check execution, timeouts | ✅ Full verification flows | ✅ No hanging checks |
| **Validation Profiles** | ✅ Profile selection, default fallback, per-goal profiles | ✅ Different profile behaviors, failure/retry | ✅ Safe default behavior |
| **Event Logger** | ✅ Event appending, queries | ✅ Event persistence | ✅ No event loss |
| **Retention** | ✅ Event pruning, artifact cleanup, retention stats | ✅ Config-driven behavior, atomic operations | ✅ No data loss, no corruption |
| **Thread Manager** | ✅ Thread lifecycle | ✅ Thread resume | ✅ No thread leaks |
| **Runner** | ✅ Candidate selection, execution, periodic tick, startup resume | ✅ Full runner flows, cross-agent coordination | ✅ No stuck runs |
| **Ingress** | ✅ Command handling, /goal fallback | ✅ Full user flows, PTY integration | ✅ Backward compatibility |

### Critical Test Coverage Requirements

#### Store/Lock Tests (`tests/unit/daemon/goal-lock.test.ts`)
1. **Concurrent claim test**: 10 processes try simultaneously, exactly 1 succeeds
2. **Stale lock recovery**: abandon lock, wait past timeout, new claim succeeds  
3. **Process crash recovery**: kill locked process, lock becomes stale and reclaimable
4. **File system atomicity**: no race conditions in lock acquisition
5. **Lock release**: only owner can release, atomic unlock
6. **Multiple run IDs**: different runs don't interfere with each other's locks

#### Runner/Retry+Resume Tests (`tests/unit/daemon/goal-runner.test.ts`)
1. **Startup resume**: queued runs resume after daemon restart
2. **Retry_wait resume**: backoff elapsed runs resume after restart
3. **Expired-lease reclaim**: orphan runs reclaimed after restart
4. **Periodic tick**: tick processes all configured agents
5. **Bounded execution**: tick timeout prevents starvation
6. **Graceful shutdown**: current processing completes before exit
7. **Cross-agent coordination**: multiple agents processed independently

#### Verifier/Profile Tests (`tests/unit/daemon/goal-verifier.test.ts`)
1. **Default profile**: goals without --profile use safe default
2. **Explicit profile**: --profile selects correct validation profile
3. **Invalid profile**: unknown profile falls back to default with warning
4. **Profile behavior**: different profiles execute different checks
5. **Failure/retry**: failed validation triggers retry_wait state
6. **Max attempts**: exhausted after max retries with failed checks

#### Thread Manager Tests (`tests/unit/daemon/goal-thread-manager.test.ts`)
1. **Thread creation**: new thread created with goal/repo/worktree
2. **Thread resume**: existing thread resumed by ID
3. **Thread status**: current status retrieved correctly
4. **Thread cleanup**: orphan threads cleaned up on restart

#### Event Logger Tests (`tests/unit/daemon/goal-event-logger.test.ts`)
1. **Event appending**: events added with correct timestamps
2. **Event persistence**: events survive state changes
3. **Event querying**: events filtered by type correctly
4. **Recent events**: limited query returns correct number

#### PTY Ingress/Integration Tests (`tests/integration/codex-app-server-pty.test.ts`)
1. **/goal fallback**: native goal used when daemon unavailable
2. **/goal <objective>**: creates durable run with correct state
3. **/goal list**: shows active runs with correct information
4. **/goal clear**: cancels non-running runs safely
5. **Arg-array spawning**: commands executed as arg arrays, no shell interpolation
6. **No auto push/merge/deploy**: no automatic git operations
7. **Atomic data writes**: run state updated atomically

#### Concurrent-Claim Integration Tests (`tests/integration/concurrent-claim.test.ts`)
1. **Race condition**: multiple runners compete, only one claims
2. **Stale token rejection**: worker with old lease rejected
3. **Lease expiry**: expired lease allows new claim
4. **Process crash**: crash during claim doesn't corrupt state

#### Restart/Reclaim Integration Tests (`tests/integration/restart-reclaim.test.ts`)
1. **Daemon restart**: all orphan runs reclaimed correctly
2. **Queued resume**: queued runs processed after restart
3. **Retry_wait resume**: backoff elapsed runs resumed
4. **Running orphan**: expired-lease runs reclaimed and resumed
5. **State consistency**: no state corruption after restart

## Success Criteria

1. **Functional**: `/goal` creates durable runs, state machine executes correctly
2. **Reliable**: No data corruption, no lost events, lease protocol robust
3. **Tested**: All tests green, regression verified, >90% coverage
4. **Performant**: No significant overhead on existing Codex App Server
5. **Observable**: Events logged, state transitions tracked
6. **Safe**: No automatic destructive operations, human dependencies explicit

## Rollout Strategy

1. **Phase 1**: Feature flag behind `CXR_GOAL_DURABLE=true`
2. **Phase 2**: Internal testing with development team
3. **Phase 3**: Beta testing with select users
4. **Phase 4**: Gradual rollout by user tier
5. **Phase 5**: Default on, opt-out available
6. **Phase 6**: Remove opt-out after monitoring period

## Post-Implementation Monitoring

- Run success rate by state
- Average execution time by goal type
- Lease expiry frequency
- Retry distribution and success rate
- Event volume and storage growth
- Thread resource utilization
- Error patterns and frequency

## Runtime Recovery Addendum — 2026-08-07

### Triggering evidence

The production daemon running with `CXR_GOAL_DURABLE=true` created only the per-agent
`.retention-observation` marker. It contained no `goal-runs/larry-codex/*.json` files,
despite prior status messages claiming three run IDs. This is a false-completion risk:
there is no durable receipt, thread ID, event history, verification record, or restart
recovery target for those claimed runs.

### Locked remediation scope

1. Make `/goal` persist a run before acknowledging it and report its exact run ID.
2. Bind the run to an explicit validated repository/worktree contract rather than the
   agent control directory when a project worktree is required.
3. Replace fire-and-forget `turn/start` dispatch with a completion-aware, run-scoped
   lifecycle. Verification may begin only after the matching goal turn is terminal.
4. Add a bounded daemon-owned periodic tick and startup resume that recover queued,
   retryable, and expired leased runs without requiring another `/goal` command.
5. Serialize goal-run dispatch against interactive turns, renew ownership while a goal
   turn is active, and fail closed on an uncorrelated completion event.
6. Preserve native `/goal` fallback, require profile-bound acceptance checks, retain
   append-only run events, and never auto-push, merge, deploy, or delete data.
7. Add integration proof covering actual `/goal` ingress, on-disk run receipt,
   asynchronous turn completion before verification, restart recovery, repository
   binding, and retry-to-pass. A status message alone is never proof of a live run.

### Completion gate

This addendum is PASS only when a real daemon-backed `/goal` invocation creates an
inspectable run JSON in the expected agent state directory, transitions through a
matching completed turn before verification, survives a daemon restart, and records
the validation evidence for its explicitly bound repository. Any missing receipt,
unbounded race, wrong-worktree execution, or early verification is a FAIL.
