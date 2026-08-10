import { createHmac, randomBytes, randomUUID } from 'crypto';
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

export const CRON_OUTCOME_VERSION = 2;
export const DEFAULT_CRON_OUTCOME_TIMEOUT_MS = 30 * 60_000;
export const MAX_CRON_OUTCOME_LINES = 2_000;
const MAX_CRON_OUTCOME_BYTES = 1_024;
const ROTATE_AT_BYTES = 512 * 1_024;
const RUN_ID_RE = /^cron_v1_[a-f0-9]{32}$/;
const ID_RE = /^(agent|cron)_v1_[a-f0-9]{32}$/;
const SAFE_VALUE_RE = /^[a-z][a-z0-9_.:-]{0,95}$/;
export const MAX_CRON_OUTCOME_INDEX_RECORDS = 20_000;

export type CronOutcomeState = 'scheduled' | 'started' | 'dispatched' | 'succeeded' | 'failed' | 'skipped' | 'timed_out' | 'needs_human';

export interface CronOutcomeReceipt {
  version: typeof CRON_OUTCOME_VERSION;
  receipt_id: string;
  run_id: string;
  attempt: number;
  /** Redacted, stable HMAC identifier. */
  agent: string;
  /** Redacted, stable HMAC identifier. */
  cron: string;
  state: CronOutcomeState;
  at: string;
  scheduled_at: string;
  detail?: string;
}

export interface CronOutcomeInput {
  run_id: string;
  attempt: number;
  agent: string;
  cron: string;
  state: CronOutcomeState;
  detail?: string;
  at?: string;
  scheduled_at?: string;
}

interface CronOutcomeIndex {
  version: 1;
  latest: Record<string, CronOutcomeReceipt>;
  nonterminal: Record<string, CronOutcomeReceipt>;
  idempotent: Record<string, CronOutcomeReceipt>;
}
interface CronOutcomeJournal { version: 1; receipt: CronOutcomeReceipt; }

const TERMINAL = new Set<CronOutcomeState>(['succeeded', 'failed', 'skipped', 'timed_out', 'needs_human']);

function outcomesPath(stateDir: string): string { return join(stateDir, 'cron-outcomes.jsonl'); }
function outcomesLock(stateDir: string): string { return join(stateDir, '.cron-outcome-domain'); }
function indexPath(stateDir: string): string { return join(stateDir, 'cron-outcome-index.json'); }
function journalPath(stateDir: string): string { return join(stateDir, 'cron-outcome-tx.json'); }
function secretPath(stateDir: string): string { return join(stateDir, 'cron-outcome-secret'); }
function emptyIndex(): CronOutcomeIndex { return { version: 1, latest: {}, nonterminal: {}, idempotent: {} }; }
function idempotentKey(row: CronOutcomeReceipt): string { return row.run_id + '\u0000' + row.state + '\u0000' + row.attempt; }

function withCronOutcomeLock<T>(stateDir: string, fn: () => T): T {
  ensureDir(stateDir);
  ensureDir(outcomesLock(stateDir));
  return withFileLockSync(outcomesLock(stateDir), fn);
}

function readOrCreateSecretLocked(stateDir: string): Buffer {
  const filePath = secretPath(stateDir);
  if (existsSync(filePath)) {
    const stored = readFileSync(filePath, 'utf-8').trim();
    if (!/^[a-f0-9]{64}$/.test(stored)) throw new Error('cron receipt identity key is unreadable');
    return Buffer.from(stored, 'hex');
  }
  const key = randomBytes(32);
  atomicWriteSync(filePath, key.toString('hex'));
  return key;
}

function hmacId(key: Buffer, prefix: 'agent' | 'cron' | 'run', value: string): string {
  return prefix + '_v1_' + createHmac('sha256', key).update(value).digest('hex').slice(0, 32);
}

function assertRawIdentity(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) throw new Error('invalid cron receipt identity');
}

