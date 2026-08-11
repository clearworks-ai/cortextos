/**
 * STAGING verification for the codex context-full DEADLOCK fix.
 *
 * Runs the REAL `CodexAppServerPTY` (the exact shipped code) against a PINNED
 * staging instance dir (~/.cortextos/cortextos-staging), writing/reading REAL
 * files on disk (NO fs mocks). Proves the two behaviors end-to-end:
 *
 *   A. RESUME yields REAL context_status usage even with NO tokenUsage push
 *      (pulled from the app-server rollout JSONL token_count event).
 *   B. A context-window turn error routes through the SAME hard-restart/handoff
 *      machinery (.force-fresh + .restart-planned + reset bridge + handoff marker),
 *      NOT a swallow and NOT a blank thread. Non-context errors do NOT recover.
 *   C. Loop guard caps recoveries at 2 / 5min.
 *
 * Isolated: staging instance, empty creds, cannot touch prod or message anyone.
 * Run: node_modules/.bin/vitest run scripts/staging/codex-context-full-staging-verify.test.mts
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CtxEnv } from '../../src/types/index.js';

const { CodexAppServerPTY } = await import('../../src/pty/codex-app-server-pty.js');

const INSTANCE = process.env.CTX_INSTANCE_ID || 'cortextos-staging';
if (INSTANCE.includes('cortextos1')) throw new Error('REFUSE: never run against prod');
const CTX_ROOT = join(homedir(), '.cortextos', INSTANCE);
const FW_ROOT = join(homedir(), '.cortextos', `${INSTANCE}-fw`);
const ORG = 'clearworksai';

type Internals = {
  _threadId: string | null;
  _alive: boolean;
  _appServerPty: { kill: () => void } | null;
  pullResumedContextUsage(thread: { id: string; path?: string | null; tokenUsage?: unknown } | undefined): void;
  handleTurnQueueFailure(err: unknown): void;
};

function seedAgent(agent: string): { env: CtxEnv; stateDir: string } {
  const agentDir = join(FW_ROOT, 'orgs', ORG, 'agents', agent);
  const stateDir = join(CTX_ROOT, 'state', agent);
  mkdirSync(join(agentDir, 'memory', 'handoffs'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  for (const f of ['context_status.json', '.force-fresh', '.restart-planned', '.handoff-doc-path', 'codex-context-recoveries.json']) {
    const p = join(stateDir, f);
    if (existsSync(p)) rmSync(p);
  }
  return {
    env: { instanceId: INSTANCE, ctxRoot: CTX_ROOT, frameworkRoot: FW_ROOT, agentName: agent, agentDir, org: ORG, projectRoot: FW_ROOT },
    stateDir,
  };
}

describe(`STAGING codex context-full fix [instance=${INSTANCE}]`, () => {
  it('A: resume pulls REAL usage from rollout JSONL with no tokenUsage push', () => {
    const { env, stateDir } = seedAgent('tlab-codex');
    const rollout = join(stateDir, 'rollout.jsonl');
    writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'resumed-full-thread' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 165000, cached_input_tokens: 10000, output_tokens: 5000, total_tokens: 180000 },
        total_token_usage: { input_tokens: 165000, cached_input_tokens: 10000, output_tokens: 5000, total_tokens: 180000 },
        model_context_window: 200000,
      } } }),
    ].join('\n'), 'utf-8');

    const pty = new CodexAppServerPTY(env, { model: 'gpt-5-codex' });
    const i = pty as unknown as Internals;
    i._threadId = 'resumed-full-thread';
    i.pullResumedContextUsage({ id: 'resumed-full-thread', path: rollout });

    const status = JSON.parse(readFileSync(join(stateDir, 'context_status.json'), 'utf-8'));
    expect(status.used_percentage).toBe(90); // 180k / 200k — the thread is FULL, not the restart-reset 0
    expect(status.measurement_source).toBe('resume_rollout');
    expect(status.context_window_size).toBe(200000);
  });

  it('B: context-window turn error routes to hard-restart/handoff machinery (not a swallow, not a blank thread)', () => {
    const { env, stateDir } = seedAgent('tlab-codex');
    writeFileSync(join(env.agentDir, 'memory', 'handoffs', 'handoff-staging.md'), '## Current Tasks\nStaging repro.\n', 'utf-8');
    const pty = new CodexAppServerPTY(env, { model: 'gpt-5-codex' });
    const i = pty as unknown as Internals;
    i._threadId = 'full-thread';
    i._alive = true;
    let killed = 0;
    i._appServerPty = { kill: () => { killed += 1; } };

    i.handleTurnQueueFailure(new Error("Codex ran out of room in the model's context window. Start a new thread"));

    expect(existsSync(join(stateDir, '.force-fresh'))).toBe(true);
    expect(readFileSync(join(stateDir, '.force-fresh'), 'utf-8')).toContain('CONTEXT-FORCE-RESTART');
    expect(existsSync(join(stateDir, '.restart-planned'))).toBe(true);
    expect(readFileSync(join(stateDir, '.handoff-doc-path'), 'utf-8')).toContain('handoff-staging.md');
    expect(JSON.parse(readFileSync(join(stateDir, 'context_status.json'), 'utf-8')).used_percentage).toBe(0);
    expect(killed).toBe(1);
  });

  it('B2: a non-context turn error does NOT trigger recovery', () => {
    const { env, stateDir } = seedAgent('tlab-codex-nonctx');
    const pty = new CodexAppServerPTY(env, { model: 'gpt-5-codex' });
    const i = pty as unknown as Internals;
    i._threadId = 'thread-x';
    i._alive = true;
    let killed = 0;
    i._appServerPty = { kill: () => { killed += 1; } };
    i.handleTurnQueueFailure(new Error('MCP transport closed unexpectedly'));
    expect(existsSync(join(stateDir, '.force-fresh'))).toBe(false);
    expect(killed).toBe(0);
  });

  it('C: loop guard caps recoveries at 2 within 5 minutes', () => {
    const { env } = seedAgent('tlab-codex-loop');
    let recoveries = 0;
    for (let n = 0; n < 4; n += 1) {
      const pty = new CodexAppServerPTY(env, { model: 'gpt-5-codex' });
      const i = pty as unknown as Internals;
      i._threadId = `t${n}`;
      i._alive = true;
      i._appServerPty = { kill: () => {} };
      i.handleTurnQueueFailure(new Error('context window exhausted'));
      if (/context-window recovery \d+\/2/.test(pty.getOutputBuffer().getRecent())) recoveries += 1;
    }
    expect(recoveries).toBe(2);
  });
});
