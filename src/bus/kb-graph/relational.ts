import type { DatabaseSync } from 'node:sqlite';
import type { SlugResolver, ResolveResult } from './resolve.js';
import { edgeStats, countFrontmatterEdges, entityExists } from './db.js';

export type IntentKind = 'edge_in' | 'two_hop_peers' | 'any_path' | 'intro_traversal';

export interface ParsedIntent {
  kind: IntentKind;
  edgeType?: 'invested_in' | 'works_at' | 'founded' | 'advises';
  seedNames: string[];
  raw: string;
}

export interface GraphHit {
  slug: string;
  path: Array<{
    from: string;
    to: string;
    type: string;
    confidence: number;
    context: string | null;
  }>;
  confidence: number;
}

export interface QueryOptions {
  maxDepth?: number;
  limit?: number;
}

const INVESTED_IN_Q = /^who\s+(?:invested\s+in|backed)\s+(.+?)\??$/i;
const WORKS_AT_Q = /^who\s+works?\s+(?:at|for)\s+(.+?)\??$/i;
const FOUNDED_Q = /^who\s+(?:founded|co-?founded)\s+(.+?)\??$/i;
const ADVISES_Q = /^who\s+advises\s+(.+?)\??$/i;
const WORKS_WITH_Q = /^who\s+does\s+(.+?)\s+work\s+with\??$/i;
const CONNECTS_Q = /^what\s+connects\s+(.+?)\s+(?:and|to|with)\s+(.+?)\??$/i;
const INTRO_Q = /^who\s+did\s+(.+?)\s+introduce\s+(?:me\s+)?to\??$/i;

export function parseRelationalIntent(query: string): ParsedIntent | null {
  const q = query.trim();
  let m: RegExpExecArray | null;
  if ((m = INVESTED_IN_Q.exec(q))) {
    return { kind: 'edge_in', edgeType: 'invested_in', seedNames: [m[1].trim()], raw: q };
  }
  if ((m = WORKS_AT_Q.exec(q))) {
    return { kind: 'edge_in', edgeType: 'works_at', seedNames: [m[1].trim()], raw: q };
  }
  if ((m = FOUNDED_Q.exec(q))) {
    return { kind: 'edge_in', edgeType: 'founded', seedNames: [m[1].trim()], raw: q };
  }
  if ((m = ADVISES_Q.exec(q))) {
    return { kind: 'edge_in', edgeType: 'advises', seedNames: [m[1].trim()], raw: q };
  }
  if ((m = WORKS_WITH_Q.exec(q))) {
    return { kind: 'two_hop_peers', seedNames: [m[1].trim()], raw: q };
  }
  if ((m = CONNECTS_Q.exec(q))) {
    return { kind: 'any_path', seedNames: [m[1].trim(), m[2].trim()], raw: q };
  }
  if ((m = INTRO_Q.exec(q))) {
    return { kind: 'intro_traversal', seedNames: [m[1].trim()], raw: q };
  }
  return null;
}

interface EdgeRec {
  from_slug: string;
  to_slug: string;
  type: string;
  confidence: number;
  context: string | null;
  link_kind: string;
  link_source: string;
}

function loadEdges(db: DatabaseSync): EdgeRec[] {
  const rows = db
    .prepare(
      `SELECT from_slug, to_slug, type, confidence, context, link_kind, link_source FROM edges`,
    )
    .all() as unknown as EdgeRec[];
  return rows;
}

function resolveSeed(
  name: string,
  resolver: SlugResolver,
  db: DatabaseSync,
): { name: string; resolved: ResolveResult | null } {
  const r = resolver.resolve(name);
  if (!r) return { name, resolved: null };
  if (r.method === 'slugify' && !entityExists(db, r.slug)) {
    return { name, resolved: null };
  }
  return { name, resolved: r };
}

