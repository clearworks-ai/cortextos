import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatchMeetingConsumers,
  resolveCoordinatorDir,
  type MeetingDispatchDeps,
  type ConsumerOutcome,
} from '../../../src/daemon/meeting-consumer-dispatch.js';

/**
 * FR-004/005/006/007 — unit tests for the daemon meeting-consumer DISPATCH.
 * The helper is exercised directly with fake spawnScript / spawnWorker / dedup ledger /
 * exists. No real subprocess or worker is created.
 */

describe('meeting-consumer-dispatch — FR-004/005/007 daemon dispatch', () => {
  const frameworkRoot = '/fw';
  const org = 'clearworksai';
  const ctxRoot = '/tmp/fake-ctx';
  const crmDir = `${frameworkRoot}/orgs/${org}/agents/crm/crm`;
  const paDir = `${frameworkRoot}/orgs/${org}/agents/pa`;
  const centralSkill = `${frameworkRoot}/orgs/${org}/skills/followup-coordinator/SKILL.md`;

  let ledger: Set<string>;
  let scripts: Array<{ cmd: string; args: string[] }>;
  let workers: Array<{ name: string; dir: string; prompt: string; parent?: string; extraEnv?: Record<string, string> }>;

  const recordEvent = (_root: string, sourceKey: string): boolean => {
    if (ledger.has(sourceKey)) return false; // duplicate → do not surface
    ledger.add(sourceKey);
    return true;
  };
  const spawnScript = (cmd: string, args: string[]): void => {
    scripts.push({ cmd, args });
  };
  const spawnWorker = vi.fn(
    async (name: string, dir: string, prompt: string, parent?: string, _model?: string, extraEnv?: Record<string, string>) => {
      workers.push({ name, dir, prompt, parent, extraEnv });
    },
  );
  // By default the coordinator skill exists in the central store only.
  const exists = (p: string): boolean => p === centralSkill;

  const deps = (over: Partial<MeetingDispatchDeps> = {}): Partial<MeetingDispatchDeps> => ({
    recordEvent,
    spawnScript,
    spawnWorker,
    exists,
    ...over,
  });

  const byConsumer = (outcomes: ConsumerOutcome[], c: ConsumerOutcome['consumer']) =>
    outcomes.find((o) => o.consumer === c)!;

  beforeEach(() => {
    ledger = new Set();
    scripts = [];
    workers = [];
    spawnWorker.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveCoordinatorDir finds central-store skill and returns pa agent dir', () => {
    expect(resolveCoordinatorDir(frameworkRoot, org, exists)).toEqual({ dir: paDir, parent: 'pa' });
  });

  it('resolveCoordinatorDir prefers per-agent skill when present', () => {
    const perAgent = `${paDir}/.claude/skills/followup-coordinator/SKILL.md`;
    const res = resolveCoordinatorDir(frameworkRoot, org, (p) => p === perAgent);
    expect(res).toEqual({ dir: paDir, parent: 'pa' });
  });

  it('resolveCoordinatorDir returns null when no skill exists anywhere', () => {
    expect(resolveCoordinatorDir(frameworkRoot, org, () => false)).toBeNull();
  });

  it('(a) completed → crm-sync + fanout scripts run + coordinator worker spawned, each once, correct args', () => {
    const res = dispatchMeetingConsumers(
      { meetingId: 'MTG1', meetingType: 'sales', ctxRoot, frameworkRoot, org },
      deps(),
    );

    // crm-sync + fanout each dispatched exactly once
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toEqual({ cmd: 'python3', args: [`${crmDir}/meeting-crm-sync.py`, '--meeting-id', 'MTG1'] });
    expect(scripts[1]).toEqual({ cmd: 'python3', args: [`${crmDir}/meeting-fanout.py`, '--meeting-id', 'MTG1'] });

    // coordinator worker spawned exactly once with the right name/dir/env
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(1);
    expect(workers[0].name).toBe('meeting-coord-mtg1');
    expect(workers[0].dir).toBe(paDir);
    expect(workers[0].parent).toBe('pa');
    expect(workers[0].extraEnv).toEqual({ FF_MEETING_ID: 'MTG1' });
    expect(workers[0].prompt).toContain('followup-coordinator');
    expect(workers[0].prompt).toContain('FF_MEETING_ID=MTG1');
    expect(workers[0].prompt).toContain('do NOT create new followups');

    // per-consumer outcomes
    expect(byConsumer(res.outcomes, 'crm-sync').status).toBe('dispatched');
    expect(byConsumer(res.outcomes, 'fanout').status).toBe('dispatched');
    expect(byConsumer(res.outcomes, 'coordinator').status).toBe('dispatched');
  });

  it('(b) re-dispatch same meeting_id → all three deduped, no second run/spawn', () => {
    const first = dispatchMeetingConsumers(
      { meetingId: 'MTG1', meetingType: 'other', ctxRoot, frameworkRoot, org },
      deps(),
    );
    const second = dispatchMeetingConsumers(
      { meetingId: 'MTG1', meetingType: 'other', ctxRoot, frameworkRoot, org },
      deps(),
    );

    expect(byConsumer(first.outcomes, 'crm-sync').status).toBe('dispatched');
    expect(byConsumer(second.outcomes, 'crm-sync').status).toBe('deduped');
    expect(byConsumer(second.outcomes, 'fanout').status).toBe('deduped');
    expect(byConsumer(second.outcomes, 'coordinator').status).toBe('deduped');

    // no second run / spawn on the re-dispatch
    expect(scripts).toHaveLength(2);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });

  it('(c) dedup keys are exactly the spec source-keys', () => {
    dispatchMeetingConsumers({ meetingId: 'MTG7', meetingType: 'other', ctxRoot, frameworkRoot, org }, deps());
    expect(ledger.has('meeting-crmsync:MTG7')).toBe(true);
    expect(ledger.has('meeting-fanout:MTG7')).toBe(true);
    expect(ledger.has('meeting-coord:MTG7')).toBe(true);
  });

  it('(d) one consumer throwing → the others still dispatch (isolation)', () => {
    // crm-sync script throws; fanout script + coordinator worker must still run.
    const throwingScript = (cmd: string, args: string[]): void => {
      if (args.some((a) => a.includes('meeting-crm-sync.py'))) throw new Error('crm-sync boom');
      scripts.push({ cmd, args });
    };
    const res = dispatchMeetingConsumers(
      { meetingId: 'MTG2', meetingType: 'other', ctxRoot, frameworkRoot, org },
      deps({ spawnScript: throwingScript }),
    );

    expect(byConsumer(res.outcomes, 'crm-sync').status).toBe('error');
    // fanout still ran
    expect(scripts).toHaveLength(1);
    expect(scripts[0].args).toContain(`${crmDir}/meeting-fanout.py`);
    expect(byConsumer(res.outcomes, 'fanout').status).toBe('dispatched');
    // coordinator still spawned
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(byConsumer(res.outcomes, 'coordinator').status).toBe('dispatched');
  });

  it('(e) sales meeting → meetingType threaded through; FR-006 debrief DEFERRED, NOT spawned', () => {
    const res = dispatchMeetingConsumers(
      { meetingId: 'MTG3', meetingType: 'sales', ctxRoot, frameworkRoot, org },
      deps(),
    );
    expect(res.meetingType).toBe('sales');
    const debrief = byConsumer(res.outcomes, 'debrief');
    expect(debrief.status).toBe('deferred');
    // sales path is reachable (distinct reason) but no debrief worker was spawned
    expect(debrief.reason).toBe('sales-meeting-fr006-deferred');
    // only the coordinator worker was spawned — never a debrief worker
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(workers.every((w) => w.name.startsWith('meeting-coord-'))).toBe(true);
  });

  it('non-sales meeting → debrief deferred with non-sales reason', () => {
    const res = dispatchMeetingConsumers(
      { meetingId: 'MTG4', meetingType: 'other', ctxRoot, frameworkRoot, org },
      deps(),
    );
    expect(byConsumer(res.outcomes, 'debrief').status).toBe('deferred');
    expect(byConsumer(res.outcomes, 'debrief').reason).toBe('non-sales-no-debrief');
  });

  it('coordinator skill missing everywhere → coordinator skipped, scripts still run', () => {
    const res = dispatchMeetingConsumers(
      { meetingId: 'MTG5', meetingType: 'other', ctxRoot, frameworkRoot, org },
      deps({ exists: () => false }),
    );
    expect(scripts).toHaveLength(2); // crm-sync + fanout still ran
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(byConsumer(res.outcomes, 'coordinator').status).toBe('skipped');
    expect(byConsumer(res.outcomes, 'coordinator').reason).toBe('coordinator-skill-not-found');
  });

  it('missing meeting_id or org → skipped, no dispatch', () => {
    const noId = dispatchMeetingConsumers({ meetingId: '', meetingType: 'other', ctxRoot, frameworkRoot, org }, deps());
    expect(scripts).toHaveLength(0);
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(noId.outcomes[0].status).toBe('skipped');

    const noOrg = dispatchMeetingConsumers(
      { meetingId: 'MTG6', meetingType: 'other', ctxRoot, frameworkRoot, org: undefined },
      deps(),
    );
    expect(scripts).toHaveLength(0);
    expect(noOrg.outcomes[0].status).toBe('skipped');
  });
});
