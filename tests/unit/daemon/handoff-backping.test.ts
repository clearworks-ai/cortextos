import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  HANDOFF_BACKPING_SUPPRESS_MS,
  readLastBackPingMs,
  shouldSuppressBackPing,
  writeLastBackPingMs,
} from '../../../src/daemon/handoff-backping.js';

describe('handoff back-ping dedup', () => {
  const W = HANDOFF_BACKPING_SUPPRESS_MS;
  const NOW = 1_000_000_000_000;

  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-handoff-backping-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('allows when there is no prior ping', () => {
    expect(shouldSuppressBackPing({
      lastPingMs: null,
      nowMs: NOW,
      newestInboundMs: null,
      windowMs: W,
    })).toBe(false);
  });

  it('allows when the suppression window has elapsed', () => {
    expect(shouldSuppressBackPing({
      lastPingMs: NOW - W - 1,
      nowMs: NOW,
      newestInboundMs: null,
      windowMs: W,
    })).toBe(false);
  });

  it('suppresses within the window when there is no newer inbound message', () => {
    expect(shouldSuppressBackPing({
      lastPingMs: NOW - 1000,
      nowMs: NOW,
      newestInboundMs: NOW - 5000,
      windowMs: W,
    })).toBe(true);
  });

  it('allows within the window when a newer inbound message arrived', () => {
    expect(shouldSuppressBackPing({
      lastPingMs: NOW - 1000,
      nowMs: NOW,
      newestInboundMs: NOW - 500,
      windowMs: W,
    })).toBe(false);
  });

  it('suppresses within the window when newest inbound is null', () => {
    expect(shouldSuppressBackPing({
      lastPingMs: NOW - 1000,
      nowMs: NOW,
      newestInboundMs: null,
      windowMs: W,
    })).toBe(true);
  });

  it('allows on the exact elapsed-window boundary', () => {
    expect(shouldSuppressBackPing({
      lastPingMs: NOW - W,
      nowMs: NOW,
      newestInboundMs: null,
      windowMs: W,
    })).toBe(false);
  });

  it('round-trips the persisted marker file', () => {
    writeLastBackPingMs(ctxRoot, 'agent-a', NOW);
    expect(readLastBackPingMs(ctxRoot, 'agent-a')).toBe(NOW);
  });

  it('treats a corrupt marker file as unreadable', () => {
    const stateDir = join(ctxRoot, 'state', 'agent-a');
    writeLastBackPingMs(ctxRoot, 'agent-a', NOW);
    writeFileSync(join(stateDir, '.last-back-ping'), 'not-a-number', 'utf-8');
    expect(readLastBackPingMs(ctxRoot, 'agent-a')).toBeNull();
  });
});
