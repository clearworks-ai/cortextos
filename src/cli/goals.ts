import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** GOALS.md is read by the agent on every boot. Keep it to a few plain lines. */
export const GOALS_MAX = 7;
export const GOAL_LINE_MAX_CHARS = 240;

function goalTitle(g: unknown): string {
  if (typeof g === 'string') return g.trim();
  if (g && typeof g === 'object' && typeof (g as { title?: unknown }).title === 'string') {
    return (g as { title: string }).title.trim();
  }
  return '';
}

/**
 * Render GOALS.md as plain lines: one focus line, a numbered goal list, and an
 * optional "Blocked on" line. No boilerplate, no history, no correction blocks —
 * those stay in goals.json for whoever needs the audit trail.
 */
export function renderGoalsMarkdown(data: Record<string, unknown>): string {
  const goals = (Array.isArray(data.goals) ? data.goals : []).map(goalTitle).filter(Boolean);
  const focus = typeof data.focus === 'string' ? data.focus.trim() : '';
  const bottleneck = typeof data.bottleneck === 'string' ? data.bottleneck.trim() : '';

  const lines = ['# Goals', '', `Focus: ${focus || 'not set. Ask your orchestrator.'}`, ''];
  if (goals.length === 0) {
    lines.push('No goals set. Ask your orchestrator.');
  } else {
    goals.forEach((g, i) => lines.push(`${i + 1}. ${g}`));
  }
  if (bottleneck) lines.push('', `Blocked on: ${bottleneck}`);
  lines.push('');
  return lines.join('\n');
}

/** Plain-voice lint: returns human-readable problems, empty when the file is in shape. */
export function lintGoals(data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const goals = (Array.isArray(data.goals) ? data.goals : []).map(goalTitle).filter(Boolean);
  const focus = typeof data.focus === 'string' ? data.focus : '';
  const texts = [focus, ...goals, typeof data.bottleneck === 'string' ? data.bottleneck : ''];

  if (goals.length > GOALS_MAX) problems.push(`${goals.length} goals; keep 3-${GOALS_MAX}`);
  texts.forEach((t) => {
    if (t.length > GOAL_LINE_MAX_CHARS) problems.push(`line over ${GOAL_LINE_MAX_CHARS} chars: "${t.slice(0, 60)}..."`);
  });
  const noisy = /task_\d{10,}|\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b|\binfer no\b|\bpreserve\b.*\bas terminal\b/i;
  texts.forEach((t) => {
    if (noisy.test(t)) problems.push(`task IDs, hashes, or "preserve/infer no" register: "${t.slice(0, 60)}..."`);
  });
  return problems;
}

export const goalsCommand = new Command('goals')
  .description('Manage goals.json and auto-generate GOALS.md for agents');

// cortextos goals generate-md --agent <name> --org <org>
goalsCommand
  .command('generate-md')
  .description('Regenerate GOALS.md from goals.json for an agent')
  .requiredOption('--agent <name>', 'Agent name')
  .requiredOption('--org <org>', 'Org name')
  .action((options: { agent: string; org: string }) => {
    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();

    if (!/^[A-Za-z0-9_-]+$/.test(options.agent) || !/^[A-Za-z0-9_-]+$/.test(options.org)) {
      process.stderr.write('Error: agent and org must be alphanumeric/dash/underscore only\n');
      process.exit(1);
    }

    const agentDir = join(frameworkRoot, 'orgs', options.org, 'agents', options.agent);
    const goalsJsonPath = join(agentDir, 'goals.json');
    const goalsMdPath = join(agentDir, 'GOALS.md');

    if (!existsSync(goalsJsonPath)) {
      process.stderr.write(`goals.json not found at ${goalsJsonPath}\n`);
      process.exit(1);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(goalsJsonPath, 'utf-8'));
    } catch {
      process.stderr.write(`Failed to parse goals.json for ${options.agent}\n`);
      process.exit(1);
    }

    writeFileSync(goalsMdPath, renderGoalsMarkdown(data), 'utf-8');
    const problems = lintGoals(data);
    if (problems.length > 0) {
      process.stderr.write(
        `GOALS.md for ${options.agent} is not plain voice. Rewrite goals.json as 3-${GOALS_MAX} short plain lines ` +
        `(current focus and real goals; no task IDs, hashes, receipts, or "preserve/infer no" wording):\n` +
        problems.map((p) => `  - ${p}`).join('\n') + '\n',
      );
    }
    console.log(`Generated GOALS.md for ${options.agent}`);
  });
