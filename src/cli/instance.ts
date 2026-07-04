import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { atomicWriteSync } from '../utils/atomic.js';
import { validateInstanceId } from '../utils/validate.js';
import {
  activeInstanceMarkerPath,
  resolveActiveInstance,
} from '../utils/resolve-active-instance.js';

/**
 * `cortextos instance` — read or set the active-instance marker.
 *
 * The marker (~/.cortextos/state/ACTIVE_INSTANCE) declares which instance bare
 * commands (no --instance, no CTX_INSTANCE_ID) resolve to. Without it, they fall
 * back to the legacy literal 'default'.
 *
 *   cortextos instance --show          # print resolved active instance + marker
 *   cortextos instance --set cortextos1  # write the marker
 *
 * NOTE: --set writes to the real ~/.cortextos on THIS machine. It is a
 * deliberate operator action; the WS7 code rollout does NOT invoke it.
 */
export const instanceCommand = new Command('instance')
  .description('Show or set the active-instance marker used for default resolution')
  .option('--show', 'Show the resolved active instance and marker path')
  .option('--set <id>', 'Write the active-instance marker to <id>')
  .action((options: { show?: boolean; set?: string }) => {
    const markerPath = activeInstanceMarkerPath();

    if (options.set !== undefined) {
      const id = options.set.trim();
      validateInstanceId(id);
      // atomicWriteSync creates parent dirs and appends the trailing newline.
      atomicWriteSync(markerPath, id);
      console.log(`Active instance marker set to '${id}' (${markerPath})`);
      return;
    }

    // Default action (and --show) both report current state.
    const markerExists = existsSync(markerPath);
    const markerValue = markerExists
      ? readFileSync(markerPath, 'utf-8').trim()
      : null;
    const resolved = resolveActiveInstance('default');

    console.log(`Resolved active instance: ${resolved}`);
    console.log(`Marker path: ${markerPath}`);
    if (markerExists) {
      console.log(`Marker contents: '${markerValue}'`);
    } else {
      console.log("Marker: (absent — falling back to legacy 'default')");
    }
  });
