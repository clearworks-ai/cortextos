import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findFreshReceipt, DEFAULT_RECEIPT_MAX_AGE_MS } from './verify-receipts.js';

/**
 * Deterministic fail-closed validator for outbound Telegram sends.
 *
 * Same pattern as src/utils/cron-prompt-validator.ts (commit 3291433): a
 * compiled floor of rules that runs at the write choke point — here the
 * `cortextos bus send-telegram` action — so behavioral rules survive context
 * compaction, model drift, and "I'm sure it's fine" moments.
 *
 * Four gates, each throws (never silently strips):
 *   A. claim-gate         — "it's live/fixed/deployed" claims require a fresh
 *                           (<15min) verify-receipt (src/utils/verify-receipts.ts).
 *   B. never-send-task-list — task-list dumps never go to Telegram
 *                           (source: feedback_no_auto_human_task_list_sends,
 *                           the 22-item re-dump incident).
 *   C. url-allowlist      — briefs.clearworks.ai links require a fresh curl-200
 *                           url receipt for that EXACT URL (the 4x bad-link
 *                           incident); telegram.org / t.me and overlay hosts
 *                           pass; every other URL is rejected outright.
 *   D. stop-means-stop    — a per-agent stop.flag blocks every outbound send
 *                           (per-agent, NOT global: one agent being told to
 *                           stop must not silence the rest of the fleet).
 *
 * Overlay: `<ctxRoot>/state/send-telegram-overrides.json` may add
 * { extraClaimPatterns?: string[], allowedUrlHosts?: string[] }. A malformed
 * overlay warns to stderr and the compiled base rules still apply.
 */

/**
 * NARROW claim patterns only. Bare words like 'done' or 'fixed' alone must
 * NOT match — "task done per your request" is a legitimate message, not a
 * verification claim.
 */
export const CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(it'?s|is|are|now)\s+(live|fixed|deployed|shipped|working)\b/i,
  /\bi(?:'ve| have)\s+(fixed|deployed|shipped|verified)\b/i,
  /\b(fix|deploy)\s+is\s+(live|in|done)\b/i,
  /\bdeployed and (live|verified)\b/i,
  /\bconfirmed (live|working|fixed)\b/i,
] as const;

/** A line that looks like a list item: bullet or numbered. */
export const LIST_ITEM_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** ≥ this many list-shaped lines is a task-list dump. */
export const TASK_LIST_LINE_THRESHOLD = 8;

/** ≥ this many '[HUMAN]' tags is a task-list dump. */
export const HUMAN_TAG_THRESHOLD = 3;

/** Hosts that always pass Gate C without a receipt. */
export const BASE_ALLOWED_URL_HOSTS: readonly string[] = ['telegram.org', 't.me'] as const;

/** Host suffix that passes Gate C only with a fresh kind:'url' receipt. */
export const BRIEFS_HOST = 'briefs.clearworks.ai';

const RECEIPT_MAX_AGE_MIN = Math.round(DEFAULT_RECEIPT_MAX_AGE_MS / 60_000);

export interface SendTelegramOverrides {
  extraClaimPatterns: RegExp[];
  allowedUrlHosts: string[];
}

export function overridesPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'send-telegram-overrides.json');
}

function warn(message: string): void {
  process.stderr.write(`[send-telegram-validator] ${message}\n`);
}

/**
 * Load the overlay file, merged like cron-prompt-validator's
 * loadOverlayPatterns: a malformed overlay never blocks — warn to stderr and
 * continue with the compiled base rules.
 */
export function loadOverrides(ctxRoot: string): SendTelegramOverrides {
  const empty: SendTelegramOverrides = { extraClaimPatterns: [], allowedUrlHosts: [] };
  const path = overridesPath(ctxRoot);
  if (!existsSync(path)) return empty;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    warn(`malformed overlay at ${path} (invalid JSON) — continuing with base rules.`);
    return empty;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`malformed overlay at ${path} (expected a JSON object) — continuing with base rules.`);
    return empty;
  }

  const overlay = raw as Record<string, unknown>;
  const result: SendTelegramOverrides = { extraClaimPatterns: [], allowedUrlHosts: [] };

  const patterns = overlay.extraClaimPatterns;
  if (patterns !== undefined) {
    if (!Array.isArray(patterns)) {
      warn(`overlay extraClaimPatterns is not an array — ignoring it.`);
    } else {
      for (const entry of patterns) {
        if (typeof entry !== 'string') {
          warn(`overlay extraClaimPatterns entry is not a string — skipping it.`);
          continue;
        }
        try {
          result.extraClaimPatterns.push(new RegExp(entry, 'i'));
        } catch {
          warn(`overlay extraClaimPatterns entry ${JSON.stringify(entry)} is not a valid regex — skipping it.`);
        }
      }
    }
  }

  const hosts = overlay.allowedUrlHosts;
  if (hosts !== undefined) {
    if (!Array.isArray(hosts)) {
      warn(`overlay allowedUrlHosts is not an array — ignoring it.`);
    } else {
      for (const entry of hosts) {
        if (typeof entry === 'string' && entry.trim()) {
          result.allowedUrlHosts.push(entry.trim().toLowerCase());
        } else {
          warn(`overlay allowedUrlHosts entry is not a non-empty string — skipping it.`);
        }
      }
    }
  }

  return result;
}

