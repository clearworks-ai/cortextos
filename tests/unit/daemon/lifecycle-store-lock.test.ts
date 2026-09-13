import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  acquireStoreLock,
  releaseStoreLock,
  withStoreLock,
  type StoreLockHandle,
} from '../../../src/daemon/lifecycle/store-lock';

describe('generation-bound store lock', () => {
  let lockRoot: string;

  beforeEach(() => {
    lockRoot = mkdtempSync(join(tmpdir(), 'cortextos-store-lock-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(lockRoot, { recursive: true, force: true });
  });

  function lockDirEntries(): string[] {
    return readdirSync(lockRoot);
  }

  it('exact-owner release succeeds and frees the slot', () => {
    const handle = acquireStoreLock(lockRoot, 'owner-a');
    expect(handle).not.toBeNull();
    expect(lockDirEntries()).toContain('.lock.d');

    releaseStoreLock(handle as StoreLockHandle);
    expect(lockDirEntries()).not.toContain('.lock.d');

    // Slot is free again -- a fresh acquire succeeds.
    const second = acquireStoreLock(lockRoot, 'owner-b');
    expect(second).not.toBeNull();
  });

  it('stale-handle release (different owner token now holds the slot) is a no-op', () => {
    const handle = acquireStoreLock(lockRoot, 'owner-a');
    expect(handle).not.toBeNull();

    // Simulate a different owner now holding the SAME physical directory
    // (same device+inode) by rewriting the identity file's ownerToken in
    // place, without touching the directory itself.
    const identityPath = join(lockRoot, '.lock.d', 'identity.json');
    const identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
    identity.ownerToken = 'owner-different';
    writeFileSync(identityPath, JSON.stringify(identity));

    releaseStoreLock(handle as StoreLockHandle);

    // The slot must still be there -- release was a no-op.
    expect(lockDirEntries()).toContain('.lock.d');
  });

  it('device/inode mismatch after directory replacement makes release a no-op', () => {
    const handle = acquireStoreLock(lockRoot, 'owner-a');
    expect(handle).not.toBeNull();

    // Externally delete-and-recreate `.lock.d` at the same path, simulating
    // a replaced directory (different inode, same path string).
    const lockPath = join(lockRoot, '.lock.d');
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'identity.json'),
      JSON.stringify({
        ownerToken: 'owner-a',
        pid: process.pid,
        acquiredAtMs: Date.now(),
        rootDev: 0,
        rootIno: 0,
      }),
    );

    releaseStoreLock(handle as StoreLockHandle);

    // The recreated directory must still be present -- release did not
    // touch it because the device+inode no longer match the handle.
    expect(existsSync(lockPath)).toBe(true);
  });

  it('concurrent takeover: exactly one of two racing acquirers wins', () => {
    const first = acquireStoreLock(lockRoot, 'owner-a');
    const second = acquireStoreLock(lockRoot, 'owner-b');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('delayed publisher: an empty .lock.d (rename won, identity not yet written) refuses, never steals', () => {
    // Fabricate the fixture directly: `.lock.d` exists but has no identity
    // file inside it yet -- the state a real holder would be in between
    // winning its rename and finishing its identity write.
    mkdirSync(join(lockRoot, '.lock.d'));

    const result = acquireStoreLock(lockRoot, 'owner-b');
    expect(result).toBeNull();

    // The fabricated slot must be untouched -- no steal occurred.
    expect(existsSync(join(lockRoot, '.lock.d'))).toBe(true);
    expect(existsSync(join(lockRoot, '.lock.d', 'identity.json'))).toBe(false);
  });

  it('missing identity file (existing, non-empty .lock.d with no identity.json) refuses', () => {
    const lockPath = join(lockRoot, '.lock.d');
    mkdirSync(lockPath);
    // Non-empty, but not the identity file -- still "missing identity".
    writeFileSync(join(lockPath, 'some-other-file'), 'noise');

    const result = acquireStoreLock(lockRoot, 'owner-b');
    expect(result).toBeNull();
  });

  it('corrupt identity file (malformed JSON) refuses', () => {
    const lockPath = join(lockRoot, '.lock.d');
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'identity.json'), '{not valid json::');

    const result = acquireStoreLock(lockRoot, 'owner-b');
    expect(result).toBeNull();
  });

  it('corrupt identity file (well-formed JSON, wrong shape) refuses', () => {
    const lockPath = join(lockRoot, '.lock.d');
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'identity.json'), JSON.stringify({ garbage: true }));

    const result = acquireStoreLock(lockRoot, 'owner-b');
    expect(result).toBeNull();
  });

  it('dead holder is reclaimed and a tombstone is created for the superseded lock', () => {
    // Guaranteed-dead PID: spawnSync blocks until the child exits, so by
    // the time it returns the PID is definitely no longer alive. This
    // avoids relying on a synthetic large PID, which could theoretically
    // collide with a live process on some systems.
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid;
    expect(typeof deadPid).toBe('number');

    const lockPath = join(lockRoot, '.lock.d');
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'identity.json'),
      JSON.stringify({
        ownerToken: 'owner-dead',
        pid: deadPid,
        acquiredAtMs: Date.now() - 60_000,
        rootDev: 0,
        rootIno: 0,
      }),
    );

    const result = acquireStoreLock(lockRoot, 'owner-new');
    expect(result).not.toBeNull();

    const entries = lockDirEntries();
    const tombstone = entries.find((e) => e.startsWith('.lock.d.tombstone-'));
    expect(tombstone).toBeDefined();

    // Reclaimer is now the live holder.
    const newIdentity = JSON.parse(readFileSync(join(lockPath, 'identity.json'), 'utf-8'));
    expect(newIdentity.ownerToken).toBe('owner-new');
  });

  it('ambiguous liveness (EPERM) refuses -- differs from the dead-holder case', () => {
    const lockPath = join(lockRoot, '.lock.d');
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'identity.json'),
      JSON.stringify({
        ownerToken: 'owner-ambiguous',
        pid: 999999, // arbitrary -- process.kill is mocked below
        acquiredAtMs: Date.now(),
        rootDev: 0,
        rootIno: 0,
      }),
    );

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const result = acquireStoreLock(lockRoot, 'owner-new');
    expect(result).toBeNull();

    // Exclusion preserved -- no tombstone was created.
    expect(lockDirEntries().some((e) => e.startsWith('.lock.d.tombstone-'))).toBe(false);

    killSpy.mockRestore();
  });

  it('contention returns null immediately -- no retry/backoff loop', () => {
    const held = acquireStoreLock(lockRoot, 'owner-a');
    expect(held).not.toBeNull();

    const start = process.hrtime.bigint();
    const result = acquireStoreLock(lockRoot, 'owner-b');
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(50);
  });

  it('withStoreLock runs fn and releases even when fn throws', () => {
    expect(() =>
      withStoreLock(lockRoot, 'owner-a', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // Lock was released in the finally -- a fresh acquire succeeds.
    const handle = acquireStoreLock(lockRoot, 'owner-b');
    expect(handle).not.toBeNull();
  });

  it('withStoreLock returns null immediately on contention without invoking fn', () => {
    const held = acquireStoreLock(lockRoot, 'owner-a');
    expect(held).not.toBeNull();

    const fn = vi.fn(() => 'should-not-run');
    const result = withStoreLock(lockRoot, 'owner-b', fn);

    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('withStoreLock returns fn result on success', () => {
    const result = withStoreLock(lockRoot, 'owner-a', () => 42);
    expect(result).toBe(42);
  });
});