export function cronRunId(stateDir: string, agent: string, cron: string, scheduledAt: string): string {
  assertRawIdentity(agent);
  assertRawIdentity(cron);
  if (Number.isNaN(Date.parse(scheduledAt))) throw new Error('invalid cron receipt identity');
  return withCronOutcomeLock(stateDir, () => hmacId(readOrCreateSecretLocked(stateDir), 'run', agent + '\u0000' + cron + '\u0000' + scheduledAt).replace('run_v1_', 'cron_v1_'));
}

export function cronIdentity(stateDir: string, kind: 'agent' | 'cron', value: string): string {
  assertRawIdentity(value);
  return withCronOutcomeLock(stateDir, () => hmacId(readOrCreateSecretLocked(stateDir), kind, value));
}

/** Read-only identity lookup for inventory; never creates a secret or state. */
export function readCronIdentity(stateDir: string, kind: 'agent' | 'cron', value: string): string | undefined {
  assertRawIdentity(value);
  const filePath = secretPath(stateDir);
  if (!existsSync(filePath)) return undefined;
  const stored = readFileSync(filePath, 'utf-8').trim();
  if (!/^[a-f0-9]{64}$/.test(stored)) throw new Error('cron receipt identity key is unreadable');
  return hmacId(Buffer.from(stored, 'hex'), kind, value);
}

function assertOutcome(row: CronOutcomeReceipt): void {
  const allowed = new Set(['version', 'receipt_id', 'run_id', 'attempt', 'agent', 'cron', 'state', 'at', 'scheduled_at', 'detail']);
  for (const key of Object.keys(row)) if (!allowed.has(key)) throw new Error('invalid cron outcome');
  if (row.version !== CRON_OUTCOME_VERSION || !RUN_ID_RE.test(row.run_id) || !/^[0-9a-f-]{36}$/i.test(row.receipt_id) || !Number.isInteger(row.attempt) || row.attempt < 1 || !ID_RE.test(row.agent) || !ID_RE.test(row.cron) || Number.isNaN(Date.parse(row.at)) || Number.isNaN(Date.parse(row.scheduled_at))) throw new Error('invalid cron outcome');
  if (row.detail !== undefined && !SAFE_VALUE_RE.test(row.detail)) throw new Error('invalid cron outcome');
  if (!['scheduled', 'started', 'dispatched', 'succeeded', 'failed', 'skipped', 'timed_out', 'needs_human'].includes(row.state)) throw new Error('invalid cron outcome');
  if (Buffer.byteLength(JSON.stringify(row), 'utf-8') > MAX_CRON_OUTCOME_BYTES) throw new Error('cron outcome exceeds bounded size');
}

function assertIndex(index: CronOutcomeIndex): void {
  if (index.version !== 1 || !index.latest || !index.nonterminal || !index.idempotent) throw new Error('cron outcome index is invalid');
  if (Object.keys(index.idempotent).length > MAX_CRON_OUTCOME_INDEX_RECORDS) throw new Error('cron outcome index exceeds bounded capacity');
  for (const row of Object.values(index.latest)) assertOutcome(row);
  for (const row of Object.values(index.nonterminal)) {
    assertOutcome(row);
    if (TERMINAL.has(row.state)) throw new Error('cron outcome index is invalid');
  }
  for (const row of Object.values(index.idempotent)) assertOutcome(row);
}

function readIndexLocked(stateDir: string): CronOutcomeIndex {
  if (!existsSync(indexPath(stateDir))) return emptyIndex();
  try {
    const index = JSON.parse(readFileSync(indexPath(stateDir), 'utf-8')) as CronOutcomeIndex;
    assertIndex(index);
    return index;
  } catch {
    throw new Error('cron outcome index is unreadable');
  }
}

function writeIndexLocked(stateDir: string, index: CronOutcomeIndex): void {
  assertIndex(index);
  atomicWriteSync(indexPath(stateDir), JSON.stringify(index));
}

