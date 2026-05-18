/**
 * Vault helpers for the dashboard /wiki page.
 *
 * Resolves the org's Obsidian vault path, parses frontmatter, scopes file
 * reads to PARA-tree paths only (read-only — no writes from the dashboard).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CTX_FRAMEWORK_ROOT } from './config';

export const PARA_DIRS = [
  '00-inbox',
  '01-projects',
  '02-areas',
  '03-resources',
  '04-archive',
  '05-daily',
  '06-maps',
] as const;

export type ParaDir = (typeof PARA_DIRS)[number];

const VAULT_FALLBACK = process.env.CTX_VAULT_PATH
  ?? path.join(os.homedir(), 'storage', 'Documents', 'Github', 'sondres-orchestrator', 'vault');

const TOP_LEVEL_SKIP = new Set(['node_modules', 'graphify-out', 'cc']);

function getKnowledgePath(org: string): string {
  return path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'knowledge.md');
}

function readKnowledgeFile(org: string): string | null {
  const knowledgePath = getKnowledgePath(org);
  if (!fs.existsSync(knowledgePath)) return null;
  try {
    return fs.readFileSync(knowledgePath, 'utf-8');
  } catch {
    return null;
  }
}

function parseConfiguredRoot(
  content: string | null,
  pattern: RegExp,
): string | null {
  if (!content) return null;
  const match = content.match(pattern);
  if (!match) return null;
  const candidate = match[1].replace(/\/$/, '');
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return null;
  return candidate;
}

function resolveContainedPath(root: string, relPath: string): string | null {
  if (path.isAbsolute(relPath)) return null;
  const cleaned = relPath.replace(/^\/+/, '');
  if (cleaned.includes('..')) return null;
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, cleaned);
  if (!abs.startsWith(resolvedRoot + path.sep)) return null;
  return abs;
}

export function getVaultRoot(org: string): string | null {
  // 1. Try parsing orgs/<org>/knowledge.md for an "Obsidian vault" path entry
  const configured = parseConfiguredRoot(
    readKnowledgeFile(org),
    /^Obsidian vault[^\n]*?`([^`]+)`/im,
  );
  if (configured) return configured;

  // 2. Fallback to the known sondre-hq vault location
  if (fs.existsSync(VAULT_FALLBACK) && fs.statSync(VAULT_FALLBACK).isDirectory()) {
    return VAULT_FALLBACK;
  }

  return null;
}

export function getVaultTopLevelAllowList(org: string): string[] | null {
  const content = readKnowledgeFile(org);
  if (!content) return null;
  const match = content.match(/^Vault top-level:\s*(.+)$/im);
  if (!match) return null;
  const items = match[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export function getRawVaultRoot(org: string): string | null {
  return parseConfiguredRoot(
    readKnowledgeFile(org),
    /^Raw vault[^\n]*?`([^`]+)`/im,
  );
}

export function getOutputsVaultRoot(org: string): string | null {
  return parseConfiguredRoot(
    readKnowledgeFile(org),
    /^Outputs vault[^\n]*?`([^`]+)`/im,
  );
}

export type Frontmatter = {
  type?: string;
  tags?: string[];
  created?: string;
  updated?: string;
  status?: string;
  agent?: string;
  session?: string;
  relates_to?: string[];
  [key: string]: unknown;
};

export function parseFrontmatter(raw: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };

  const fm: Frontmatter = {};
  const block = m[1];

  for (const line of block.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value: unknown = kv[2].trim();
    const v = value as string;

    if (v === '') {
      value = '';
    } else if (v.startsWith('[') && v.endsWith(']')) {
      // Array — comma split inside the brackets, strip quotes
      value = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      // Strip surrounding quotes if present
      value = v.replace(/^["']|["']$/g, '');
    }

    fm[key] = value;
  }

  return { frontmatter: fm, body: m[2] };
}

export function firstMeaningfulLine(body: string, max = 160): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue; // skip headings
    if (line.startsWith('```')) continue;
    if (line === '---') continue;
    return line.length > max ? line.slice(0, max).trimEnd() + '…' : line;
  }
  return '';
}

/**
 * Resolves a relative vault path safely. Refuses anything outside the vault
 * root.
 */
export function resolveVaultPath(
  vaultRoot: string,
  relPath: string,
): string | null {
  return resolveContainedPath(vaultRoot, relPath);
}

export function resolveRawVaultPath(
  rawRoot: string,
  relPath: string,
): string | null {
  return resolveContainedPath(rawRoot, relPath);
}

export function resolveOutputsVaultPath(
  outputsRoot: string,
  relPath: string,
): string | null {
  return resolveContainedPath(outputsRoot, relPath);
}

/**
 * Walk the org's configured top-level dirs and collect every .md file. Used by search.
 */
export function listAllNotes(vaultRoot: string, org?: string): Array<{
  relPath: string;
  absPath: string;
  mtimeMs: number;
}> {
  const out: Array<{ relPath: string; absPath: string; mtimeMs: number }> = [];
  const allowList = org ? getVaultTopLevelAllowList(org) : null;
  const entries = fs.readdirSync(vaultRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (TOP_LEVEL_SKIP.has(entry.name)) continue;
    if (allowList && !allowList.includes(entry.name)) continue;
    const abs = path.join(vaultRoot, entry.name);
    walk(abs, vaultRoot, out);
  }
  return out;
}

function walk(
  abs: string,
  vaultRoot: string,
  out: Array<{ relPath: string; absPath: string; mtimeMs: number }>,
) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      walk(child, vaultRoot, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(child);
      out.push({
        relPath: path.relative(vaultRoot, child),
        absPath: child,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
}

/**
 * Resolve a wikilink slug (e.g. "20260506-dev-foo" or "foo/bar") to a vault
 * file path. Searches all PARA dirs for the first matching basename (with or
 * without .md extension).
 */
export function resolveWikilink(
  vaultRoot: string,
  slug: string,
): string | null {
  const normalized = slug.replace(/\.md$/, '');
  for (const note of listAllNotes(vaultRoot)) {
    const base = path.basename(note.relPath, '.md');
    if (base === normalized) return note.relPath;
  }
  // Also try exact relative path match (e.g. "01-projects/coliseum")
  for (const note of listAllNotes(vaultRoot)) {
    if (note.relPath.replace(/\.md$/, '') === normalized) return note.relPath;
  }
  return null;
}
