import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createExperiment,
  evaluateExperiment,
  runExperiment,
  type Experiment,
} from '../src/bus/experiment.js';
import { DEFAULT_EXPERIMENT_GRACE_MS, sweepExperiments } from '../src/bus/experiment-sweep.js';

describe('experiment sweep', () => {
  const agentName = 'testbot';
  const now = Date.parse('2026-07-18T00:00:00Z');
  let testDir = '';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-experiment-sweep-'));
    mkdirSync(join(testDir, 'experiments', 'history'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function historyPath(id: string): string {
    return join(testDir, 'experiments', 'history', `${id}.json`);
  }

  function readExperiment(id: string): Experiment {
    return JSON.parse(readFileSync(historyPath(id), 'utf-8').trim()) as Experiment;
  }

  function writeExperiment(id: string, experiment: Experiment): void {
    writeFileSync(historyPath(id), JSON.stringify(experiment, null, 2));
  }

  function isoFor(offsetMs: number): string {
    return new Date(now - offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  it('flags once within grace and stays idempotent on re-sweep', () => {
    const id = createExperiment(testDir, agentName, 'ctr', 'Bold CTA improves CTR');
    runExperiment(testDir, id);

    const experiment = readExperiment(id);
    experiment.started_at = isoFor(25 * 3_600_000);
    writeExperiment(id, experiment);

    const firstSweep = sweepExperiments(testDir, agentName, { now, dryRun: false });
    expect(firstSweep).toHaveLength(1);
    expect(firstSweep[0].action).toBe('flag');

    const flagged = readExperiment(id);
    expect(flagged.window_flagged_at).toBeTruthy();
    const flaggedAt = flagged.window_flagged_at;

    const secondSweep = sweepExperiments(testDir, agentName, { now, dryRun: false });
    expect(secondSweep).toEqual([]);
    expect(readExperiment(id).window_flagged_at).toBe(flaggedAt);
  });

  it('autocloses after grace and stays idempotent with completed fields set', () => {
    const id = createExperiment(testDir, agentName, 'engagement', 'More emojis');
    runExperiment(testDir, id);

    const experiment = readExperiment(id);
    experiment.started_at = isoFor(49 * 3_600_000);
    writeExperiment(id, experiment);

    const actions = sweepExperiments(testDir, agentName, { now, dryRun: false });
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('autoclose');

    const closed = readExperiment(id);
    expect(closed.status).toBe('completed');
    expect(closed.decision).toBe('discard');
    expect(closed.result_value).toBeNull();
    expect(closed.completed_at).toBeTruthy();
    expect(closed.learning).toContain('Auto-closed');
    expect(closed.learning).toContain(experiment.window);
    expect(existsSync(join(testDir, 'experiments', 'results.tsv'))).toBe(true);
    expect(existsSync(join(testDir, 'experiments', 'learnings.md'))).toBe(true);

    const secondSweep = sweepExperiments(testDir, agentName, { now, dryRun: false });
    expect(secondSweep).toEqual([]);
  });

  it('skips unparseable windows without mutating the running experiment', () => {
    const id = createExperiment(testDir, agentName, 'latency', 'Weekly trend', {
      window: 'weekly',
    });
    runExperiment(testDir, id);

    const actions = sweepExperiments(testDir, agentName, { now, dryRun: false });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: 'skip-unparseable',
      expiredAt: null,
      ageMs: 0,
    });

    const experiment = readExperiment(id);
    expect(experiment.status).toBe('running');
    expect(experiment.window_flagged_at).toBeUndefined();
    expect(experiment.decision).toBeNull();
  });

  it('leaves not-yet-expired running experiments untouched', () => {
    const id = createExperiment(testDir, agentName, 'retention', 'Longer onboarding');
    runExperiment(testDir, id);

    const experiment = readExperiment(id);
    experiment.started_at = isoFor(23 * 3_600_000);
    writeExperiment(id, experiment);

    const actions = sweepExperiments(testDir, agentName, { now, dryRun: false });
    expect(actions).toEqual([]);

    const unchanged = readExperiment(id);
    expect(unchanged.status).toBe('running');
    expect(unchanged.window_flagged_at).toBeUndefined();
  });

  it('ignores proposed and completed experiments entirely', () => {
    const proposedId = createExperiment(testDir, agentName, 'nps', 'More follow-up');
    const proposed = readExperiment(proposedId);
    proposed.started_at = isoFor(72 * 3_600_000);
    writeExperiment(proposedId, proposed);

    const completedId = createExperiment(testDir, agentName, 'reply_rate', 'Faster response');
    runExperiment(testDir, completedId);
    evaluateExperiment(testDir, completedId, 1, { learning: 'done' });
    const completed = readExperiment(completedId);
    completed.started_at = isoFor(72 * 3_600_000);
    writeExperiment(completedId, completed);

    const actions = sweepExperiments(testDir, agentName, { now, dryRun: false });
    expect(actions).toEqual([]);

    expect(readExperiment(proposedId).status).toBe('proposed');
    expect(readExperiment(completedId).status).toBe('completed');
  });

  it('returns computed actions in dry-run mode without mutating disk state', () => {
    const id = createExperiment(testDir, agentName, 'signup_rate', 'Shorter form');
    runExperiment(testDir, id);

    const experiment = readExperiment(id);
    experiment.started_at = isoFor(49 * 3_600_000);
    writeExperiment(id, experiment);

    const actions = sweepExperiments(testDir, agentName, {
      now,
      dryRun: true,
      graceMs: DEFAULT_EXPERIMENT_GRACE_MS,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('autoclose');

    const unchanged = readExperiment(id);
    expect(unchanged.status).toBe('running');
    expect(unchanged.completed_at).toBeNull();
    expect(unchanged.window_flagged_at).toBeUndefined();
  });
});
