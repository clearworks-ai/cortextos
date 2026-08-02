/**
 * pty-stub-dead-host.cjs — stub host that dies BEFORE sending pty-ready.
 *
 * Simulates the RW-5 failure regime: the forked pty-host child dies pre-ready
 * (OOM kill, module-load failure, posix_spawnp refusal). The client must
 * reject waitReady()/hostSpawn() instead of wedging forever.
 */

'use strict';

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'pty-spawn') {
    // Die without ever sending pty-ready or pty-error.
    process.exit(1);
  }
});

process.on('disconnect', () => {
  process.exit(0);
});
