import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { withFileLockAsync } from '../utils/lock.js';
import { migrateGoalRun, validateGoalManifest } from './goal-manifest.js';
import { validateGoalAcceptanceProfile, type GoalConfig, type GoalRun, type GoalRunState } from './goal-run.js';

export type GoalClaimResult = { kind: 'claimed'; run: GoalRun } | { kind: 'not_eligible' } | { kind: 'lock_contended' };
export class GoalLockContentionError extends Error { constructor(operation: string) { super(`Goal run lock contended during ${operation}`); this.name = 'GoalLockContentionError'; } }
const terminal = (state: GoalRunState) => ['done', 'exhausted', 'cancelled'].includes(state);
const nowIso = (now: number) => new Date(now).toISOString();
const release = (run: GoalRun): GoalRun => { const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expires, ...rest } = run; return rest; };

export class GoalRunStore {
  private readonly goalRunsDir: string;
  constructor(stateRoot: string, private readonly config: GoalConfig) { this.goalRunsDir = resolve(stateRoot, 'goal-runs'); }
  async initialize(): Promise<void> { await mkdir(this.goalRunsDir, { recursive: true }); }
  private segment(kind: 'agent' | 'run', value: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error(`Invalid goal ${kind} identifier`);
    return value;
  }
  private agentDir(agent: string): string {
    const directory = resolve(this.goalRunsDir, this.segment('agent', agent));
    if (!directory.startsWith(`${this.goalRunsDir}${sep}`)) throw new Error('Goal agent path escapes goal-runs');
    return directory;
  }
  private path(agent: string, id: string): string {
    const directory = this.agentDir(agent); const path = resolve(directory, `${this.segment('run', id)}.json`);
    if (!path.startsWith(`${directory}${sep}`)) throw new Error('Goal run path escapes agent directory');
    return path;
  }
  private identity(run: GoalRun, agent: string, id: string): GoalRun {
    if (run.agentName !== agent || run.id !== id) throw new Error(`Goal run identity mismatch for ${agent}/${id}`);
    return run;
  }
  private bounded(value: string, bytes: number): string { const redacted = value.replace(/\b(?:sk-|xox[baprs]-|github_pat_)[A-Za-z0-9_-]+\b/g, '[redacted]').replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1[redacted]'); let used = 0; let end = 0; for (const character of redacted) { const width = Buffer.byteLength(character); if (used + width > bytes) break; used += width; end += character.length; } return redacted.slice(0, end); }
  private sanitize(run: GoalRun, now = Number.isFinite(Date.parse(run.updatedAt)) ? Date.parse(run.updatedAt) : Date.now()): GoalRun {
    const retention = { eventRetentionDays: this.config.eventRetentionDays, maxTerminalRuns: this.config.maxTerminalRuns, maxInlineArtifactBytes: this.config.maxInlineArtifactBytes, maxArtifactBytes: this.config.maxArtifactBytes, maxEvents: this.config.maxEvents, ...run.retention };
    const cutoff = now - retention.eventRetentionDays * 86_400_000; const events = run.events.filter((event) => !Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp) >= cutoff).slice(-retention.maxEvents).map((event) => ({ ...event, data: event.data ? { summary: this.bounded(typeof event.data.summary === 'string' && Object.keys(event.data).length === 1 ? event.data.summary : JSON.stringify(event.data), 1_024) } : undefined }));
    let artifactBytes = 0; const artifacts = [...run.artifacts].reverse().filter((artifact) => !Number.isFinite(Date.parse(artifact.timestamp)) || Date.parse(artifact.timestamp) >= cutoff).flatMap((artifact) => { const content = artifact.content === undefined ? undefined : this.bounded(artifact.content, Math.min(retention.maxInlineArtifactBytes, Math.max(0, retention.maxArtifactBytes - artifactBytes))); const size = content ? Buffer.byteLength(content) : 0; if (artifact.content !== undefined && size === 0) return []; artifactBytes += size; const metadata = artifact.metadata; return [{ ...artifact, content, metadata: metadata ? { checkId: metadata.checkId, itemId: metadata.itemId, cycle: metadata.cycle, provenance: metadata.provenance, truncated: Boolean(metadata.truncated || content !== artifact.content), aggregateTruncated: Boolean(metadata.aggregateTruncated) } : undefined }]; }).reverse();
    const recent = (timestamp: string): boolean => !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) >= cutoff;
    const itemProgress = run.itemProgress?.map((item) => ({ ...item, blocker: item.blocker ? { ...item.blocker, summary: this.bounded(item.blocker.summary, 512) } : undefined, implementationReceipt: item.implementationReceipt && recent(item.implementationReceipt.timestamp) ? { ...item.implementationReceipt, summary: this.bounded(item.implementationReceipt.summary, 2_048), artifactIds: item.implementationReceipt.artifactIds.slice(0, 64) } : undefined, evidenceReceipts: item.evidenceReceipts.filter((receipt) => recent(receipt.timestamp)).slice(-retention.maxEvents), reviewReceipts: item.reviewReceipts.filter((receipt) => recent(receipt.timestamp)).slice(-retention.maxEvents), findings: item.findings.filter((finding) => recent(finding.timestamp)).slice(-retention.maxEvents).map((finding) => ({ ...finding, summary: this.bounded(finding.summary, 1_024) })) }));
    return { ...run, retention, events, artifacts, itemProgress, checkResults: run.checkResults?.filter((result) => recent(result.timestamp)).slice(-retention.maxEvents) };
  }
  private async write(path: string, run: GoalRun, now?: number): Promise<void> { const safe = this.sanitize(run, now); const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 }); await rename(temp, path); }
  private async locked<T>(path: string, fn: () => Promise<T>): Promise<T> { return withFileLockAsync(dirname(path), fn, { timeoutMs: 250 }); }
  private lockError(error: unknown): boolean { return error instanceof Error && error.message.includes('failed to acquire lock'); }
  private validate(run: GoalRun): void {
    if (run.schemaVersion !== 3) return;
    if (!run.manifest || !run.itemProgress) throw new Error('schema-v3 run requires manifest and item progress');
    const errors = validateGoalManifest(run.manifest); const itemIds = run.manifest.boards.flatMap((board) => board.items.map((item) => item.id));
    if (run.itemProgress.length !== itemIds.length || run.itemProgress.some((progress, index) => progress.itemId !== itemIds[index])) errors.push('item progress must exactly match manifest order');
    const checks = new Set(run.acceptanceChecks.map((check) => check.id));
    if (checks.size !== run.acceptanceChecks.length) errors.push('acceptance check IDs must be unique');
    if (run.acceptanceChecks.length > 128 || run.acceptanceChecks.some((check) => !check.command.length || check.command.length > 32 || check.command.some((part) => typeof part !== 'string' || Buffer.byteLength(part) > 1_024))) errors.push('acceptance checks exceed bounded argv contract');
    if (run.acceptanceProfile?.name === 'repository-full') errors.push(...validateGoalAcceptanceProfile(run.acceptanceProfile, run.worktree || run.repo));
    for (const item of run.manifest.boards.flatMap((board) => board.items)) if (item.evidenceRequirements.some((requirement) => !checks.has(requirement.checkId))) errors.push(`unknown evidence requirement: ${item.id}`);
    if (errors.length) throw new Error(`Invalid goal manifest: ${errors.join('; ')}`);
  }
  async create(input: GoalRun): Promise<void> {
    const run = migrateGoalRun({ ...input, retention: input.retention ?? { eventRetentionDays: this.config.eventRetentionDays, maxTerminalRuns: this.config.maxTerminalRuns, maxInlineArtifactBytes: this.config.maxInlineArtifactBytes, maxArtifactBytes: this.config.maxArtifactBytes, maxEvents: this.config.maxEvents } });
    this.validate(run); const path = this.path(run.agentName, run.id); await mkdir(dirname(path), { recursive: true });
    try { await this.locked(path, async () => { try { await readFile(path, 'utf8'); throw new Error(`Goal run ${run.id} already exists`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await this.write(path, run); }); } catch (error) { if (this.lockError(error)) throw new GoalLockContentionError('create'); throw error; }
  }
  async get(agent: string, id: string): Promise<GoalRun | null> { try { const safeAgent = this.segment('agent', agent); const safeId = this.segment('run', id); return this.identity(migrateGoalRun(JSON.parse(await readFile(this.path(safeAgent, safeId), 'utf8')) as GoalRun), safeAgent, safeId); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
  async list(agent: string, state?: GoalRunState): Promise<GoalRun[]> { const safeAgent = this.segment('agent', agent); try { const files = await readdir(this.agentDir(safeAgent)); const runs = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => this.get(safeAgent, file.slice(0, -5)))); return runs.filter((run): run is GoalRun => run !== null && (!state || run.state === state)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
  async claimEligible(agent: string, id: string, owner: string, now = Date.now()): Promise<GoalClaimResult> {
    const path = this.path(agent, id);
    try { return await this.locked(path, async () => {
      const run = await this.get(agent, id); if (!run || terminal(run.state) || run.state === 'needs_human') return { kind: 'not_eligible' };
      this.validate(run);
      const dueRetry = run.state === 'retry_wait' && new Date(run.updatedAt).getTime() + Math.min(this.config.retryDelayMs * 2 ** Math.min(run.attempt, 20), this.config.retryMaxDelayMs) <= now;
      const leased = ['claimed', 'running', 'verifying'].includes(run.state); const expired = leased && Boolean(run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() <= now);
      if (!(run.state === 'queued' || dueRetry || expired)) return { kind: 'not_eligible' };
      const claimed: GoalRun = { ...run, state: 'claimed', leaseOwner: owner, leaseToken: randomUUID(), leaseExpiresAt: nowIso(now + this.config.leaseTtlMs), updatedAt: nowIso(now), events: [...run.events, { id: randomUUID(), type: 'claimed', timestamp: nowIso(now), data: { owner, reclaimed: expired } }] };
      await this.write(path, claimed); return { kind: 'claimed', run: claimed };
    }); } catch (error) { if (this.lockError(error)) return { kind: 'lock_contended' }; throw error; }
  }
  async update(agent: string, id: string, token: string, mutate: (run: GoalRun) => GoalRun, now = Date.now()): Promise<GoalRun> {
    const path = this.path(agent, id);
    try { return await this.locked(path, async () => { const run = await this.get(agent, id); if (!run) throw new Error(`Goal run ${id} not found`); if (!token || run.leaseToken !== token) throw new Error(`Lease token mismatch for ${id}`); if (!['claimed', 'running', 'verifying'].includes(run.state)) throw new Error(`Goal run ${id} is not in a leased state`); if (!run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime() <= now) throw new Error(`Lease expired for ${id}`); this.validate(run); const next = this.identity(mutate(run), agent, id); this.validate(next); await this.write(path, next, now); return this.sanitize(next, now); }); }
    catch (error) { if (this.lockError(error)) throw new GoalLockContentionError('update'); throw error; }
  }
  async updateUnleased(agent: string, id: string, mutate: (run: GoalRun) => GoalRun, now = Date.now()): Promise<GoalRun> {
    const path = this.path(agent, id);
    try { return await this.locked(path, async () => { const run = await this.get(agent, id); if (!run) throw new Error(`Goal run ${id} not found`); if (run.leaseToken && (!run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime() > now)) throw new Error(`Goal run ${id} is leased`); this.validate(run); const next = this.identity(mutate(release(run)), agent, id); this.validate(next); await this.write(path, next); return next; }); }
    catch (error) { if (this.lockError(error)) throw new GoalLockContentionError('updateUnleased'); throw error; }
  }
  async resume(agent: string, id: string, itemId?: string, now = Date.now()): Promise<GoalRun> {
    return this.updateUnleased(agent, id, (run) => {
      const progress = run.itemProgress ?? []; let resumed = 0;
      const next = progress.map((item) => item.status === 'waiting' && (!itemId || item.itemId === itemId) ? (resumed += 1, { ...item, status: 'runnable' as const, blocker: undefined, nextEligibleAt: undefined, updatedAt: nowIso(now) }) : item);
      if (!resumed) throw new Error(`No waiting item${itemId ? ` ${itemId}` : ''} found`);
      return { ...run, itemProgress: next, state: 'queued', updatedAt: nowIso(now), events: [...run.events, { id: randomUUID(), type: 'item_resumed', timestamp: nowIso(now), data: { itemId, count: resumed } }] };
    }, now);
  }
  async prune(agent: string, now = Date.now()): Promise<number> {
    const lockPath = resolve(this.agentDir(agent), '.retention'); await mkdir(dirname(lockPath), { recursive: true });
    try { return await this.locked(lockPath, async () => {
      const runs = await this.list(agent); const candidates = runs.filter((run) => terminal(run.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const old = candidates.filter((run) => new Date(run.updatedAt).getTime() < now - (run.retention ?? this.config).eventRetentionDays * 86_400_000);
      const newest = [...candidates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); const excess = newest.filter((run, index) => index >= (run.retention ?? this.config).maxTerminalRuns);
      const ids = new Set([...old, ...excess].map((run) => run.id)); for (const runId of ids) await unlink(this.path(agent, runId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      const survivors = runs.filter((run) => !ids.has(run.id)); const observationTarget = [...survivors].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
      for (const survivor of survivors) await this.write(this.path(agent, survivor.id), observationTarget?.id === survivor.id ? { ...survivor, events: [...survivor.events, { id: randomUUID(), type: 'retention_pruned', timestamp: nowIso(now), data: { removedRuns: ids.size } }] } : survivor, now);
      const metric = resolve(this.agentDir(agent), '.retention-observation'); const temp = `${metric}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify({ timestamp: nowIso(now), removedRuns: ids.size })}\n`, { mode: 0o600 }); await rename(temp, metric);
      return ids.size;
    }); } catch (error) { if (this.lockError(error)) throw new GoalLockContentionError('prune'); throw error; }
  }
}
