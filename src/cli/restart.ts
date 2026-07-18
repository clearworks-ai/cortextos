import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-server.js';
import type { AgentStatus } from '../types/index.js';
import { writeStopMarker } from './stop.js';
import { resolveInstanceId } from './resolve-instance-id.js';

export const RESTART_VERIFY_TIMEOUT_MS = 10_000;
export const RESTART_VERIFY_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findAgentStatus(data: unknown, agent: string): AgentStatus | null {
  if (!Array.isArray(data)) return null;
  return (data as AgentStatus[]).find(status => status.name === agent) || null;
}

function isRunningAgent(status: AgentStatus | null): status is AgentStatus & { pid: number } {
  return Boolean(status && status.status === 'running' && typeof status.pid === 'number' && status.pid > 0);
}

async function readAgentStatus(ipc: IPCClient, agent: string): Promise<AgentStatus | null> {
  try {
    const response = await ipc.send({ type: 'status', source: 'cortextos restart' });
    if (!response.success) return null;
    return findAgentStatus(response.data, agent);
  } catch {
    return null;
  }
}

async function waitForRestartLiveness(ipc: IPCClient, agent: string, previousPid?: number): Promise<boolean> {
  const deadline = Date.now() + RESTART_VERIFY_TIMEOUT_MS;
  let sawRestartWindow = previousPid === undefined;

  while (Date.now() <= deadline) {
    const status = await readAgentStatus(ipc, agent);

    if (isRunningAgent(status)) {
      if (previousPid === undefined || status.pid !== previousPid || sawRestartWindow) {
        return true;
      }
    } else {
      sawRestartWindow = true;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await sleep(Math.min(RESTART_VERIFY_INTERVAL_MS, remainingMs));
  }

  return false;
}

export const restartCommand = new Command('restart')
  .argument('<agent>', 'Agent name to restart')
  .option('--instance <id>', 'Instance ID')
  .description('Restart a running agent (stop + start). Re-reads config.json and .env, respawns the PTY. Does NOT restart the daemon process itself — use `pm2 restart cortextos-daemon` for that.')
  .action(async (agent: string, options: { instance?: string }) => {
    const instanceId = resolveInstanceId(options.instance);
    const ipc = new IPCClient(instanceId);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.error('Daemon is not running. Start it first: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting agent: ${agent}`);
    const previousStatus = await readAgentStatus(ipc, agent);
    const previousPid = typeof previousStatus?.pid === 'number' ? previousStatus.pid : undefined;

    // Stop phase mirrors `cortextos stop <agent>` — write the .user-stop marker
    // before the IPC stop so the SessionEnd crash-alert hook does not fire a
    // false 🚨 CRASH alarm during the brief stop window. (BUG-036 pattern.)
    writeStopMarker(instanceId, agent, 'stopped via cortextos restart');
    const restartResponse = await ipc.send({ type: 'restart-agent', agent, source: 'cortextos restart' });
    if (!restartResponse.success) {
      console.error(`  Restart failed: ${restartResponse.error}`);
      process.exit(1);
    }

    const running = await waitForRestartLiveness(ipc, agent, previousPid);
    if (!running) {
      console.error(`  Start did not confirm within ${RESTART_VERIFY_TIMEOUT_MS / 1000}s — agent may have failed to spawn.`);
      console.error(`  Recover with: cortextos start ${agent}`);
      process.exit(1);
    }

    console.log(`  ${agent} restarted`);
  });