/** Drop the oldest completed runs before the idempotency index reaches its cap. */
function pruneIndexLocked(index: CronOutcomeIndex): void {
  if (Object.keys(index.idempotent).length <= MAX_CRON_OUTCOME_INDEX_RECORDS) return;
  const completedRuns = Object.values(index.latest)
    .filter(row => TERMINAL.has(row.state))
    .sort((left, right) => left.at.localeCompare(right.at));
  for (const completed of completedRuns) {
    delete index.latest[completed.run_id];
    delete index.nonterminal[completed.run_id];
    const prefix = completed.run_id + '\u0000';
    for (const key of Object.keys(index.idempotent)) if (key.startsWith(prefix)) delete index.idempotent[key];
    if (Object.keys(index.idempotent).length <= MAX_CRON_OUTCOME_INDEX_RECORDS) return;
  }
  throw new Error('cron outcome index exceeds bounded capacity');
}

function rotateIfNeededLocked(stateDir: string): void {
  const filePath = outcomesPath(stateDir);
  if (!existsSync(filePath) || statSync(filePath).size < ROTATE_AT_BYTES) return;
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  if (lines.length > MAX_CRON_OUTCOME_LINES) atomicWriteSync(filePath, lines.slice(-MAX_CRON_OUTCOME_LINES).join('\n') + '\n');
}

function appendLogLocked(stateDir: string, row: CronOutcomeReceipt): void {
  rotateIfNeededLocked(stateDir);
  appendFileSync(outcomesPath(stateDir), JSON.stringify(row) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

function hasReceiptLocked(stateDir: string, receiptId: string): boolean {
  if (!existsSync(outcomesPath(stateDir))) return false;
  return readFileSync(outcomesPath(stateDir), 'utf-8').split('\n').some(line => {
    try { return !!line && (JSON.parse(line) as CronOutcomeReceipt).receipt_id === receiptId; } catch { return false; }
  });
}

function assertTransition(previous: CronOutcomeReceipt | undefined, next: CronOutcomeReceipt): void {
  if (!previous) {
    if (next.state !== 'scheduled') throw new Error('cron outcome must start scheduled');
    return;
  }
  if (TERMINAL.has(previous.state)) throw new Error('cron outcome is terminal');
  if (next.attempt < previous.attempt) throw new Error('cron outcome attempt regressed');
  const valid = (previous.state === 'scheduled' && (next.state === 'started' || next.state === 'failed' || next.state === 'skipped' || next.state === 'timed_out' || next.state === 'needs_human'))
    || (previous.state === 'started' && (next.state === 'started' || next.state === 'dispatched' || next.state === 'failed' || next.state === 'needs_human' || next.state === 'timed_out'))
    || (previous.state === 'dispatched' && (next.state === 'succeeded' || next.state === 'failed' || next.state === 'timed_out' || next.state === 'needs_human'));
  if (!valid) throw new Error('invalid cron outcome transition');
}

function applyReceiptLocked(stateDir: string, index: CronOutcomeIndex, row: CronOutcomeReceipt): CronOutcomeReceipt {
  const idempotent = index.idempotent[idempotentKey(row)];
  if (idempotent) return idempotent;
  assertTransition(index.latest[row.run_id], row);
  atomicWriteSync(journalPath(stateDir), JSON.stringify({ version: 1, receipt: row }));
  appendLogLocked(stateDir, row);
  index.latest[row.run_id] = row;
  if (TERMINAL.has(row.state)) delete index.nonterminal[row.run_id];
  else index.nonterminal[row.run_id] = row;
  index.idempotent[idempotentKey(row)] = row;
  pruneIndexLocked(index);
  writeIndexLocked(stateDir, index);
  try { unlinkSync(journalPath(stateDir)); } catch { /* recovered on the next operation */ }
  return row;
}

function recoverJournalLocked(stateDir: string, index: CronOutcomeIndex): void {
  if (!existsSync(journalPath(stateDir))) return;
  let journal: CronOutcomeJournal;
  try {
    journal = JSON.parse(readFileSync(journalPath(stateDir), 'utf-8')) as CronOutcomeJournal;
    if (journal.version !== 1) throw new Error('invalid');
    assertOutcome(journal.receipt);
  } catch {
    throw new Error('cron outcome transaction is unreadable');
  }
  const row = journal.receipt;
  if (!index.idempotent[idempotentKey(row)]) {
    if (!hasReceiptLocked(stateDir, row.receipt_id)) appendLogLocked(stateDir, row);
    assertTransition(index.latest[row.run_id], row);
    index.latest[row.run_id] = row;
    if (TERMINAL.has(row.state)) delete index.nonterminal[row.run_id];
    else index.nonterminal[row.run_id] = row;
    index.idempotent[idempotentKey(row)] = row;
    pruneIndexLocked(index);
    writeIndexLocked(stateDir, index);
  }
  try { unlinkSync(journalPath(stateDir)); } catch { /* next call retries cleanup */ }
}

export function appendCronOutcome(stateDir: string, input: CronOutcomeInput): CronOutcomeReceipt {
  assertRawIdentity(input.agent);
  assertRawIdentity(input.cron);
  return withCronOutcomeLock(stateDir, () => {
    const index = readIndexLocked(stateDir);
    recoverJournalLocked(stateDir, index);
    const key = readOrCreateSecretLocked(stateDir);
    const previous = index.latest[input.run_id];
    const row: CronOutcomeReceipt = {
      version: CRON_OUTCOME_VERSION,
      receipt_id: randomUUID(),
      run_id: input.run_id,
      attempt: input.attempt,
      agent: hmacId(key, 'agent', input.agent),
      cron: hmacId(key, 'cron', input.cron),
      state: input.state,
      at: input.at ?? new Date().toISOString(),
      scheduled_at: input.scheduled_at ?? previous?.scheduled_at ?? input.at ?? new Date().toISOString(),
      detail: input.detail,
    };
    assertOutcome(row);
    return applyReceiptLocked(stateDir, index, row);
  });
}

export function readCronOutcomes(stateDir: string, limit = 500): CronOutcomeReceipt[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CRON_OUTCOME_LINES) throw new Error('invalid cron outcome limit');
  if (!existsSync(outcomesPath(stateDir))) return [];
  try {
    return readFileSync(outcomesPath(stateDir), 'utf-8').split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line) as CronOutcomeReceipt;
      assertOutcome(row);
      return row;
    }).slice(-limit);
  } catch {
    throw new Error('cron outcomes unreadable');
  }
}

