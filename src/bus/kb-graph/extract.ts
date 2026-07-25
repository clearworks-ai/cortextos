import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, relative, sep } from 'path';
import { homedir } from 'os';
import type { DatabaseSync } from 'node:sqlite';
import {
  openLinksDb,
  setWatermark,
  getWatermark,
  upsertEdge,
  upsertEntity,
  type EdgeRow,
} from './db.js';
import { extractMentions, inferLinkType, PARTNER_ROLE_RE } from './link-extraction.js';
import { extractFrontmatterEdges, parseFrontmatterBlock } from './frontmatter.js';
import type { SlugResolver } from './resolve.js';
import { slugify } from './resolve.js';

/** Narrow interface P1 codes against; production uses createSlugResolver. */
export interface SlugResolverIface {
  resolve(
    name: string,
    typeHint?: string,
  ): { slug: string; method: 'exact' | 'prefix' | 'fuzzy' | 'slugify' } | null;
}

export interface ExtractOptions {
  roots: string[];
  dbPath: string;
  resolver: SlugResolver | SlugResolverIface;
  force?: boolean;
  wikiRoot?: string;
}

export interface ExtractResult {
  filesScanned: number;
  filesSkippedUnchanged: number;
  entitiesUpserted: number;
  edgesUpserted: number;
  typedEdges: number;
  errors: Array<{ path: string; error: string }>;
}

export type { SlugResolver };

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.hg', '.svn']);

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function walkMdFiles(root: string, out: string[]): void {
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkMdFiles(full, out);
    } else if (st.isFile() && name.endsWith('.md') && st.size <= MAX_FILE_BYTES) {
      out.push(full);
    }
  }
}

function pageSlugFor(
  filePath: string,
  roots: string[],
  wikiRoot: string | undefined,
  resolver: ExtractOptions['resolver'],
): { slug: string; type: string } {
  const candidates = wikiRoot ? [wikiRoot, ...roots] : roots;
  for (const root of candidates) {
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (filePath.startsWith(prefix) || filePath === root) {
      const rel = relative(root, filePath).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..') && rel.endsWith('.md')) {
        const slug = rel.slice(0, -3);
        const type = slug.includes('/') ? slug.split('/')[0] : 'unknown';
        return { slug, type };
      }
    }
  }
  const base = basename(filePath, '.md');
  const resolved = resolver.resolve(base);
  const slug = resolved?.slug ?? slugify(base);
  const type = slug.includes('/') ? slug.split('/')[0] : 'unknown';
  return { slug, type };
}

function entityTypeFromSlug(slug: string): string {
  return slug.includes('/') ? slug.split('/')[0] : 'unknown';
}

function processFile(
  db: DatabaseSync,
  filePath: string,
  opts: ExtractOptions,
  result: ExtractResult,
): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    result.errors.push({
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const hash = sha256(content);
  if (!opts.force) {
    const prev = getWatermark(db, filePath);
    if (prev === hash) {
      result.filesSkippedUnchanged += 1;
      return;
    }
  }

  result.filesScanned += 1;
  const { slug: fromSlug, type: fromType } = pageSlugFor(
    filePath,
    opts.roots,
    opts.wikiRoot,
    opts.resolver,
  );

  const fm = parseFrontmatterBlock(content);
  const body = fm ? content.slice(fm.endOffset) : content;
  const pageRoleHit = body.match(PARTNER_ROLE_RE) ?? content.match(PARTNER_ROLE_RE);

  try {
    db.exec('BEGIN');
    upsertEntity(db, fromSlug, fromType, undefined, filePath);
    result.entitiesUpserted += 1;

    const fmEdges = extractFrontmatterEdges(
      content,
      { pageSlug: fromSlug, sourcePath: filePath },
      opts.resolver,
    );
    for (const edge of fmEdges) {
      upsertEntity(db, edge.from_slug, entityTypeFromSlug(edge.from_slug));
      upsertEntity(db, edge.to_slug, entityTypeFromSlug(edge.to_slug));
      result.entitiesUpserted += 2;
      upsertEdge(db, edge);
      result.edgesUpserted += 1;
      result.typedEdges += 1;
    }

    const mentions = extractMentions(body);
    for (const mention of mentions) {
      const resolved = opts.resolver.resolve(mention.rawTarget);
      if (!resolved) continue;
      const toSlug = resolved.slug;
      upsertEntity(db, toSlug, entityTypeFromSlug(toSlug));
      result.entitiesUpserted += 1;

      const plain: EdgeRow = {
        from_slug: fromSlug,
        to_slug: toSlug,
        type: 'mentions',
        link_source: mention.source,
        link_kind: '',
        context: mention.context,
        confidence: 0.5,
        source_path: filePath,
      };
      upsertEdge(db, plain);
      result.edgesUpserted += 1;

      const inferred = inferLinkType(mention.context, pageRoleHit);
      if (inferred.type !== 'mentions') {
        const typed: EdgeRow = {
          from_slug: fromSlug,
          to_slug: toSlug,
          type: inferred.type,
          link_source: mention.source,
          link_kind: 'typed_ner',
          context: mention.context,
          confidence: inferred.confidence,
          source_path: filePath,
        };
        upsertEdge(db, typed);
        result.edgesUpserted += 1;
        result.typedEdges += 1;
      }
    }

    setWatermark(db, filePath, hash);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    result.errors.push({
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function extractEdges(opts: ExtractOptions): ExtractResult {
  const result: ExtractResult = {
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    entitiesUpserted: 0,
    edgesUpserted: 0,
    typedEdges: 0,
    errors: [],
  };
  const db = openLinksDb(opts.dbPath);
  try {
    const files: string[] = [];
    for (const root of opts.roots) {
      walkMdFiles(root, files);
    }
    files.sort();
    for (const f of files) {
      processFile(db, f, opts, result);
    }
  } finally {
    db.close();
  }
  return result;
}

export function defaultExtractRoots(ctxRoot?: string): string[] {
  const home = homedir();
  const roots = [
    join(home, 'code', 'knowledge-sync', 'wiki'),
    join(home, 'code', 'knowledge-sync', 'raw'),
  ];
  if (ctxRoot) {
    roots.push(join(ctxRoot, '.cortextOS', 'state', 'agents'));
  }
  return roots.filter((r) => existsSync(r));
}
