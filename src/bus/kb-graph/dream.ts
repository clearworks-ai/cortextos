import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join, resolve as pathResolve, sep } from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { atomicWriteSync, ensureDir } from '../../utils/atomic.js';
import { openLinksDb, upsertEdge, upsertEntity } from './db.js';
import type { SlugResolver } from './resolve.js';
import { readJobState } from '../reliable-job.js';

export interface DreamScanOptions {
  roots: string[];
  dbPath: string;
  maxBytes?: number;
}

export interface DreamJob {
  jobKey: string;
  path: string;
  contentHash: string;
  status: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EDGE_TYPES = new Set([
  'works_at',
  'invested_in',
  'founded',
  'advises',
  'mentions',
  'relates_to',
]);

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sha256String(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function makeJobKey(absPath: string, hash: string): string {
  return `dream:synth:${absPath}:${hash}`;
}

function walkConversationBuffers(root: string, out: string[], maxBytes: number): void {
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkConversationBuffers(full, out, maxBytes);
    } else if (st.isFile() && name === 'conversation-buffer.jsonl' && st.size <= maxBytes) {
      out.push(full);
    } else if (
      st.isFile() &&
      name.endsWith('.jsonl') &&
      name.includes('transcript') &&
      st.size <= maxBytes
    ) {
      out.push(full);
    }
  }
}

