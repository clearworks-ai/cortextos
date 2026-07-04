/**
 * Completion-claim detector for the outbound-comms certainty guard.
 *
 * Josh's governing goal: "never state a claim without a live check." The
 * recurring failure mode is agents telling Josh something is "done / live /
 * shipped / fixed / deployed / merged" without a verification receipt. This
 * pure detector answers a single question: does this outbound text assert
 * that a piece of work is COMPLETE?
 *
 * It is deliberately CONSERVATIVE. A false positive only produces a WARN-ONLY
 * log event (never blocks a send), but noisy warnings erode signal, so the
 * detector is tuned to fire on confident completion language and to stay quiet
 * on tentative / in-progress / interrogative phrasing.
 */

/**
 * Completion-claim phrases. Matched case-insensitively as whole words/phrases
 * so "done" fires but "abandoned" / "redone" do not, and "fixed" fires but
 * "prefixed" does not. Multi-word phrases ("it works", "up and running") are
 * matched with flexible internal whitespace.
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bdone\b/i,
  /\ball\s+done\b/i,
  /\bshipped?\b/i,
  /\bit'?s\s+live\b/i,
  /\bnow\s+live\b/i,
  /\bgone\s+live\b/i,
  /\bis\s+live\b/i,
  /\bare\s+live\b/i,
  /\bdeployed\b/i,
  /\bfixed\b/i,
  /\bmerged\b/i,
  /\bcompleted?\b/i,
  /\bit\s+works\b/i,
  /\bworks\s+now\b/i,
  /\bworking\s+now\b/i,
  /\bverified\b/i,
  /\bconfirmed\s+working\b/i,
  /\bup\s+and\s+running\b/i,
  /\bpushed\s+(the|to|and)\b/i,
  /\bresolved\b/i,
  /\btests?\s+pass(ing|ed|es)?\b/i,
  /\bbuild\s+pass(ing|ed|es)?\b/i,
  /\ball\s+set\b/i,
  /\bgood\s+to\s+go\b/i,
  /\btaken\s+care\s+of\b/i,
] as const;

/**
 * Tentative / non-claim guards. When the ENTIRE relevant clause is clearly
 * forward-looking or interrogative, we suppress. These are checked as a
 * lightweight veto against obvious non-claims that might otherwise brush a
 * claim word (e.g. "trying to get it working", "should I deploy?", "working
 * on the fix"). Kept small and specific so we do not over-suppress real
 * claims.
 */
const NEGATION_PATTERNS: readonly RegExp[] = [
  /\bworking\s+on\b/i,
  /\btrying\s+to\b/i,
  /\bgoing\s+to\b/i,
  /\babout\s+to\b/i,
  /\bplan\s+to\b/i,
  /\bwill\s+(be\s+)?(deploy|ship|fix|merge|verif|complet)/i,
  /\bnot\s+(yet\s+)?(done|deployed|fixed|merged|live|verified|shipped|working)\b/i,
  /\bstill\s+(working|trying|need|broken|failing)\b/i,
  /\bhaven'?t\b/i,
  /\bcan'?t\b/i,
  /\bshould\s+i\b/i,
  /\bdo\s+you\b/i,
  /\bcan\s+you\b/i,
  /\bwould\s+you\b/i,
  /\bneed(s)?\s+to\s+(be\s+)?(done|deployed|fixed|merged|verified)\b/i,
];

/**
 * Returns true when `text` makes a completion claim without an obvious
 * tentative/interrogative veto. Pure — no I/O, no side effects.
 *
 * Precedence: if any NEGATION pattern matches the message, we treat the whole
 * message as a non-claim. This is a conservative bias — it means a message
 * that both promises future work AND claims a completed sub-task might be
 * suppressed, but the cost of a missed warning is lower than the cost of
 * warning on "I'm working on the deploy."
 */
export function detectsCompletionClaim(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // A trailing '?' with no period-terminated statement before it is very
  // likely a question — suppress. (e.g. "is it deployed?")
  if (/\?\s*$/.test(trimmed) && !/[.!]/.test(trimmed)) return false;

  for (const neg of NEGATION_PATTERNS) {
    if (neg.test(trimmed)) return false;
  }

  for (const pat of CLAIM_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }

  return false;
}