export function executeIntent(
  db: DatabaseSync,
  intent: ParsedIntent,
  resolver: SlugResolver,
  opts?: QueryOptions,
): {
  seeds: Array<{ name: string; resolved: ResolveResult | null }>;
  hits: GraphHit[];
} {
  const limit = opts?.limit ?? 25;
  const seeds = intent.seedNames.map((n) => resolveSeed(n, resolver, db));

  if (seeds.some((s) => s.resolved === null)) {
    return { seeds, hits: [] };
  }

  const allEdges = loadEdges(db);

  if (intent.kind === 'edge_in' && intent.edgeType) {
    const seed = seeds[0].resolved!.slug;
    const hits: GraphHit[] = [];
    for (const e of allEdges) {
      if (e.to_slug !== seed) continue;
      if (e.type !== intent.edgeType) continue;
      if (e.link_kind === '' && e.link_source === 'mentions') continue;
      hits.push({
        slug: e.from_slug,
        path: [
          {
            from: e.from_slug,
            to: e.to_slug,
            type: e.type,
            confidence: e.confidence,
            context: e.context,
          },
        ],
        confidence: e.confidence,
      });
    }
    hits.sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug));
    return { seeds, hits: hits.slice(0, limit) };
  }

  if (intent.kind === 'two_hop_peers') {
    const a = seeds[0].resolved!.slug;
    const maxDepth = opts?.maxDepth ?? 2;
    void maxDepth;
    const companies = allEdges.filter(
      (e) => e.from_slug === a && e.type === 'works_at' && !(e.link_kind === '' && e.link_source === 'mentions'),
    );
    const best = new Map<string, GraphHit>();
    for (const hop1 of companies) {
      const peers = allEdges.filter(
        (e) =>
          e.to_slug === hop1.to_slug &&
          e.type === 'works_at' &&
          e.from_slug !== a &&
          !(e.link_kind === '' && e.link_source === 'mentions'),
      );
      for (const hop2 of peers) {
        const conf = Math.min(hop1.confidence, hop2.confidence);
        const hit: GraphHit = {
          slug: hop2.from_slug,
          path: [
            {
              from: hop1.from_slug,
              to: hop1.to_slug,
              type: hop1.type,
              confidence: hop1.confidence,
              context: hop1.context,
            },
            {
              from: hop2.from_slug,
              to: hop2.to_slug,
              type: hop2.type,
              confidence: hop2.confidence,
              context: hop2.context,
            },
          ],
          confidence: conf,
        };
        const prev = best.get(hop2.from_slug);
        if (!prev || hit.confidence > prev.confidence) best.set(hop2.from_slug, hit);
      }
    }
    const hits = [...best.values()].sort(
      (x, y) => y.confidence - x.confidence || x.slug.localeCompare(y.slug),
    );
    return { seeds, hits: hits.slice(0, limit) };
  }

  if (intent.kind === 'intro_traversal') {
    const seed = seeds[0].resolved!.slug;
    const hits: GraphHit[] = [];
    for (const e of allEdges) {
      if (e.from_slug !== seed) continue;
      if (e.type !== 'mentions' && e.type !== 'relates_to') continue;
      hits.push({
        slug: e.to_slug,
        path: [
          {
            from: e.from_slug,
            to: e.to_slug,
            type: e.type,
            confidence: e.confidence,
            context: e.context,
          },
        ],
        confidence: e.confidence,
      });
    }
    hits.sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug));
    return { seeds, hits: hits.slice(0, limit) };
  }

  // any_path
  const start = seeds[0].resolved!.slug;
  const goal = seeds[1].resolved!.slug;
  const maxDepth = opts?.maxDepth ?? 4;

  type AdjEdge = {
    neighbor: string;
    from: string;
    to: string;
    type: string;
    confidence: number;
    context: string | null;
  };

  // If edges > 50k, load lazily per-node — explicit branch for scale
  const useLazy = allEdges.length > 50_000;
  let adj: Map<string, AdjEdge[]>;

  if (useLazy) {
    adj = new Map();
    const ensure = (node: string) => {
      if (adj.has(node)) return;
      const neighbors: AdjEdge[] = [];
      for (const e of allEdges) {
        if (e.from_slug === node) {
          neighbors.push({
            neighbor: e.to_slug,
            from: e.from_slug,
            to: e.to_slug,
            type: e.type,
            confidence: e.confidence,
            context: e.context,
          });
        } else if (e.to_slug === node) {
          neighbors.push({
            neighbor: e.from_slug,
            from: e.from_slug,
            to: e.to_slug,
            type: e.type,
            confidence: e.confidence,
            context: e.context,
          });
        }
      }
      neighbors.sort((a, b) => a.type.localeCompare(b.type) || a.neighbor.localeCompare(b.neighbor));
      adj.set(node, neighbors);
    };
    // fill on demand in DFS
    const getNeighbors = (node: string): AdjEdge[] => {
      ensure(node);
      return adj.get(node) ?? [];
    };
    const hits: GraphHit[] = [];
    type Frame = {
      node: string;
      path: GraphHit['path'];
      visited: Set<string>;
    };
    const stack: Frame[] = [{ node: start, path: [], visited: new Set([start]) }];
    while (stack.length > 0 && hits.length < limit) {
      const frame = stack.pop()!;
      if (frame.path.length > 0 && frame.node === goal) {
        const conf = frame.path.reduce((m, p) => Math.min(m, p.confidence), 1);
        hits.push({ slug: goal, path: frame.path, confidence: conf });
        continue;
      }
      if (frame.path.length >= maxDepth) continue;
      for (const edge of getNeighbors(frame.node)) {
        if (frame.visited.has(edge.neighbor)) continue;
        const nextVisited = new Set(frame.visited);
        nextVisited.add(edge.neighbor);
        stack.push({
          node: edge.neighbor,
          path: [
            ...frame.path,
            {
              from: edge.from,
              to: edge.to,
              type: edge.type,
              confidence: edge.confidence,
              context: edge.context,
            },
          ],
          visited: nextVisited,
        });
      }
    }
    return { seeds, hits };
  }

  adj = new Map();
  for (const e of allEdges) {
    const push = (node: string, edge: AdjEdge) => {
      const list = adj.get(node) ?? [];
      list.push(edge);
      adj.set(node, list);
    };
    push(e.from_slug, {
      neighbor: e.to_slug,
      from: e.from_slug,
      to: e.to_slug,
      type: e.type,
      confidence: e.confidence,
      context: e.context,
    });
    push(e.to_slug, {
      neighbor: e.from_slug,
      from: e.from_slug,
      to: e.to_slug,
      type: e.type,
      confidence: e.confidence,
      context: e.context,
    });
  }
  for (const [, list] of adj) {
    list.sort((a, b) => a.type.localeCompare(b.type) || a.neighbor.localeCompare(b.neighbor));
  }

  const hits: GraphHit[] = [];
  type Frame = { node: string; path: GraphHit['path']; visited: Set<string> };
  const stack: Frame[] = [{ node: start, path: [], visited: new Set([start]) }];
  while (stack.length > 0 && hits.length < limit) {
    const frame = stack.pop()!;
    if (frame.path.length > 0 && frame.node === goal) {
      const conf = frame.path.reduce((m, p) => Math.min(m, p.confidence), 1);
      hits.push({ slug: goal, path: frame.path, confidence: conf });
      continue;
    }
    if (frame.path.length >= maxDepth) continue;
    for (const edge of adj.get(frame.node) ?? []) {
      if (frame.visited.has(edge.neighbor)) continue;
      const nextVisited = new Set(frame.visited);
      nextVisited.add(edge.neighbor);
      stack.push({
        node: edge.neighbor,
        path: [
          ...frame.path,
          {
            from: edge.from,
            to: edge.to,
            type: edge.type,
            confidence: edge.confidence,
            context: edge.context,
          },
        ],
        visited: nextVisited,
      });
    }
  }
  return { seeds, hits };
}

