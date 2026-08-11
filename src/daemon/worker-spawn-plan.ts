import { existsSync } from 'fs';
import { join } from 'path';
import { IPCClient } from './ipc-server.js';

/**
 * The daemon's WORKER_NAME_REGEX (see ipc-server.ts) — worker names must match
 * /^[a-z0-9_-]+$/ or the spawn is rejected. Every lane's plan sanitizes its id
 * through this shape, so it is exported for both the planner and its tests.
 */
export const WORKER_NAME_REGEX = /^[a-z0-9_-]+$/;
const WORKER_NAME_MAX = 64;

/**
 * A lane template describes how one event surface (fireflies, gmail, calendar,
 * slack, ...) turns an event id into a deterministic worker spawn. It is the
 * per-lane data the generic planner consumes; the planner itself is lane-agnostic.
 */
export interface WorkerSpawnTemplate {
  /** Framework root (absolute) — the agent dir is derived from it, never hardcoded. */
  frameworkRoot: string;
  /** Org name; required — no org means no filable spawn (caller falls back to NL relay). */
  org?: string;
  /** Target agent whose dir + skill the worker runs in (e.g. 'pa'). */
  target: string;
  /** Prefix for the worker name, e.g. 'meeting-writeback'. Must be regex-safe. */
  workerNamePrefix: string;
  /**
   * Skill paths (relative to the agent dir) to probe, in order. The first that
   * exists is used in the prompt. If none exist the plan is null so the caller
   * falls back to the NL relay (no regression when a lane's skill is absent).
   */
  skillRelativePaths: string[];
  /**
   * Builds the worker prompt from the resolved skill path + event id. Kept as a
   * template hook so each lane phrases its own single-event fast-path prompt.
   */
  buildPrompt: (args: { skillRelativePath: string; eventId: string }) => string;
  /**
   * Env vars injected into the spawned worker (e.g. { FF_MEETING_ID: id }).
   * Returned in the plan as extraEnv so the caller passes them to spawn-worker.
   */
  buildEnv: (eventId: string) => Record<string, string>;
  /** Test seam: existence check for skill paths. Defaults to fs.existsSync. */
  skillExists?: (path: string) => boolean;
}

export interface WorkerSpawnPlan {
  workerName: string;
  dir: string;
  prompt: string;
  extraEnv: Record<string, string>;
}

/**
 * Pure planner for a deterministic per-event worker spawn — the generic backbone
 * extracted from the fireflies path (FR-E1). Resolves the worker name (sanitized
 * to satisfy the daemon's WORKER_NAME_REGEX), the agent dir (dynamic — from the
 * framework root/org, never a hardcoded absolute), the prompt, and the extra env.
 * Returns null when the inputs can't produce a valid, filable spawn (missing org,
 * empty id after sanitization, or the target has no matching skill), so the caller
 * falls back to the NL relay. No IPC here — kept pure for testing.
 */
export function planWorkerSpawn(
  template: WorkerSpawnTemplate,
  eventId: string,
  _env?: Record<string, string>,
): WorkerSpawnPlan | null {
  if (!template.org || !template.frameworkRoot || !template.target || !template.workerNamePrefix) return null;
  const trimmedId = (eventId ?? '').trim();
  if (!trimmedId) return null;
  const safeId = trimmedId.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  if (!safeId) return null;
  const workerName = `${template.workerNamePrefix}-${safeId}`.slice(0, WORKER_NAME_MAX);
  if (!WORKER_NAME_REGEX.test(workerName)) return null;
  const dir = join(template.frameworkRoot, 'orgs', template.org, 'agents', template.target);
  const exists = template.skillExists ?? ((p: string) => existsSync(p));
  const skillRelativePath = template.skillRelativePaths.find((candidate) => exists(join(dir, candidate)));
  if (!skillRelativePath) return null;
  const prompt = template.buildPrompt({ skillRelativePath, eventId: trimmedId });
  const extraEnv = template.buildEnv(trimmedId);
  return { workerName, dir, prompt, extraEnv };
}

/**
 * Generic guarded-spawn wrapper every event lane reuses (FR-E1). Runs the
 * provided planner; if it yields a plan, spawns the worker directly via the
 * daemon (IPC spawn-worker). Returns ok:false on a null plan OR any failure so
 * the caller can fall back to the NL inbox relay (no regression if the daemon is
 * unreachable). The `integration` label is carried through for the caller's
 * logging/receipt; the spawn itself is lane-agnostic.
 */
export async function trySpawnWorkerForEvent(
  integration: string,
  planFn: () => WorkerSpawnPlan | null,
  options: { instanceId?: string; parent: string; client?: { send: (req: unknown) => Promise<{ success: boolean }> } },
): Promise<{ ok: true; integration: string; workerName: string } | { ok: false }> {
  const plan = planFn();
  if (!plan) return { ok: false };
  try {
    const client = options.client ?? new IPCClient(options.instanceId || 'default');
    const response = await client.send({
      type: 'spawn-worker',
      data: {
        name: plan.workerName,
        dir: plan.dir,
        prompt: plan.prompt,
        parent: options.parent,
        env: plan.extraEnv,
      },
    });
    return response.success ? { ok: true, integration, workerName: plan.workerName } : { ok: false };
  } catch {
    return { ok: false };
  }
}
