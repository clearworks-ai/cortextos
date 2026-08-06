import { randomUUID } from 'node:crypto';
import type { GoalRunEvent } from '../types/goal-run.js';
import { GoalRunStore } from './goal-run-store.js';
export class GoalEventLogger {
  static async logEvent(store: GoalRunStore, agentName: string, runId: string, leaseToken: string, event: Omit<GoalRunEvent, 'id' | 'timestamp'>): Promise<void> { await store.update(agentName, runId, leaseToken, run => ({ ...run, events: [...run.events, { ...event, id: randomUUID(), timestamp: new Date().toISOString() }], updatedAt: new Date().toISOString() })); }
  static async getEventsByType(store: GoalRunStore, agentName: string, runId: string, type: GoalRunEvent['type']): Promise<GoalRunEvent[]> { return (await store.get(agentName, runId))?.events.filter(event => event.type === type) ?? []; }
  static async getRecentEvents(store: GoalRunStore, agentName: string, runId: string, limit = 10): Promise<GoalRunEvent[]> { return (await store.get(agentName, runId))?.events.slice(-limit) ?? []; }
}
