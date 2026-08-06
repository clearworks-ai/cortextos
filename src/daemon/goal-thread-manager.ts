import type { GoalRun } from '../types/goal-run.js';
export interface GoalCodexApi {
  createThread(input: { goal: string; repo: string; worktree?: string }): Promise<{ id: string }>;
  resumeThread(threadId: string): Promise<void>;
  setThreadGoal(threadId: string, goal: string): Promise<void>;
  getThreadStatus(threadId: string): Promise<{ active: boolean; goal: string | null; lastActivity: string }>;
  dispatchPrompt?(threadId: string, prompt: string): Promise<void>;
}
export class GoalThreadManager {
  constructor(private readonly codexApi: GoalCodexApi) {}
  async createThread(run: GoalRun): Promise<string> { return (await this.codexApi.createThread({ goal: run.goal, repo: run.repo, worktree: run.worktree })).id; }
  async resumeThread(threadId: string): Promise<void> { await this.codexApi.resumeThread(threadId); }
  async setThreadGoal(threadId: string, goal: string): Promise<void> { await this.codexApi.setThreadGoal(threadId, goal); }
  async getThreadStatus(threadId: string): Promise<{ active: boolean; goal: string | null; lastActivity: string }> { return this.codexApi.getThreadStatus(threadId); }
  async dispatchPrompt(threadId: string, prompt: string): Promise<void> { if (!this.codexApi.dispatchPrompt) throw new Error('Goal Codex API does not support prompt dispatch'); await this.codexApi.dispatchPrompt(threadId, prompt); }
}
