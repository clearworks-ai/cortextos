/**
 * Slug resolution — exact → prefix → fuzzy (trigram) → slugify.
 * Pure FS/string logic; no SQLite. gbrain hybrid-search fallback is NOT ported.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface SlugIndexEntry {
  slug: string;
  dir: string;
  base: string;
  title: string | null;
}

export interface ResolveResult {
  slug: string;
  method: 'exact' | 'prefix' | 'fuzzy' | 'slugify';
  score?: number;
}

export interface SlugResolver {
  resolve(name: string, typeHint?: string): ResolveResult | null;
}

export const FUZZY_THRESHOLD = 0.3;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Jaccard over padded 3-grams (pg_trgm-style left pad with two spaces). */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const padded = `  ${s}`;
    const set = new Set<string>();
    if (padded.length < 3) {
      if (padded.length > 0) set.add(padded.padEnd(3, ' '));
      return set;
    }
    for (let i = 0; i <= padded.length - 3; i++) {
      set.add(padded.slice(i, i + 3));
    }
    return set;
  };
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const g of A) {
    if (B.has(g)) inter++;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function extractTitle(content: string): string | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const titleLine = fm[1].match(/^title:\s*(.+)$/m);
    if (titleLine) {
      return titleLine[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  const h1 = content.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : null;
}

export function buildSlugIndex(wikiRoot: string): SlugIndexEntry[] {
  const entries: SlugIndexEntry[] = [];
  if (!existsSync(wikiRoot)) return entries;
  let top: string[];
  try {
    top = readdirSync(wikiRoot);
  } catch {
    return entries;
  }
  for (const dir of top) {
    const dirPath = join(wikiRoot, dir);
    let st;
    try {
      st = statSync(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (dir.startsWith('.')) continue;
    let files: string[];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.md') || f.startsWith('.')) continue;
      const base = f.slice(0, -3);
      const full = join(dirPath, f);
      let title: string | null = null;
      try {
        title = extractTitle(readFileSync(full, 'utf-8'));
      } catch {
        /* ignore */
      }
      entries.push({ slug: `${dir}/${base}`, dir, base, title });
    }
  }
  return entries;
}

export function createSlugResolver(wikiRoot: string): SlugResolver {
  const index = buildSlugIndex(wikiRoot);
  const cache = new Map<string, ResolveResult | null>();

  /** Resolve against a candidate set. Returns null when no indexed hit (caller may fall back / slugify). */
  function resolveAgainst(name: string, candidates: SlugIndexEntry[]): ResolveResult | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    const slugified = slugify(trimmed);

    for (const e of candidates) {
      if (e.slug.toLowerCase() === lower) return { slug: e.slug, method: 'exact' };
      if (e.base.toLowerCase() === lower) return { slug: e.slug, method: 'exact' };
      if (e.base === slugified) return { slug: e.slug, method: 'exact' };
      if (e.title && slugify(e.title) === slugified) return { slug: e.slug, method: 'exact' };
    }

    if (slugified) {
      const truePrefixes = candidates.filter((e) => e.base.startsWith(slugified + '-'));
      if (truePrefixes.length === 1) {
        return { slug: truePrefixes[0].slug, method: 'prefix' };
      }
    }

    let best: { entry: SlugIndexEntry; score: number } | null = null;
    for (const e of candidates) {
      const score = trigramSimilarity(slugified, e.base);
      if (score < FUZZY_THRESHOLD) continue;
      if (
        !best ||
        score > best.score ||
        (score === best.score && e.slug.localeCompare(best.entry.slug) < 0)
      ) {
        best = { entry: e, score };
      }
    }
    if (best) {
      return { slug: best.entry.slug, method: 'fuzzy', score: best.score };
    }
    return null;
  }

  function resolveOnce(name: string, typeHint?: string): ResolveResult | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const slugified = slugify(trimmed);

    if (typeHint) {
      const filtered = index.filter((e) => e.dir === typeHint);
      if (filtered.length > 0) {
        const scopedHit = resolveAgainst(name, filtered);
        if (scopedHit) return scopedHit;
      }
      // Filtered pass found nothing — fall back to global before slugify
      const globalHit = resolveAgainst(name, index);
      if (globalHit) return globalHit;
      return { slug: `${typeHint}/${slugified}`, method: 'slugify' };
    }

    const hit = resolveAgainst(name, index);
    if (hit) return hit;
    return { slug: slugified, method: 'slugify' };
  }

  return {
    resolve(name: string, typeHint?: string): ResolveResult | null {
      const key = `${typeHint ?? ''}::${name.toLowerCase().trim()}`;
      if (cache.has(key)) return cache.get(key) ?? null;
      const result = resolveOnce(name, typeHint);
      cache.set(key, result);
      return result;
    },
  };
}
