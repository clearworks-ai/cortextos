// gbrain WORKS_AT_RE — cues: "CEO of", "VP at", "engineer at", "joined the team"
export const WORKS_AT_RE =
  /\b(?:ceo|cto|cfo|coo|vp|vice president|president|director|head|engineer|manager|lead)\s+(?:of|at)\b|\bworks?\s+(?:at|for)\b|\bjoined(?:\s+the\s+team)?(?:\s+at)?\b|\bemployed\s+(?:at|by)\b/i;

// gbrain INVESTED_RE — cues: "led the seed", "early investor", "portfolio company"
export const INVESTED_RE =
  /\bled\s+the\s+(?:seed|series\s+[a-e]|round)\b|\b(?:early|angel|seed)\s+investor\b|\bportfolio\s+compan(?:y|ies)\b|\binvest(?:ed|s|ing|ment)\s+in\b/i;

// gbrain FOUNDED_RE — cues: "founded", "co-founded", "founder of"
export const FOUNDED_RE = /\bco-?found(?:ed|er)\b|\bfound(?:ed|er)(?:\s+(?:of|at))?\b/i;

// gbrain ADVISES_RE — cues: "advisor to", "advisory board", "consulting role"
export const ADVISES_RE =
  /\badvis(?:or|er|es|ing)\b(?:\s+(?:to|of|at))?|\badvisory\s+board\b|\bconsult(?:ing|ant)\s+(?:role|to|for)\b/i;

// gbrain PARTNER_ROLE_RE — page-level role prior: "venture partner", "investor in"
export const PARTNER_ROLE_RE =
  /\b(?:venture|general|managing|operating)\s+partner\b|\bpartner\s+at\b|\binvestor\s+in\b/i;

export const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
export const MDLINK_RE = /\[([^\]]+)\]\(([^)\s:]+\.md)\)/g;
export const BARE_SLUG_RE =
  /\b((?:people|companies|projects|agents|tools|processes|growth|intelligence)\/[a-z0-9][a-z0-9_-]*)\b/g;

export type LinkType = 'founded' | 'invested_in' | 'advises' | 'works_at' | 'mentions';

export interface Mention {
  rawTarget: string;
  matchIndex: number;
  context: string;
  source: 'mentions' | 'wikilink-resolved';
}

export interface InferredLink {
  type: LinkType;
  confidence: 1.0 | 0.8 | 0.5;
  matchedFamily: string | null;
}

export function contextWindow(body: string, index: number, span = 240): string {
  const half = Math.floor(span / 2);
  let start = Math.max(0, index - half);
  let end = Math.min(body.length, index + half);
  // Prefer full span when near edges
  if (end - start < span) {
    if (start === 0) end = Math.min(body.length, start + span);
    else if (end === body.length) start = Math.max(0, end - span);
  }
  return body.slice(start, end);
}

function collectMatches(
  body: string,
  re: RegExp,
  pick: (m: RegExpExecArray) => { raw: string; index: number; source: Mention['source'] } | null,
): Mention[] {
  const out: Mention[] = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(body)) !== null) {
    const picked = pick(m);
    if (!picked) continue;
    out.push({
      rawTarget: picked.raw,
      matchIndex: picked.index,
      context: contextWindow(body, picked.index),
      source: picked.source,
    });
  }
  return out;
}

export function extractMentions(body: string): Mention[] {
  const mentions: Mention[] = [];
  const seen = new Set<string>();

  const add = (m: Mention) => {
    const key = `${m.source}|${m.matchIndex}|${m.rawTarget}`;
    if (seen.has(key)) return;
    seen.add(key);
    mentions.push(m);
  };

  for (const m of collectMatches(body, WIKILINK_RE, (match) => ({
    raw: match[1].trim(),
    index: match.index,
    source: 'wikilink-resolved',
  }))) {
    add(m);
  }

  for (const m of collectMatches(body, MDLINK_RE, (match) => {
    const href = match[2];
    // Reject URLs (":" already excluded by regex); also skip pure http via re
    if (href.includes('://')) return null;
    return {
      raw: href.replace(/\.md$/i, ''),
      index: match.index,
      source: 'wikilink-resolved',
    };
  })) {
    add(m);
  }

  for (const m of collectMatches(body, BARE_SLUG_RE, (match) => ({
    raw: match[1],
    index: match.index,
    source: 'mentions',
  }))) {
    add(m);
  }

  mentions.sort((a, b) => a.matchIndex - b.matchIndex);
  return mentions;
}

/**
 * gbrain inferLinkType cascading precedence:
 *   founded > invested_in > advises > works_at > role-prior > mentions
 * Confidence: 1.0 regex family, 0.8 page-role prior, 0.5 fallback mention.
 * Role-prior maps to 'invested_in' when prior matched "investor in", else 'works_at'.
 */
export function inferLinkType(context: string, pageRoleHit: RegExpMatchArray | null): InferredLink {
  if (FOUNDED_RE.test(context)) {
    return { type: 'founded', confidence: 1.0, matchedFamily: 'founded' };
  }
  if (INVESTED_RE.test(context)) {
    return { type: 'invested_in', confidence: 1.0, matchedFamily: 'invested_in' };
  }
  if (ADVISES_RE.test(context)) {
    return { type: 'advises', confidence: 1.0, matchedFamily: 'advises' };
  }
  if (WORKS_AT_RE.test(context)) {
    return { type: 'works_at', confidence: 1.0, matchedFamily: 'works_at' };
  }
  if (pageRoleHit) {
    const hitText = pageRoleHit[0].toLowerCase();
    if (/\binvestor\s+in\b/.test(hitText)) {
      return { type: 'invested_in', confidence: 0.8, matchedFamily: 'partner_role' };
    }
    return { type: 'works_at', confidence: 0.8, matchedFamily: 'partner_role' };
  }
  return { type: 'mentions', confidence: 0.5, matchedFamily: null };
}
