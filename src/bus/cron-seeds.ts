/**
 * cron-seeds.ts — Seed cron definitions for wiki re-publish + graphify re-index.
 *
 * WS10: the knowledge wiki went stale (published once, never re-published)
 * because no re-publish cron existed. The fix is "one cron, not a new system":
 * two seed CronDefinitions plus an idempotent installer that writes them via
 * the existing crons.ts API.
 *
 * Both seeds ship `enabled: false`. This module only defines and installs the
 * definitions — enabling them is a deliberate, separate ops action.
 *
 * Prompt rules (enforced by tests):
 *   - No hardcoded URLs or tokens. BRIEFS_BASE_URL and DASHBOARD_BRIEF_TOKEN
 *     live in the runtime environment (Railway / .env) — a local copy can
 *     drift silently, which is exactly how the 4x bad-link incident happened.
 *   - Fail loud: a non-zero exit or a missing receipt line must be logged as
 *     an error event, never silently skipped.
 *   - No outbound-messaging instructions of any kind (the cron write path is
 *     gated by a banned-prompt validator in the live fork).
 */

import type { CronDefinition } from '../types/index.js';
import { addCron, getCronByName } from './crons.js';

/**
 * Daily wiki re-publish — runs at 07:00, after the nightly wiki-synthesis
 * cron has finished, so the freshly synthesized wiki/ content is what gets
 * published.
 */
export const WIKI_REPUBLISH_CRON: CronDefinition = {
  name: 'wiki-republish',
  schedule: '0 7 * * *',
  enabled: false,
  created_at: new Date(0).toISOString(),
  description:
    'Daily wiki re-publish after nightly wiki-synthesis. Ships disabled; ops enables deliberately.',
  prompt: [
    'Run `bash bus/publish-wiki.sh` to re-publish the knowledge-sync wiki/ directory.',
    'The script reads BRIEFS_BASE_URL and DASHBOARD_BRIEF_TOKEN from the environment',
    '(.env / Railway) — do NOT substitute, hardcode, or echo any URL or token yourself;',
    'the environment is the only source of truth for those values.',
    'After the script exits: (1) verify the exit code is 0, and (2) verify the output',
    'contains a WIKI_PUBLISH_RECEIPT line. Then write a receipt line recording the',
    'published count and HTTP status from that receipt.',
    'Fail-loud rules: if the exit code is non-zero OR the WIKI_PUBLISH_RECEIPT line is',
    'missing, log an error event via `cortextos bus log-event` with the failure details.',
    'Never silently skip a failure and never report success without the receipt.',
  ].join(' '),
};

/**
 * Weekly graphify re-index — refreshes the knowledge graph over the repo and
 * knowledge directories. graphify is a ~/.claude/skills skill executed by the
 * agent that receives this prompt; nothing here imports or executes it.
 */
export const GRAPHIFY_REINDEX_CRON: CronDefinition = {
  name: 'graphify-reindex',
  schedule: '0 5 * * 0',
  enabled: false,
  created_at: new Date(0).toISOString(),
  description:
    'Weekly graphify re-index of repo + knowledge dirs. Ships disabled; ops enables deliberately.',
  prompt: [
    'Invoke the graphify skill over the repository and the knowledge directories',
    '(knowledge-sync raw/ and wiki/) to rebuild the knowledge graph.',
    'Write the refreshed graph output (HTML + JSON + audit report) to the usual',
    'graphify output location, then write a receipt line recording the run:',
    'input dirs scanned, node/edge counts, and the output path.',
    'Fail-loud rules: if the graphify run errors OR the receipt cannot be written,',
    'log an error event via `cortextos bus log-event` with the failure details.',
    'Never silently skip a failure and never report success without the receipt.',
  ].join(' '),
};

/** All seeds this module knows how to install. */
export const CRON_SEEDS: readonly CronDefinition[] = [
  WIKI_REPUBLISH_CRON,
  GRAPHIFY_REINDEX_CRON,
] as const;

export interface InstallCronSeedsResult {
  /** Seed names written to the agent's crons.json by this call. */
  installed: string[];
  /** Seed names skipped because a cron with that name already exists. */
  skipped: string[];
}

/**
 * Idempotently install the seed crons for an agent.
 *
 * Existing crons are NEVER overwritten: any name collision (even with a
 * hand-edited or diverged definition) is skipped. Calling this twice yields
 * `installed: []` on the second call.
 */
export function installCronSeeds(agentName: string): InstallCronSeedsResult {
  const installed: string[] = [];
  const skipped: string[] = [];

  for (const seed of CRON_SEEDS) {
    if (getCronByName(agentName, seed.name) !== undefined) {
      skipped.push(seed.name);
      continue;
    }
    addCron(agentName, { ...seed, created_at: new Date().toISOString() });
    installed.push(seed.name);
  }

  return { installed, skipped };
}
