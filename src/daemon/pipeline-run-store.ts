import { mkdir, readFile, readdir, rename, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLockAsync } from '../utils/lock.js';

export type PipelineRunState =
  | 'queued' | 'gating' | 'fanout' | 'joining' | 'reviewing' | 'staging_verify'
  | 'true_verify' | 'pr_ready' | 'blocked' | 'retry_wait' | 'done' | 'exhausted' | 'cancelled';
export type WorkstreamState = 'pending' | 'ready' | 'leased' | 'running' | 'succeeded' | 'failed' | 'retry_wait' | 'blocked' | 'exhausted' | 'cancelled';
export type PipelinePhase = 'research' | 'explore' | 'synthesize' | 'plan' | 'specs' | 'implement_light' | 'implement_heavy' | 'review' | 'staging-verify' | 'true-verify' | 'pr';
export type BlockerCode = 'PROVENANCE_PENDING' | 'WORKER_TRANSIENT' | 'HUMAN_APPROVAL' | 'TERMINAL_POLICY';

export interface PipelineRoute { runtime?: string; model?: string; provider?: string; [key: string]: unknown }
export interface PipelineLease { owner: string; token: string; expiresAt: string; heartbeatAt: string; fence: number }
export type Lease = PipelineLease;
export interface PipelineArtifact { id?: string; sha256: string; path?: string; ledgerRowId?: string; ledgerRowSha?: string; [key: string]: unknown }
export type ArtifactRef = PipelineArtifact;
export interface PipelineBlocker { code: BlockerCode; reason?: string; paths?: string[]; retryAt?: string }
export type Blocker = PipelineBlocker;

export interface PipelineWorkstream {
  id: string;
  phase: PipelinePhase;
  deps: string[];
  files?: string[];
  lane?: string;
  route?: PipelineRoute;
  state: WorkstreamState;
  attempt: number;
  maxAttempts: number;
  inputSha?: string;
  retryAt?: string;
  lease?: PipelineLease;
  /** Last fencing token remains durable after a lease is reclaimed. */
  fence?: number;
  artifact?: PipelineArtifact;
  blocker?: PipelineBlocker;
  dispatchKey?: string;
  messageId?: string;
  replyTo?: string;
  scopeSha?: string;
  transcriptPath?: string;
  updatedAt?: string;
  [key: string]: unknown;
}
export type Workstream = PipelineWorkstream;

export interface PipelineRun {
  runId: string;
  slug: string;
  goal: string;
  repo?: string;
  worktreeRoot?: string;
  state: PipelineRunState;
  specPath?: string;
  specifyPassSha?: string;
  goalConditionSha?: string;
  planner?: 'fable' | 'opus' | 'kimi-k3' | string;
  plannerConfirmed?: boolean;
  maxAttempts: number;
  attempt: number;
  revision: number;
  workstreams: PipelineWorkstream[];
  gates?: Array<Record<string, unknown>>;
  eventsPath?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface PipelineEvent {
  id: string;
  type: string;
  version?: 'pipeline_dispatch/v1' | string;
  timestamp: string;
  runId: string;
  workstreamId?: string;
  attempt: number;
  fence: number;
  leaseToken?: string;
  inputSha?: string;
  from?: string;
  to?: string;
  action?: string;
  observedResult?: string;
  causalEventId?: string;
  artifactSha?: string;
  scopeSha?: string;
  messageId?: string;
  stage?: string;
  route?: PipelineRoute;
  data?: Record<string, unknown>;
}

export class PipelineRevisionConflict extends Error {
  constructor(public readonly runId: string, public readonly expected: number, public readonly actual: number) {
    super(`Pipeline run ${runId} revision conflict: expected ${expected}, found ${actual}`);
    this.name = 'PipelineRevisionConflict';
  }
}

/** Atomic, revisioned file projection for pipeline runs and append-only events. */
export class PipelineRunStore {
  readonly runsDir: string;
  readonly eventsDir: string;
  constructor(readonly stateRoot: string) {
    this.runsDir = join(stateRoot, 'pipeline-runs');
    this.eventsDir = join(stateRoot, 'pipeline-events');
  }

  async initialize(): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
    await mkdir(this.eventsDir, { recursive: true });
  }
  private runPath(runId: string): string { return join(this.runsDir, `${runId}.json`); }
  private eventPath(run: PipelineRun): string { return run.eventsPath || join(this.eventsDir, `${run.runId}.jsonl`); }
  private async atomicWrite(path: string, value: PipelineRun): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  }
  async create(run: PipelineRun): Promise<void> {
    await this.initialize();
    const value: PipelineRun = { ...run, revision: run.revision ?? 0, eventsPath: run.eventsPath || join(this.eventsDir, `${run.runId}.jsonl`) };
    const path = this.runPath(run.runId);
    await mkdir(`${path}.lock`, { recursive: true });
    await withFileLockAsync(`${path}.lock`, async () => {
      try { await readFile(path, 'utf8'); throw new Error(`Pipeline run ${run.runId} already exists`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.atomicWrite(path, value);
    });
  }
  async get(runId: string): Promise<PipelineRun | null> {
    try { return JSON.parse(await readFile(this.runPath(runId), 'utf8')) as PipelineRun; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async list(): Promise<PipelineRun[]> {
    try {
      const files = await readdir(this.runsDir);
      const runs = await Promise.all(files.filter(f => f.endsWith('.json')).map(f => this.get(f.slice(0, -5))));
      return runs.filter((run): run is PipelineRun => run !== null);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  /** Compare-and-swap a complete run. Every successful mutation increments revision. */
  async compareAndSwap(runId: string, expectedRevision: number, updater: (run: PipelineRun) => PipelineRun): Promise<PipelineRun> {
    const path = this.runPath(runId);
    await mkdir(`${path}.lock`, { recursive: true });
    return withFileLockAsync(`${path}.lock`, async () => {
      const current = await this.get(runId);
      if (!current) throw new Error(`Pipeline run ${runId} not found`);
      if (current.revision !== expectedRevision) throw new PipelineRevisionConflict(runId, expectedRevision, current.revision);
      const updated = updater(current);
      const next = { ...updated, revision: current.revision + 1, updatedAt: new Date().toISOString(), eventsPath: updated.eventsPath || current.eventsPath };
      await this.atomicWrite(path, next);
      return next;
    });
  }
  /** Alias used by callers that call this operation `update`. */
  async update(runId: string, expectedRevision: number, updater: (run: PipelineRun) => PipelineRun): Promise<PipelineRun> {
    return this.compareAndSwap(runId, expectedRevision, updater);
  }
  async appendEvent(runId: string, event: Omit<PipelineEvent, 'id' | 'timestamp' | 'runId'> & Partial<Pick<PipelineEvent, 'runId'>>): Promise<PipelineEvent> {
    const run = await this.get(runId);
    if (!run) throw new Error(`Pipeline run ${runId} not found`);
    const full: PipelineEvent = { ...event, id: randomUUID(), timestamp: new Date().toISOString(), runId };
    const path = this.eventPath(run);
    await mkdir(`${path}.lock`, { recursive: true });
    await withFileLockAsync(`${path}.lock`, async () => {
      await mkdir(join(path, '..'), { recursive: true });
      await appendFile(path, `${JSON.stringify(full)}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    return full;
  }
  async events(runId: string): Promise<PipelineEvent[]> {
    const run = await this.get(runId); if (!run) return [];
    try { const raw = await readFile(this.eventPath(run), 'utf8'); return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as PipelineEvent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
}
