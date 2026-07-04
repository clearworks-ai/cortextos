/**
 * Claim classifier for WS2 — the outbound-comms escalation gate.
 *
 * Sits on top of the existing claim detector (claim-detector.ts) and adds a
 * second dimension: *which kind* of claim it is, so high-stakes completion
 * assertions can be routed to a stricter escalation rung while generic claims
 * continue to produce the shipped warn-only behaviour.
 *
 * Design rules:
 *  - Never edit claim-detector.ts. Import it; don't fork it.
 *  - Unknown phrasings ALWAYS degrade to `generic` / `warn` — never over-block.
 *  - Pure module: no I/O, no side effects, no process.env reads.
 *  - Ordered: high-stakes classes are tested first so the first match wins.
 */

import { detectsCompletionClaim } from './claim-detector.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The class of a completion claim, from most- to least-restrictive. */
export type ClaimClass = 'external-send' | 'deploy' | 'merge' | 'generic';

/** The escalation rung that corresponds to a claim class. */
export type ClaimRung = 'block' | 'require-confirm' | 'warn';

export interface ClaimClassification {
  cls: ClaimClass;
  rung: ClaimRung;
}

// ---------------------------------------------------------------------------
// High-stakes pattern lists (small, explicit, English-specific)
// ---------------------------------------------------------------------------

/**
 * "external-send" class — claims that a message/invoice was sent to an external
 * party. These are the highest-cost false claims: → BLOCK rung.
 */
const EXTERNAL_SEND_PATTERNS: readonly RegExp[] = [
  /\bsent\s+to\s+(the\s+)?client\b/i,
  /\bemailed?\s+(the\s+)?client\b/i,
  /\binvoice\s+sent\b/i,
  /\bsent\s+(the\s+)?invoice\b/i,
  /\bsent\s+to\s+[A-Z][a-zA-Z]+\b/,   // "sent to Marcus" — proper-name heuristic
  /\boutreach\s+sent\b/i,
  /\bproposal\s+sent\b/i,
  /\bcontract\s+sent\b/i,
];

/**
 * "deploy" class — claims that code is live in a production-like environment.
 * → REQUIRE-CONFIRM rung.
 */
const DEPLOY_PATTERNS: readonly RegExp[] = [
  /\bdeployed\s+to\s+prod(uction)?\b/i,
  /\bpushed\s+to\s+prod(uction)?\b/i,
  /\bnow\s+live\s+in\s+prod(uction)?\b/i,
  /\bis\s+live\s+in\s+prod(uction)?\b/i,
  /\bdeployed\s+to\s+(railway|staging|heroku|vercel|fly)\b/i,
  /\bdeployed\b/i,        // broad: catches "deployed and tested" etc.
  /\bpushed\s+to\s+prod\b/i,
];

/**
 * "merge" class — claims that a branch was merged to main/prod.
 * → REQUIRE-CONFIRM rung.
 */
const MERGE_PATTERNS: readonly RegExp[] = [
  /\bmerged\s+to\s+main\b/i,
  /\bmerged\s+(in)?to\s+prod(uction)?\b/i,
  /\bmerged\s+the\s+PR\b/i,
  /\bPR\s+(was\s+)?merged\b/i,
  /\bmerged\s+and\s+deployed\b/i,
];

// ---------------------------------------------------------------------------
// Receipt-kind maps
// ---------------------------------------------------------------------------

/**
 * Returns the receipt `kind` values that satisfy a claim class. A receipt
 * whose `.kind` is in this set counts as evidence for that class.
 */
export function requiredReceiptKinds(cls: ClaimClass): readonly string[] {
  switch (cls) {
    case 'external-send':
      return ['external-send', 'send', 'email', 'manual'] as const;
    case 'deploy':
      return ['deploy', 'curl', 'build', 'manual'] as const;
    case 'merge':
      return ['merge', 'pr', 'build', 'manual'] as const;
    case 'generic':
      return [] as const; // generic never needs a specific receipt kind
  }
}

