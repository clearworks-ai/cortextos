import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Executes the REAL .claude/workflows/dynamic-pipeline.js stage graph start to
 * finish with stubbed workflow-runtime hooks (agent/parallel/phase/log/args).
 * All stages are routed to provider=anthropic via a test routing config, so
 * every hop lands on the stubbed agent() — no external CLIs, no network — while
 * the genuine routing-policy + stage-graph code paths run unmodified.
 */

const workflowsDir = fileURLToPath(new URL('../../../.claude/workflows/', import.meta.url));
const pipelinePath = join(workflowsDir, 'dynamic-pipeline.js');

interface AgentCall {
  phase: string;
  label: string;
  model: string;
  isolation?: string;
  prompt: string;
}

type StageResult = Record<string, unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {
  /* prototype probe */
}).constructor as new (...params: string[]) => (
  importModule: (specifier: string) => unknown,
  args: Record<string, unknown>,
  log: (message: string) => void,
  phase: (name: string) => void,
  agent: (prompt: string, opts: Record<string, unknown>) => Promise<StageResult>,
  parallel: (thunks: Array<() => Promise<StageResult>>) => Promise<StageResult[]>,
) => Promise<StageResult>;

function loadPipelineRunner() {
  const source = readFileSync(pipelinePath, 'utf8');
  const libDir = join(workflowsDir, 'lib');
  // Vitest's sandbox has no dynamic-import callback for Function-constructed
  // code, so route the pipeline's `await import(...)` through an injected
  // CJS loader (the workflow lib modules are CommonJS).
  const body = source
    .replace(/^export const meta = /m, 'const meta = ')
    .replaceAll('await import(', 'await __importModule(')
    .replaceAll("'./lib/", `'${libDir}/`);
  return new AsyncFunction('__importModule', 'args', 'log', 'phase', 'agent', 'parallel', body);
}

function stageResultFor(opts: Record<string, unknown>): StageResult {
  const phase = String(opts.phase ?? '');
  switch (phase) {
    case 'Research':
      return {
        summary: 'External context digest',
        findings: [{ finding: 'Upstream API is stable', relevance: 'No migration risk', source: 'https://example.test/docs' }],
        openQuestions: [],
      };
    case 'Explore':
      return {
        summary: 'Repo area scan',
        relevantFiles: [{ path: 'notes.txt', why: 'Target of the change' }],
        conventions: ['plain text'],
        risks: [],
      };
    case 'Synthesize':
      return {
        brief: 'One folded brief for the planner',
        keyFacts: ['notes.txt is the only touched file'],
        constraints: ['keep it one line'],
        risks: [],
      };
    case 'Plan':
      return {
        approach: 'Two file-disjoint workstreams, one light and one heavy',
        workstreams: [
          {
            id: 'light-note',
            title: 'Add note line',
            instructions: 'Append one line to notes.txt',
            files: ['notes.txt'],
            acceptance: 'Line present',
            weight: 'light',
          },
          {
            id: 'heavy-core',
            title: 'Rework core module',
            instructions: 'Restructure core.txt content',
            files: ['core.txt'],
            acceptance: 'Content restructured',
            weight: 'heavy',
          },
        ],
      };
    case 'Implement': {
      const label = String(opts.label ?? '');
      const id = label.replace(/^impl-/, '');
      return { id, branch: `wf/ws-${id}`, committed: true, summary: `Implemented ${id}`, filesChanged: [] };
    }
    case 'Merge':
      return {
        candidateBranch: 'wf/candidate',
        mergedBranches: ['wf/ws-light-note', 'wf/ws-heavy-core'],
        conflicts: [],
        buildPassed: true,
      };
    case 'Review':
      return { approved: true, problems: [] };
    case 'PR':
      return { opened: true, url: 'https://example.test/pr/1', title: 'Test PR' };
    case 'Lessons':
      return { lessonFiles: [] };
    default:
      throw new Error(`Unexpected stage phase "${phase}" reached the agent stub`);
  }
}

