import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { IPCClient, type IPCResponse } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidName(name: string): boolean {
  return /^[a-z0-9_-]+$/.test(name);
}

/**
 * Task 2.9: an IPC response is "durably accepted" when the daemon actually
 * received and durably queued the request. `accepted` is only present on
 * responses from Task 2.8's typed lifecycle envelope (start-agent/stop-agent/
 * restart-agent for a supervised agent) — an older daemon, or a legacy/
 * unsupervised agent's fire-and-forget dispatch, has no `accepted` field at
 * all, in which case `success: true` is the only signal available and is
 * treated as accepted for backwards compatibility. `accepted === false` is
 * an explicit, durable REJECTION (e.g. Task 2.8's `REQUIRES_RESUME` gate,
 * or a blocked prior teardown) and must never be treated as a success.
 */
function isDurablyAccepted(result: IPCResponse): boolean {
  return result.success && result.accepted !== false;
}

async function readEnabledAgents(enabledAgentsPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(enabledAgentsPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {}; // file may not exist yet
  }
}

async function writeEnabledAgents(enabledAgentsPath: string, enabledAgents: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(enabledAgentsPath), { recursive: true });
  await fs.writeFile(enabledAgentsPath, JSON.stringify(enabledAgents, null, 2) + '\n', 'utf-8');
}

/**
 * Task 2.9: bounded poll for a lifecycle operation's real, settled outcome —
 * mirrors `src/cli/stop.ts`'s `waitForAgentSettled` pattern (Task 2.8),
 * adapted to poll the `lifecycle-operation-status` introspection command
 * directly (cheaper and more precise than the fleet-wide `status` command
 * when an `operationId` is available) rather than declaring "retired" the
 * instant dispatch was accepted.
 */
