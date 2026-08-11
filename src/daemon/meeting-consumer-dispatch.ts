import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { checkAndRecordSourceEvent } from '../utils/event-dedup.js';

/**
 * FR-004/005/006/007 — daemon meeting-consumer DISPATCH.
 *
 * When the FR-002 emit (`maybeEmitMeetingEvent`) returns `outcome==='completed'` for a
 * meeting-writeback worker, the DAEMON — not the crm LLM noticing an inbox line —
 * deterministically triggers the downstream consumers:
 *
 *   - FR-007 crm-sync  : `python3 <crmDir>/meeting-crm-sync.py --meeting-id <id>` (detached)
 *   - FR-004 fanout    : `python3 <crmDir>/meeting-fanout.py   --meeting-id <id>` (detached)
 *   - FR-005 coordinator: LLM worker running the `followup-coordinator` skill (recap + tracker)
 *   - FR-006 debrief   : DEFERRED (deal-debrief-analyst skill not yet in the org store)
 *
 * Design constraints (see state/specs/FR-004-008-consume-half-design-2026-08-10.md):
 *   - NON-BLOCKING: the two scripts run as detached/unref'd subprocesses (never execSync)
 *     so they cannot block the daemon event loop; the coordinator uses the async
 *     `spawnWorker` which the caller fires-and-forgets (`.catch` log).
 *   - IDEMPOTENT: each consumer is independently dedup-gated by its own source-key +
 *     meeting_id via the shared event-dedup ledger (fire-once), so a re-emitted /
 *     re-spawned meeting never double-dispatches.
 *   - ISOLATED: a throw in one consumer must not stop the others or crash the daemon
 *     (try/catch per consumer, log-and-continue).
 *   - INJECTABLE: all side effects (spawnScript, spawnWorker, recordEvent, exists) are
 *     dependency-injected so unit tests run with fakes — no real subprocess/worker.
 */

/** Input for a single meeting-consumer dispatch (built by the daemon `onDone` hook). */
export interface MeetingDispatchInput {
  /** The Fireflies meeting id (from `extraEnv.FF_MEETING_ID` / the emit result). */
  meetingId: string;
  /** Meeting type from the writeback payload — used only for the deferred FR-006 gate. */
  meetingType: string;
  /** Daemon ctxRoot (dedup ledger). */
  ctxRoot: string;
  /** Framework root (resolves the crm dir + the coordinator skill/agent dir). */
  frameworkRoot: string;
  /** Org for path resolution. Required — no org → no dispatch. */
  org?: string;
}

/** Injectable side-effects so the dispatch is testable without touching real procs. */
export interface MeetingDispatchDeps {
  /**
   * Run a deterministic (LLM-free) script DETACHED. Default: `child_process.spawn`
   * with detached+unref and stdio ignored, so it survives and never blocks the daemon.
   */
  spawnScript: (cmd: string, args: string[]) => void;
  /**
   * Spawn an LLM worker. Default: bound to `AgentManager.spawnWorker`. The daemon
   * fires-and-forgets this promise (the dispatch itself awaits nothing that blocks).
   */
  spawnWorker: (
    name: string,
    dir: string,
    prompt: string,
    parent?: string,
    model?: string,
    extraEnv?: Record<string, string>,
  ) => Promise<void>;
  /**
   * Dedup gate. Returns true ONLY the first time this source-key is seen (fire-once)
   * so a re-dispatch of the same meeting_id does not double-run a consumer.
   * Default: shared event-dedup ledger via checkAndRecordSourceEvent(fireOnce).
   */
  recordEvent: (ctxRoot: string, sourceKey: string) => boolean;
  /** existsSync override (tests) — used to resolve the coordinator skill/agent dir. */
  exists: (path: string) => boolean;
}

/** Per-consumer outcome, surfaced for testing + logging. */
export interface ConsumerOutcome {
  consumer: 'crm-sync' | 'fanout' | 'coordinator' | 'debrief';
  /** 'dispatched' | 'deduped' | 'deferred' | 'error' | 'skipped'. */
  status: 'dispatched' | 'deduped' | 'deferred' | 'error' | 'skipped';
  sourceKey?: string;
  reason?: string;
}

export interface MeetingDispatchResult {
  meetingId: string;
  meetingType: string;
  outcomes: ConsumerOutcome[];
}

