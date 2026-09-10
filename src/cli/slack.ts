import { Command } from 'commander';
import { SlackAPI, loadSlackIdentity, type PostMessageRequest } from '../slack/index.js';
import { resolveEnv, loadEnvFileInto } from '../utils/env.js';
import { recordVerificationReceipt } from '../utils/verification-receipt.js';
import { join } from 'path';

export interface TestSendOptions {
  frameworkRoot: string;
  org: string;
  agent?: string;
  channel: string;
  text: string;
  ctxRoot?: string;
  receiptAgent?: string;
}

/** Pure function — testable without process exit. */
export async function runTestSend(opts: TestSendOptions, api: SlackAPI) {
  const req: PostMessageRequest = { channel: opts.channel, text: opts.text };
  if (opts.agent) {
    const id = loadSlackIdentity(opts.frameworkRoot, opts.org, opts.agent);
    if (!id) throw new Error(`agent "${opts.agent}" has no slack.json (not Slack-enabled)`);
    req.username = id.username;
    if (id.icon_emoji) req.icon_emoji = id.icon_emoji;
    if (id.icon_url) req.icon_url = id.icon_url;
  }
  const response = await api.postMessage(req);
  const receiptAgent = opts.receiptAgent ?? opts.agent;
  if (opts.ctxRoot && receiptAgent) {
    recordVerificationReceipt(opts.ctxRoot, receiptAgent, {
      kind: 'external-send',
      ref: `slack:${response.channel}:${response.ts}`,
    });
  }
  return response;
}

function requireToken(): string {
  const env = resolveEnv();
  const frameworkRoot =
    process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || env.frameworkRoot || process.cwd();
  const orgSecrets: Record<string, string> = {};
  if (env.org) {
    loadEnvFileInto(join(frameworkRoot, 'orgs', env.org, 'secrets.env'), orgSecrets);
  }
  const token = process.env.SLACK_BOT_TOKEN || orgSecrets.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN not set. See docs/runbook/slack-adapter-setup.md.');
    process.exit(1);
  }
  return token;
}

function requireOrg(opt?: string): string {
  const org = opt || resolveEnv().org;
  if (!org) {
    console.error('ERROR: --org or CTX_ORG required');
    process.exit(1);
  }
  return org;
}

const testSendCommand = new Command('test-send')
  .argument('<channel>', 'Slack channel id (Cxxx) or name (#general)')
  .argument('<text>', 'Message text')
  .option('--as <agent>', 'Post under this agent\'s identity (loads slack.json)')
  .option('--org <org>', 'Organization name')
  .description('Post a test message to a Slack channel')
  .action(async (channel: string, text: string, options: { as?: string; org?: string }) => {
    const api = new SlackAPI(requireToken());
    const env = resolveEnv();
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
    const org = requireOrg(options.org);
    try {
      const receipt = await runTestSend({
        frameworkRoot, org, agent: options.as, channel, text,
        ctxRoot: env.ctxRoot, receiptAgent: options.as ?? env.agentName,
      }, api);
      console.log(`sent channel=${receipt.channel} ts=${receipt.ts}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// Stable command name the injected "Reply using:" line invokes. Shares
// runTestSend's implementation with test-send (same shape, same identity
// threading via --as) — this is the one operators/agents should treat as
// the standing reply path; test-send remains for ad-hoc manual testing.
const sendCommand = new Command('send')
  .argument('<channel>', 'Slack channel id (Cxxx) or name (#general)')
  .argument('<text>', 'Message text')
  .option('--as <agent>', 'Post under this agent\'s identity (loads slack.json)')
  .option('--org <org>', 'Organization name')
  .description('Send a Slack message (used by the inbound reply path)')
  .action(async (channel: string, text: string, options: { as?: string; org?: string }) => {
    const api = new SlackAPI(requireToken());
    const env = resolveEnv();
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
    const org = requireOrg(options.org);
    try {
      const receipt = await runTestSend({
        frameworkRoot, org, agent: options.as, channel, text,
        ctxRoot: env.ctxRoot, receiptAgent: options.as ?? env.agentName,
      }, api);
      console.log(`sent channel=${receipt.channel} ts=${receipt.ts}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const discoverChannelsCommand = new Command('discover-channels')
  .description('List Slack channels the bot is a member of (with ids)')
  .action(async () => {
    const api = new SlackAPI(requireToken());
    const channels = await api.listChannels();
    const visible = channels.filter((c) => c.is_member !== false);
    for (const c of visible) {
      const prefix = c.is_private ? '🔒' : '#';
      console.log(`${c.id}\t${prefix}${c.name}`);
    }
  });

export const slackCommand = new Command('slack')
  .description('Slack adapter ops')
  .addCommand(testSendCommand)
  .addCommand(sendCommand)
  .addCommand(discoverChannelsCommand);
