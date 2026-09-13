import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { extractMeetingId, planMeetingWritebackSpawn } from '../../../src/cli/webhook-bridge';

const FW = '/fw';
const ORG = 'clearworksai';
const yesSkill = () => true;

describe('extractMeetingId', () => {
  it('reads and trims a string/number meeting_id, empty when absent', () => {
    expect(extractMeetingId({ event: 'x', meeting_id: '  01ABC ' } as never)).toBe('01ABC');
    expect(extractMeetingId({ event: 'x', meeting_id: 12345 } as never)).toBe('12345');
    expect(extractMeetingId({ event: 'x' } as never)).toBe('');
    expect(extractMeetingId({ event: 'x', meeting_id: null } as never)).toBe('');
  });
});

describe('planMeetingWritebackSpawn', () => {
  it('lowercases + sanitizes the id into a WORKER_NAME_REGEX-safe worker name', () => {
    const plan = planMeetingWritebackSpawn({
      frameworkRoot: FW, org: ORG, target: 'pa', meetingId: '01JXYZ.abc/9', skillExists: yesSkill,
    });
    expect(plan).not.toBeNull();
    // daemon WORKER_NAME_REGEX = /^[a-z0-9_-]+$/
    expect(plan!.workerName).toMatch(/^[a-z0-9_-]+$/);
    expect(plan!.workerName).toBe('meeting-writeback-01jxyzabc9');
    expect(plan!.workerName.length).toBeLessThanOrEqual(64);
  });

  it('resolves the agent dir dynamically from framework root/org (no hardcoded absolute)', () => {
    const plan = planMeetingWritebackSpawn({
      frameworkRoot: FW, org: ORG, target: 'pa', meetingId: 'abc', skillExists: yesSkill,
    });
    expect(plan!.dir).toBe(join(FW, 'orgs', ORG, 'agents', 'pa'));
    expect(plan!.prompt).toContain('FF_MEETING_ID=abc');
    // Phase G: the spawned session now runs the deterministic pipeline instead of
    // reading the legacy SKILL — that lane received webhooks for months without
    // ever filing a meeting or drafting a recap.
    expect(plan!.prompt).toContain('scripts/brain/run_meeting.py');
    expect(plan!.prompt).toContain('--meeting-id abc --apply');
    expect(plan!.prompt).not.toContain('SKILL.md');
  });

  it('returns null when the target agent has no writeback skill (so caller falls back to NL relay)', () => {
    expect(planMeetingWritebackSpawn({
      frameworkRoot: FW, org: ORG, target: 'pa', meetingId: 'abc', skillExists: () => false,
    })).toBeNull();
  });

  it('returns null on missing org or an id that sanitizes to empty', () => {
    expect(planMeetingWritebackSpawn({ frameworkRoot: FW, target: 'pa', meetingId: 'abc', skillExists: yesSkill })).toBeNull();
    expect(planMeetingWritebackSpawn({ frameworkRoot: FW, org: ORG, target: 'pa', meetingId: '....', skillExists: yesSkill })).toBeNull();
  });

  it('caps the worker name at 64 chars for a very long id', () => {
    const plan = planMeetingWritebackSpawn({
      frameworkRoot: FW, org: ORG, target: 'pa', meetingId: 'a'.repeat(200), skillExists: yesSkill,
    });
    expect(plan!.workerName.length).toBeLessThanOrEqual(64);
  });
});