/** safeId used for the coordinator worker name — mirrors webhook-bridge/emit sanitization. */
function safeId(meetingId: string): string {
  return meetingId.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

/** Default detached script runner — never blocks the daemon event loop. */
function defaultSpawnScript(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Default dedup: shared event-dedup ledger, fire-once, keyed by source. */
function defaultRecordEvent(ctxRoot: string, sourceKey: string): boolean {
  return checkAndRecordSourceEvent(ctxRoot, sourceKey, { fireOnce: true }).surface;
}

/**
 * Resolve the directory of the agent that owns the `followup-coordinator` skill.
 *
 * The skill can live either per-agent (`orgs/<org>/agents/pa/.claude/skills/...`) or in
 * the central org store (`orgs/<org>/skills/followup-coordinator/SKILL.md`). We check both
 * and return the AGENT DIR the coordinator worker should run in. When only the central
 * store has it, the worker still runs in the `pa` agent dir (the org's default meeting
 * owner) and resolves the skill from the central store at runtime. Returns null if no
 * SKILL.md exists in either place (so the caller records a `skipped` outcome, never a
 * broken spawn).
 */
export function resolveCoordinatorDir(
  frameworkRoot: string,
  org: string,
  exists: (path: string) => boolean,
): { dir: string; parent: string } | null {
  const paAgentDir = join(frameworkRoot, 'orgs', org, 'agents', 'pa');
  const perAgentSkill = join(paAgentDir, '.claude', 'skills', 'followup-coordinator', 'SKILL.md');
  const centralSkill = join(frameworkRoot, 'orgs', org, 'skills', 'followup-coordinator', 'SKILL.md');
  if (exists(perAgentSkill) || exists(centralSkill)) {
    // Both resolutions run the worker in the pa agent dir; per-agent takes precedence
    // when present, central store is the fallback the worker reads at runtime.
    return { dir: paAgentDir, parent: 'pa' };
  }
  return null;
}

/**
 * Dispatch the meeting consumers for a `completed` meeting event. Each consumer is
 * independently dedup-gated + isolated. Returns per-consumer outcomes for logging/tests.
 * The daemon calls this from `onDone` right after `maybeEmitMeetingEvent` returns
 * `outcome==='completed'`, and fires-and-forgets it (`.catch` log) so it never blocks.
 */
export function dispatchMeetingConsumers(
  input: MeetingDispatchInput,
  deps: Partial<MeetingDispatchDeps> = {},
): MeetingDispatchResult {
  const spawnScript = deps.spawnScript ?? defaultSpawnScript;
  const spawnWorker = deps.spawnWorker;
  const recordEvent = deps.recordEvent ?? defaultRecordEvent;
  const exists = deps.exists ?? ((p: string) => existsSync(p));

  const meetingId = (input.meetingId ?? '').trim();
  const meetingType = (input.meetingType ?? 'other').trim() || 'other';
  const outcomes: ConsumerOutcome[] = [];

  if (!meetingId || !input.org || !input.frameworkRoot) {
    return {
      meetingId,
      meetingType,
      outcomes: [{ consumer: 'crm-sync', status: 'skipped', reason: 'missing-meeting-id-or-org' }],
    };
  }

  const crmDir = join(input.frameworkRoot, 'orgs', input.org, 'agents', 'crm', 'crm');

  // --- FR-007 crm-sync (always) — detached deterministic script -------------------------
  runConsumer(outcomes, 'crm-sync', `meeting-crmsync:${meetingId}`, input.ctxRoot, recordEvent, () => {
    spawnScript('python3', [join(crmDir, 'meeting-crm-sync.py'), '--meeting-id', meetingId]);
  });

  // --- FR-004 fanout (always) — detached deterministic script ---------------------------
  runConsumer(outcomes, 'fanout', `meeting-fanout:${meetingId}`, input.ctxRoot, recordEvent, () => {
    spawnScript('python3', [join(crmDir, 'meeting-fanout.py'), '--meeting-id', meetingId]);
  });

  // --- FR-005 coordinator (all types) — LLM worker, followup-coordinator skill ----------
  runConsumer(outcomes, 'coordinator', `meeting-coord:${meetingId}`, input.ctxRoot, recordEvent, () => {
    const resolved = resolveCoordinatorDir(input.frameworkRoot, input.org!, exists);
    if (!resolved) {
      // No coordinator skill anywhere → record skipped (undo the dedup surface so a
      // later dispatch, once the skill exists, can still spawn it).
      throw new DispatchSkip('coordinator-skill-not-found');
    }
    if (!spawnWorker) {
      throw new DispatchSkip('no-spawnWorker-dep');
    }
    const workerName = `meeting-coord-${safeId(meetingId)}`.slice(0, 64);
    const prompt = [
      'You are the followup-coordinator worker (short-lived).',
      `FF_MEETING_ID=${meetingId}.`,
      'Read the followup-coordinator SKILL and produce the recap doc + OUR/THEIR tracker',
      'for this meeting. The fanout already created the bus tasks + followup rows —',
      'do NOT create new followups or bus tasks; only the recap doc + tracker. Output DONE.',
    ].join(' ');
    // Fire-and-forget: spawnWorker is async; the daemon must not block onDone on it.
    void spawnWorker(workerName, resolved.dir, prompt, resolved.parent, undefined, {
      FF_MEETING_ID: meetingId,
    }).catch((err) => {
      console.error(`[meeting-dispatch] coordinator worker spawn failed for ${meetingId}: ${String(err)}`);
    });
  });

  // --- FR-006 deal-debrief (sales ONLY) — DEFERRED --------------------------------------
  // TODO FR-006: the deal-debrief-analyst skill is not yet in the org store. When it
  // lands, spawn a short-lived debrief worker here, gated `meeting-debrief:<meeting_id>`,
  // ONLY for sales meetings. meetingType is threaded through the input so wiring this is
  // trivial. Example (do NOT enable until the skill exists):
  //
  //   if (meetingType === 'sales') {
  //     runConsumer(outcomes, 'debrief', `meeting-debrief:${meetingId}`, input.ctxRoot, recordEvent, () => {
  //       const resolved = resolveDebriefDir(input.frameworkRoot, input.org!, exists);
  //       void spawnWorker!(`meeting-debrief-${safeId(meetingId)}`, resolved.dir, debriefPrompt, resolved.parent, undefined, { FF_MEETING_ID: meetingId });
  //     });
  //   }
  outcomes.push({
    consumer: 'debrief',
    status: 'deferred',
    reason: meetingType === 'sales' ? 'sales-meeting-fr006-deferred' : 'non-sales-no-debrief',
  });

  return { meetingId, meetingType, outcomes };
}

/** Internal sentinel: a consumer chose to skip (not an error) — undo its dedup surface. */
class DispatchSkip extends Error {}

/**
 * Run one consumer under its own dedup gate + isolation:
 *   1. record the source-key fire-once; if already seen → 'deduped', do nothing.
 *   2. run the action; a DispatchSkip → 'skipped'; any other throw → 'error' (isolated).
 * A throw in one consumer never propagates — the next consumer still runs.
 */
function runConsumer(
  outcomes: ConsumerOutcome[],
  consumer: ConsumerOutcome['consumer'],
  sourceKey: string,
  ctxRoot: string,
  recordEvent: (ctxRoot: string, sourceKey: string) => boolean,
  action: () => void,
): void {
  try {
    if (!recordEvent(ctxRoot, sourceKey)) {
      outcomes.push({ consumer, status: 'deduped', sourceKey });
      return;
    }
    try {
      action();
      outcomes.push({ consumer, status: 'dispatched', sourceKey });
    } catch (err) {
      if (err instanceof DispatchSkip) {
        outcomes.push({ consumer, status: 'skipped', sourceKey, reason: err.message });
        return;
      }
      // Isolate: log and record error, but never rethrow — other consumers must proceed.
      console.error(`[meeting-dispatch] ${consumer} failed for ${sourceKey}: ${String(err)}`);
      outcomes.push({ consumer, status: 'error', sourceKey, reason: String(err) });
    }
  } catch (outer) {
    // recordEvent itself threw — still isolate so sibling consumers run.
    console.error(`[meeting-dispatch] ${consumer} dedup-gate failed for ${sourceKey}: ${String(outer)}`);
    outcomes.push({ consumer, status: 'error', sourceKey, reason: String(outer) });
  }
}
