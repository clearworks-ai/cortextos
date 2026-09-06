/**
 * FR-011: status artifact from canonical state (phase 3). Feeds an
 * engagement's node files to the existing delivery-status engine unchanged
 * (zero changes to src/bus/delivery-status.ts — spec Bucket A).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { buildStatusReportPlan, type StatusReportPlan } from '../../src/bus/delivery-status';

export interface NodeMeta {
  id: string;
  kind: string;
  client: string;
  parent: string;
  title: string;
  path: string;
}

export function parseNodeBlock(text: string, path: string): NodeMeta {
  const idx = text.indexOf('## Node');
  if (idx === -1) throw new Error(`${path}: no ## Node block`);
  const rest = text.slice(idx + '## Node'.length);
  const next = rest.indexOf('\n## ');
  const block = next < 0 ? rest : rest.slice(0, next);
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (key) out[key] = line.slice(i + 1).trim();
  }
  return {
    id: out.id || '',
    kind: out.kind || '',
    client: out.client || '',
    parent: out.parent || '',
    title: out.title || '',
    path,
  };
}

export function extractSection(md: string, heading: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (capturing) break;
      const title = line.replace(/^##\s+/, '').trim().toLowerCase();
      const want = heading.toLowerCase();
      capturing = title === want || title.startsWith(`${want} `) || title.startsWith(`${want}(`);
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join('\n');
}

/**
 * G0a F-3 / G0b C1-1: the same split-by-`## `-heading algorithm as
 * writeback_render._split_sections (Python), reimplemented here since this
 * file has no Python interop — status_plan.ts needs the actual section
 * SPANS (not just extracted text) so an edited section can be spliced back
 * without touching a single byte outside it.
 */
function splitSections(text: string): { preamble: string; sections: { heading: string; body: string }[] } {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const preamble: string[] = [];
  const sections: { heading: string; body: string[] }[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (current) sections.push(current);
      current = { heading: line.slice(3).trim(), body: [line] };
    } else if (!current) {
      preamble.push(line);
    } else {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  return { preamble: preamble.join(''), sections: sections.map((s) => ({ heading: s.heading, body: s.body.join('') })) };
}

export function loadNodes(vault: string): Record<string, NodeMeta> {
  const projDir = join(vault, 'raw/areas/clearworks/org-brain/projects');
  const nodes: Record<string, NodeMeta> = {};
  if (!existsSync(projDir)) return nodes;
  for (const name of readdirSync(projDir)) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue;
    const path = join(projDir, name);
    const node = parseNodeBlock(readFileSync(path, 'utf8'), path);
    nodes[node.id || name.replace(/\.md$/, '')] = node;
  }
  return nodes;
}

export function resolveEngagementId(
  nodeId: string,
  nodes: Record<string, NodeMeta>,
): { engagementId: string; skipReason: string | null } {
  const node = nodes[nodeId];
  if (!node) return { engagementId: '', skipReason: 'no-engagement' };
  if (node.kind === 'engagement') return { engagementId: node.id, skipReason: null };
  if (node.kind === 'project' && node.parent) return { engagementId: node.parent, skipReason: null };
  return { engagementId: '', skipReason: 'no-engagement' };
}

