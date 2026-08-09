import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { acquireLock, releaseLock } from '../utils/lock.js';
import {
  PipelineRunStore, type PipelineRun, type PipelineWorkstream, type PipelineLease,
  type PipelineEvent, type PipelineBlocker, type PipelineRoute,
} from './pipeline-run-store.js';

export const PIPELINE_LEASE_TTL_MS = 5 * 60_000;
export const PIPELINE_HEARTBEAT_MS = 60_000;
export const PIPELINE_TICK_MS = 15_000;
export const PIPELINE_RETRY_BACKOFF_MS = [60_000, 120_000, 240_000] as const;

export interface PipelineDispatchRequest {
  runId: string; workstreamId: string; attempt: number; fence: number; leaseToken: string;
  inputSha?: string; stage: string; route?: PipelineRoute; message?: string;
}
export interface PipelineDispatchResult {
  messageId?: string; replyTo?: string; artifactSha?: string; scopeSha?: string;
  inputSha?: string; transcriptPath?: string; artifactPath?: string; observedResult?: string;
}
export type PipelineDispatcher = (request: PipelineDispatchRequest) => Promise<PipelineDispatchResult | void>;

export interface PipelineSupervisorOptions {
  store: PipelineRunStore;
  owner?: string;
  lockRoot?: string;
  tickIntervalMs?: number;
  heartbeatIntervalMs?: number;
  leaseTtlMs?: number;
  maxAttempts?: number;
  dispatch?: PipelineDispatcher;
  onEvent?: (event: PipelineEvent) => void | Promise<void>;
}

export interface PipelineReceipt {
  runId: string; workstreamId: string; attempt: number; fence: number; leaseToken: string;
  inputSha?: string; artifactSha?: string; scopeSha?: string; transcriptPath?: string; artifactPath?: string;
  messageId?: string; replyTo?: string; observedResult?: string;
}

/**
 * Reconciliation owner for the durable pipeline projection. The class is
 * deliberately adapter-based: dispatching a real bus message is supplied by
 * the daemon owner, while lease/CAS/fencing and status persistence live here.
 */
export class PipelineSupervisor {
  readonly owner: string;
  private readonly lockRoot: string;
  private readonly tickIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxAttempts: number;
  private readonly dispatch?: PipelineDispatcher;
  private readonly onEvent?: PipelineSupervisorOptions['onEvent'];
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private hasLock = false;

  constructor(private readonly options: PipelineSupervisorOptions) {
    this.owner = options.owner || `pipeline-supervisor-${process.pid}-${randomUUID()}`;
    this.lockRoot = options.lockRoot || options.store.stateRoot;
    this.tickIntervalMs = options.tickIntervalMs ?? PIPELINE_TICK_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? PIPELINE_HEARTBEAT_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? PIPELINE_LEASE_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.dispatch = options.dispatch;
    this.onEvent = options.onEvent;
  }

