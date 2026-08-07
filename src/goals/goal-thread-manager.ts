import type { GoalBlocker, GoalImplementationReceipt, GoalReviewFinding, GoalReviewReceipt, GoalRun } from './goal-run.js';

export interface GoalImplementationReport { kind: 'implementation_report'; itemId: string; cycle: number; status: 'completed' | 'planning_only'; summary: string; artifactIds?: string[]; blocker?: GoalBlocker; }
export interface GoalReviewReport { kind: 'review_report'; itemId: string; cycle: number; decision: 'approved' | 'changes_requested'; summary: string; findings?: Array<{ id?: string; severity?: 'blocking' | 'non_blocking'; summary: string }>; blocker?: GoalBlocker; }
export interface GoalTurnOutcome { outcome: 'completed' | 'failed'; blocker?: GoalBlocker; report?: unknown; }
export interface GoalCodexApi {
  createThread(input: { goal: string; repo: string; worktree?: string; role?: 'implementation' | 'review' }): Promise<{ id: string }>;
  resumeThread(threadId: string, cwd: string): Promise<void>;
  setThreadGoal(threadId: string, goal: string): Promise<void>;
  dispatchPrompt(threadId: string, prompt: string): Promise<GoalTurnOutcome | void>;
}
export type ImplementationOutcome = { kind: 'accepted'; receipt: GoalImplementationReceipt } | { kind: 'blocked'; blocker: GoalBlocker } | { kind: 'invalid'; reason: string };
export type ReviewOutcome = { kind: 'accepted'; receipt: GoalReviewReceipt; findings: GoalReviewFinding[] } | { kind: 'blocked'; blocker: GoalBlocker } | { kind: 'invalid'; reason: string };
const bounded = (text: string, max = 512) => text.replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]').slice(0, max);
const validBlocker = (value: unknown): GoalBlocker | undefined => {
  if (!value || typeof value !== 'object') return undefined; const blocker = value as Partial<GoalBlocker>;
  if (!['approval', 'credential', 'human_action', 'permission'].includes(String(blocker.kind)) || !['codex_turn', 'transport', 'operator'].includes(String(blocker.source)) || typeof blocker.summary !== 'string') return undefined;
  return { kind: blocker.kind!, source: blocker.source!, summary: bounded(blocker.summary) };
};
const parseReport = (value: unknown): unknown => {
  try { if (Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)) > 65_536) return undefined; } catch { return undefined; }
  if (typeof value !== 'string') return value;
  const trimmed = value.trim(); const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? trimmed;
  try { return JSON.parse(fenced); } catch { return undefined; }
};
const exactKeys = (value: object, allowed: string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

export class GoalThreadManager {
  constructor(private readonly api: GoalCodexApi) {}
  async createThread(run: GoalRun, role: 'implementation' | 'review' = 'implementation'): Promise<string> { return (await this.api.createThread({ goal: run.goal, repo: run.repo, worktree: run.worktree, role })).id; }
  async resumeThread(threadId: string, run: GoalRun): Promise<void> { await this.api.resumeThread(threadId, run.worktree || run.repo); }
  async setThreadGoal(threadId: string, goal: string): Promise<void> { await this.api.setThreadGoal(threadId, goal); }
  private async raw(threadId: string, prompt: string): Promise<GoalTurnOutcome> { const result = await this.api.dispatchPrompt(threadId, prompt); return result ?? { outcome: 'failed' }; }
  async dispatchImplementation(threadId: string, prompt: string, itemId: string, cycle: number, now: string): Promise<ImplementationOutcome> {
    const turn = await this.raw(threadId, prompt); const blocker = validBlocker(turn.blocker); if (blocker) return { kind: 'blocked', blocker };
    const report = parseReport(turn.report) as Partial<GoalImplementationReport> | undefined;
    if (turn.outcome !== 'completed') return { kind: 'invalid', reason: 'failed turn cannot produce an implementation receipt' };
    if (!report || report.kind !== 'implementation_report' || typeof report !== 'object' || !exactKeys(report, ['kind', 'itemId', 'cycle', 'status', 'summary', 'artifactIds'])) return { kind: 'invalid', reason: 'missing, malformed, or non-exact implementation report' };
    if (report.itemId !== itemId || report.cycle !== cycle) return { kind: 'invalid', reason: 'implementation report item/cycle mismatch' };
    if (!['completed', 'planning_only'].includes(String(report.status)) || typeof report.summary !== 'string') return { kind: 'invalid', reason: 'invalid implementation report fields' };
    if (report.artifactIds !== undefined && (!Array.isArray(report.artifactIds) || report.artifactIds.length > 64 || report.artifactIds.some((entry) => typeof entry !== 'string'))) return { kind: 'invalid', reason: 'invalid implementation artifactIds' };
    return { kind: 'accepted', receipt: { itemId, cycle, status: report.status!, summary: bounded(report.summary, 2048), artifactIds: report.artifactIds ?? [], timestamp: now } };
  }
  async dispatchReview(threadId: string, prompt: string, itemId: string, cycle: number, now: string): Promise<ReviewOutcome> {
    const turn = await this.raw(threadId, prompt); const blocker = validBlocker(turn.blocker); if (blocker) return { kind: 'blocked', blocker };
    const report = parseReport(turn.report) as Partial<GoalReviewReport> | undefined;
    if (turn.outcome !== 'completed') return { kind: 'invalid', reason: 'failed turn cannot produce a review receipt' };
    if (!report || report.kind !== 'review_report' || typeof report !== 'object' || !exactKeys(report, ['kind', 'itemId', 'cycle', 'decision', 'summary', 'findings'])) return { kind: 'invalid', reason: 'missing, malformed, or non-exact review report' };
    if (report.itemId !== itemId || report.cycle !== cycle) return { kind: 'invalid', reason: 'review report item/cycle mismatch' };
    if (!['approved', 'changes_requested'].includes(String(report.decision)) || typeof report.summary !== 'string') return { kind: 'invalid', reason: 'invalid review report fields' };
    if (report.findings !== undefined && (!Array.isArray(report.findings) || report.findings.length > 64 || report.findings.some((finding) => !finding || typeof finding !== 'object' || !exactKeys(finding, ['id', 'severity', 'summary']) || typeof finding.summary !== 'string' || (finding.id !== undefined && typeof finding.id !== 'string') || (finding.severity !== undefined && !['blocking', 'non_blocking'].includes(finding.severity))))) return { kind: 'invalid', reason: 'invalid review findings' };
    const findings = (report.findings ?? []).map((finding, index) => ({ id: typeof finding.id === 'string' ? bounded(finding.id, 128) : `finding-${cycle}-${index + 1}`, itemId, cycle, severity: finding.severity === 'non_blocking' ? 'non_blocking' as const : 'blocking' as const, summary: bounded(finding.summary, 1024), resolved: false, timestamp: now }));
    if (report.decision === 'changes_requested' && findings.length === 0) return { kind: 'invalid', reason: 'changes_requested requires findings' };
    if (report.decision === 'approved' && findings.length > 0) return { kind: 'invalid', reason: 'approved review cannot include findings' };
    return { kind: 'accepted', receipt: { itemId, cycle, reviewerThreadId: threadId, decision: report.decision!, findingIds: findings.map((finding) => finding.id), timestamp: now }, findings };
  }
  /** Compatibility surface for v2 callers/tests. */
  async dispatchPrompt(threadId: string, prompt: string): Promise<GoalTurnOutcome> { const turn = await this.raw(threadId, prompt); const blocker = validBlocker(turn.blocker); return blocker ? { outcome: turn.outcome, blocker, report: turn.report } : turn; }
}
