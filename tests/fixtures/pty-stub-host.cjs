/**
 * pty-stub-host.cjs — drop-in stub for pty-host-entry in tests.
 *
 * Accepts the same IPC protocol as pty-host-entry.ts but never allocates a
 * real pty. Instead it:
 *   1. Replies pty-ready with pid=9999 when it receives pty-spawn
 *   2. Echoes any pty-write data back as a pty-data message
 *   3. Sends pty-exit and exits when it receives pty-kill
 *   4. Sends pty-exit and exits when it receives pty-dispose (graceful
 *      teardown, RW-4) — unless PTY_STUB_IGNORE_DISPOSE=1, which simulates
 *      a wedged host so tests can prove the client escalates to SIGKILL.
 *
 * Cross-platform: no native addons, no /dev/ptmx.
 */

'use strict';

let spawned = false;
let killed = false;

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'pty-spawn':
      if (spawned) {
        process.send({ type: 'pty-error', message: 'already spawned' });
        return;
      }
      spawned = true;
      process.send({ type: 'pty-ready', pid: 9999 });
      break;

    case 'pty-write':
      if (spawned && !killed && typeof msg.data === 'string') {
        // Echo the write back as output — useful for round-trip tests
        process.send({ type: 'pty-data', data: msg.data });
      }
      break;

    case 'pty-resize':
      // Acknowledged — no-op for the stub
      break;

    case 'pty-kill':
      if (!killed) {
        killed = true;
        process.send({ type: 'pty-exit', exitCode: 0, signal: undefined });
        setTimeout(() => process.exit(0), 20);
      }
      break;

    case 'pty-dispose':
      if (process.env.PTY_STUB_IGNORE_DISPOSE === '1') {
        // Simulate a wedged host: never exit on its own. Keep the event loop
        // busy so only an external SIGKILL can take this process down.
        setInterval(() => {}, 1000);
        break;
      }
      if (!killed) {
        killed = true;
        process.send({ type: 'pty-exit', exitCode: 0, signal: undefined });
        setTimeout(() => process.exit(0), 20);
      } else {
        setTimeout(() => process.exit(0), 20);
      }
      break;

    default:
      break;
  }
});

process.on('disconnect', () => {
  process.exit(0);
});