  async start(): Promise<boolean> {
    if (this.started) return true;
    await this.options.store.initialize();
    await mkdir(this.lockRoot, { recursive: true });
    this.hasLock = acquireLock(this.lockRoot);
    if (!this.hasLock) return false;
    this.started = true;
    await this.tick();
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.tickIntervalMs);
    this.timer.unref?.();
    return true;
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.started = false;
    if (this.hasLock) releaseLock(this.lockRoot);
    this.hasLock = false;
  }
  isStarted(): boolean { return this.started; }

  /** One idempotent reconciliation pass; safe to call from startup or tests. */
  async tick(now = Date.now()): Promise<void> {
    if (!this.hasLock && this.started) return;
    for (const run of await this.options.store.list()) {
      await this.reconcileRun(run, now);
    }
  }
  async reconcileTick(now = Date.now()): Promise<void> { return this.tick(now); }

  private async reconcileRun(initial: PipelineRun, now: number): Promise<void> {
    let run = initial;
    for (const ws of [...run.workstreams]) {
      if (this.isExpired(ws, now)) {
        const result = await this.reclaim(run, ws, now);
        if (result) run = result;
      } else if (this.shouldHeartbeat(ws, now)) {
        const result = await this.renew(run, ws, now);
        if (result) run = result;
      }
    }
    run = await this.options.store.get(run.runId) || run;
    for (const ws of run.workstreams) {
      if (!this.ready(run, ws, now)) continue;
      const claimed = await this.claim(run, ws, now);
      if (!claimed) continue;
      run = claimed;
      await this.dispatchClaimed(run, claimed.workstreams.find(item => item.id === ws.id)!);
      run = await this.options.store.get(run.runId) || run;
    }
  }
  private isExpired(ws: PipelineWorkstream, now: number): boolean {
    return Boolean(ws.lease && (ws.state === 'leased' || ws.state === 'running') && Date.parse(ws.lease.expiresAt) <= now);
  }
  private shouldHeartbeat(ws: PipelineWorkstream, now: number): boolean {
    return Boolean(ws.lease && (ws.state === 'leased' || ws.state === 'running') && now - Date.parse(ws.lease.heartbeatAt) >= this.heartbeatIntervalMs && Date.parse(ws.lease.expiresAt) > now);
  }
  private ready(run: PipelineRun, ws: PipelineWorkstream, now: number): boolean {
    if (!['pending', 'ready', 'retry_wait'].includes(ws.state)) return false;
    if (ws.retryAt && Date.parse(ws.retryAt) > now) return false;
    return ws.deps.every(dep => run.workstreams.find(item => item.id === dep)?.state === 'succeeded');
  }
  private lease(now: number, fence: number): PipelineLease {
    const nowIso = new Date(now).toISOString();
    return { owner: this.owner, token: randomUUID(), expiresAt: new Date(now + this.leaseTtlMs).toISOString(), heartbeatAt: nowIso, fence };
  }
  private async claim(run: PipelineRun, ws: PipelineWorkstream, now: number): Promise<PipelineRun | null> {
    try {
      const next = await this.options.store.compareAndSwap(run.runId, run.revision, current => {
        const currentWs = current.workstreams.find(item => item.id === ws.id);
        if (!currentWs || !this.ready(current, currentWs, now) || currentWs.lease) throw new Error('not ready');
        const lease = this.lease(now, (currentWs.fence ?? 0) + 1);
        return this.withWorkstream(current, ws.id, { state: 'leased', lease, fence: lease.fence, dispatchKey: `${current.runId}:${ws.id}:${currentWs.attempt}:${currentWs.inputSha || ''}`, updatedAt: new Date(now).toISOString() });
      });
      await this.emit(next, ws.id, 'dispatch_claimed', 'leased', { fence: next.workstreams.find(item => item.id === ws.id)?.lease?.fence ?? 0 });
      return next;
    } catch { return null; }
  }
  private async dispatchClaimed(run: PipelineRun, ws: PipelineWorkstream): Promise<void> {
    if (!ws.lease) return;
    const request: PipelineDispatchRequest = { runId: run.runId, workstreamId: ws.id, attempt: ws.attempt, fence: ws.lease.fence, leaseToken: ws.lease.token, inputSha: ws.inputSha, stage: ws.phase, route: ws.route };
    try {
      const result = this.dispatch ? await this.dispatch(request) : undefined;
      if (result) {
        const latest = await this.options.store.get(run.runId);
        if (latest) await this.options.store.compareAndSwap(run.runId, latest.revision, current => this.withWorkstream(current, ws.id, { state: 'running', messageId: result.messageId, replyTo: result.replyTo, scopeSha: result.scopeSha, transcriptPath: result.transcriptPath, artifact: result.artifactPath && result.artifactSha ? { sha256: result.artifactSha, path: result.artifactPath } : undefined, inputSha: result.inputSha || ws.inputSha, updatedAt: new Date().toISOString() }));
        await this.emit(run, ws.id, 'pipeline_dispatch/v1', 'running', { version: 'pipeline_dispatch/v1', messageId: result.messageId, artifactSha: result.artifactSha, scopeSha: result.scopeSha, stage: ws.phase, fence: ws.lease.fence, leaseToken: ws.lease.token, inputSha: result.inputSha || ws.inputSha });
      }
    } catch (error) {
      const latest = await this.options.store.get(run.runId); if (!latest) return;
      const current = latest.workstreams.find(item => item.id === ws.id); if (!current?.lease || current.lease.token !== ws.lease.token) return;
      await this.fail(latest, current, { code: 'WORKER_TRANSIENT', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private async renew(run: PipelineRun, ws: PipelineWorkstream, now: number): Promise<PipelineRun | null> {
    if (!ws.lease) return null;
    try {
      const next = await this.options.store.compareAndSwap(run.runId, run.revision, current => {
        const currentWs = current.workstreams.find(item => item.id === ws.id);
        if (!currentWs?.lease || currentWs.lease.token !== ws.lease!.token || currentWs.lease.fence !== ws.lease!.fence || this.isExpired(currentWs, now)) throw new Error('stale lease');
        return this.withWorkstream(current, ws.id, { lease: { ...currentWs.lease, heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + this.leaseTtlMs).toISOString() } });
      });
      await this.emit(next, ws.id, 'heartbeat', next.workstreams.find(item => item.id === ws.id)?.state || ws.state, { fence: ws.lease.fence, leaseToken: ws.lease.token });
      return next;
    } catch { return null; }
  }
  private async reclaim(run: PipelineRun, ws: PipelineWorkstream, now: number): Promise<PipelineRun | null> {
    try {
      const next = await this.options.store.compareAndSwap(run.runId, run.revision, current => {
        const currentWs = current.workstreams.find(item => item.id === ws.id);
        if (!currentWs?.lease || !this.isExpired(currentWs, now)) throw new Error('lease changed');
        const attempt = currentWs.attempt + 1;
        const exhausted = attempt >= Math.min(currentWs.maxAttempts || this.maxAttempts, current.maxAttempts || this.maxAttempts);
        const retryAt = exhausted ? undefined : new Date(now + PIPELINE_RETRY_BACKOFF_MS[Math.min(currentWs.attempt, PIPELINE_RETRY_BACKOFF_MS.length - 1)]).toISOString();
        return this.withWorkstream(current, ws.id, { state: exhausted ? 'exhausted' : 'retry_wait', attempt, retryAt, fence: currentWs.lease.fence, blocker: exhausted ? { code: 'WORKER_TRANSIENT', reason: 'lease expired; retry budget exhausted' } : undefined, lease: undefined, updatedAt: new Date(now).toISOString() });
      });
      await this.emit(next, ws.id, 'lease_reclaimed', next.workstreams.find(item => item.id === ws.id)?.state || 'retry_wait', { fence: (ws.lease?.fence || 0) + 1 });
      return next;
    } catch { return null; }
  }
  private async fail(run: PipelineRun, ws: PipelineWorkstream, blocker: PipelineBlocker): Promise<PipelineRun | null> {
    try {
      const next = await this.options.store.compareAndSwap(run.runId, run.revision, current => {
        const currentWs = current.workstreams.find(item => item.id === ws.id);
        if (!currentWs || currentWs.lease?.token !== ws.lease?.token) throw new Error('stale failure');
        const attempt = currentWs.attempt + 1;
        const exhausted = attempt >= Math.min(currentWs.maxAttempts || this.maxAttempts, current.maxAttempts || this.maxAttempts);
        return this.withWorkstream(current, ws.id, { state: exhausted ? 'exhausted' : 'retry_wait', attempt, blocker, retryAt: exhausted ? undefined : new Date(Date.now() + PIPELINE_RETRY_BACKOFF_MS[Math.min(currentWs.attempt, 2)]).toISOString(), lease: undefined, fence: currentWs.lease?.fence });
      });
      await this.emit(next, ws.id, 'retry', next.workstreams.find(item => item.id === ws.id)?.state || 'retry_wait', { fence: ws.lease?.fence || 0, data: blocker as unknown as Record<string, unknown> });
      return next;
    } catch { return null; }
  }
  private withWorkstream(run: PipelineRun, id: string, patch: Partial<PipelineWorkstream>): PipelineRun {
    return { ...run, workstreams: run.workstreams.map(ws => ws.id === id ? { ...ws, ...patch } : ws) };
  }
  private async emit(run: PipelineRun, workstreamId: string, type: string, to: string, data: Partial<PipelineEvent> = {}): Promise<void> {
    const ws = run.workstreams.find(item => item.id === workstreamId);
    const event = await this.options.store.appendEvent(run.runId, { type, version: data.version, workstreamId, attempt: ws?.attempt || 0, fence: data.fence || ws?.lease?.fence || 0, leaseToken: data.leaseToken || ws?.lease?.token, inputSha: data.inputSha || ws?.inputSha, from: ws?.state, to, action: type, observedResult: data.observedResult, causalEventId: data.causalEventId, artifactSha: data.artifactSha, scopeSha: data.scopeSha, messageId: data.messageId, stage: data.stage || ws?.phase, route: ws?.route, data: data.data });
    await this.onEvent?.(event);
  }

  async heartbeat(receipt: Pick<PipelineReceipt, 'runId' | 'workstreamId' | 'attempt' | 'fence' | 'leaseToken' | 'inputSha'>): Promise<boolean> {
    return this.mutateReceipt(receipt, 'heartbeat', ws => ({ lease: ws.lease ? { ...ws.lease, heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.leaseTtlMs).toISOString() } : ws.lease }));
  }
  async complete(receipt: PipelineReceipt): Promise<boolean> {
    if (!receipt.artifactSha || !receipt.transcriptPath) {
      await this.blockReceipt(receipt, { code: 'PROVENANCE_PENDING', reason: 'completion requires artifactSha and transcriptPath' });
      return false;
    }
    return this.mutateReceipt(receipt, 'completion', () => ({ state: 'succeeded', artifact: { sha256: receipt.artifactSha!, path: receipt.artifactPath || receipt.transcriptPath }, messageId: receipt.messageId, replyTo: receipt.replyTo, scopeSha: receipt.scopeSha, lease: undefined }));
  }
  private async mutateReceipt(receipt: PipelineReceipt, type: string, patch: (ws: PipelineWorkstream) => Partial<PipelineWorkstream>): Promise<boolean> {
    const run = await this.options.store.get(receipt.runId); if (!run) return false;
    try {
      const next = await this.options.store.compareAndSwap(run.runId, run.revision, current => {
        const ws = current.workstreams.find(item => item.id === receipt.workstreamId);
        if (!ws?.lease || ws.attempt !== receipt.attempt || ws.lease.fence !== receipt.fence || ws.lease.token !== receipt.leaseToken || (receipt.inputSha !== undefined && ws.inputSha !== receipt.inputSha)) throw new Error('stale receipt');
        return this.withWorkstream(current, ws.id, patch(ws));
      });
      await this.emit(next, receipt.workstreamId, type, next.workstreams.find(ws => ws.id === receipt.workstreamId)?.state || type, { fence: receipt.fence, leaseToken: receipt.leaseToken, inputSha: receipt.inputSha, artifactSha: receipt.artifactSha, scopeSha: receipt.scopeSha, messageId: receipt.messageId, stage: next.workstreams.find(ws => ws.id === receipt.workstreamId)?.phase });
      return true;
    } catch {
      await this.options.store.appendEvent(receipt.runId, { type: 'stale_receipt_rejected', workstreamId: receipt.workstreamId, attempt: receipt.attempt, fence: receipt.fence, leaseToken: receipt.leaseToken, inputSha: receipt.inputSha, from: 'leased', to: 'blocked', action: 'reject', observedResult: 'stale receipt' }).catch(() => {});
      return false;
    }
  }
  private async blockReceipt(receipt: PipelineReceipt, blocker: PipelineBlocker): Promise<void> {
    const run = await this.options.store.get(receipt.runId); if (!run) return;
    try {
      const next = await this.options.store.compareAndSwap(run.runId, run.revision, current => {
        const ws = current.workstreams.find(item => item.id === receipt.workstreamId);
        if (!ws?.lease || ws.attempt !== receipt.attempt || ws.lease.fence !== receipt.fence || ws.lease.token !== receipt.leaseToken || (receipt.inputSha !== undefined && ws.inputSha !== receipt.inputSha)) throw new Error('stale receipt');
        return this.withWorkstream(current, receipt.workstreamId, { state: 'blocked', blocker, lease: undefined, fence: ws.lease.fence });
      });
      await this.emit(next, receipt.workstreamId, 'blocker', 'blocked', { fence: receipt.fence, leaseToken: receipt.leaseToken, data: blocker as unknown as Record<string, unknown> });
    } catch { /* stale completion is rejected and remains observable */ }
  }
}