function historyEntries(md: string): { date: string; text: string }[] {
  const body = extractSection(md, 'History');
  const entries: { date: string; text: string }[] = [];
  let current: { date: string; lines: string[] } | null = null;
  for (const line of body.split('\n')) {
    const m = /^- (\d{4}-\d{2}-\d{2})\s*—/.exec(line);
    if (m) {
      if (current) entries.push({ date: current.date, text: current.lines.join('\n') });
      current = { date: m[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) entries.push({ date: current.date, text: current.lines.join('\n') });
  return entries;
}

function openItemRows(md: string): string[] {
  const body = extractSection(md, 'Open Items');
  return body
    .split('\n')
    .filter((line) => line.trim().startsWith('|') && !/^\|\s*-+/.test(line.trim()));
}

export function composeSyntheticMarkdown(
  clientTitle: string,
  engagement: NodeMeta,
  engagementMd: string,
  children: { node: NodeMeta; md: string }[],
): string {
  const reporting = extractSection(engagementMd, 'Reporting').trim();
  const allDocs = [engagementMd, ...children.map((c) => c.md)];
  const merged = allDocs.flatMap(historyEntries).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const openRows = allDocs.flatMap(openItemRows);
  return [
    `# Client: ${clientTitle} — ${engagement.title || engagement.id}`,
    '',
    '## Reporting',
    reporting,
    '',
    '## History (dated, newest first)',
    '',
    ...merged.map((e) => e.text),
    '',
    '## Open Items',
    '',
    '| Item | Owner | Deadline | Source | Status |',
    '|---|---|---|---|---|',
    ...openRows,
    '',
  ].join('\n');
}

const REPORTING_LAST_UPDATE_LINE = /^([ \t]*-?[ \t]*last_update[ \t]*:)[ \t]*.*$/m;

export function setLastUpdate(md: string, today: string): string {
  const { preamble, sections } = splitSections(md);
  const idx = sections.findIndex((s) => s.heading.toLowerCase().startsWith('reporting'));
  if (idx === -1) return md;
  const body = sections[idx].body;
  const newBody = REPORTING_LAST_UPDATE_LINE.test(body)
    ? body.replace(REPORTING_LAST_UPDATE_LINE, `$1 ${today}`)
    : body.replace(/^(## Reporting[^\n]*\n)/, `$1last_update: ${today}\n`);
  if (newBody === body) return md;
  const newSections = sections.slice();
  newSections[idx] = { ...sections[idx], body: newBody };
  return preamble + newSections.map((s) => s.body).join('');
}

function targetOf(plan: StatusReportPlan): { relPath: string; fileContent: string } | null {
  if (plan.action === 'draft' && plan.draft) return { relPath: plan.draft.relPath, fileContent: plan.draft.fileContent };
  if (plan.action === 'brief' && plan.brief) return { relPath: plan.brief.relPath, fileContent: plan.brief.fileContent };
  return null;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') {
      args.write = true;
      continue;
    }
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const vault = String(args.vault || join(process.env.HOME || '', 'code/knowledge-sync'));
  const clientSlug = String(args.client || '');
  const nodeId = String(args.node || '');
  const today = String(args.today || new Date().toISOString().slice(0, 10));
  const write = Boolean(args.write);

  const nodes = loadNodes(vault);
  const { engagementId, skipReason } = resolveEngagementId(nodeId, nodes);
  if (skipReason) {
    process.stdout.write(`skip: ${skipReason}\n`);
    process.stdout.write(JSON.stringify({ relPath: null, action: `skip: ${skipReason}` }) + '\n');
    return 0;
  }
  const engagement = nodes[engagementId];
  const engagementMd = readFileSync(engagement.path, 'utf8');
  if (!extractSection(engagementMd, 'Reporting').trim()) {
    process.stdout.write('skip: no-reporting-block\n');
    process.stdout.write(JSON.stringify({ relPath: null, action: 'skip: no-reporting-block' }) + '\n');
    return 0;
  }
  const children = Object.values(nodes)
    .filter((n) => n.kind === 'project' && n.parent === engagement.id)
    .map((n) => ({ node: n, md: readFileSync(n.path, 'utf8') }));
  const clientTitle = clientSlug.charAt(0).toUpperCase() + clientSlug.slice(1);
  const synthetic = composeSyntheticMarkdown(clientTitle, engagement, engagementMd, children);
  const plan = buildStatusReportPlan({ slug: clientSlug, clientFileMarkdown: synthetic, today });

  if (plan.action === 'skip') {
    process.stdout.write(`skip: ${plan.skipReason || 'skip'}\n`);
    process.stdout.write(JSON.stringify({ relPath: null, action: `skip: ${plan.skipReason || 'skip'}` }) + '\n');
    return 0;
  }
  const target = targetOf(plan);
  if (!target) {
    process.stdout.write('skip: no-target\n');
    process.stdout.write(JSON.stringify({ relPath: null, action: 'skip: no-target' }) + '\n');
    return 0;
  }
  if (!write) {
    process.stdout.write(`would-write: ${target.relPath}\n`);
    process.stdout.write(JSON.stringify({ relPath: target.relPath, action: plan.action }) + '\n');
    return 0;
  }
  const destPath = join(vault, target.relPath);
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp-${process.pid}`;
  writeFileSync(tmp, target.fileContent);
  renameSync(tmp, destPath);
  const newEngagementMd = setLastUpdate(engagementMd, today);
  if (newEngagementMd !== engagementMd) {
    const engTmp = `${engagement.path}.tmp-${process.pid}`;
    writeFileSync(engTmp, newEngagementMd);
    renameSync(engTmp, engagement.path);
  }
  process.stdout.write(`wrote: ${target.relPath}\n`);
  process.stdout.write(JSON.stringify({ relPath: target.relPath, action: plan.action }) + '\n');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
