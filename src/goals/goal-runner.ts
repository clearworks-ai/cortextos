import { randomUUID } from 'node:crypto';
import { auditGoalCompletion } from './goal-manifest.js';
import type { GoalConfig, GoalItemProgress, GoalManifestItem, GoalRun, GoalRunState } from './goal-run.js';
import { GoalLockContentionError, GoalRunStore } from './goal-run-store.js';
import { GoalThreadManager } from './goal-thread-manager.js';
import { GoalVerifier } from './goal-verifier.js';

const terminal = (state: GoalRunState) => ['done', 'exhausted', 'cancelled'].includes(state);
const iso = (now: number) => new Date(now).toISOString();
const release = (run: GoalRun): GoalRun => { const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expires, ...rest } = run; return rest; };
const deriveState = (items: GoalItemProgress[]): GoalRunState => items.every((item) => item.status === 'done') ? 'verifying' : items.filter((item) => item.status !== 'done').every((item) => item.status === 'waiting') ? 'needs_human' : 'queued';
const deriveScheduledState = (items: GoalItemProgress[], now: number): GoalRunState => {
  const base = deriveState(items); if (base !== 'queued') return base;
  return items.some((item) => item.status === 'runnable' && (!item.nextEligibleAt || new Date(item.nextEligibleAt).getTime() <= now)) ? 'queued' : 'retry_wait';
};

