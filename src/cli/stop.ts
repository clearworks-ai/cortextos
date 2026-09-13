import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';
import { resolveInstanceId } from './resolve-instance-id.js';
import type { AgentStatus, IPCRequest, IPCResponse } from '../types/index.js';

/**
 * Task 2.8 (PRD §2.7): "No control surface prints 'stopped'/'restarted'
 * merely because dispatch was accepted; the CLI may await/query completion
 * with a bounded wait." IPC responses for start/stop/restart only ever
 * report DURABLE ACCEPTANCE, never completion — this polls the existing
 * `status` command (cheap, no new IPC surface needed) for a SHORT, bounded
 * window and returns whichever outcome actually settled, instead of a CLI
 * command declaring an outcome the instant dispatch was accepted.
 *
 * Works uniformly for both a supervised agent (whose status carries `phase`)
 * and a legacy/unsupervised one (whose status has only the coarse
 * `status` field) — `isSettled` is handed the same `AgentStatus`-shaped
 * object either way and decides what "done" means for its own call site.
 */
export async function waitForAgentSettled(
  ipc: { send(request: IPCRequest): Promise<IPCResponse> },
  agent: string,
  isSettled: (status: AgentStatus | undefined) => boolean,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<{ settled: boolean; last: AgentStatus | undefined }> {
  const attempts = opts.attempts ?? 5;
  const intervalMs = opts.intervalMs ?? 400;
  let last: AgentStatus | undefined;
  for (let i = 0; i < attempts; i++) {
    const response = await ipc.send({ type: 'status', source: 'cortextos lifecycle-wait' });
    if (response.success) {
      const statuses = response.data as AgentStatus[];
      last = statuses.find((s) => s.name === agent);
      if (isSettled(last)) return { settled: true, last };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { settled: false, last };
}

/**
 * BUG-036 fix: write a `.user-stop` marker before the agent's PTY is killed,
 * so the SessionEnd crash-alert hook (src/hooks/hook-crash-alert.ts) knows
 * the stop was intentional and does not fire a false 🚨 CRASH alarm.
 * Pattern matches src/cli/bus.ts:1285-1289.
 */
export function writeStopMarker(instanceId: string, agent: string, reason: string): void {
  try {
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    const stateDir = join(ctxRoot, 'state', agent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-stop'), reason);
  } catch { /* don't block stop on marker-write failure */ }
}

export const stopCommand = new Command('stop')
  .argument('[agent]', 'Agent name to stop. Omit and pass --all to stop every running agent.')
  .option('--instance <id>', 'Instance ID')
  .option('--all', 'Stop every running agent (required when no agent name is given)')
  .description('Stop a running agent. Use --all to stop every agent. Does NOT stop the daemon process itself — use `pm2 stop cortextos-daemon` for that.')
  .action(async (agent: string | undefined, options: { instance?: string; all?: boolean }) => {
    const instanceId = resolveInstanceId(options.instance);
    // Safety: refuse to stop the entire fleet unless the user explicitly opted in.
    if (!agent && !options.all) {
      console.error('Refusing to stop all agents without an explicit target.');
      console.error('');
      console.error('  To stop one agent:    cortextos stop <agent>');
      console.error('  To stop every agent:  cortextos stop --all');
      console.error('  To stop the daemon:   pm2 stop cortextos-daemon');
      console.error('');
      console.error('(Previously `cortextos stop` with no argument silently stopped every running agent. That behavior was a foot-gun and now requires --all.)');
      process.exit(2);
    }

    if (agent && options.all) {
      console.error('Error: pass either an agent name or --all, not both.');
      process.exit(2);
    }

    const ipc = new IPCClient(instanceId);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.log('Daemon is not running.');
      return;
    }

    if (agent) {
      console.log(`Stopping agent: ${agent}`);
      writeStopMarker(instanceId, agent, 'stopped via cortextos stop');
      const response = await ipc.send({ type: 'stop-agent', agent, source: 'cortextos stop' });
      if (response.success) {
        // Dispatch was durably accepted — not yet proof of completion. Poll
        // a bounded window for the real outcome rather than declaring
        // "stopped" on acceptance alone.
        const { settled, last } = await waitForAgentSettled(ipc, agent, (s) => s === undefined || s.status !== 'running');
        if (settled) {
          console.log(`  Stopped ${agent}.`);
        } else {
          console.log(`  Stop accepted for ${agent} (durable); teardown still in progress — check \`cortextos status\`.`);
          if (last?.blockedReason) console.log(`  Last known blocked reason: ${last.blockedReason}`);
        }
      } else {
        console.error(`  Error: ${response.error}`);
        process.exit(1);
      }
      return;
    }

    // options.all === true
    console.log('Stopping all agents...');
    const listResponse = await ipc.send({ type: 'list-agents', source: 'cortextos stop --all' });
    if (!listResponse.success) {
      console.error(`  Error listing agents: ${listResponse.error}`);
      process.exit(1);
    }
    const agents = listResponse.data as string[];
    if (agents.length === 0) {
      console.log('  No agents are running.');
      return;
    }
    for (const a of agents) {
      writeStopMarker(instanceId, a, 'stopped via cortextos stop --all');
      const response = await ipc.send({ type: 'stop-agent', agent: a, source: 'cortextos stop --all' });
      // Bulk path: no per-agent bounded-wait poll (would multiply latency by
      // the fleet size) — report what actually happened, "stop accepted",
      // not the completed-sounding "stopped".
      console.log(`  ${a}: ${response.success ? 'stop accepted' : response.error}`);
    }
    console.log('\nStop requests accepted for all agents. The daemon is still running. To stop it: pm2 stop cortextos-daemon');
  });
