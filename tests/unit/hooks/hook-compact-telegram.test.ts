import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mockLogEvent = vi.fn();
const mockResolvePaths = vi.fn().mockReturnValue({ analyticsDir: '/tmp/test-analytics' });

vi.mock('../../../src/bus/event.js', () => ({
  logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: (...args: unknown[]) => mockResolvePaths(...args),
}));

vi.mock('../../../src/hooks/index.js', () => ({
  loadEnv: () => ({
    agentName: 'agent',
    botToken: '',
    chatId: '',
  }),
}));

import { readEmitSystemPingsFlag } from '../../../src/hooks/hook-compact-telegram.js';

describe('readEmitSystemPingsFlag', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'compact-telegram-'));
    mockLogEvent.mockReset();
    mockResolvePaths.mockClear();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false when agentDir is undefined', () => {
    expect(readEmitSystemPingsFlag(undefined)).toBe(false);
  });

  it('returns false when config.json is missing', () => {
    expect(readEmitSystemPingsFlag(tmp)).toBe(false);
  });

  it('returns false when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{ trailing,', 'utf-8');
    expect(readEmitSystemPingsFlag(tmp)).toBe(false);
  });

  it('returns false when the flag is absent', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'agent' }), 'utf-8');
    expect(readEmitSystemPingsFlag(tmp)).toBe(false);
  });

  it('returns false when emit_system_telegram_pings is false', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ emit_system_telegram_pings: false }), 'utf-8');
    expect(readEmitSystemPingsFlag(tmp)).toBe(false);
  });

  it('returns true when emit_system_telegram_pings is true', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ emit_system_telegram_pings: true }), 'utf-8');
    expect(readEmitSystemPingsFlag(tmp)).toBe(true);
  });

  it('returns false for truthy non-boolean values', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ emit_system_telegram_pings: 'yes' }), 'utf-8');
    expect(readEmitSystemPingsFlag(tmp)).toBe(false);

    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ emit_system_telegram_pings: 1 }), 'utf-8');
    expect(readEmitSystemPingsFlag(tmp)).toBe(false);
  });
});
