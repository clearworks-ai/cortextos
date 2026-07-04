import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { validateInstanceId } from '../utils/validate.js';
import {
  resolveActiveInstance,
  activeInstanceMarkerPath,
} from '../utils/resolve-active-instance.js';

/**
 * `cortextos instance --show / --set <id>`
 *
 * A small local-dev convenience for reading and writing the canonical-instance
 * marker (~/.cortextos/state/ACTIVE_INSTANCE) that resolve-instance-id.ts
 * consults when neither --instance nor CTX_INSTANCE_ID is provided.
 *
 * This does NOT perform any prod cutover on its own — it only reads/writes a
 * local marker file. Promoting an instance to canonical in a live fleet is a
 * separate, human-gated operation.
 */
export const instanceCommand = new Command('instance')
  .option('--show', 'Print the resolved active instance and the marker path')
  .option('--set <id>', 'Write the canonical-instance marker to <id>')
  .description('Show or set the canonical active instance (marker file)')
  .action((options: { show?: boolean; set?: string }) => {
    const markerPath = activeInstanceMarkerPath();

    if (options.set !== undefined) {
      const id = options.set.trim();
      try {
        validateInstanceId(id);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
      try {
        mkdirSync(dirname(markerPath), { recursive: true });
        writeFileSync(markerPath, id + '\n', 'utf-8');
      } catch (err) {
        console.error(`Error: failed to write marker: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(`Canonical instance set to '${id}'.`);
      console.log(`  Marker: ${markerPath}`);
      return;
    }

    // Default action (also covers --show): report the resolved active instance.
    const active = resolveActiveInstance('default');
    console.log(`Active instance: ${active}`);
    console.log(`Marker: ${markerPath}`);
  });
