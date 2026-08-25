/**
 * Skill-tree parity between the claude and codex agent templates.
 *
 * Bug context: PR 02 added the codex-agent template under
 * templates/agent-codex/plugins/cortextos-agent-skills/skills/, but the
 * template's .gitignore matched a bare `memory/` rule, which silently dropped
 * the memory skill from the committed tree. Fresh codex agents booted without
 * a memory skill — invisible breakage with no failing test.
 *
 * The fix anchored the .gitignore to agent-instance memory dirs only and
 * restored the template's memory/ skill. This test pins the invariant: every
 * skill that ships in the claude template must also ship in the codex
 * template, by directory name.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CLAUDE_SKILLS = join(__dirname, '..', '..', '..', 'templates', 'agent', '.claude', 'skills');
const TEMPLATE_ROOT = join(__dirname, '..', '..', '..', 'templates');
const CODEX_SKILLS = join(
  __dirname,
  '..',
  '..',
  '..',
  'templates',
  'agent-codex',
  'plugins',
  'cortextos-agent-skills',
  'skills',
);

function listSkillDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('agent template skill-tree parity', () => {
  it('codex template ships every skill that the claude template ships', () => {
    const claudeSkills = listSkillDirs(CLAUDE_SKILLS);
    const codexSkills = listSkillDirs(CODEX_SKILLS);

    const missingInCodex = claudeSkills.filter((skill) => !codexSkills.includes(skill));
    expect(missingInCodex).toEqual([]);
  });

  it('codex template does not ship skills that the claude template lacks', () => {
    const claudeSkills = listSkillDirs(CLAUDE_SKILLS);
    const codexSkills = listSkillDirs(CODEX_SKILLS);

    const extraInCodex = codexSkills.filter((skill) => !claudeSkills.includes(skill));
    expect(extraInCodex).toEqual([]);
  });

  it('skill counts match exactly', () => {
    expect(listSkillDirs(CODEX_SKILLS).length).toBe(listSkillDirs(CLAUDE_SKILLS).length);
  });

  it.each([
    ['claude', 'agent'],
    ['codex', 'agent-codex'],
    ['opencode', 'agent-opencode'],
  ])('%s AGENTS.md documents the context handoff lifecycle contract', (_runtime, templateDir) => {
    const agentsMd = readFileSync(join(TEMPLATE_ROOT, templateDir, 'AGENTS.md'), 'utf-8');

    expect(agentsMd).toContain('## Context Handoff Lifecycle');
    expect(agentsMd).toContain('[CONTEXT HANDOFF REQUIRED]');
    expect(agentsMd).toContain('memory/handoffs/handoff-<ts>.md');
    expect(agentsMd).toContain('--handoff-doc <absolute path>');
    expect(agentsMd).toContain('## Current Tasks');
    expect(agentsMd).toContain('## Files Modified This Session');
  });

  it.each([
    ['claude agent', join(TEMPLATE_ROOT, 'agent', '.claude', 'skills', 'agent-browser', 'SKILL.md')],
    ['claude analyst', join(TEMPLATE_ROOT, 'analyst', '.claude', 'skills', 'agent-browser', 'SKILL.md')],
    ['claude orchestrator', join(TEMPLATE_ROOT, 'orchestrator', '.claude', 'skills', 'agent-browser', 'SKILL.md')],
    ['codex agent', join(TEMPLATE_ROOT, 'agent-codex', 'plugins', 'cortextos-agent-skills', 'skills', 'agent-browser', 'SKILL.md')],
    ['opencode agent', join(TEMPLATE_ROOT, 'agent-opencode', 'plugins', 'cortextos-agent-skills', 'skills', 'agent-browser', 'SKILL.md')],
  ])('%s browser skill enforces the fleet control hierarchy', (_runtime, skillPath) => {
    const skill = readFileSync(skillPath, 'utf-8');

    expect(skill).toContain('Fleet route hierarchy — mandatory preflight');
    expect(skill).toContain('Computer control is not synonymous with Chrome remote-debugging attachment');
    expect(skill).toContain('Runtime-native computer use (including Codex Computer Use when available)');
    expect(skill).toContain('Native CuaDriver window, accessibility, and pixel control does **not** require CDP');
    expect(skill).toContain('Never create a human dependency until the applicable authorized routes above have been attempted');
  });

  it.each(['agent', 'analyst', 'agent-codex', 'agent-opencode'])(
    '%s TOOLS.md points to the versioned CuaDriver policy',
    (templateDir) => {
      const tools = readFileSync(join(TEMPLATE_ROOT, templateDir, 'TOOLS.md'), 'utf-8');

      expect(tools).toContain('### Computer and browser control');
      expect(tools).toContain('~/.cua-driver/skills/cua-driver/SKILL.md');
      expect(tools).toContain('Codex Computer Use when available');
      expect(tools).toContain('Native CuaDriver control is independent of CDP');
      expect(tools).toContain('Do not create a human dependency until applicable authorized routes have been exhausted');
    },
  );
});