export class GoalRunner {
  private readonly id = `goal-runner-${randomUUID()}`; private readonly verifier: GoalVerifier;
  private stopped = false; private readonly abortController = new AbortController();
  constructor(private readonly store: GoalRunStore, private readonly config: GoalConfig, private readonly threads: GoalThreadManager, private readonly agents: () => string[], private readonly clock: () => number = Date.now) { this.verifier = new GoalVerifier(config, clock); }
  async processTick(): Promise<void> { if (this.stopped) return; for (const agent of this.agents()) { if (this.stopped) return; await this.processAgent(agent); } }
  shutdown(): void { this.stopped = true; this.abortController.abort(); }
  private async processAgent(agent: string): Promise<void> {
    try { await this.store.prune(agent, this.clock()); } catch (error) { if (error instanceof GoalLockContentionError) return; throw error; } const candidates = await this.store.list(agent); let claimed = 0;
    for (const candidate of candidates) { if (claimed >= this.config.claimBudget) break; if (terminal(candidate.state) || candidate.state === 'needs_human') continue; const result = await this.store.claimEligible(agent, candidate.id, this.id, this.clock()); if (result.kind !== 'claimed') continue; claimed += 1;
      await this.processClaim(result.run).catch(async (error) => { if (error instanceof GoalLockContentionError) return; await this.retryRun(result.run, error instanceof Error ? error.message : 'goal turn failed'); }); }
  }
  private select(run: GoalRun): { item: GoalManifestItem; progress: GoalItemProgress; index: number } | undefined {
    const items = run.manifest!.boards.flatMap((board) => board.items); const progress = run.itemProgress!; const start = (run.schedulingCursor ?? 0) % items.length; const now = this.clock();
    for (let offset = 0; offset < items.length; offset += 1) { const index = (start + offset) % items.length; const state = progress[index]!; if (state.status === 'runnable' && (!state.nextEligibleAt || new Date(state.nextEligibleAt).getTime() <= now)) return { item: items[index]!, progress: state, index }; }
    return undefined;
  }
  private async processClaim(run: GoalRun): Promise<void> {
    const token = run.leaseToken!; let current = await this.store.update(run.agentName, run.id, token, (value) => this.transition(value, value.itemProgress?.every((item) => item.status === 'done') ? 'verifying' : 'running'), this.clock());
    const heartbeat = setInterval(() => { void this.store.update(run.agentName, run.id, token, (value) => ({ ...value, leaseExpiresAt: iso(this.clock() + this.config.leaseTtlMs), updatedAt: iso(this.clock()) }), this.clock()).catch(() => {}); }, Math.max(1, Math.floor(this.config.leaseTtlMs / 3))); heartbeat.unref?.();
    try {
      if (current.itemProgress?.every((entry) => entry.status === 'done')) { await this.finishVerification(current, token); return; }
      const selected = this.select(current); if (!selected) { await this.store.update(run.agentName, run.id, token, (value) => release({ ...value, state: deriveState(value.itemProgress ?? []), updatedAt: iso(this.clock()) }), this.clock()); return; }
      let progress = selected.progress; const item = selected.item; const now = iso(this.clock());
      if (!progress.implementationThreadId) { const threadId = await this.threads.createThread(current, 'implementation'); current = await this.patchItem(current, token, selected.index, (value) => ({ ...value, implementationThreadId: threadId, updatedAt: now })); progress = current.itemProgress![selected.index]!; }
      else await this.threads.resumeThread(progress.implementationThreadId, current);
      await this.threads.setThreadGoal(progress.implementationThreadId!, current.goal);
      const priorFindings = progress.findings.filter((finding) => !finding.resolved).map((finding) => `- ${finding.summary}`).join('\n');
      const prompt = [`Overall objective (verbatim):\n${current.manifest!.objectiveVerbatim}`, `Item ${item.id} (verbatim):\n${item.textVerbatim}`, `Cycle: ${progress.cycle}`, `Required checks: ${item.evidenceRequirements.map((entry) => entry.checkId).join(', ')}`, priorFindings ? `Prior reviewer/check findings:\n${priorFindings}` : '', 'Return one JSON implementation_report envelope for this exact item and cycle. Planning-only work must use status planning_only.'].filter(Boolean).join('\n\n');
      const implementation = await this.threads.dispatchImplementation(progress.implementationThreadId!, prompt, item.id, progress.cycle, now);
      if (implementation.kind === 'blocked') { await this.finishItem(run, token, selected.index, (value) => ({ ...value, status: 'waiting', blocker: implementation.blocker, updatedAt: now })); return; }
      if (implementation.kind === 'invalid' || implementation.receipt.status === 'planning_only') { await this.retryItem(run, token, selected.index, implementation.kind === 'invalid' ? implementation.reason : 'planning_only report'); return; }
      if (implementation.receipt.artifactIds.some((artifactId) => !current.artifacts.some((artifact) => artifact.id === artifactId))) { await this.retryItem(run, token, selected.index, 'implementation report references a missing artifact'); return; }
      current = await this.patchItem(current, token, selected.index, (value) => ({ ...value, phase: 'verification', implementationReceipt: implementation.receipt, blocker: undefined, updatedAt: now }));
      const verified = await this.verifier.verifyItem(current, item, progress.cycle, this.abortController.signal);
      current = await this.store.update(run.agentName, run.id, token, (value) => { const items = [...value.itemProgress!]; const prior = items[selected.index]!; items[selected.index] = { ...prior, evidenceReceipts: [...prior.evidenceReceipts.filter((receipt) => receipt.cycle !== prior.cycle), ...verified.receipts], phase: verified.passed ? 'review' : 'implementation', updatedAt: iso(this.clock()) }; return { ...value, itemProgress: items, checkResults: [...(value.checkResults ?? []), ...verified.results], artifacts: [...value.artifacts, ...verified.artifacts], state: 'running', updatedAt: iso(this.clock()) }; }, this.clock());
      if (!verified.passed) { await this.retryItem(current, token, selected.index, 'required evidence failed', true); return; }
      progress = current.itemProgress![selected.index]!;
      if (!progress.reviewerThreadId) { const reviewerThreadId = await this.threads.createThread(current, 'review'); current = await this.patchItem(current, token, selected.index, (value) => ({ ...value, reviewerThreadId, updatedAt: iso(this.clock()) })); progress = current.itemProgress![selected.index]!; }
      else await this.threads.resumeThread(progress.reviewerThreadId, current);
      await this.threads.setThreadGoal(progress.reviewerThreadId!, current.goal);
      const cycleEvidence = progress.evidenceReceipts.filter((receipt) => receipt.cycle === progress.cycle);
      const referencedArtifactIds = new Set([...(progress.implementationReceipt?.artifactIds ?? []), ...cycleEvidence.flatMap((receipt) => receipt.artifactIds)]);
      const reviewArtifacts = current.artifacts.filter((artifact) => referencedArtifactIds.has(artifact.id) || (artifact.metadata?.itemId === item.id && artifact.metadata?.cycle === progress.cycle));
      const reviewChecks = (current.checkResults ?? []).filter((receipt) => receipt.itemId === item.id && receipt.cycle === progress.cycle);
      const unresolvedFindings = progress.findings.filter((finding) => !finding.resolved);
      const reviewPrompt = [`Independently review ${item.id}, cycle ${progress.cycle}.`, `Overall objective (verbatim):\n${current.manifest!.objectiveVerbatim}`, `Item ${item.id} (verbatim):\n${item.textVerbatim}`, `Implementation receipt:\n${JSON.stringify(progress.implementationReceipt)}`, `Implementation and evidence artifacts:\n${JSON.stringify(reviewArtifacts)}`, `Evidence receipts:\n${JSON.stringify(cycleEvidence)}`, `Check receipts:\n${JSON.stringify(reviewChecks)}`, `Unresolved findings:\n${JSON.stringify(unresolvedFindings)}`, 'Return one JSON review_report envelope for this exact item and cycle.'].join('\n\n');
      const review = await this.threads.dispatchReview(progress.reviewerThreadId!, reviewPrompt, item.id, progress.cycle, iso(this.clock()));
      if (review.kind === 'blocked') { await this.finishItem(current, token, selected.index, (value) => ({ ...value, status: 'waiting', blocker: review.blocker, updatedAt: iso(this.clock()) })); return; }
      if (review.kind === 'invalid') { await this.retryItem(current, token, selected.index, review.reason); return; }
      if (review.receipt.decision === 'changes_requested') {
        await this.finishItem(current, token, selected.index, (value) => ({ ...value, phase: 'implementation', cycle: value.cycle + 1, attempt: value.attempt + 1, implementationReceipt: undefined, evidenceReceipts: [], reviewReceipts: [...value.reviewReceipts, review.receipt], findings: [...value.findings.map((finding) => ({ ...finding, resolved: true })), ...review.findings], nextEligibleAt: iso(this.clock() + this.retryDelay(value.attempt)), updatedAt: iso(this.clock()) })); return;
      }
      current = await this.store.update(run.agentName, run.id, token, (value) => { const items = [...value.itemProgress!]; const prior = items[selected.index]!; items[selected.index] = { ...prior, status: 'done', reviewReceipts: [...prior.reviewReceipts, review.receipt], findings: prior.findings.map((finding) => ({ ...finding, resolved: true })), updatedAt: iso(this.clock()) }; const allDone = items.every((entry) => entry.status === 'done'); return { ...value, itemProgress: items, schedulingCursor: (selected.index + 1) % items.length, state: allDone ? 'verifying' : deriveScheduledState(items, this.clock()), finalVerificationPassed: false, updatedAt: iso(this.clock()) }; }, this.clock());
      if (current.itemProgress!.every((entry) => entry.status === 'done')) await this.finishVerification(current, token);
      else await this.store.update(run.agentName, run.id, token, (value) => release(value), this.clock());
    } finally { clearInterval(heartbeat); }
  }
  private async finishVerification(run: GoalRun, token: string): Promise<void> {
    const final = await this.verifier.verify(run, this.abortController.signal);
    const current = await this.store.update(run.agentName, run.id, token, (value) => ({ ...value, state: 'verifying', checkResults: [...(value.checkResults ?? []), ...final.results], artifacts: [...value.artifacts, ...final.artifacts], finalVerificationPassed: final.passed, updatedAt: iso(this.clock()) }), this.clock());
    if (!final.passed) {
      await this.store.update(run.agentName, run.id, token, (value) => release({ ...value, state: 'retry_wait', itemProgress: value.itemProgress!.map((entry) => ({ ...entry, status: 'runnable', phase: 'implementation', cycle: entry.cycle + 1, implementationReceipt: undefined, evidenceReceipts: [], nextEligibleAt: iso(this.clock() + this.retryDelay(entry.attempt)), findings: [...entry.findings, { id: randomUUID(), itemId: entry.itemId, cycle: entry.cycle, severity: 'blocking', summary: 'final acceptance verification failed', resolved: false, timestamp: iso(this.clock()) }], updatedAt: iso(this.clock()) })), updatedAt: iso(this.clock()) }), this.clock()); return;
    }
    const audit = auditGoalCompletion(current);
    if (audit.passed) await this.store.update(run.agentName, run.id, token, (value) => release(this.transition(value, 'done')), this.clock());
    else await this.store.update(run.agentName, run.id, token, (value) => release({ ...this.transition(value, 'retry_wait', { errors: audit.errors }), finalVerificationPassed: false, itemProgress: value.itemProgress!.map((entry) => ({ ...entry, status: 'runnable', phase: 'implementation', cycle: entry.cycle + 1, implementationReceipt: undefined, evidenceReceipts: [], nextEligibleAt: iso(this.clock() + this.retryDelay(entry.attempt)), findings: [...entry.findings, { id: randomUUID(), itemId: entry.itemId, cycle: entry.cycle, severity: 'blocking', summary: `completion audit failed: ${audit.errors.join('; ')}`.slice(0, 1_024), resolved: false, timestamp: iso(this.clock()) }], updatedAt: iso(this.clock()) })) }), this.clock());
  }
  private async patchItem(run: GoalRun, token: string, index: number, mutate: (item: GoalItemProgress) => GoalItemProgress): Promise<GoalRun> { return this.store.update(run.agentName, run.id, token, (value) => { const items = [...value.itemProgress!]; items[index] = mutate(items[index]!); return { ...value, itemProgress: items, updatedAt: iso(this.clock()) }; }, this.clock()); }
  private async finishItem(run: GoalRun, token: string, index: number, mutate: (item: GoalItemProgress) => GoalItemProgress, forced?: GoalRunState): Promise<void> { await this.store.update(run.agentName, run.id, token, (value) => { const items = [...value.itemProgress!]; items[index] = mutate(items[index]!); return release({ ...value, itemProgress: items, schedulingCursor: (index + 1) % items.length, state: forced ?? deriveScheduledState(items, this.clock()), updatedAt: iso(this.clock()) }); }, this.clock()); }
  private retryDelay(attempt: number): number { return Math.min(this.config.retryDelayMs * 2 ** Math.min(attempt, 20), this.config.retryMaxDelayMs); }
  private async retryItem(run: GoalRun, token: string, index: number, reason: string, advanceCycle = false): Promise<void> { await this.finishItem(run, token, index, (value) => ({ ...value, phase: 'implementation', cycle: advanceCycle ? value.cycle + 1 : value.cycle, attempt: value.attempt + 1, implementationReceipt: advanceCycle ? undefined : value.implementationReceipt, evidenceReceipts: advanceCycle ? [] : value.evidenceReceipts, nextEligibleAt: iso(this.clock() + this.retryDelay(value.attempt)), findings: [...value.findings, { id: randomUUID(), itemId: value.itemId, cycle: value.cycle, severity: 'blocking', summary: reason.slice(0, 1024), resolved: false, timestamp: iso(this.clock()) }], updatedAt: iso(this.clock()) })); }
  private async retryRun(run: GoalRun, reason: string): Promise<void> { if (!run.leaseToken) return; await this.store.update(run.agentName, run.id, run.leaseToken, (value) => release(this.transition({ ...value, attempt: value.attempt + 1 }, 'retry_wait', { reason })), this.clock()).catch(() => {}); }
  private transition(run: GoalRun, state: GoalRunState, data?: Record<string, unknown>): GoalRun { const now = this.clock(); return { ...run, state, updatedAt: iso(now), events: [...run.events, { id: randomUUID(), type: state === 'needs_human' ? 'needs_human' : 'state_changed', timestamp: iso(now), data: { from: run.state, to: state, ...data } }] }; }
}
