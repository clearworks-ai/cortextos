import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  planWorkerSpawn,
  trySpawnWorkerForEvent,
  WORKER_NAME_REGEX,
  type WorkerSpawnTemplate,
} from '../../../src/daemon/worker-spawn-plan';

const FW = '/fw';
const ORG = 'clearworksai';

/** The fireflies meeting-writeback template, cloned into the test so the generic
 * backbone is exercised exactly as the fireflies lane uses it. */
function firefliesTemplate(overrides: Partial<WorkerSpawnTemplate> = {}): WorkerSpawnTemplate {
  return {
    frameworkRoot: FW,
    org: ORG,
    target: 'pa',
    workerNamePrefix: 'meeting-writeback',
    skillRelativePaths: [
      join('plugins', 'cortextos-agent-skills', 'skills', 'meeting-writeback-worker', 'SKILL.md'),
      join('.claude', 'skills', 'meeting-writeback-worker', 'SKILL.md'),
      join('plugins', 'meeting-writeback-worker', 'SKILL.md'),
    ],
    buildPrompt: ({ skillRelativePath, eventId }) =>
      [
        'You are the meeting-writeback worker (short-lived session).',
        `FF_MEETING_ID=${eventId} is set in your environment.`,
        `Read ${skillRelativePath} and execute every bash block in order,`,
        'then output DONE. Do nothing else — no heartbeat, no daily memory, no Telegram.',
      ].join(' '),
    buildEnv: (eventId) => ({ FF_MEETING_ID: eventId }),
    skillExists: () => true,
    ...overrides,
  };
}

describe('planWorkerSpawn (FR-E1 backbone)', () => {
  it('sanitizes the event id into a WORKER_NAME_REGEX-safe worker name', () => {
    const plan = planWorkerSpawn(firefliesTemplate(), '01JXYZ.abc/9');
    expect(plan).not.toBeNull();
    expect(plan!.workerName).toMatch(WORKER_NAME_REGEX);
    expect(plan!.workerName).toBe('meeting-writeback-01jxyzabc9');
    expect(plan!.workerName.length).toBeLessThanOrEqual(64);
  });

  it('resolves the agent dir dynamically from framework root/org (no hardcoded absolute)', () => {
    const plan = planWorkerSpawn(firefliesTemplate(), 'abc');
    expect(plan!.dir).toBe(join(FW, 'orgs', ORG, 'agents', 'pa'));
  });

  it('builds the prompt from the resolved skill path and event id', () => {
    const plan = planWorkerSpawn(firefliesTemplate(), 'abc');
    expect(plan!.prompt).toContain('FF_MEETING_ID=abc');
    expect(plan!.prompt).toContain(
      join('plugins', 'cortextos-agent-skills', 'skills', 'meeting-writeback-worker', 'SKILL.md'),
    );
  });

  it('returns the extraEnv the template requested', () => {
    const plan = planWorkerSpawn(firefliesTemplate(), 'abc');
    expect(plan!.extraEnv).toEqual({ FF_MEETING_ID: 'abc' });
  });

  it('falls back to a legacy skill path when the centralized skill is absent', () => {
    const primary = join('plugins', 'cortextos-agent-skills', 'skills', 'meeting-writeback-worker', 'SKILL.md');
    const secondary = join('.claude', 'skills', 'meeting-writeback-worker', 'SKILL.md');
    const plan = planWorkerSpawn(
      firefliesTemplate({ skillExists: (p) => p.endsWith(secondary) && !p.endsWith(primary) }),
      'abc',
    );
    expect(plan!.prompt).toContain(secondary);
  });

  it('returns null when no skill path exists (caller falls back to NL relay)', () => {
    expect(planWorkerSpawn(firefliesTemplate({ skillExists: () => false }), 'abc')).toBeNull();
  });

  it('returns null on missing org or an id that sanitizes to empty', () => {
    expect(planWorkerSpawn(firefliesTemplate({ org: undefined }), 'abc')).toBeNull();
    expect(planWorkerSpawn(firefliesTemplate(), '....')).toBeNull();
    expect(planWorkerSpawn(firefliesTemplate(), '   ')).toBeNull();
  });

  it('caps the worker name at 64 chars for a very long id', () => {
    const plan = planWorkerSpawn(firefliesTemplate(), 'a'.repeat(200));
    expect(plan!.workerName.length).toBeLessThanOrEqual(64);
    expect(plan!.workerName).toMatch(WORKER_NAME_REGEX);
  });
});

describe('trySpawnWorkerForEvent (FR-E1 guarded wrapper)', () => {
  it('spawns via the client and returns the worker name + integration on success', async () => {
    const calls: unknown[] = [];
    const client = { send: async (req: unknown) => { calls.push(req); return { success: true }; } };
    const result = await trySpawnWorkerForEvent(
      'fireflies',
      () => planWorkerSpawn(firefliesTemplate(), 'abc'),
      { parent: 'pa', client },
    );
    expect(result).toEqual({ ok: true, integration: 'fireflies', workerName: 'meeting-writeback-abc' });
    expect(calls).toEqual([
      {
        type: 'spawn-worker',
        data: {
          name: 'meeting-writeback-abc',
          dir: join(FW, 'orgs', ORG, 'agents', 'pa'),
          prompt: expect.stringContaining('FF_MEETING_ID=abc'),
          parent: 'pa',
          env: { FF_MEETING_ID: 'abc' },
        },
      },
    ]);
  });

  it('returns ok:false without spawning when the plan is null', async () => {
    let sent = false;
    const client = { send: async () => { sent = true; return { success: true }; } };
    const result = await trySpawnWorkerForEvent('fireflies', () => null, { parent: 'pa', client });
    expect(result).toEqual({ ok: false });
    expect(sent).toBe(false);
  });

  it('returns ok:false when the daemon reports failure', async () => {
    const client = { send: async () => ({ success: false }) };
    const result = await trySpawnWorkerForEvent(
      'fireflies',
      () => planWorkerSpawn(firefliesTemplate(), 'abc'),
      { parent: 'pa', client },
    );
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:false (no throw) when the client throws — caller falls back to NL relay', async () => {
    const client = { send: async () => { throw new Error('daemon unreachable'); } };
    const result = await trySpawnWorkerForEvent(
      'fireflies',
      () => planWorkerSpawn(firefliesTemplate(), 'abc'),
      { parent: 'pa', client },
    );
    expect(result).toEqual({ ok: false });
  });
});
