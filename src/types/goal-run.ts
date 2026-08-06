export type GoalRunState = 'queued' | 'claimed' | 'running' | 'verifying' | 'retry_wait' | 'done' | 'needs_human' | 'exhausted' | 'cancelled';

export interface GoalAcceptanceCheck { id: string; command: string[]; timeoutMs: number; required: boolean; description?: string; }
export interface GoalArtifact { id: string; type: 'stdout' | 'stderr' | 'file' | 'custom'; content?: string; filePath?: string; timestamp: string; metadata?: Record<string, unknown>; }
export interface GoalRunEvent { id: string; type: 'run_created' | 'claimed' | 'turn_started' | 'turn_completed' | 'error' | 'verifying' | 'check_passed' | 'check_failed' | 'state_changed' | 'cancelled'; timestamp: string; data?: Record<string, unknown>; }
export interface GoalRun {
  id: string; agentName: string; goal: string; repo: string; worktree?: string; state: GoalRunState;
  threadId?: string; leaseOwner?: string; leaseToken?: string; leaseExpiresAt?: string;
  attempt: number; maxAttempts: number; acceptanceChecks: GoalAcceptanceCheck[]; artifacts: GoalArtifact[]; events: GoalRunEvent[];
  createdAt: string; updatedAt: string;
}
export interface GoalConfig { maxAttempts: number; retryDelayMs: number; retryMaxDelayMs: number; checkTimeoutMs: number; }
export const DEFAULT_GOAL_CONFIG: GoalConfig = { maxAttempts: 3, retryDelayMs: 30_000, retryMaxDelayMs: 30 * 60_000, checkTimeoutMs: 30 * 60_000 };
export function loadGoalConfig(): GoalConfig {
  const number = (name: string, fallback: number) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; };
  return { maxAttempts: number('CXR_GOAL_MAX_ATTEMPTS', DEFAULT_GOAL_CONFIG.maxAttempts), retryDelayMs: number('CXR_GOAL_RETRY_DELAY_MS', DEFAULT_GOAL_CONFIG.retryDelayMs), retryMaxDelayMs: number('CXR_GOAL_RETRY_MAX_DELAY_MS', DEFAULT_GOAL_CONFIG.retryMaxDelayMs), checkTimeoutMs: number('CXR_GOAL_CHECK_TIMEOUT_MS', DEFAULT_GOAL_CONFIG.checkTimeoutMs) };
}
