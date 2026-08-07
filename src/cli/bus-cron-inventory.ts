import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolveEnv } from '../utils/env.js';
import { IPCClient } from '../daemon/ipc-server.js';
import { inventoryCrons, type CronInventoryInput } from '../bus/cron-inventory.js';
import { readCronIdentity } from '../bus/cron-outcome.js';
import type { CronDefinition, CronSummaryRow } from '../types/index.js';

export function readCronDefinitions(filePath: string, unreadable: string[], malformed: string[]): CronDefinition[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    unreadable.push(filePath + ': ' + (error instanceof Error ? error.message : String(error)));
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { crons?: unknown }).crons)) {
      malformed.push(filePath + ': expected a crons array');
      return [];
    }
    const valid: CronDefinition[] = [];
    for (const item of (parsed as { crons: unknown[] }).crons) {
      if (!item || typeof item !== 'object' || typeof (item as CronDefinition).name !== 'string') malformed.push(filePath + ': malformed cron definition');
      else valid.push(item as CronDefinition);
    }
    return valid;
  } catch (error) {
    malformed.push(filePath + ': ' + (error instanceof Error ? error.message : String(error)));
    return [];
  }
}

function gatherDeclared(ctxRoot: string, input: CronInventoryInput): void {
  const agentsRoot = join(ctxRoot, '.cortextOS', 'state', 'agents');
  if (!existsSync(agentsRoot)) {
    (input.missing ?? []).push(agentsRoot + ': missing declared cron root');
    return;
  }
  try {
    for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(agentsRoot, entry.name, 'crons.json');
      if (existsSync(path)) input.declared[entry.name] = readCronDefinitions(path, input.unreadable ?? [], input.malformed ?? []);
    }
  } catch (error) {
    (input.unreadable ?? []).push(agentsRoot + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

function gatherRuntime(ctxRoot: string, input: CronInventoryInput): void {
  const stateRoot = join(ctxRoot, 'state');
  if (!existsSync(stateRoot)) {
    (input.missing ?? []).push(stateRoot + ': missing runtime outcome root');
    return;
  }
  try {
    for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(stateRoot, entry.name, 'cron-outcomes.jsonl');
      if (!existsSync(path)) continue;
      try {
        input.runtime[entry.name] = readFileSync(path, 'utf-8').split('\n').filter(Boolean).flatMap(line => {
          try {
            const row = JSON.parse(line) as { version?: unknown; cron?: unknown; run_id?: unknown; state?: unknown; scheduled_at?: unknown };
            if (row.version === 2 && typeof row.cron === 'string' && /^cron_v1_[a-f0-9]{32}$/.test(row.cron) && typeof row.run_id === 'string' && /^cron_v1_[a-f0-9]{32}$/.test(row.run_id) && typeof row.state === 'string' && typeof row.scheduled_at === 'string') return [row.cron];
            (input.malformed ?? []).push(path + ': outcome receipt has no cron');
            return [];
          } catch {
            (input.malformed ?? []).push(path + ': malformed outcome receipt');
            return [];
          }
        });
      } catch (error) {
        (input.unreadable ?? []).push(path + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  } catch (error) {
    (input.unreadable ?? []).push(stateRoot + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

function normalizeRuntimeIds(ctxRoot: string, input: CronInventoryInput): void {
  for (const [agent, runtime] of Object.entries(input.runtime)) {
    const candidates = [...(input.declared[agent] ?? []), ...(input.scheduled[agent] ?? [])].map(cron => cron.name);
    input.runtime[agent] = runtime.map(entry => {
      const id = typeof entry === 'string' ? entry : entry.name;
      try {
        const match = candidates.find(name => readCronIdentity(join(ctxRoot, 'state', agent), 'cron', name) === id);
        return match ?? id;
      } catch {
        (input.unreadable ?? []).push('runtime identity for ' + agent + ': unreadable');
        return id;
      }
    });
  }
}

export const cronInventoryCommand = new Command('cron-inventory')
  .description('Read-only inventory of declared, runtime, and daemon-scheduled crons.')
  .option('--json', 'Emit JSON')
  .action(async (opts: { json?: boolean }) => {
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot || process.cwd();
    const input: CronInventoryInput = { declared: {}, runtime: {}, scheduled: {}, missing: [], malformed: [], unreadable: [] };
    gatherDeclared(ctxRoot, input);
    gatherRuntime(ctxRoot, input);
    try {
      const response = await new IPCClient(env.instanceId).send({ type: 'list-all-crons', source: 'cortextos bus cron-inventory' });
      if (!response.success || !Array.isArray(response.data)) input.unreadable?.push('daemon schedule: ' + (response.error || 'unavailable'));
      else for (const row of response.data as CronSummaryRow[]) {
        if (!row || typeof row.agent !== 'string' || !row.cron || typeof row.cron !== 'object' || typeof row.cron.name !== 'string' || typeof row.cron.prompt !== 'string' || typeof row.cron.schedule !== 'string' || typeof row.cron.enabled !== 'boolean' || typeof row.cron.created_at !== 'string') input.malformed?.push('daemon schedule: malformed row');
        else (input.scheduled[row.agent] ??= []).push(row.cron);
      }
    } catch (error) {
      input.unreadable?.push('daemon schedule: ' + (error instanceof Error ? error.message : String(error)));
    }
    normalizeRuntimeIds(ctxRoot, input);
    const report = inventoryCrons(input);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (report.clean) console.log('Cron inventory: clean.');
    else for (const finding of report.findings) console.log('[' + finding.kind + '] ' + (finding.agent ? finding.agent + '/' : '') + (finding.cron ? finding.cron + ': ' : '') + finding.detail);
  });
