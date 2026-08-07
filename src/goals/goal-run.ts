import { execFileSync } from 'node:child_process';
/** Durable schema-v3 types for /goal promise completion. */
export type GoalRunState = 'queued' | 'claimed' | 'running' | 'verifying' | 'retry_wait' | 'done' | 'needs_human' | 'exhausted' | 'cancelled';
export type GoalBlockerKind = 'approval' | 'credential' | 'human_action' | 'permission';
export interface GoalBlocker { kind: GoalBlockerKind; summary: string; source: 'codex_turn' | 'transport' | 'operator'; }
export interface GoalSourceSpan { start: number; end: number; }
export interface GoalEvidenceRequirement { checkId: string; required: boolean; }
export interface GoalManifestItem { id: string; ordinal: number; boardId: string; textVerbatim: string; sourceSpan: GoalSourceSpan; evidenceRequirements: GoalEvidenceRequirement[]; }
export interface GoalManifestBoard { id: string; ordinal: number; titleVerbatim: string; sourceSpan: GoalSourceSpan; items: GoalManifestItem[]; }
export interface GoalManifest { schemaVersion: 3; objectiveVerbatim: string; objectiveSha256: string; manifestSha256: string; boards: GoalManifestBoard[]; }
export interface GoalAcceptanceCheck { id: string; command: string[]; timeoutMs: number; required: boolean; description?: string; scope?: 'item' | 'global'; itemIds?: string[]; }
export type GoalCheckClassification = 'passed' | 'failed' | 'timeout' | 'spawn_error' | 'manifest_invalid' | 'missing_result' | 'stale_evidence';
export interface GoalCheckResult { checkId: string; command: string[]; passed: boolean; exitCode: number | null; signal: string | null; classification: GoalCheckClassification; durationMs: number; timestamp: string; stdoutArtifact?: string; stderrArtifact?: string; itemId?: string; cycle?: number; }
export interface GoalArtifact { id: string; type: 'stdout' | 'stderr' | 'file' | 'custom'; content?: string; filePath?: string; timestamp: string; metadata?: Record<string, unknown>; }
export interface GoalImplementationReceipt { itemId: string; cycle: number; status: 'completed' | 'planning_only'; summary: string; artifactIds: string[]; timestamp: string; }
export interface GoalEvidenceReceipt { itemId: string; cycle: number; checkId: string; passed: boolean; result: GoalCheckResult; artifactIds: string[]; timestamp: string; }
export interface GoalReviewFinding { id: string; itemId: string; cycle: number; severity: 'blocking' | 'non_blocking'; summary: string; resolved: boolean; timestamp: string; }
export interface GoalReviewReceipt { itemId: string; cycle: number; reviewerThreadId: string; decision: 'approved' | 'changes_requested'; findingIds: string[]; timestamp: string; }
export interface GoalItemProgress { itemId: string; status: 'runnable' | 'waiting' | 'done'; phase: 'implementation' | 'verification' | 'review'; cycle: number; attempt: number; nextEligibleAt?: string; implementationThreadId?: string; reviewerThreadId?: string; blocker?: GoalBlocker; implementationReceipt?: GoalImplementationReceipt; evidenceReceipts: GoalEvidenceReceipt[]; reviewReceipts: GoalReviewReceipt[]; findings: GoalReviewFinding[]; updatedAt: string; }
export interface GoalRunEvent { id: string; type: 'run_created' | 'claimed' | 'turn_started' | 'turn_completed' | 'error' | 'verifying' | 'check_passed' | 'check_failed' | 'state_changed' | 'cancelled' | 'needs_human' | 'retention_pruned' | 'item_resumed' | 'review_completed'; timestamp: string; data?: Record<string, unknown>; }
export interface GoalBaselineObservation { date: string; commit: string; command: 'npm test'; exitCode: number; failures: string[]; }
export interface GoalAcceptanceProfile { name: 'goal-focused' | 'repository-full'; checks: GoalAcceptanceCheck[]; baselineObservation?: GoalBaselineObservation; baselineGreen?: { date: string; commit: string; command: 'npm test' }; baselineWaiver?: { date: string; commit: string; command: 'npm test'; owner: string; reason: string; failures: string[] }; }
export interface GoalRetentionPolicy { eventRetentionDays: number; maxTerminalRuns: number; maxInlineArtifactBytes: number; maxArtifactBytes: number; maxEvents: number; }
export interface GoalRun {
  schemaVersion?: 2 | 3; id: string; agentName: string; goal: string; repo: string; worktree?: string; state: GoalRunState;
  manifest?: GoalManifest; itemProgress?: GoalItemProgress[]; schedulingCursor?: number; finalVerificationPassed?: boolean;
  threadId?: string; leaseOwner?: string; leaseToken?: string; leaseExpiresAt?: string;
  attempt: number; maxAttempts: number; acceptanceChecks: GoalAcceptanceCheck[]; acceptanceProfile?: GoalAcceptanceProfile; retention?: GoalRetentionPolicy;
  checkResults?: GoalCheckResult[]; artifacts: GoalArtifact[]; events: GoalRunEvent[]; createdAt: string; updatedAt: string;
}
export interface GoalConfig extends GoalRetentionPolicy { maxAttempts: number; retryDelayMs: number; retryMaxDelayMs: number; checkTimeoutMs: number; leaseTtlMs: number; claimBudget: number; tickIntervalMs: number; }
export const DEFAULT_GOAL_CONFIG: GoalConfig = { maxAttempts: 3, retryDelayMs: 30_000, retryMaxDelayMs: 30 * 60_000, checkTimeoutMs: 30 * 60_000, leaseTtlMs: 5 * 60_000, claimBudget: 4, tickIntervalMs: 60_000, eventRetentionDays: 30, maxTerminalRuns: 500, maxInlineArtifactBytes: 16_384, maxArtifactBytes: 65_536, maxEvents: 2_000 };
const positive = (name: string, fallback: number) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; };
export function loadGoalConfig(): GoalConfig { return { maxAttempts: positive('CXR_GOAL_MAX_ATTEMPTS', DEFAULT_GOAL_CONFIG.maxAttempts), retryDelayMs: positive('CXR_GOAL_RETRY_DELAY_MS', DEFAULT_GOAL_CONFIG.retryDelayMs), retryMaxDelayMs: positive('CXR_GOAL_RETRY_MAX_DELAY_MS', DEFAULT_GOAL_CONFIG.retryMaxDelayMs), checkTimeoutMs: positive('CXR_GOAL_CHECK_TIMEOUT_MS', DEFAULT_GOAL_CONFIG.checkTimeoutMs), leaseTtlMs: positive('CXR_GOAL_LEASE_TTL_MS', DEFAULT_GOAL_CONFIG.leaseTtlMs), claimBudget: positive('CXR_GOAL_CLAIM_BUDGET', DEFAULT_GOAL_CONFIG.claimBudget), tickIntervalMs: positive('CXR_GOAL_TICK_INTERVAL_MS', DEFAULT_GOAL_CONFIG.tickIntervalMs), eventRetentionDays: positive('CXR_GOAL_EVENT_RETENTION_DAYS', DEFAULT_GOAL_CONFIG.eventRetentionDays), maxTerminalRuns: positive('CXR_GOAL_MAX_TERMINAL_RUNS', DEFAULT_GOAL_CONFIG.maxTerminalRuns), maxInlineArtifactBytes: positive('CXR_GOAL_MAX_INLINE_ARTIFACT_BYTES', DEFAULT_GOAL_CONFIG.maxInlineArtifactBytes), maxArtifactBytes: positive('CXR_GOAL_MAX_ARTIFACT_BYTES', DEFAULT_GOAL_CONFIG.maxArtifactBytes), maxEvents: positive('CXR_GOAL_MAX_EVENTS', DEFAULT_GOAL_CONFIG.maxEvents) }; }
export const defaultRetention = (config: GoalConfig): GoalRetentionPolicy => ({ eventRetentionDays: config.eventRetentionDays, maxTerminalRuns: config.maxTerminalRuns, maxInlineArtifactBytes: config.maxInlineArtifactBytes, maxArtifactBytes: config.maxArtifactBytes, maxEvents: config.maxEvents });
const exactInventory = (one: string[], two: string[]): boolean => one.length === two.length && one.every((value, index) => value === two[index]);
export const currentGitCommit = (repo: string): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
export function validateGoalAcceptanceProfile(profile: GoalAcceptanceProfile, repo: string, now = Date.now()): string[] {
  if (profile.name !== 'repository-full') return [];
  const errors: string[] = []; const observation = profile.baselineObservation; let commit = '';
  try { commit = currentGitCommit(repo); } catch { errors.push('unable to resolve current repository commit'); }
  if (!observation) return [...errors, 'repository-full requires an observed baseline'];
  const observedAt = Date.parse(observation.date); if (!Number.isFinite(observedAt) || observedAt < now - 86_400_000 || observedAt > now + 300_000) errors.push('baseline observation is stale or future-dated');
  if (!commit || observation.commit !== commit) errors.push('baseline observation commit does not match current commit');
  if (observation.command !== 'npm test') errors.push('baseline observation command must be exactly npm test');
  if (!Array.isArray(observation.failures) || observation.failures.some((failure) => typeof failure !== 'string' || !failure.trim())) errors.push('baseline observation failure inventory is invalid');
  if (observation.exitCode === 0) { const green = profile.baselineGreen; if (!green || green.date !== observation.date || green.commit !== observation.commit || green.command !== observation.command || observation.failures.length) errors.push('green baseline evidence does not match the observed green run'); }
  else { const waiver = profile.baselineWaiver; if (!waiver || waiver.date !== observation.date || waiver.commit !== observation.commit || waiver.command !== observation.command || !waiver.owner || !waiver.reason || !exactInventory(waiver.failures, observation.failures)) errors.push('baseline waiver does not match the observed failure inventory'); }
  return errors;
}
export function selectGoalAcceptanceProfile(env: NodeJS.ProcessEnv, config: GoalConfig, repo = process.cwd(), now = Date.now()): GoalAcceptanceProfile {
  const timeoutMs = config.checkTimeoutMs;
  const focused: GoalAcceptanceCheck[] = [
    { id: 'typecheck', command: ['npm', 'run', 'typecheck'], timeoutMs, required: true, scope: 'global' },
    { id: 'goal-unit', command: ['npx', 'vitest', 'run', 'tests/unit/goals'], timeoutMs, required: true, scope: 'global' },
    { id: 'goal-integration', command: ['npx', 'vitest', 'run', 'tests/integration/goal-run-control-plane.test.ts', 'tests/integration/goal-pty-process-boundary.test.ts'], timeoutMs, required: true, scope: 'global' },
    { id: 'pty-goal', command: ['npx', 'vitest', 'run', 'tests/unit/pty/codex-app-server-pty-goal.test.ts'], timeoutMs, required: true, scope: 'global' },
  ];
  if (env.CXR_GOAL_ACCEPTANCE_PROFILE !== 'repository-full') return { name: 'goal-focused', checks: focused };
  let observation: GoalAcceptanceProfile['baselineObservation']; let green: GoalAcceptanceProfile['baselineGreen']; let waiver: GoalAcceptanceProfile['baselineWaiver'];
  try { observation = JSON.parse(env.CXR_GOAL_BASELINE_OBSERVATION ?? '') as GoalAcceptanceProfile['baselineObservation']; } catch { /* handled below */ }
  try { green = JSON.parse(env.CXR_GOAL_BASELINE_GREEN ?? '') as GoalAcceptanceProfile['baselineGreen']; } catch { /* handled below */ }
  try { waiver = JSON.parse(env.CXR_GOAL_BASELINE_WAIVER ?? '') as GoalAcceptanceProfile['baselineWaiver']; } catch { /* handled below */ }
  const candidate: GoalAcceptanceProfile = { name: 'repository-full', checks: [...focused, { id: 'repository-full', command: ['npm', 'test'], timeoutMs, required: true, scope: 'global' }], baselineObservation: observation, baselineGreen: green, baselineWaiver: waiver };
  const errors = validateGoalAcceptanceProfile(candidate, repo, now); if (errors.length) throw new Error(`repository-full baseline rejected: ${errors.join('; ')}`); return candidate;
}