/** Extract all http(s) URLs from a message, trailing punctuation stripped. */
export function extractUrls(message: string): string[] {
  const matches = message.match(/https?:\/\/[^\s<>"'()\]]+/gi) ?? [];
  return matches
    .map((u) => u.replace(/[.,;:!?]+$/, ''))
    .filter((u) => u.length > 'https://'.length);
}

function hostMatches(host: string, allowed: string): boolean {
  return host === allowed || host.endsWith('.' + allowed);
}

/**
 * Validate an outbound Telegram message. Throws with the exact rule violated
 * and the exact remediation. Fail-closed: this function never rewrites or
 * strips the message — a violation always blocks the whole send.
 */
export function validateOutboundTelegram(
  ctxRoot: string,
  agentName: string,
  message: string
): void {
  const overrides = loadOverrides(ctxRoot);

  // ── Gate D: stop-means-stop (checked first — blocks EVERY send) ──────────
  // Per-agent flag, not global: state/<agent>/stop.flag silences only that
  // agent; the rest of the fleet keeps its channels.
  const stopFlag = join(ctxRoot, 'state', agentName, 'stop.flag');
  if (existsSync(stopFlag)) {
    throw new Error(
      `Outbound Telegram send BLOCKED — rule violated: stop-means-stop (Gate D). ` +
        `A stop flag exists at ${stopFlag} for agent "${agentName}". ` +
        `Remediation: Josh set a stop flag; do not message until he initiates. ` +
        `Only after Josh initiates contact again may the flag be removed.`
    );
  }

  // ── Gate A: claim-gate ────────────────────────────────────────────────────
  const claimPatterns = [...CLAIM_PATTERNS, ...overrides.extraClaimPatterns];
  for (const re of claimPatterns) {
    re.lastIndex = 0;
    if (!re.test(message)) continue;

    const receipt = findFreshReceipt(ctxRoot, agentName, {
      maxAgeMs: DEFAULT_RECEIPT_MAX_AGE_MS,
    });
    if (receipt) break; // Fresh proof exists — the claim is grounded.

    throw new Error(
      `Outbound Telegram send BLOCKED — rule violated: claim-gate (Gate A). ` +
        `The message asserts a completion/verification claim (matched pattern: /${re.source}/) ` +
        `but agent "${agentName}" has no fresh (<${RECEIPT_MAX_AGE_MIN}min) verify-receipt. ` +
        `Remediation: run the verification, then: ` +
        `cortextos bus verify-receipt --kind url --target <url> --command "curl -s -o /dev/null -w %{http_code} <url>" ` +
        `(use --kind deploy|log|generic with the command that proves the claim), then resend.`
    );
  }

  // ── Gate B: never-send-task-list ─────────────────────────────────────────
  const listLines = message.split('\n').filter((line) => LIST_ITEM_RE.test(line)).length;
  const humanTags = (message.match(/\[HUMAN\]/g) ?? []).length;
  if (listLines >= TASK_LIST_LINE_THRESHOLD || humanTags >= HUMAN_TAG_THRESHOLD) {
    const detail =
      listLines >= TASK_LIST_LINE_THRESHOLD
        ? `${listLines} list-item lines (limit ${TASK_LIST_LINE_THRESHOLD - 1})`
        : `${humanTags} '[HUMAN]' tags (limit ${HUMAN_TAG_THRESHOLD - 1})`;
    throw new Error(
      `Outbound Telegram send BLOCKED — rule violated: never-send-task-list (Gate B). ` +
        `The message looks like a task-list dump: ${detail}. ` +
        `Task lists are never auto-sent to Josh (source: feedback_no_auto_human_task_list_sends, ` +
        `the 22-item re-dump incident). ` +
        `Remediation: send a 1-2 line summary with a link to the dashboard instead; ` +
        `only send the full list when Josh explicitly asks for it in this conversation.`
    );
  }

  // ── Gate C: URL allowlist ─────────────────────────────────────────────────
  for (const url of extractUrls(message)) {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error(
        `Outbound Telegram send BLOCKED — rule violated: url-allowlist (Gate C). ` +
          `"${url}" is not a parseable URL. ` +
          `Remediation: remove or correct the URL, then resend.`
      );
    }

    // Briefs links pass ONLY with a fresh curl-200 receipt for the exact URL.
    if (host.endsWith(BRIEFS_HOST)) {
      const receipt = findFreshReceipt(ctxRoot, agentName, {
        kind: 'url',
        target: url,
        maxAgeMs: DEFAULT_RECEIPT_MAX_AGE_MS,
      });
      if (!receipt) {
        throw new Error(
          `Outbound Telegram send BLOCKED — rule violated: url-allowlist (Gate C). ` +
            `"${url}" is a briefs link with no fresh (<${RECEIPT_MAX_AGE_MIN}min) kind:url ` +
            `verify-receipt for that exact URL (curl-200 proof — the 4x bad-link incident). ` +
            `Remediation: run the verification, then: ` +
            `cortextos bus verify-receipt --kind url --target ${url} --command "curl -s -o /dev/null -w %{http_code} ${url}", ` +
            `then resend.`
        );
      }
      continue;
    }

    const allowedHosts = [...BASE_ALLOWED_URL_HOSTS, ...overrides.allowedUrlHosts];
    if (allowedHosts.some((allowed) => hostMatches(host, allowed))) {
      continue;
    }

    throw new Error(
      `Outbound Telegram send BLOCKED — rule violated: url-allowlist (Gate C). ` +
        `URL "${url}" (host "${host}") is not on the outbound allowlist ` +
        `(allowed: ${BRIEFS_HOST} with a fresh url receipt, ${BASE_ALLOWED_URL_HOSTS.join(', ')}, ` +
        `plus allowedUrlHosts in state/send-telegram-overrides.json). ` +
        `Remediation: remove the URL, or if it is legitimate add "${host}" to allowedUrlHosts ` +
        `in state/send-telegram-overrides.json, then resend.`
    );
  }
}
