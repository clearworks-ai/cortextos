import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { SlackAPI } from '../slack/index.js';
import { resolveGatedDisplayIdentity, slackConfigPath } from '../slack/slack-routing.js';
import { resolveEnv, loadEnvFileInto } from '../utils/env.js';
import { join } from 'path';

export interface TestSendOptions {
  frameworkRoot: string;
  org: string;
  agent?: string;
  channel: string;
  text: string;
}

/** Pure function — testable without process exit. Identity goes through the
 * D4 persona gate; object-form postMessage never carries username/icon. */
export async function runTestSend(opts: TestSendOptions, api: SlackAPI): Promise<void> {
  if (!opts.agent) {
    await api.postMessage(opts.channel, opts.text);
    return;
  }
  const cfgPath = slackConfigPath(opts.frameworkRoot, opts.org, opts.agent);
  if (!existsSync(cfgPath)) {
    throw new Error(`agent "${opts.agent}" has no slack.json (not Slack-enabled)`);
  }
  // Prior CLI: loadSlackIdentity threw on unparseable JSON. Do not treat
  // malformed as absent (that would silently send with the app default).
  try {
    JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch (e) {
    throw new Error(`slack.json parse failed for ${opts.agent}: ${(e as Error).message}`);
  }
  const identity = resolveGatedDisplayIdentity(
    opts.frameworkRoot,
    opts.org,
    opts.agent,
    (line) => console.error(line),
  );
  await api.postMessage(opts.channel, opts.text, identity);
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
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
    const org = requireOrg(options.org);
    try {
      await runTestSend({ frameworkRoot, org, agent: options.as, channel, text }, api);
      console.log('sent');
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
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
    const org = requireOrg(options.org);
    try {
      await runTestSend({ frameworkRoot, org, agent: options.as, channel, text }, api);
      console.log('sent');
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
    for (const c of channels) {
      console.log(`${c.id}\t#${c.name}`);
    }
  });

export const slackCommand = new Command('slack')
  .description('Slack adapter ops')
  .addCommand(testSendCommand)
  .addCommand(sendCommand)
  .addCommand(discoverChannelsCommand);