export interface GraphCanaryConfig {
  min_edges?: number;
  frontmatter_edges_min?: number;
  resolve?: Array<{ name: string; expect_prefix: string }>;
  queries?: Array<{ query: string; expect_slug: string }>;
  wikiRoot?: string;
}

export function runGraphCanary(
  db: DatabaseSync,
  resolver: SlugResolver,
  config: GraphCanaryConfig,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const stats = edgeStats(db);
  const minEdges = config.min_edges ?? 1;
  if (stats.edges < minEdges) {
    failures.push(`min_edges: expected >= ${minEdges}, got ${stats.edges}`);
  }
  if (config.frontmatter_edges_min !== undefined) {
    const fm = countFrontmatterEdges(db);
    if (fm < config.frontmatter_edges_min) {
      failures.push(
        `frontmatter_edges_min: expected >= ${config.frontmatter_edges_min}, got ${fm}`,
      );
    }
  }
  for (const r of config.resolve ?? []) {
    const res = resolver.resolve(r.name);
    if (!res || !res.slug.startsWith(r.expect_prefix) || res.method === 'slugify') {
      failures.push(
        `resolve "${r.name}": expected prefix ${r.expect_prefix} non-slugify, got ${JSON.stringify(res)}`,
      );
    }
  }
  for (const q of config.queries ?? []) {
    const intent = parseRelationalIntent(q.query);
    if (!intent) {
      failures.push(`query unparseable: ${q.query}`);
      continue;
    }
    const { hits } = executeIntent(db, intent, resolver);
    if (!hits.some((h) => h.slug === q.expect_slug)) {
      failures.push(
        `query "${q.query}": expected slug ${q.expect_slug}, hits=${hits.map((h) => h.slug).join(',')}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

export const SUPPORTED_PATTERNS = [
  'who invested in X?',
  'who works at Y?',
  'who founded Z?',
  'who advises W?',
  'who does A work with?',
  'what connects A and B?',
  'who did X introduce me to?',
];
