import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-server.js';
import { writeStopMarker } from './stop.js';
import { resolveInstanceId } from './resolve-instance-id.js';
import type { IPCResponse } from '../types/index.js';

type RestartIPC = {
  send(request: { type: 'restart-agent'; agent: string; source: string }): Promise<IPCResponse>;
};

export function requestSerializedRestart(ipc: RestartIPC, agent: string): Promise<IPCResponse> {
  return ipc.send({ type: 'restart-agent', agent, source: 'cortextos restart' });
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

    // Write the .user-stop marker before the daemon-owned restart so the
    // SessionEnd crash-alert hook does not fire a false crash alarm during the
    // brief stop window. (BUG-036 pattern.)
    writeStopMarker(instanceId, agent, 'stopped via cortextos restart');
    // One daemon-owned restart request is required here. Sending independent
    // stop-agent and start-agent requests only waits for IPC acknowledgement,
    // not operation completion, so start can overtake the asynchronous stop
    // and the late stop can remove the replacement PID. AgentManager.restartAgent
    // awaits stopAgent before startAgent and owns the serialization contract.
    const response = await requestSerializedRestart(ipc, agent);
    if (!response.success) {
      console.error(`  Restart failed: ${response.error}`);
      process.exit(1);
    }
    console.log(`  ${response.data}`);
  });