describe('dynamic-pipeline stage graph', () => {
  it('runs research -> explore -> synthesize -> plan -> implement(split) -> merge -> review -> pr -> lessons', async () => {
    const root = join(tmpdir(), `dynamic-pipeline-${Date.now()}`);
    mkdirSync(join(root, '.claude', 'workflows'), { recursive: true });
    const configPath = join(root, '.claude', 'workflows', 'routing-config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        stages: {
          research: { provider: 'anthropic', model: 'haiku' },
          explore: { provider: 'anthropic', model: 'haiku' },
          synthesize: { provider: 'anthropic', model: 'opus', effort: 'high' },
          implement_light: { provider: 'anthropic', model: 'haiku' },
          implement_heavy: { provider: 'anthropic', model: 'sonnet' },
          merge: { provider: 'anthropic', model: 'haiku' },
          review: { provider: 'anthropic', model: 'opus', effort: 'high' },
          pr: { provider: 'anthropic', model: 'sonnet' },
          lessons: { provider: 'anthropic', model: 'sonnet' },
        },
      }),
      'utf8',
    );

    const phases: string[] = [];
    const logs: string[] = [];
    const agentCalls: AgentCall[] = [];

    const agent = async (prompt: string, opts: Record<string, unknown>): Promise<StageResult> => {
      agentCalls.push({
        phase: String(opts.phase ?? ''),
        label: String(opts.label ?? ''),
        model: String(opts.model ?? ''),
        isolation: typeof opts.isolation === 'string' ? opts.isolation : undefined,
        prompt,
      });
      return stageResultFor(opts);
    };
    const parallel = async (thunks: Array<() => Promise<StageResult>>): Promise<StageResult[]> =>
      Promise.all(thunks.map((thunk) => thunk()));

    const requireModule = createRequire(import.meta.url);
    const runner = loadPipelineRunner();
    const result = await runner(
      (specifier: string) => requireModule(specifier),
      {
        task: 'Append a single friendly note line to notes.txt',
        repoPath: root,
        exploreCount: 2,
        routingConfigPath: configPath,
      },
      (message: string) => logs.push(message),
      (name: string) => phases.push(name),
      agent,
      parallel,
    );

    expect(phases).toEqual(['Research', 'Explore', 'Synthesize', 'Plan', 'PR', 'Lessons']);

    const stageSequence = agentCalls.map((call) => call.phase);
    expect(stageSequence).toEqual([
      'Research',
      'Explore',
      'Explore',
      'Synthesize',
      'Plan',
      'Implement',
      'Implement',
      'Merge',
      'Review',
      'PR',
      'Lessons',
    ]);

    // Implement weight split: light workstream on the cheap route, heavy on the heavy route.
    const lightImpl = agentCalls.find((call) => call.label === 'impl-light-note');
    const heavyImpl = agentCalls.find((call) => call.label === 'impl-heavy-core');
    expect(lightImpl).toMatchObject({ model: 'haiku', isolation: 'worktree' });
    expect(heavyImpl).toMatchObject({ model: 'sonnet', isolation: 'worktree' });

    // Fable gate: plan was NOT confirmed, so it must have fallen back to opus.
    const planCall = agentCalls.find((call) => call.phase === 'Plan');
    expect(planCall?.model).toBe('opus');

    // Synthesize consumed both the research findings and the explore reports.
    const synthCall = agentCalls.find((call) => call.phase === 'Synthesize');
    expect(synthCall?.prompt).toContain('Upstream API is stable');
    expect(synthCall?.prompt).toContain('Repo area scan');

    // Planner worked from the synthesized brief, not raw reports.
    const planPrompt = planCall?.prompt ?? '';
    expect(planPrompt).toContain('SYNTHESIZED BRIEF');
    expect(planPrompt).toContain('One folded brief for the planner');

    // Review is diff-scoped and approved on the first pass.
    const reviewCall = agentCalls.find((call) => call.phase === 'Review');
    expect(reviewCall?.model).toBe('opus');
    expect(reviewCall?.prompt).toContain('do not re-read the rest of the repo');

    expect(result).toMatchObject({
      task: 'Append a single friendly note line to notes.txt',
      workstreams: [
        { id: 'light-note', title: 'Add note line' },
        { id: 'heavy-core', title: 'Rework core module' },
      ],
      merge: { candidateBranch: 'wf/candidate', conflicts: [] },
      review: { approved: true, problems: [] },
      pr: { opened: true, url: 'https://example.test/pr/1' },
      lessons: { lessonFiles: [] },
    });

    expect(logs.some((line) => line.includes('Research complete: 1 finding(s)'))).toBe(true);
    expect(logs.some((line) => line.includes('Synthesize complete'))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});