function ensureJobRow(
  db: DatabaseSync,
  jobKey: string,
  filePath: string,
  contentHash: string,
  status: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO dream_jobs (job_key, path, content_hash, status, entities_filed, edges_filed, pages_written, error, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, NULL, ?)
     ON CONFLICT(job_key) DO NOTHING`,
  ).run(jobKey, filePath, contentHash, status, now);
}

export function dreamScan(opts: DreamScanOptions): {
  pending: DreamJob[];
  alreadyDone: number;
  rejected: number;
} {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const files: string[] = [];
  for (const root of opts.roots) {
    walkConversationBuffers(root, files, maxBytes);
  }
  files.sort();

  const db = openLinksDb(opts.dbPath);
  try {
    const pending: DreamJob[] = [];
    let alreadyDone = 0;
    let rejected = 0;

    for (const filePath of files) {
      const abs = pathResolve(filePath);
      let hash: string;
      try {
        hash = sha256File(abs);
      } catch {
        continue;
      }
      const jobKey = makeJobKey(abs, hash);
      const existing = db.prepare('SELECT status FROM dream_jobs WHERE job_key = ?').get(jobKey) as
        | { status: string }
        | undefined;

      if (existing) {
        if (existing.status === 'filed') {
          alreadyDone += 1;
          continue;
        }
        if (existing.status === 'rejected') {
          rejected += 1;
          continue;
        }
        pending.push({ jobKey, path: abs, contentHash: hash, status: existing.status });
        continue;
      }

      ensureJobRow(db, jobKey, abs, hash, 'pending');
      pending.push({ jobKey, path: abs, contentHash: hash, status: 'pending' });
    }

    return { pending, alreadyDone, rejected };
  } finally {
    db.close();
  }
}

export function recordVerdict(
  db: DatabaseSync,
  jobKey: string,
  verdict: 'yes' | 'no',
  model?: string,
): void {
  let row = db.prepare('SELECT path, content_hash FROM dream_jobs WHERE job_key = ?').get(jobKey) as
    | { path: string; content_hash: string }
    | undefined;
  if (!row) {
    const prefix = 'dream:synth:';
    if (!jobKey.startsWith(prefix)) {
      throw new Error(`unknown job_key: ${jobKey}`);
    }
    const rest = jobKey.slice(prefix.length);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon <= 0) throw new Error(`unknown job_key: ${jobKey}`);
    const path = rest.slice(0, lastColon);
    const hash = rest.slice(lastColon + 1);
    ensureJobRow(db, jobKey, path, hash, 'pending');
    row = { path, content_hash: hash };
  }

  const existingVerdict = db
    .prepare('SELECT verdict FROM dream_verdicts WHERE job_key = ?')
    .get(jobKey) as { verdict: string } | undefined;
  if (existingVerdict) {
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO dream_verdicts (job_key, path, content_hash, verdict, model, decided_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(jobKey, row.path, row.content_hash, verdict, model ?? null, now);
  const status = verdict === 'yes' ? 'approved' : 'rejected';
  db.prepare(`UPDATE dream_jobs SET status = ?, updated_at = ? WHERE job_key = ?`).run(
    status,
    now,
    jobKey,
  );
}

export interface DreamPayload {
  entities: Array<{ name: string; type?: string; summary?: string }>;
  edges: Array<{ from: string; to: string; type: string; context?: string }>;
  pages: Array<{ slug_hint: string; title: string; markdown: string }>;
}

export function validateDreamPayload(
  raw: unknown,
): { ok: true; payload: DreamPayload } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['payload must be an object'] };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.entities)) errors.push('entities must be an array');
  if (!Array.isArray(obj.edges)) errors.push('edges must be an array');
  if (!Array.isArray(obj.pages)) errors.push('pages must be an array');
  if (errors.length) return { ok: false, errors };

  const entities = obj.entities as Array<Record<string, unknown>>;
  for (let i = 0; i < entities.length; i++) {
    if (typeof entities[i]?.name !== 'string') errors.push(`entities[${i}].name required`);
  }
  const edges = obj.edges as Array<Record<string, unknown>>;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (typeof e?.from !== 'string') errors.push(`edges[${i}].from required`);
    if (typeof e?.to !== 'string') errors.push(`edges[${i}].to required`);
    if (typeof e?.type !== 'string') errors.push(`edges[${i}].type required`);
    else if (!ALLOWED_EDGE_TYPES.has(e.type as string)) {
      errors.push(`edges[${i}].type invalid: ${String(e.type)}`);
    }
  }
  const pages = obj.pages as Array<Record<string, unknown>>;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (typeof p?.slug_hint !== 'string') errors.push(`pages[${i}].slug_hint required`);
    if (typeof p?.title !== 'string') errors.push(`pages[${i}].title required`);
    if (typeof p?.markdown !== 'string') errors.push(`pages[${i}].markdown required`);
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      entities: entities.map((e) => ({
        name: String(e.name),
        type: typeof e.type === 'string' ? e.type : undefined,
        summary: typeof e.summary === 'string' ? e.summary : undefined,
      })),
      edges: edges.map((e) => ({
        from: String(e.from),
        to: String(e.to),
        type: String(e.type),
        context: typeof e.context === 'string' ? e.context : undefined,
      })),
      pages: pages.map((p) => ({
        slug_hint: String(p.slug_hint),
        title: String(p.title),
        markdown: String(p.markdown),
      })),
    },
  };
}

function onDiskWikiDirs(wikiRoot: string): Set<string> {
  const dirs = new Set<string>(['intelligence']);
  if (!existsSync(wikiRoot)) return dirs;
  try {
    for (const name of readdirSync(wikiRoot)) {
      try {
        if (statSync(join(wikiRoot, name)).isDirectory() && !name.startsWith('.')) {
          dirs.add(name);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return dirs;
}

function entityTypeFromSlug(slug: string): string {
  return slug.includes('/') ? slug.split('/')[0] : 'unknown';
}

export interface FileResult {
  entitiesFiled: number;
  edgesFiled: number;
  pagesWritten: string[];
  entitiesSkipped: string[];
  edgesSkipped: string[];
}

export function fileDreamPayload(
  db: DatabaseSync,
  jobKey: string,
  payload: DreamPayload,
  resolver: SlugResolver,
  knowledgeSyncRoot: string,
): FileResult {
  const wikiRoot = join(knowledgeSyncRoot, 'wiki');
  const allowedDirs = onDiskWikiDirs(wikiRoot);
  const result: FileResult = {
    entitiesFiled: 0,
    edgesFiled: 0,
    pagesWritten: [],
    entitiesSkipped: [],
    edgesSkipped: [],
  };
  const now = new Date().toISOString();

  try {
    db.exec('BEGIN');

    for (const ent of payload.entities) {
      const r = resolver.resolve(ent.name, ent.type);
      if (!r) {
        result.entitiesSkipped.push(ent.name);
        continue;
      }
      upsertEntity(db, r.slug, entityTypeFromSlug(r.slug), ent.name);
      result.entitiesFiled += 1;
    }

    for (const edge of payload.edges) {
      if (!ALLOWED_EDGE_TYPES.has(edge.type)) {
        result.edgesSkipped.push(`${edge.from} -> ${edge.to} (${edge.type})`);
        continue;
      }
      const from = resolver.resolve(edge.from);
      const to = resolver.resolve(edge.to);
      if (!from || !to) {
        result.edgesSkipped.push(`${edge.from} -> ${edge.to} (${edge.type})`);
        continue;
      }
      upsertEntity(db, from.slug, entityTypeFromSlug(from.slug));
      upsertEntity(db, to.slug, entityTypeFromSlug(to.slug));
      const typed = edge.type !== 'mentions';
      upsertEdge(db, {
        from_slug: from.slug,
        to_slug: to.slug,
        type: edge.type,
        link_source: 'mentions',
        link_kind: typed ? 'typed_ner' : '',
        context: edge.context ?? null,
        confidence: 0.9,
        source_path: jobKey,
      });
      result.edgesFiled += 1;
    }

    ensureDir(wikiRoot);
    for (const page of payload.pages) {
      const hint = page.slug_hint.replace(/\\/g, '/').replace(/^\/+/, '');
      if (hint.includes('..') || hint.includes('\0')) {
        throw new Error(`rejected slug_hint (path escape): ${page.slug_hint}`);
      }
      const slug = hint.includes('/')
        ? hint.replace(/\.md$/, '')
        : `intelligence/${hint.replace(/\.md$/, '')}`;
      const dir = slug.split('/')[0];
      if (!allowedDirs.has(dir)) {
        throw new Error(`rejected slug dir not allowed: ${dir}`);
      }
      const relParts = slug.split('/');
      if (relParts.some((p) => p === '..' || p === '')) {
        throw new Error(`rejected slug_hint: ${page.slug_hint}`);
      }
      const targetPath = join(wikiRoot, ...relParts) + '.md';
      const wikiResolved = pathResolve(wikiRoot) + sep;
      if (!pathResolve(targetPath).startsWith(wikiResolved) && pathResolve(targetPath) !== pathResolve(wikiRoot)) {
        throw new Error(`rejected slug outside wiki: ${page.slug_hint}`);
      }
      ensureDir(dirname(targetPath));
      let writePath = targetPath;
      if (existsSync(targetPath)) {
        const existing = readFileSync(targetPath, 'utf-8');
        const incoming = page.markdown.endsWith('\n') ? page.markdown : page.markdown + '\n';
        const existingNorm = existing.endsWith('\n') ? existing : existing + '\n';
        if (existingNorm === incoming) {
          result.pagesWritten.push(writePath);
          continue;
        }
        const h = sha256String(page.markdown).slice(0, 8);
        const base = basename(targetPath, '.md');
        writePath = join(dirname(targetPath), `${base}-${h}.md`);
      }
      const body = page.markdown.endsWith('\n') ? page.markdown.slice(0, -1) : page.markdown;
      atomicWriteSync(writePath, body);
      result.pagesWritten.push(writePath);
    }

    const indexPath = join(wikiRoot, 'intelligence', 'dream-index.md');
    ensureDir(dirname(indexPath));
    const line = `- ${now} | ${jobKey} | entities=${result.entitiesFiled} edges=${result.edgesFiled} pages=${result.pagesWritten.length}`;
    if (existsSync(indexPath)) {
      const prev = readFileSync(indexPath, 'utf-8');
      const base = prev.endsWith('\n') ? prev : prev + '\n';
      atomicWriteSync(indexPath, (base + line).trimEnd());
    } else {
      atomicWriteSync(indexPath, `# Dream Index\n\n${line}`);
    }

    db.prepare(
      `UPDATE dream_jobs SET status='filed', entities_filed=?, edges_filed=?, pages_written=?, error=NULL, updated_at=? WHERE job_key=?`,
    ).run(result.entitiesFiled, result.edgesFiled, result.pagesWritten.length, now, jobKey);

    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    const msg = err instanceof Error ? err.message : String(err);
    try {
      db.prepare(
        `UPDATE dream_jobs SET status='failed', error=?, updated_at=? WHERE job_key=?`,
      ).run(msg.slice(0, 2000), new Date().toISOString(), jobKey);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function dreamStatus(
  db: DatabaseSync,
  jobStateDir: string,
): {
  pending: number;
  approved: number;
  filed: number;
  failed: number;
  lastCompletionTs: string | null;
  neverSucceeded: boolean;
} {
  const count = (status: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM dream_jobs WHERE status = ?`).get(status) as {
      c: number;
    };
    return row.c;
  };
  const jobState = readJobState(jobStateDir, 'gbrain-dream');
  const lastCompletionTs = jobState?.last_success_at ?? null;
  return {
    pending: count('pending'),
    approved: count('approved'),
    filed: count('filed'),
    failed: count('failed'),
    lastCompletionTs,
    neverSucceeded: !lastCompletionTs,
  };
}
