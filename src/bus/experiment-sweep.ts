import {
  autoCloseExpiredExperiment,
  listExperiments,
  loadExperiment,
  saveExperiment,
  type Experiment,
} from './experiment.js';
import { parseDurationMs } from './cron-state.js';

export const DEFAULT_EXPERIMENT_GRACE_MS = 24 * 3_600_000;

export interface ExperimentSweepAction {
  id: string;
  agent: string;
  agentDir: string;
  action: 'flag' | 'autoclose' | 'skip-unparseable';
  window: string;
  startedAt: string | null;
  expiredAt: number | null;
  ageMs: number;
}

export interface ExperimentSweepOptions {
  now?: number;
  graceMs?: number;
  dryRun?: boolean;
}

function buildAction(
  experiment: Experiment,
  agentDir: string,
  agentName: string,
  action: ExperimentSweepAction['action'],
  expiredAt: number | null,
  ageMs: number,
): ExperimentSweepAction {
  return {
    id: experiment.id,
    agent: agentName,
    agentDir,
    action,
    window: experiment.window,
    startedAt: experiment.started_at,
    expiredAt,
    ageMs,
  };
}

export function sweepExperiments(
  agentDir: string,
  agentName: string,
  opts?: ExperimentSweepOptions,
): ExperimentSweepAction[] {
  const now = opts?.now ?? Date.now();
  const graceMs = opts?.graceMs ?? DEFAULT_EXPERIMENT_GRACE_MS;
  const running = listExperiments(agentDir, { status: 'running' });
  const actions: ExperimentSweepAction[] = [];

  for (const experiment of running) {
    const windowMs = parseDurationMs(experiment.window);
    if (Number.isNaN(windowMs)) {
      actions.push(
        buildAction(experiment, agentDir, agentName, 'skip-unparseable', null, 0),
      );
      continue;
    }
    if (!experiment.started_at) continue;
    const started = Date.parse(experiment.started_at);
    if (Number.isNaN(started)) continue;

    const expiredAt = started + windowMs;
    const ageMs = now - expiredAt;
    if (now <= expiredAt) continue;

    if (now <= expiredAt + graceMs) {
      if (experiment.window_flagged_at) continue;
      actions.push(buildAction(experiment, agentDir, agentName, 'flag', expiredAt, ageMs));
      continue;
    }

    actions.push(buildAction(experiment, agentDir, agentName, 'autoclose', expiredAt, ageMs));
  }

  if (!opts?.dryRun) {
    for (const action of actions) {
      if (action.action === 'flag') {
        const experiment = loadExperiment(agentDir, action.id);
        experiment.window_flagged_at = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
        saveExperiment(agentDir, experiment);
      } else if (action.action === 'autoclose') {
        const ageHrs = Math.round(action.ageMs / 3_600_000);
        const reason =
          `Auto-closed: window ${action.window} expired ${ageHrs}h ago without evaluation ` +
          '(forced-decision sweep).';
        autoCloseExpiredExperiment(agentDir, action.id, reason);
      }
    }
  }

  return actions;
}
