import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';

/**
 * WS3 — Handoff-tail fidelity.
 *
 * The DAEMON (not the agent) appends the last-N live-buffer output and
 * open-loop markers to every handoff doc at restart, so instructions given
 * AFTER the 80%-context handoff write can never vanish (the Jun 28
 * "lost it at 3:11" / 4x-repeated-form-blocker class of memory leak).
 *
 * Everything here is IO-safe by contract: these functions never throw. A
 * failure to append degrades to `return false` (+ optional log line) so the
 * daemon's stop() sequence can never be blocked or failed by handoff-tail
 * bookkeeping. Idempotent-safe: repeated calls only ever append a complete,
 * well-formed section — they never truncate, corrupt, or partially write the
 * doc (fs.appendFileSync is a single atomic-enough append of a fully built
 * string).
 */

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Cap the buffer tail at ~16KB — the END of the buffer is what matters. */
const MAX_TAIL_BYTES = 16 * 1024;

/** First 120 chars of each inbox message body is enough to identify the loop. */
const OPEN_LOOP_PREVIEW_CHARS = 120;

export interface AppendHandoffTailOpts {
  /** Path to the handoff doc (from the .handoff-doc-path marker). */
  docPath: string;
  /** Raw live PTY output tail (may contain ANSI escapes). */
  bufferTail: string;
  /** Unconsumed inbox items at restart (see collectOpenLoops). */
  openLoops: string[];
  /** Optional daemon logger — failures are reported here, never thrown. */
  log?: (m: string) => void;
}

/**
 * Append the daemon-owned session-tail section to a handoff doc.
 *
 * Returns true if the section was appended, false (never throws) when the
 * doc is missing/empty/unwritable or the buffer tail is empty after ANSI
 * stripping.
 */
export function appendHandoffTail(opts: AppendHandoffTailOpts): boolean {
  const log = opts.log ?? (() => {});
  try {
    const docPath = (opts.docPath || '').trim();
    if (!docPath || !existsSync(docPath)) {
      log(`handoff-tail: doc missing or empty path (${docPath || '<empty>'}) — skipping`);
      return false;
    }

    let tail = (opts.bufferTail || '').replace(ANSI_ESCAPE_RE, '');
    if (tail.length > MAX_TAIL_BYTES) {
      // Keep the END of the buffer — the most recent output is the part that
      // can contain post-handoff instructions.
      tail = tail.slice(-MAX_TAIL_BYTES);
    }
    if (!tail.trim()) {
      log('handoff-tail: live buffer tail is empty — skipping');
      return false;
    }

    const loops = opts.openLoops.length > 0
      ? opts.openLoops.map((l) => `- ${l}`).join('\n')
      : '- (none)';

    const section =
      '\n\n## Daemon-appended session tail (automatic — written at restart, independent of the agent)\n' +
      '### Last live output before restart\n' +
      '```\n' +
      tail +
      '\n```\n' +
      '### Open loops (unconsumed inbox items at restart)\n' +
      loops +
      '\n### Rule\n' +
      'Any correction/instruction visible in the tail above that is not reflected in the handoff body is UNRESOLVED — action it first.\n';

    appendFileSync(docPath, section, 'utf-8');
    return true;
  } catch (err) {
    log(`handoff-tail: append failed (non-fatal): ${err}`);
    return false;
  }
}

/**
 * List unconsumed message files under <ctxRoot>/inbox/<agentName> as
 * "basename: <first 120 chars>" lines. Unreadable entries are skipped;
 * a missing inbox dir yields []. Never throws.
 */
export function collectOpenLoops(ctxRoot: string, agentName: string): string[] {
  const inboxDir = join(ctxRoot, 'inbox', agentName);
  let entries: string[];
  try {
    entries = readdirSync(inboxDir);
  } catch {
    return [];
  }

  const loops: string[] = [];
  for (const entry of entries.sort()) {
    const full = join(inboxDir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      const preview = readFileSync(full, 'utf-8')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, OPEN_LOOP_PREVIEW_CHARS);
      loops.push(`${basename(entry)}: ${preview}`);
    } catch {
      // Unreadable entry (perms, race with consumption) — skip, don't fail.
      continue;
    }
  }
  return loops;
}
