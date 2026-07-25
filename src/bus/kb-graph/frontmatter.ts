import type { EdgeRow } from './db.js';
import type { SlugResolver } from './resolve.js';

export const FRONTMATTER_LINK_MAP: Readonly<
  Record<string, { type: string; direction: 'out' | 'in'; typeHint?: string }>
> = {
  companies: { type: 'works_at', direction: 'out', typeHint: 'companies' },
  works_at: { type: 'works_at', direction: 'out', typeHint: 'companies' },
  investments: { type: 'invested_in', direction: 'out' },
  invested_in: { type: 'invested_in', direction: 'out' },
  advises: { type: 'advises', direction: 'out', typeHint: 'people' },
  founded: { type: 'founded', direction: 'out', typeHint: 'companies' },
  key_people: { type: 'works_at', direction: 'in', typeHint: 'people' },
  relates_to: { type: 'relates_to', direction: 'out' },
};

export interface FrontmatterBlock {
  fields: Map<string, string[]>;
  endOffset: number;
}

export interface FrontmatterEdgeInput {
  pageSlug: string;
  sourcePath: string;
}

function splitInlineList(raw: string): string[] {
  const inner = raw.trim();
  if (!inner.startsWith('[') || !inner.endsWith(']')) return [];
  const body = inner.slice(1, -1).trim();
  if (!body) return [];
  const parts: string[] = [];
  let cur = '';
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ',') {
      const t = cur.trim();
      if (t) parts.push(t);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const t = cur.trim();
  if (t) parts.push(t);
  return parts;
}

/**
 * Hand-parse leading frontmatter: first line exactly '---', ends at next '---' line.
 * Supported: scalar, inline list, block list. Nested maps skipped never throw.
 */
export function parseFrontmatterBlock(content: string): FrontmatterBlock | null {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return null;
  }
  const firstNl = normalized.indexOf('\n');
  if (firstNl < 0) return null;
  let i = firstNl + 1;
  const lines: string[] = [];
  while (i < normalized.length) {
    const nextNl = normalized.indexOf('\n', i);
    const lineEnd = nextNl < 0 ? normalized.length : nextNl;
    let line = normalized.slice(i, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '---') {
      const endOffset = (nextNl < 0 ? normalized.length : nextNl + 1);
      return { fields: parseFields(lines), endOffset };
    }
    lines.push(line);
    if (nextNl < 0) break;
    i = nextNl + 1;
  }
  return null;
}

function parseFields(lines: string[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2].trim();
    // Nested map-like value on same line: skip
    if (rest && !rest.startsWith('[') && rest.endsWith(':')) {
      i++;
      continue;
    }
    if (rest.startsWith('{')) {
      // nested map — skip
      i++;
      continue;
    }
    if (rest.startsWith('[')) {
      fields.set(key, splitInlineList(rest));
      i++;
      continue;
    }
    if (rest === '') {
      // block list
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const bl = lines[i];
        const item = /^\s+-\s+(.*)$/.exec(bl);
        if (!item) break;
        items.push(item[1].trim().replace(/^["']|["']$/g, ''));
        i++;
      }
      if (items.length > 0) fields.set(key, items);
      continue;
    }
    // scalar
    fields.set(key, [rest.replace(/^["']|["']$/g, '')]);
    i++;
  }
  return fields;
}

export function extractFrontmatterEdges(
  content: string,
  page: FrontmatterEdgeInput,
  resolver: SlugResolver | { resolve(name: string, typeHint?: string): { slug: string } | null },
): EdgeRow[] {
  const block = parseFrontmatterBlock(content);
  if (!block) return [];
  const edges: EdgeRow[] = [];
  for (const [key, values] of block.fields) {
    const map = FRONTMATTER_LINK_MAP[key];
    if (!map) continue;
    for (const value of values) {
      if (!value.trim()) continue;
      const resolved = resolver.resolve(value, map.typeHint);
      if (!resolved) continue;
      const target = resolved.slug;
      const from = map.direction === 'out' ? page.pageSlug : target;
      const to = map.direction === 'out' ? target : page.pageSlug;
      edges.push({
        from_slug: from,
        to_slug: to,
        type: map.type,
        link_source: 'frontmatter',
        link_kind: '',
        context: null,
        confidence: 0.9,
        source_path: page.sourcePath,
      });
    }
  }
  return edges;
}
