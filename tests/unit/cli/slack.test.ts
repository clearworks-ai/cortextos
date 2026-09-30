import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTestSend, slackCommand } from '../../../src/cli/slack';

describe('runTestSend', () => {
  let root: string;
  let api: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp3a-cli-'));
    api = { postMessage: vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '1' }) };
  });

  it('routes --as through the gated 3-arg path, never object-form identity', async () => {
    const agentDir = join(root, 'orgs', 'wyre', 'agents', 'boss');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'slack.json'),
      JSON.stringify({
        display_name: 'boss',
        icon_emoji: ':robot_face:',
        channels: {},
        allowed_channels: [],
      }),
    );
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', agent: 'boss', channel: 'C1', text: 'hi' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    const args = api.postMessage.mock.calls[0];
    expect(args[0]).toBe('C1');
    expect(args[1]).toBe('hi');
    expect(args[2]).toEqual({ username: 'boss' });
    expect(args[2]).not.toHaveProperty('icon_emoji');
    expect(args[2]).not.toHaveProperty('icon_url');
  });

  it('posts without identity when --as is omitted (string-form, not object-form)', async () => {
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', channel: 'C1', text: 'plain' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith('C1', 'plain');
  });

  it('malformed slack.json still throws parse failed (prior CLI behavior)', async () => {
    const agentDir = join(root, 'orgs', 'wyre', 'agents', 'boss');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'slack.json'), '{ not json');
    await expect(
      runTestSend(
        { frameworkRoot: root, org: 'wyre', agent: 'boss', channel: 'C1', text: 'hi' },
        api as never,
      ),
    ).rejects.toThrow(/slack.json parse failed for boss/);
    expect(api.postMessage).not.toHaveBeenCalled();
  });
});

describe('slack send subcommand (SP3b reply path)', () => {
  it('registers a stable "send" subcommand alongside test-send', () => {
    const names = slackCommand.commands.map((c) => c.name());
    expect(names).toContain('send');
    expect(names).toContain('test-send'); // unchanged — send is additive, not a replacement
  });
});

describe('CLI send payload — arbitrary slack.json identity never reaches chat.postMessage', () => {
  const saved = process.env.CTX_AGENT_NAME;
  const AGENT = 'boss';
  let root: string;
  let sent: unknown;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cli-persona-payload-'));
    sent = undefined;
    vi.resetModules();
    process.env.CTX_AGENT_NAME = AGENT;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' } as Response;
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = saved;
  });

  it('CEO display_name + icons in slack.json cannot appear in the posted body', async () => {
    const agentDir = join(root, 'orgs', 'wyre', 'agents', AGENT);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'slack.json'),
      JSON.stringify({
        display_name: 'CEO',
        icon_emoji: ':crown:',
        icon_url: 'https://evil.example/ceo.png',
        channels: {},
        allowed_channels: [],
      }),
    );
    const { runTestSend } = await import('../../../src/cli/slack');
    const { SlackAPI } = await import('../../../src/slack/api');
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', agent: AGENT, channel: 'C1', text: 'hi' },
      new SlackAPI('xoxb-test'),
    );
    const body = sent as Record<string, unknown>;
    expect(body).toEqual({ channel: 'C1', text: 'hi', username: AGENT });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('CEO');
    expect(serialized).not.toContain('crown');
    expect(serialized).not.toContain('evil.example');
  });
});
