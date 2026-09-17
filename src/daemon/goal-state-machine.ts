import { randomUUID } from 'node:crypto';
import type { GoalRun, GoalRunState } from '../types/goal-run.js';
export class GoalStateMachine {
  static canTransition(from: GoalRunState, to: GoalRunState): boolean { const transitions: Record<GoalRunState, GoalRunState[]> = { queued: ['claimed', 'cancelled'], claimed: ['running', 'cancelled'], running: ['verifying', 'retry_wait', 'needs_human', 'exhausted', 'cancelled'], verifying: ['done', 'retry_wait', 'needs_human', 'exhausted'], retry_wait: ['claimed'], done: [], needs_human: [], exhausted: [], cancelled: [] }; return transitions[from].includes(to); }
  static transition(run: GoalRun, to: GoalRunState, data?: Record<string, unknown>): GoalRun { if (!this.canTransition(run.state, to)) throw new Error(`Invalid state transition: ${run.state} → ${to}`); const now = new Date().toISOString(); return { ...run, state: to, updatedAt: now, events: [...run.events, { id: randomUUID(), type: 'state_changed', timestamp: now, data: { from: run.state, to, ...data } }] }; }
  static isTerminal(state: GoalRunState): boolean { return ['done', 'needs_human', 'exhausted', 'cancelled'].includes(state); }
  static canRetry(state: GoalRunState): boolean { return state === 'retry_wait'; }
}
