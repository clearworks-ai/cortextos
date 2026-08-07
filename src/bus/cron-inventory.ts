import type { CronDefinition } from '../types/index.js';

export type CronInventoryFindingKind = 'missing_root' | 'malformed_input' | 'unreadable_input' | 'declared_only' | 'runtime_only' | 'scheduled_only' | 'definition_mismatch';
export interface CronInventoryFinding { kind: CronInventoryFindingKind; agent?: string; cron?: string; detail: string; }
export interface CronInventoryInput {
  declared: Record<string, CronDefinition[]>;
  runtime: Record<string, Array<string | { name: string }>>;
  scheduled: Record<string, CronDefinition[]>;
  missing?: string[];
  malformed?: string[];
  unreadable?: string[];
}
export interface CronInventoryReport { findings: CronInventoryFinding[]; clean: boolean; }

function isCron(value: unknown): value is CronDefinition {
  if (!value || typeof value !== 'object') return false;
  const cron = value as Partial<CronDefinition>;
  return typeof cron.name === 'string' && cron.name.length > 0
    && typeof cron.prompt === 'string'
    && typeof cron.schedule === 'string'
    && typeof cron.enabled === 'boolean'
    && typeof cron.created_at === 'string'
    && !Number.isNaN(Date.parse(cron.created_at));
}

function identity(cron: CronDefinition): string {
  return JSON.stringify({ name: cron.name, prompt: cron.prompt, schedule: cron.schedule, enabled: cron.enabled, fire_at: cron.fire_at ?? null, manualFireDisabled: cron.manualFireDisabled ?? null, owner: cron.owner ?? null, timeout_ms: cron.timeout_ms ?? null, expected_output: cron.expected_output ?? null, backstop_class: cron.backstop_class ?? null });
}

function names(entries: unknown, findings: CronInventoryFinding[], agent: string): string[] {
  if (!Array.isArray(entries)) {
    findings.push({ kind: 'malformed_input', agent, detail: 'runtime entries are not an array' });
    return [];
  }
  const result = new Set<string>();
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : undefined;
    if (!name) findings.push({ kind: 'malformed_input', agent, detail: 'runtime entry is invalid' });
    else result.add(name);
  }
  return [...result];
}

function cronMap(value: unknown, source: 'declared' | 'scheduled', findings: CronInventoryFinding[], agent: string): Map<string, CronDefinition> {
  if (!Array.isArray(value)) {
    findings.push({ kind: 'malformed_input', agent, detail: source + ' crons are not an array' });
    return new Map();
  }
  const mapped = new Map<string, CronDefinition>();
  for (const cron of value) {
    if (!isCron(cron)) {
      findings.push({ kind: 'malformed_input', agent, detail: source + ' cron is invalid' });
      continue;
    }
    if (mapped.has(cron.name)) findings.push({ kind: 'malformed_input', agent, cron: cron.name, detail: source + ' cron is duplicated' });
    else mapped.set(cron.name, cron);
  }
  return mapped;
}

/** Pure, read-only comparison. All invalid inputs become explicit findings. */
export function inventoryCrons(input: CronInventoryInput): CronInventoryReport {
  const findings: CronInventoryFinding[] = [];
  for (const detail of input.missing ?? []) findings.push({ kind: 'missing_root', detail });
  for (const detail of input.malformed ?? []) findings.push({ kind: 'malformed_input', detail });
  for (const detail of input.unreadable ?? []) findings.push({ kind: 'unreadable_input', detail });
  const declaredRoot = input.declared && typeof input.declared === 'object' ? input.declared : {};
  const runtimeRoot = input.runtime && typeof input.runtime === 'object' ? input.runtime : {};
  const scheduledRoot = input.scheduled && typeof input.scheduled === 'object' ? input.scheduled : {};
  const agents = new Set([...Object.keys(declaredRoot), ...Object.keys(runtimeRoot), ...Object.keys(scheduledRoot)]);
  for (const agent of [...agents].sort()) {
    const declared = cronMap(declaredRoot[agent], 'declared', findings, agent);
    const scheduled = cronMap(scheduledRoot[agent], 'scheduled', findings, agent);
    for (const [name, cron] of declared) {
      const scheduledCron = scheduled.get(name);
      if (!scheduledCron) findings.push({ kind: 'declared_only', agent, cron: name, detail: 'declared but absent from daemon schedule' });
      else if (identity(cron) !== identity(scheduledCron)) findings.push({ kind: 'definition_mismatch', agent, cron: name, detail: 'declared definition differs from daemon schedule' });
    }
    for (const name of names(runtimeRoot[agent] ?? [], findings, agent)) if (!declared.has(name)) findings.push({ kind: 'runtime_only', agent, cron: name, detail: 'runtime activity has no declaration' });
    for (const name of scheduled.keys()) if (!declared.has(name)) findings.push({ kind: 'scheduled_only', agent, cron: name, detail: 'daemon schedule has no declaration' });
  }
  return { findings, clean: findings.length === 0 };
}
