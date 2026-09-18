import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTestSend, slackCommand } from '../../../src/cli/slack';
import { hasRecentReceiptOfKind } from '../../../src/utils/verification-receipt';

describe('runTestSend', () => {
  let root: string;
  let api: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp3a-cli-'));
    api = { postMessage: vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '1' }) };
  });

  it('posts a test message under the agent identity', async () => {
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
    const receipt = await runTestSend(
      {
        frameworkRoot: root, org: 'wyre', agent: 'boss', channel: 'C1', text: 'hi',
        ctxRoot: root,
      },
      api as never,
    );
    expect(receipt).toEqual({ ok: true, channel: 'C1', ts: '1' });
    expect(hasRecentReceiptOfKind(root, 'boss', ['external-send'], 60_000)).toBe(true);
    expect(api.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'hi',
      username: 'boss',
      icon_emoji: ':robot_face:',
    });
  });

  it('posts without identity when --as is omitted', async () => {
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', channel: 'C1', text: 'plain' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'plain' });
  });
});

describe('slack send subcommand (SP3b reply path)', () => {
  it('registers a stable "send" subcommand alongside test-send', () => {
    const names = slackCommand.commands.map((c) => c.name());
    expect(names).toContain('send');
    expect(names).toContain('test-send'); // unchanged — send is additive, not a replacement
  });
});
