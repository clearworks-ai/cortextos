/**
 * pty-stub-silent-host.cjs — stub host that stays alive but NEVER replies.
 *
 * Simulates the RW-5 hang regime: the forked pty-host child is alive but
 * loop-dead (never sends pty-ready, never exits). The client's waitReady()
 * deadline must fire and reject instead of awaiting forever.
 */

'use strict';

process.on('message', () => {
  // Swallow everything. Never reply. Never exit.
});

process.on('disconnect', () => {
  process.exit(0);
});