export function getCronOutcome(stateDir: string, runId: string): CronOutcomeReceipt | undefined {
  if (!RUN_ID_RE.test(runId)) throw new Error('invalid cron run id');
  return withCronOutcomeLock(stateDir, () => {
    const index = readIndexLocked(stateDir);
    recoverJournalLocked(stateDir, index);
    return index.latest[runId];
  });
}

export function getActiveCronOutcome(stateDir: string, agent: string, cron: string): CronOutcomeReceipt | undefined {
  assertRawIdentity(agent);
  assertRawIdentity(cron);
  return withCronOutcomeLock(stateDir, () => {
    const index = readIndexLocked(stateDir);
    recoverJournalLocked(stateDir, index);
    const key = readOrCreateSecretLocked(stateDir);
    const agentId = hmacId(key, 'agent', agent);
    const cronId = hmacId(key, 'cron', cron);
    const matches = Object.values(index.nonterminal)
      .filter(row => row.agent === agentId && row.cron === cronId)
      .sort((left, right) => left.scheduled_at.localeCompare(right.scheduled_at) || left.at.localeCompare(right.at));
    return matches.find(row => row.state === 'scheduled' || row.state === 'started') ?? matches[0];
  });
}

export function reconcileCronOutcomes(stateDir: string, nowMs = Date.now(), timeoutMs = DEFAULT_CRON_OUTCOME_TIMEOUT_MS): CronOutcomeReceipt[] {
  if (!Number.isFinite(nowMs) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid cron outcome timeout');
  return withCronOutcomeLock(stateDir, () => {
    const index = readIndexLocked(stateDir);
    recoverJournalLocked(stateDir, index);
    const created: CronOutcomeReceipt[] = [];
    for (const row of Object.values(index.nonterminal)) {
      if (nowMs - Date.parse(row.at) < timeoutMs) continue;
      const timedOut: CronOutcomeReceipt = { ...row, receipt_id: randomUUID(), state: 'timed_out', at: new Date(nowMs).toISOString(), detail: 'terminal_receipt_missing' };
      created.push(applyReceiptLocked(stateDir, index, timedOut));
    }
    return created;
  });
}
