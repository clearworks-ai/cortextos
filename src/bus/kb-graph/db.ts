import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeOrgName } from '../../utils/org.js';

const require = createRequire(import.meta.url);

let sqliteAvailable: boolean | null = null;

export function hasNodeSqlite(): boolean {
  if (sqliteAvailable !== null) return sqliteAvailable;
  try {
    const mod = require('node:sqlite') as { DatabaseSync?: unknown };
    sqliteAvailable = typeof mod.DatabaseSync === 'function';
  } catch {
    sqliteAvailable = false;
  }
  return sqliteAvailable;
}

export function assertNodeSqliteAvailable(): void {
  if (!hasNodeSqlite()) {
    throw new Error(
      'kb-graph requires Node >= 22.5 (node:sqlite). Current: ' +
        process.version +
        '. All other cortextOS features are unaffected.',
    );
  }
}

export function kbRootPath(instanceId: string, frameworkRoot: string, org: string): string {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  return join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
}

export function linksDbPath(instanceId: string, frameworkRoot: string, org: string): string {
  return join(kbRootPath(instanceId, frameworkRoot, org), 'links.sqlite');
}

export function jobsDir(instanceId: string, frameworkRoot: string, org: string): string {
  return join(kbRootPath(instanceId, frameworkRoot, org), 'jobs');
}

const DDL = `
CREATE TABLE IF NOT EXISTS entities (
  slug        TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'unknown',
  title       TEXT,
  source_path TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_slug   TEXT NOT NULL,
  to_slug     TEXT NOT NULL,
  type        TEXT NOT NULL,
  link_source TEXT NOT NULL CHECK (link_source IN ('mentions','frontmatter','wikilink-resolved')),
  link_kind   TEXT NOT NULL DEFAULT ''
              CHECK (link_kind IN ('', 'typed_ner')),
  context     TEXT,
  confidence  REAL NOT NULL,
  source_path TEXT,
  extracted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (from_slug, to_slug, type, link_source, link_kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges (from_slug, type);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges (to_slug, type);

CREATE TABLE IF NOT EXISTS extract_watermarks (
  path         TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  extracted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dream_verdicts (
  job_key      TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('yes','no')),
  model        TEXT,
  decided_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dream_jobs (
  job_key      TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','filed','failed')),
  entities_filed INTEGER NOT NULL DEFAULT 0,
  edges_filed    INTEGER NOT NULL DEFAULT 0,
  pages_written  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  updated_at   TEXT NOT NULL
);
`;

export function openLinksDb(dbPath: string): DatabaseSync {
  assertNodeSqliteAvailable();
  mkdirSync(dirname(dbPath), { recursive: true });
  const { DatabaseSync: DatabaseSyncCtor } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  const db = new DatabaseSyncCtor(dbPath);
  db.exec(DDL);
  db.exec('PRAGMA journal_mode=WAL');
  return db;
}

export interface EdgeRow {
  from_slug: string;
  to_slug: string;
  type: string;
  link_source: 'mentions' | 'frontmatter' | 'wikilink-resolved';
  link_kind: '' | 'typed_ner';
  context: string | null;
  confidence: number;
  source_path: string | null;
}

export function upsertEntity(
  db: DatabaseSync,
  slug: string,
  type: string,
  title?: string,
  sourcePath?: string,
): void {
  db.prepare(
    `INSERT INTO entities (slug, type, title, source_path, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(slug) DO UPDATE SET
       type=excluded.type,
       title=COALESCE(excluded.title, entities.title),
       source_path=COALESCE(excluded.source_path, entities.source_path),
       updated_at=excluded.updated_at`,
  ).run(slug, type, title ?? null, sourcePath ?? null);
}

export function upsertEdge(db: DatabaseSync, edge: EdgeRow): void {
  db.prepare(
    `INSERT INTO edges (from_slug, to_slug, type, link_source, link_kind, context, confidence, source_path, extracted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(from_slug, to_slug, type, link_source, link_kind) DO UPDATE SET
       context=excluded.context,
       confidence=excluded.confidence,
       source_path=excluded.source_path,
       extracted_at=excluded.extracted_at`,
  ).run(
    edge.from_slug,
    edge.to_slug,
    edge.type,
    edge.link_source,
    edge.link_kind,
    edge.context,
    edge.confidence,
    edge.source_path,
  );
}

export function getWatermark(db: DatabaseSync, path: string): string | null {
  const row = db.prepare('SELECT content_hash FROM extract_watermarks WHERE path = ?').get(path) as
    | { content_hash: string }
    | undefined;
  return row?.content_hash ?? null;
}

export function setWatermark(db: DatabaseSync, path: string, contentHash: string): void {
  db.prepare(
    `INSERT INTO extract_watermarks (path, content_hash, extracted_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(path) DO UPDATE SET
       content_hash=excluded.content_hash,
       extracted_at=excluded.extracted_at`,
  ).run(path, contentHash);
}

export function edgeStats(db: DatabaseSync): {
  entities: number;
  edges: number;
  byType: Record<string, number>;
} {
  const entitiesRow = db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number };
  const edgesRow = db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number };
  const byTypeRows = db.prepare('SELECT type, COUNT(*) AS c FROM edges GROUP BY type').all() as Array<{
    type: string;
    c: number;
  }>;
  const byType: Record<string, number> = {};
  for (const r of byTypeRows) {
    byType[r.type] = r.c;
  }
  return { entities: entitiesRow.c, edges: edgesRow.c, byType };
}

export function countFrontmatterEdges(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM edges WHERE link_source = 'frontmatter'`)
    .get() as { c: number };
  return row.c;
}

export function entityExists(db: DatabaseSync, slug: string): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM entities WHERE slug = ?').get(slug) as
    | { ok: number }
    | undefined;
  return !!row;
}
