#!/usr/bin/env node
// run-stage.cjs — Larry's per-stage executor for the multi-harness pipeline.
//
// Runs ONE pipeline stage on the harness configured in routing-config.json and
// prints the schema-validated JSON result to stdout. This is the RUNNABLE unit
// the dynamic pipeline is built from — plain Node, no Workflow sandbox, so it
// can actually exec the opencode/codex CLIs the bridge needs.
//
//   Non-Anthropic stages (research, explore, implement_light, implement_heavy)
//     -> exec opencode/codex via lib/runtime-bridge.js -> validated JSON.
//   Anthropic stages (synthesize, plan, review, merge, pr)
//     -> NOT run here. Headless `claude -p` has no billable credit on this host,
//        so this CLI prints a delegation contract {"delegate":"anthropic",...}
//        and the Larry driver runs the stage as a session subagent (Agent tool).
//
// See larry/PIPELINE.md for the full stage graph. Larry is the top-level driver.
//
// Usage:
//   node run-stage.cjs --stage research \
//     --prompt-file /tmp/p.txt --schema-file /tmp/s.json [--cwd <dir>] [--write] \
//     [--confirm-fable] [--config <routing-config.json>]
//   node run-stage.cjs --stage plan --resolve-only   # print the resolved route, run nothing

const fs = require('node:fs');
const path = require('node:path');
const { sendWork } = require('./lib/runtime-bridge.js');
const { loadRoutingConfig, resolveStageRoute } = require('./lib/routing-policy.js');

function parseArgs(argv) {
  const out = { write: false, confirmFable: false, resolveOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case '--stage': out.stage = next(); break;
      case '--prompt': out.prompt = next(); break;
      case '--prompt-file': out.promptFile = next(); break;
      case '--schema-file': out.schemaFile = next(); break;
      case '--cwd': out.cwd = next(); break;
      case '--config': out.config = next(); break;
      case '--write': out.write = true; break;
      case '--confirm-fable': out.confirmFable = true; break;
      case '--resolve-only': out.resolveOnly = true; break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!out.stage) throw new Error('--stage is required');
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cwd = a.cwd || process.cwd();
  const configPath = a.config || path.join(__dirname, 'routing-config.json');
  const config = loadRoutingConfig(configPath, { cwd });
  const route = resolveStageRoute(config, a.stage, { confirmFableUse: () => a.confirmFable });

  if (a.resolveOnly) {
    process.stdout.write(JSON.stringify({ stage: a.stage, route }, null, 2));
    return;
  }

  if (route.provider === 'anthropic') {
    // Larry runs Anthropic stages as session subagents; this CLI only reports the route.
    process.stdout.write(JSON.stringify({ delegate: 'anthropic', stage: a.stage, route }));
    return;
  }

  const prompt = a.prompt != null
    ? a.prompt
    : (a.promptFile ? fs.readFileSync(a.promptFile, 'utf8') : null);
  if (!prompt || !prompt.trim()) {
    throw new Error('--prompt or --prompt-file is required for a non-Anthropic stage');
  }
  if (!a.schemaFile) {
    throw new Error('--schema-file is required for a non-Anthropic stage');
  }
  const schema = JSON.parse(fs.readFileSync(a.schemaFile, 'utf8'));

  const result = await sendWork({
    provider: route.provider,
    model: route.model,
    prompt,
    schema,
    cwd,
    effort: route.effort,
    allowWrite: a.write === true,
  });
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stderr.write(`RUN_STAGE_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