async function waitForOperationSettled(
  ipc: IPCClient,
  agent: string,
  operationId: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<{ settled: boolean; phase?: string; blockedReason?: string | null }> {
  const attempts = opts.attempts ?? 40;
  const intervalMs = opts.intervalMs ?? 500;
  let last: IPCResponse | undefined;
  for (let i = 0; i < attempts; i++) {
    const response = await ipc.send({
      type: 'lifecycle-operation-status',
      agent,
      data: { operationId },
    });
    last = response;
    if (response.success && (response.phase === 'absent' || response.phase === 'blocked')) {
      return { settled: true, phase: response.phase, blockedReason: response.blockedReason };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { settled: false, phase: last?.phase, blockedReason: last?.blockedReason };
}

/**
 * Task 2.9: fallback verification for a legacy/unsupervised agent's stop
 * (no `operationId` in the response at all — the supervisor mailbox was
 * never involved) — polls the coarse fleet-wide `status` command exactly
 * as `src/cli/stop.ts`'s `waitForAgentSettled` does, and treats
 * `status !== 'running'` as the best available "retired" proxy.
 */
async function waitForStatusSettled(
  ipc: IPCClient,
  agent: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 40;
  const intervalMs = opts.intervalMs ?? 500;
  for (let i = 0; i < attempts; i++) {
    const response = await ipc.send({ type: 'status' });
    if (response.success) {
      const statuses = response.data as Array<{ name: string; status: string }>;
      const entry = statuses.find((s) => s.name === agent);
      if (!entry || entry.status !== 'running') return true;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const VALID_ACTIONS = ['enable', 'disable', 'restart', 'start', 'stop', 'restart_continue', 'restart_fresh'];

// Security (C4): Validate org and name against allowlist before use in shell commands or path.join.
function validateIdentifier(value: string | null | undefined, field: string): string {
  if (!value || !/^[a-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${field}: must match [a-z0-9_-]+`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// POST /api/agents/[name]/lifecycle - Enable, disable, or restart an agent
//
// Body: { action: "enable" | "disable" | "restart", org?: string, mode?: "continue" | "fresh" }
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  if (!isValidName(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action: rawAction, org } = body as {
    action?: string;
    org?: string;
  };

  if (!rawAction || !VALID_ACTIONS.includes(rawAction)) {
    return Response.json(
      { error: `action must be one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  // Normalize UI action names to IPC action names
  const action = rawAction === 'start' ? 'enable'
    : rawAction === 'stop' ? 'disable'
    : rawAction === 'restart_continue' || rawAction === 'restart_fresh' ? 'restart'
    : rawAction;
  const restartMode = rawAction === 'restart_continue' ? 'continue'
    : rawAction === 'restart_fresh' ? 'fresh'
    : undefined;

  // Security (C4): Validate org before use in shell commands.
  let safeOrg: string | undefined;
  if (org !== undefined) {
    try {
      safeOrg = validateIdentifier(org, 'org');
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 400 });
    }
  }

  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  const ipc = new IPCClient(instanceId);

  try {
    let ipcResult: IPCResponse;
    let registryMessage = '';
    // Task 2.9: whether this action's registry write already happened
    // (only ever performed AFTER a confirmed-accepted IPC response —
    // never independently/before it, per PRD §2.9's "enable/disable
    // intent+config transition is performed by the daemon owner, not by
    // an independent registry write"). Used below to decide whether the
    // daemon-unavailable soft-success path for `enable` has anything to
    // report.
    let registryWritten = false;

    switch (action) {
      case 'enable': {
        // Task 2.9 / PRD §2.7 resume gate: the dashboard's "enable" action
        // is an explicit operator intent to (re)start this agent — mirrors
        // `cortextos start --resume` (Task 2.8's CLI equivalent) so a
        // previously operator-stopped/halted/quarantined agent can actually
        // be cleared from here, rather than silently no-op'ing behind
        // Task 2.8's REQUIRES_RESUME gate.
        ipcResult = await ipc.send({ type: 'start-agent', agent: decoded, data: { resume: true } });

        if (isDurablyAccepted(ipcResult)) {
          // Confirmed accepted (or talking to a pre-2.8 daemon with no
          // `accepted` field at all, treated as accepted for backwards
          // compatibility) — ONLY NOW perform the registry write.
          const ctxRoot = getCTXRoot();
          const enabledAgentsPath = path.join(ctxRoot, 'config', 'enabled-agents.json');
          const enabledAgents = await readEnabledAgents(enabledAgentsPath);
          enabledAgents[decoded] = {
            ...(typeof enabledAgents[decoded] === 'object' && enabledAgents[decoded] !== null
              ? (enabledAgents[decoded] as object)
              : {}),
            enabled: true,
            ...(safeOrg ? { org: safeOrg } : {}),
          };
          await writeEnabledAgents(enabledAgentsPath, enabledAgents);
          registryWritten = true;
          registryMessage = 'enabled in registry';
        } else if (!ipcResult.success && ipcResult.error?.includes('Daemon is not running')) {
          // Daemon unavailable: there is no owner to confirm acceptance
          // with at all. Unlike DELETE's destructive teardown gate, writing
          // `enabled: true` here is non-destructive and reversible, so the
          // pre-existing "agent will start when daemon starts" soft-success
          // behavior is retained — but the write still only happens in this
          // one deliberate branch, never unconditionally ahead of the IPC
          // call.
          const ctxRoot = getCTXRoot();
          const enabledAgentsPath = path.join(ctxRoot, 'config', 'enabled-agents.json');
          const enabledAgents = await readEnabledAgents(enabledAgentsPath);
          enabledAgents[decoded] = {
            ...(typeof enabledAgents[decoded] === 'object' && enabledAgents[decoded] !== null
              ? (enabledAgents[decoded] as object)
              : {}),
            enabled: true,
            ...(safeOrg ? { org: safeOrg } : {}),
          };
          await writeEnabledAgents(enabledAgentsPath, enabledAgents);
          registryWritten = true;
          registryMessage = 'enabled in registry';
        }
        break;
      }

      case 'disable': {
        ipcResult = await ipc.send({ type: 'stop-agent', agent: decoded });

        if (isDurablyAccepted(ipcResult)) {
          // Same ordering fix as `enable`: the registry write only happens
          // after a confirmed-accepted stop, never independently of it.
          const ctxRoot = getCTXRoot();
          const enabledAgentsPath = path.join(ctxRoot, 'config', 'enabled-agents.json');
          try {
            const raw = await fs.readFile(enabledAgentsPath, 'utf-8');
            const enabledAgents = JSON.parse(raw) as Record<string, unknown>;
            if (enabledAgents[decoded] && typeof enabledAgents[decoded] === 'object') {
              (enabledAgents[decoded] as Record<string, unknown>).enabled = false;
            }
            await fs.writeFile(enabledAgentsPath, JSON.stringify(enabledAgents, null, 2) + '\n', 'utf-8');
            registryMessage = 'disabled in registry';
          } catch {
            registryMessage = 'registry update failed (non-fatal)';
          }
          registryWritten = true;
        }
        break;
      }

      case 'restart': {
        // Task 2.9 fix: `mode` must be nested under `data` — the daemon's
        // `restart-agent` IPC handler (Task 2.8) reads `request.data?.mode`,
        // never a bare top-level `mode` field. The pre-2.9 bug sent
        // `{ type: 'restart-agent', agent, mode: restartMode }`, so any
        // restart-mode selection was silently dropped even after Task 2.8's
        // handler-side fix landed, since nothing on the sending side ever
        // put it where the handler looks.
        ipcResult = await ipc.send({
          type: 'restart-agent',
          agent: decoded,
          ...(restartMode ? { data: { mode: restartMode } } : {}),
        });
        registryMessage = '';
        break;
      }

      default:
        return Response.json({ error: 'Invalid action' }, { status: 400 });
    }

    if (!isDurablyAccepted(ipcResult)) {
      const isDaemonDown = ipcResult.error?.includes('Daemon is not running');
      if (isDaemonDown && action === 'enable' && registryWritten) {
        return Response.json({
          success: true,
          action,
          agent: decoded,
          output: `${registryMessage}; daemon not running — agent will start when daemon starts`,
        });
      }
      console.error(`[api/agents/${decoded}/lifecycle] POST IPC error (${action}):`, ipcResult.error ?? ipcResult.blockedReason);
      const rejectedButSucceeded = ipcResult.success && ipcResult.accepted === false;
      return Response.json(
        {
          error: rejectedButSucceeded
            ? `Rejected: ${ipcResult.blockedReason ?? ipcResult.error ?? `${action} was refused`}`
            : `Failed to ${action} agent: ${ipcResult.error ?? 'unknown IPC error'}`,
          code: ipcResult.code,
          blockedReason: ipcResult.blockedReason,
        },
        { status: rejectedButSucceeded ? 409 : 500 },
      );
    }

    return Response.json({
      success: true,
      action,
      agent: decoded,
      operationId: ipcResult.operationId,
      phase: ipcResult.phase,
      output: [registryMessage, String(ipcResult.data ?? '')].filter(Boolean).join('; '),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/agents/${decoded}/lifecycle] POST error:`, message);
    return Response.json({ error: `Failed to ${action} agent` }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/agents/[name]/lifecycle - Remove an agent entirely
//
// Query params: ?deleteFiles=true to also remove agent directory
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  if (!isValidName(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const ctxRoot = getCTXRoot();
  const enabledAgentsPath = path.join(ctxRoot, 'config', 'enabled-agents.json');
  const deleteFiles = request.nextUrl.searchParams.get('deleteFiles') === 'true';

  // Look up org from enabled-agents.json
  let org = '';
  let enabledAgents: Record<string, { org?: string; enabled?: boolean }> = {};
  try {
    const raw = await fs.readFile(enabledAgentsPath, 'utf-8');
    enabledAgents = JSON.parse(raw);
    if (enabledAgents[decoded]) {
      org = enabledAgents[decoded].org ?? '';
    }
  } catch {
    // File doesn't exist or is malformed
  }

  // Security (C4): Validate org from stored data before use in shell commands and path.join.
  let safeDeleteOrg = '';
  if (org) {
    try {
      safeDeleteOrg = validateIdentifier(org, 'org');
    } catch {
      // org stored in registry is malformed — skip shell/fs operations that use it
      safeDeleteOrg = '';
    }
  }

  // 1. Tell daemon to stop the agent, then VERIFY the teardown actually
  //    retired before proceeding — Task 2.9 / PRD §2.9: "DELETE removes
  //    configuration/files only after a verified `retired` result" and
  //    "never a best-effort stop followed by a destructive continuation."
  //    The pre-2.9 code fired stop-agent, logged a warning on failure, and
  //    proceeded to destructive work regardless — that unconditional
  //    proceed is exactly the bug fixed here.
  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  const ipc = new IPCClient(instanceId);
  const stopResult = await ipc.send({ type: 'stop-agent', agent: decoded });

  const daemonDown = !stopResult.success && stopResult.error?.includes('Daemon is not running');
  if (daemonDown) {
    // No owner is reachable to confirm/verify retirement against at all.
    // Configuration and file removal are both destructive/hard-to-reverse
    // here, so the whole DELETE (not just deleteFiles) is rejected outright
    // rather than silently proceeding for a possibly-still-running agent
    // the daemon just can't currently be asked about.
    return Response.json(
      {
        error: `Cannot delete "${decoded}": daemon is not running, so teardown cannot be verified. Start the daemon and retry.`,
      },
      { status: 503 },
    );
  }

  if (!stopResult.success) {
    console.error(`[api/agents/${decoded}/lifecycle] DELETE stop error:`, stopResult.error);
    return Response.json(
      { error: `Cannot delete "${decoded}": failed to stop agent (${stopResult.error ?? 'unknown IPC error'})` },
      { status: 500 },
    );
  }

  if (stopResult.accepted === false) {
    return Response.json(
      {
        error: `Cannot delete "${decoded}": stop request was rejected (${stopResult.blockedReason ?? 'unknown reason'})`,
        blockedReason: stopResult.blockedReason,
      },
      { status: 409 },
    );
  }

  let retired: boolean;
  let blockedReason: string | null | undefined;
  if (stopResult.operationId) {
    // Supervised agent — poll the precise per-operation outcome.
    const outcome = await waitForOperationSettled(ipc, decoded, stopResult.operationId);
    retired = outcome.settled && outcome.phase !== 'blocked';
    blockedReason = outcome.blockedReason ?? (outcome.settled ? null : 'teardown did not settle within the verification window');
  } else {
    // Legacy/unsupervised agent — no operationId to poll precisely; the
    // coarse fleet-status proxy (`status !== 'running'`) is the best
    // verification signal actually available for this agent today.
    const settled = await waitForStatusSettled(ipc, decoded);
    retired = settled;
    blockedReason = settled ? null : 'agent status did not settle within the verification window';
  }

  if (!retired) {
    return Response.json(
      {
        error: `Cannot delete "${decoded}": teardown is not verified as retired (${blockedReason ?? 'unknown reason'}) — nothing was removed`,
        blockedReason,
      },
      { status: 409 },
    );
  }

  // 2. Remove from enabled-agents.json
  try {
    delete enabledAgents[decoded];
    await fs.writeFile(
      enabledAgentsPath,
      JSON.stringify(enabledAgents, null, 2) + '\n',
      'utf-8',
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/agents/${decoded}/lifecycle] failed to update enabled-agents.json:`, message);
    return Response.json(
      { error: 'Failed to update agent registry' },
      { status: 500 },
    );
  }

  // 3. Optionally remove agent directory
  if (deleteFiles && safeDeleteOrg) {
    try {
      const agentDir = path.join(getFrameworkRoot(), 'orgs', safeDeleteOrg, 'agents', decoded);
      await fs.rm(agentDir, { recursive: true, force: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[api/agents/${decoded}/lifecycle] failed to remove agent dir:`, message);
      // Non-fatal - agent is already deregistered
    }
  }

  return Response.json({ success: true, deleted: decoded });
}
