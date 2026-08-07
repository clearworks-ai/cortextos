/**
 * Owner-facing Telegram policy checks. These checks deliberately target only
 * routine reassurance/disclaimer language, never an approval request or an
 * incident report.
 */
export function classifyRoutineAuthorizationDisclaimer(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;

  // A real approval request must remain deliverable.
  if (/\?|\b(?:please\s+)?(?:approve|authorize)\b|\bneed (?:your|Josh'?s) (?:approval|authorization)\b/i.test(normalized)) {
    return undefined;
  }

  // Incidents must surface even if they mention a controlled operation.
  if (/\b(?:incident|outage|degraded|failure|failed|error|security|breach|rollback)\b/i.test(normalized)) {
    return undefined;
  }

  // A concrete runtime-configuration defect is actionable operational evidence,
  // even if it mentions a restart that has not happened yet.
  if (/\b(?:live\s+)?(?:codex\s+)?(?:app-server\s+)?(?:argv|runtime|model)\b[^.!?]{0,100}\b(?:omit(?:s|ted)?|missing|mismatch|invalid|unsupported)\b/i.test(normalized)) {
    return undefined;
  }

  const refusal = /\b(?:I|we)\s+(?:will\s+not|won't|cannot|can't|am\s+not|are\s+not|have\s+not|do\s+not|don't)\b/i;
  const controlledOperation = /\b(?:merge(?:d|ing)?|deploy(?:ed|ing)?|push(?:ed|ing)?(?:\s+to)?\s+main|restart(?:ed|ing)?(?:\s+the\s+(?:daemon|runtime))?|run(?:ning)?\s+(?:a\s+)?canary|bypass(?:ed|ing)?(?:\s+\w+)?|delete(?:d|ing)?(?:\s+data)?|ship(?:ped|ping)?)\b/i;
  if (refusal.test(normalized) && controlledOperation.test(normalized)) {
    return 'routine authorization-disclaimer text is blocked; send the outcome, a concrete incident, or a specific approval question instead';
  }
  return undefined;
}
