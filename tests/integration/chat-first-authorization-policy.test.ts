import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

describe('chat-first authorization policy', () => {
  it('is synchronized across templates, community agents, and existing org agents', () => {
    expect(() => execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'sync-chat-first-authorization-policy.mjs'), '--check'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
    )).not.toThrow();
  });

  it('makes Telegram authoritative and private Google Docs routine work', () => {
    const template = readFileSync(join(ROOT, 'templates', 'agent-codex', 'AGENTS.md'), 'utf8');
    const skill = readFileSync(
      join(ROOT, 'community', 'skills', 'approvals', 'SKILL.md'),
      'utf8',
    );

    expect(template).toContain("Josh's authorized Telegram chat is the user interface and control channel");
    expect(template).toContain('creating or editing private Google Docs, Sheets, Slides, or Drive files');
    expect(template).toContain('Do not manufacture a second approval');
    expect(skill).toContain('Never tell Josh to check or use a dashboard');
    expect(skill).toContain('Never gate private Google Workspace or local artifact creation behind approval');
  });
});
