import { createConnection } from 'net';
import { homedir } from 'os';
import { join } from 'path';

export type ExecutionLogStatusFilter = 'all' | 'success' | 'failure';

// ---------------------------------------------------------------------------
// Fleet Health types (Subtask 4.4)
// ---------------------------------------------------------------------------

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

export interface CronHealthRow {
  agent: string;
  org: string;
  cronName: string;
  state: CronHealthState;
  reason: string;
  lastFire: number | null;
  expectedIntervalMs: number;
  gapMs: number | null;
  successRate24h: number;
  firesLast24h: number;
  nextFire: string;
}

export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

export interface FleetHealthResponse {
  rows: CronHealthRow[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

export interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

/** Paginated response for list-cron-executions IPC command (Subtask 4.3). */
export interface CronExecutionLogPage {
  entries: CronExecutionLogEntry[];
  total: number;
  hasMore: boolean;
}

export interface IPCRequest {
  type:
    | 'status'
    | 'start-agent'
    | 'stop-agent'
    | 'restart-agent'
    | 'wake'
    | 'list-agents'
    | 'list-all-crons'
    | 'list-cron-executions'
    | 'reload-crons'
    | 'fire-cron'
    | 'inject-agent'
    | 'add-cron'
    | 'update-cron'
    | 'remove-cron'
    | 'fleet-health'
    // Task 2.9: the two Task 2.8 read-only lifecycle introspection commands,
    // used by the dashboard lifecycle route to verify a `retired` outcome
    // before proceeding with any destructive DELETE work rather than
    // treating IPC "accepted" as "completed".
    | 'agent-lifecycle-status'
    | 'lifecycle-operation-status';
  agent?: string;
  data?: Record<string, unknown>;
}

/**
 * Task 2.9: mirrors `src/types/index.ts`'s `ObservedPhase`/error `code` union
 * (`src/daemon/lifecycle/types.ts`'s `ObservedPhase`, Task 1.1) as plain
 * string literals, duplicated rather than imported for the same reason
 * `src/types/index.ts` itself duplicates them (`LifecycleDesiredStateWire`/
 * `LifecycleObservedPhaseWire`, Task 2.8's comment there): this file sits
 * under `dashboard/`, entirely outside the daemon's isolation-gate-scanned
 * `src/` tree, so there's no actual gate concern here — the duplication is
 * purely to keep the dashboard package's type graph free of a cross-package
 * import into the daemon's `src/daemon/lifecycle` internals. Value sets are
 * identical by construction with the real daemon-side `IPCResponse`.
 */
export type LifecycleObservedPhase = 'absent' | 'starting' | 'ready' | 'retiring' | 'blocked';

export interface IPCResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Task 2.9 (consumes Task 2.8's typed envelope): `accepted` is DURABLE
   * ACCEPTANCE of the request, never completion — a `true` here does not
   * mean the agent has actually retired/started yet. `operationId` lets a
   * caller poll `lifecycle-operation-status` for the real, eventually-
   * settled outcome. `phase`/`blockedReason` are the most recent observed
   * phase for that operation (or, for `agent-lifecycle-status`, the agent's
   * current persisted phase).
   */
  accepted?: boolean;
  operationId?: string;
  phase?: LifecycleObservedPhase;
  blockedReason?: string | null;
  code?: 'NOT_FOUND' | 'DEDUPED' | 'INVALID_INPUT' | 'NOT_RUNNING' | 'AGENT_NOT_SCHEDULED' | 'REQUIRES_RESUME' | 'INVALID_MODE';
}

function getIpcPath(instanceId: string = 'default'): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return join(homedir(), '.cortextos', instanceId, 'daemon.sock');
}

export class IPCClient {
  private socketPath: string;

  constructor(instanceId: string = 'default') {
    this.socketPath = getIpcPath(instanceId);
  }

  async send(request: IPCRequest): Promise<IPCResponse> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        socket.write(JSON.stringify(request));
      });

      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid response from daemon'));
        }
      });

      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
          resolve({
            success: false,
            error: 'Daemon is not running. Start it with: cortextos start',
          });
        } else {
          reject(err);
        }
      });

      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('IPC request timed out'));
      });
    });
  }

  async isDaemonRunning(): Promise<boolean> {
    try {
      const response = await this.send({ type: 'status' });
      return response.success;
    } catch {
      return false;
    }
  }
}
