import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GoalRun, GoalRunState } from '../types/goal-run.js';

/** File-backed run store. Per-path serialization makes read/validate/write a compare-and-swap in this process. */
export class GoalRunStore {
  private readonly goalRunsDir: string;
  private readonly queues = new Map<string, Promise<void>>();
  constructor(stateRoot: string) { this.goalRunsDir = join(stateRoot, 'goal-runs'); }
  async initialize(): Promise<void> { await mkdir(this.goalRunsDir, { recursive: true }); }
  private path(agentName: string, id: string): string { return join(this.goalRunsDir, agentName, `${id}.json`); }
  private async atomicWrite(path: string, value: GoalRun): Promise<void> { const tmp = `${path}.${process.pid}.${Date.now()}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, path); }
  private async exclusive<T>(path: string, work: () => Promise<T>): Promise<T> { const prior = this.queues.get(path) ?? Promise.resolve(); let release!: () => void; const next = new Promise<void>(resolve => { release = resolve; }); this.queues.set(path, prior.then(() => next)); await prior; try { return await work(); } finally { release(); if (this.queues.get(path) === next) this.queues.delete(path); } }
  async create(run: GoalRun): Promise<void> { const path = this.path(run.agentName, run.id); await mkdir(join(this.goalRunsDir, run.agentName), { recursive: true }); await this.exclusive(path, async () => { try { await readFile(path, 'utf8'); throw new Error(`Goal run ${run.id} already exists`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await this.atomicWrite(path, run); }); }
  async get(agentName: string, id: string): Promise<GoalRun | null> { try { return JSON.parse(await readFile(this.path(agentName, id), 'utf8')) as GoalRun; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
  async list(agentName: string, state?: GoalRunState): Promise<GoalRun[]> { const dir = join(this.goalRunsDir, agentName); try { const files = await readdir(dir); const runs = await Promise.all(files.filter(f => f.endsWith('.json')).map(f => this.get(agentName, f.slice(0, -5)))); return runs.filter((run): run is GoalRun => run !== null && (!state || run.state === state)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
  async update(agentName: string, id: string, leaseToken: string, updater: (run: GoalRun) => GoalRun): Promise<GoalRun> { const path = this.path(agentName, id); return this.exclusive(path, async () => { const current = await this.get(agentName, id); if (!current) throw new Error(`Goal run ${id} not found`); if (leaseToken ? current.leaseToken !== leaseToken : Boolean(current.leaseToken)) throw new Error(`Lease token mismatch for ${id}`); const updated = updater(current); await this.atomicWrite(path, updated); return updated; }); }
  /** Unleased enqueue/cancel changes are intentionally restricted to runs without an active lease. */
  async updateUnleased(agentName: string, id: string, updater: (run: GoalRun) => GoalRun): Promise<GoalRun> { const path = this.path(agentName, id); return this.exclusive(path, async () => { const current = await this.get(agentName, id); if (!current) throw new Error(`Goal run ${id} not found`); if (current.leaseToken) throw new Error(`Goal run ${id} is leased`); const updated = updater(current); await this.atomicWrite(path, updated); return updated; }); }
  async delete(agentName: string, id: string): Promise<void> { try { await unlink(this.path(agentName, id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
