import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const hookPath = resolve(__dirname, '../../../orgs/clearworksai/agents/frank2/.claude/hooks/assert-telegram-delivery.sh');
const describeHook = existsSync(hookPath) ? describe : describe.skip;

function transcriptLine(
  type: 'assistant' | 'user',
  content: string | Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    type,
    message: {
      role: type,
      content,
    },
  });
}

function runHook(payload: Record<string, unknown>) {
  return spawnSync('bash', [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });
}

describeHook('assert-telegram-delivery stop hook', () => {
  let tempDir: string;
  let transcriptCounter = 0;

  const telegramInbound = transcriptLine(
    'user',
    "=== TELEGRAM from [USER: pd88] (chat_id:6690120787) ===\nwhat's the status?",
  );
  const normalInbound = transcriptLine('user', 'just a normal message');
  const assistantText = transcriptLine('assistant', [
    { type: 'text', text: 'Here is your answer: all green.' },
  ]);
  const assistantSend = transcriptLine('assistant', [
    {
      type: 'tool_use',
      name: 'Bash',
      input: { command: "cortextos bus send-telegram 6690120787 'all green'" },
    },
  ]);
  const assistantToolOnly = transcriptLine('assistant', [
    {
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/tmp/status.txt' },
    },
  ]);

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'assert-telegram-delivery-'));
    transcriptCounter = 0;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTranscript(lines: string[]): string {
    transcriptCounter += 1;
    const transcriptPath = join(tempDir, `transcript-${transcriptCounter}.jsonl`);
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`, 'utf-8');
    return transcriptPath;
  }

  it('blocks when a Telegram inbound gets assistant text but no send-telegram tool use', () => {
    const transcriptPath = writeTranscript([telegramInbound, assistantText]);

    const result = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"decision":"block"');
    expect(result.stdout).toContain('TELEGRAM DELIVERY GATE');
  });

  it('allows when a Telegram inbound is followed by assistant text and send-telegram', () => {
    const transcriptPath = writeTranscript([telegramInbound, assistantText, assistantSend]);

    const result = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('allows non-Telegram inbound turns', () => {
    const transcriptPath = writeTranscript([normalInbound, assistantText]);

    const result = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('allows when stop_hook_active is already true', () => {
    const transcriptPath = writeTranscript([telegramInbound, assistantText]);

    const result = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('allows unreadable transcripts fail-open', () => {
    const result = runHook({
      transcript_path: join(tempDir, 'does-not-exist.jsonl'),
      stop_hook_active: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('allows tool-only Telegram turns with no assistant text block', () => {
    const transcriptPath = writeTranscript([telegramInbound, assistantToolOnly]);

    const result = runHook({
      transcript_path: transcriptPath,
      stop_hook_active: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
