import fs from 'fs';
import path from 'path';
import { getFrameworkRoot, getOrgs } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const dynamic = 'force-dynamic';

interface SkillEntry {
  slug: string;
  name: string;
  description: string;
  triggers: string[];
  installed: boolean;
  installedFor: string[];   // "org/agent" pairs
  source: 'catalog' | 'agent';
}

function parseSkillMd(content: string): { name: string; description: string; triggers: string[] } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  let name = '';
  let description = '';
  let triggers: string[] = [];

  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const nm = fm.match(/^name:\s*(.+)$/m);
    const dm = fm.match(/^description:\s*(.+)$/m);
    const tm = fm.match(/^triggers:\s*(\[.+\])/m);

    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
    if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
    if (tm) {
      try {
        triggers = JSON.parse(tm[1]);
      } catch { /* skip */ }
    }
  }

  if (!name) {
    const h = content.match(/^#\s+(.+)$/m);
    if (h) name = h[1].trim();
  }

  return { name: name || 'Unnamed Skill', description: description || '', triggers };
}

function readSkillDir(dirPath: string): { name: string; description: string; triggers: string[] } | null {
  if (!fs.existsSync(dirPath)) return null;
  const skillMd = path.join(dirPath, 'SKILL.md');
  const readme = path.join(dirPath, 'README.md');
  let content = '';
  if (fs.existsSync(skillMd)) content = fs.readFileSync(skillMd, 'utf-8');
  else if (fs.existsSync(readme)) content = fs.readFileSync(readme, 'utf-8');
  else return null;
  return parseSkillMd(content);
}

export async function GET() {
  try {
    const frameworkRoot = getFrameworkRoot();
    const skillMap = new Map<string, SkillEntry>();

    // 1. Framework catalog: $CTX_FRAMEWORK_ROOT/skills/
    const catalogDir = path.join(frameworkRoot, 'skills');
    if (fs.existsSync(catalogDir)) {
      for (const entry of fs.readdirSync(catalogDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const slug = entry.name;
        const meta = readSkillDir(path.join(catalogDir, slug));
        if (!meta) continue;
        skillMap.set(slug, {
          slug,
          name: meta.name || slug,
          description: meta.description,
          triggers: meta.triggers,
          installed: false,
          installedFor: [],
          source: 'catalog',
        });
      }
    }

    // 2. Per-agent skills: both $CTX_FRAMEWORK_ROOT/orgs/{org}/agents/{agent}/skills/
    //    AND $CTX_FRAMEWORK_ROOT/orgs/{org}/agents/{agent}/.claude/skills/
    const orgs = getOrgs();
    for (const org of orgs) {
      const agentsDir = path.join(frameworkRoot, 'orgs', org, 'agents');
      if (!fs.existsSync(agentsDir)) continue;

      for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!agentEntry.isDirectory()) continue;
        const agentName = agentEntry.name;
        const agentPath = `${org}/${agentName}`;

        const skillDirs = [
          path.join(agentsDir, agentName, 'skills'),
          path.join(agentsDir, agentName, '.claude', 'skills'),
        ];

        for (const skillsDir of skillDirs) {
          if (!fs.existsSync(skillsDir)) continue;
          for (const skillDirEntry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
            if (!skillDirEntry.isDirectory() || skillDirEntry.name.startsWith('.')) continue;
            const slug = skillDirEntry.name;
            const dirPath = path.join(skillsDir, slug);

            if (!skillMap.has(slug)) {
              const meta = readSkillDir(dirPath);
              if (!meta) continue;
              skillMap.set(slug, {
                slug,
                name: meta.name || slug,
                description: meta.description,
                triggers: meta.triggers,
                installed: false,
                installedFor: [],
                source: 'agent',
              });
            }

            const entry = skillMap.get(slug)!;
            if (!entry.installedFor.includes(agentPath)) {
              entry.installedFor.push(agentPath);
              entry.installed = true;
            }
          }
        }
      }
    }

    const skills = Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    return Response.json(skills);
  } catch (err) {
    console.error('[api/skills] error:', err);
    return Response.json([]);
  }
}

// POST /api/skills - Install a skill to an agent
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Run skill: { action: 'run', slug, org, agent }
    if (body.action === 'run') {
      const { slug, org, agent } = body as { slug?: string; org?: string; agent?: string };
      if (!slug || !agent) {
        return Response.json({ error: 'slug and agent required' }, { status: 400 });
      }

      const frameworkRoot = getFrameworkRoot();
      const agentName = agent;

      // Find the skill SKILL.md to get the first trigger or use slug
      const skillPaths = [
        path.join(frameworkRoot, 'skills', slug, 'SKILL.md'),
        path.join(frameworkRoot, 'orgs', org ?? '', 'agents', agentName, '.claude', 'skills', slug, 'SKILL.md'),
        path.join(frameworkRoot, 'orgs', org ?? '', 'agents', agentName, 'skills', slug, 'SKILL.md'),
      ];

      let triggerPhrase = `/${slug}`;
      for (const p of skillPaths) {
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf-8');
          const meta = parseSkillMd(content);
          if (meta.triggers.length > 0) {
            triggerPhrase = meta.triggers[0];
          }
          break;
        }
      }

      const message = `Run skill: ${triggerPhrase}`;
      try {
        await execAsync(`cortextos bus send-message ${agentName} normal '${message.replace(/'/g, "'\\''")}' 2>/dev/null || true`);
        return Response.json({ success: true, message });
      } catch {
        return Response.json({ error: 'Failed to send message to agent' }, { status: 500 });
      }
    }

    // Install skill: { slug, org, agent }
    const { slug, org, agent } = body as { slug?: string; org?: string; agent?: string };
    if (!slug || !org || !agent) {
      return Response.json({ error: 'slug, org, and agent required' }, { status: 400 });
    }

    const frameworkRoot = getFrameworkRoot();
    const catalogDir = path.join(frameworkRoot, 'skills', slug);
    if (!fs.existsSync(catalogDir)) {
      return Response.json({ error: `Skill not found: ${slug}` }, { status: 404 });
    }

    const skillsDir = path.join(frameworkRoot, 'orgs', org, 'agents', agent, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const linkPath = path.join(skillsDir, slug);

    try { if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath); } catch { /* doesn't exist */ }
    fs.symlinkSync(catalogDir, linkPath, 'dir');

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE /api/skills - Uninstall a skill from an agent
export async function DELETE(request: Request) {
  try {
    const { slug, org, agent } = await request.json();
    if (!slug || !org || !agent) {
      return Response.json({ error: 'slug, org, and agent required' }, { status: 400 });
    }

    const frameworkRoot = getFrameworkRoot();
    const linkPath = path.join(frameworkRoot, 'orgs', org, 'agents', agent, 'skills', slug);

    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
      else if (stat.isDirectory()) fs.rmSync(linkPath, { recursive: true });
    } catch {
      return Response.json({ error: `Skill not installed: ${slug}` }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