// ---------------------------------------------------------------------------
// Negation veto: tentative phrasing exempts even high-stakes patterns
// ---------------------------------------------------------------------------

/**
 * High-stakes-specific tentative guards. These check for phrasing that would
 * make a high-stakes match a non-claim ("about to deploy", "should I merge?").
 * The generic detector's NEGATION_PATTERNS already handle most cases; this
 * supplements with high-stakes-specific regexes.
 */
const HIGH_STAKES_NEGATION: readonly RegExp[] = [
  /\babout\s+to\s+(deploy|merge|send|push)\b/i,
  /\bgoing\s+to\s+(deploy|merge|send|push)\b/i,
  /\bplan(ning)?\s+to\s+(deploy|merge|send|push)\b/i,
  /\bshould\s+i\s+(deploy|merge|send|push)\b/i,
  /\bready\s+to\s+(deploy|merge|send|push)\b/i,
  /\bwant(s)?\s+to\s+(deploy|merge|send|push)\b/i,
  /\bnot\s+(yet\s+)?(deployed|merged|sent)\b/i,
  /\bhaven'?t\s+(deployed|merged|sent)\b/i,
  /\btrying\s+to\s+(deploy|merge|send)\b/i,
  /\bneed(s)?\s+to\s+(deploy|merge|send)\b/i,
];

function isHighStakesNegated(text: string): boolean {
  for (const pat of HIGH_STAKES_NEGATION) {
    if (pat.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/**
 * Classify the claim in `text`, returning the most-restrictive matching class
 * and its corresponding escalation rung — or `null` if no claim is detected.
 *
 * Precedence (first match wins):
 *   1. `external-send` → `block`  (checked independently of low-bar detector;
 *      these phrases are inherently completion claims)
 *   2. `merge`         → `require-confirm`
 *   3. `deploy`        → `require-confirm`
 *   4. generic (existing detector fires) → `warn`
 *
 * External-send patterns are checked BEFORE the generic detector because
 * phrases like "invoice sent" / "emailed the client" / "proposal sent" are
 * unambiguous completion claims, even though they don't match the detector's
 * word list (which focuses on work-completion vocabulary, not dispatch verbs).
 *
 * Tentative / interrogative phrasing suppresses high-stakes classes.
 *
 * Pure — no I/O, no throws.
 */
export function classifyClaim(text: string): ClaimClassification | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Suppress all classification for tentative phrasing early.
  if (isHighStakesNegated(trimmed)) {
    // Still run the low-bar detector: if it fires, fall through to generic.
    // If it doesn't fire, there's no claim at all.
    if (!detectsCompletionClaim(trimmed)) return null;
    return { cls: 'generic', rung: 'warn' };
  }

  // external-send patterns are checked FIRST and independently of the
  // low-bar detector, because dispatch-verb phrases ("sent to client",
  // "invoice sent") do not appear in CLAIM_PATTERNS but are still
  // completion claims with high stakes.
  for (const pat of EXTERNAL_SEND_PATTERNS) {
    if (pat.test(trimmed)) {
      return { cls: 'external-send', rung: 'block' };
    }
  }

  // For merge and deploy, the low-bar detector is the floor: if it fires,
  // upgrade to the appropriate high-stakes class. This avoids catching
  // "pushing the boundaries" or "merging departments" as code claims.
  const genericDetectorFired = detectsCompletionClaim(trimmed);

  // merge (require-confirm)
  for (const pat of MERGE_PATTERNS) {
    if (pat.test(trimmed)) {
      return { cls: 'merge', rung: 'require-confirm' };
    }
  }

  // deploy (require-confirm)
  for (const pat of DEPLOY_PATTERNS) {
    if (pat.test(trimmed)) {
      return { cls: 'deploy', rung: 'require-confirm' };
    }
  }

  // Generic: the low-bar detector fired but no high-stakes class matched.
  if (genericDetectorFired) {
    return { cls: 'generic', rung: 'warn' };
  }

  // No claim detected.
  return null;
}
