/**
 * WS7 — CLI instance-id resolution.
 *
 * Historically the final fallback across CLI entry points was the literal
 * 'default' — a DEAD instance (frozen 2026-06-25). The live fleet runs under
 * cortextos1, so bare commands (`cortextos status`, `cortextos restart <agent>`)
 * hit a frozen state tree and answered "Daemon is not running".
 *
 * These tests assert the NEW behavior: with no explicit --instance and no
 * CTX_INSTANCE_ID, resolution follows the ~/.cortextos/ACTIVE_INSTANCE marker
 * and falls back to 'cortextos1' — never 'default'. Explicit arg and env still
 * win, in that order.
 *
 * HOME is overridden per-test (lifecycle-markers.test.ts pattern) so the
 * user's REAL marker file can never leak into the assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { resolveInstanceId } from '../../../src/cli/resolve-instance-id';
import { resolveEnv } from '../../../src/utils/env';

describe('WS7: CLI instance-id resolution (resolveInstanceId + resolveEnv)', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  const origCtxInstanceId = process.env.CTX_INSTANCE_ID;
  const origCtxRoot = process.env.CTX_ROOT;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-ws7-cli-'));
    process.env.HOME = tmpHome;
    // Isolate from the caller's shell: these would win over the marker.
    delete process.env.CTX_INSTANCE_ID;
    delete process.env.CTX_ROOT;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCtxInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = origCtxInstanceId;
    if (origCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = origCtxRoot;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeMarker(content: string): void {
    mkdirSync(join(tmpHome, '.cortextos'), { recursive: true });
    writeFileSync(join(tmpHome, '.cortextos', 'ACTIVE_INSTANCE'), content, 'utf-8');
  }

  describe('resolveInstanceId (start/stop/restart/enable-agent/notify-agent/doctor/status path)', () => {
    it('falls back to cortextos1 (NOT "default") with no arg, no env, no marker', () => {
      expect(resolveInstanceId()).toBe('cortextos1');
      expect(resolveInstanceId(undefined)).not.toBe('default');
    });

    it('honors a valid ACTIVE_INSTANCE marker when no arg/env is given', () => {
      writeMarker('staging_2\n');
      expect(resolveInstanceId()).toBe('staging_2');
    });

    it('ignores an invalid marker and falls back to cortextos1', () => {
      writeMarker('Bad Id!\n');
      expect(resolveInstanceId()).toBe('cortextos1');
    });

    it('CTX_INSTANCE_ID env wins over the marker', () => {
      writeMarker('staging_2\n');
      process.env.CTX_INSTANCE_ID = 'env_instance';
      expect(resolveInstanceId()).toBe('env_instance');
    });

    it('explicit --instance value wins over env and marker', () => {
      writeMarker('staging_2\n');
      process.env.CTX_INSTANCE_ID = 'env_instance';
      expect(resolveInstanceId('explicit_one')).toBe('explicit_one');
    });

    it('explicit "default" is still honored (explicit arg always wins)', () => {
      writeMarker('staging_2\n');
      expect(resolveInstanceId('default')).toBe('default');
    });
  });

  describe('resolveEnv final instanceId fallback (bus-command entry point)', () => {
    it('resolves instanceId to cortextos1 with no override, no env, no marker', () => {
      const env = resolveEnv({ agentName: 'commander' });
      expect(env.instanceId).toBe('cortextos1');
      expect(env.ctxRoot).toBe(join(homedir(), '.cortextos', 'cortextos1'));
    });

    it('resolves instanceId from a valid marker', () => {
      writeMarker('staging_2\n');
      const env = resolveEnv({ agentName: 'commander' });
      expect(env.instanceId).toBe('staging_2');
      expect(env.ctxRoot).toBe(join(homedir(), '.cortextos', 'staging_2'));
    });

    it('CTX_INSTANCE_ID env still wins over the marker', () => {
      writeMarker('staging_2\n');
      process.env.CTX_INSTANCE_ID = 'env_instance';
      const env = resolveEnv({ agentName: 'commander' });
      expect(env.instanceId).toBe('env_instance');
    });

    it('overrides.instanceId still wins over everything', () => {
      writeMarker('staging_2\n');
      process.env.CTX_INSTANCE_ID = 'env_instance';
      const env = resolveEnv({ agentName: 'commander', instanceId: 'override_one' });
      expect(env.instanceId).toBe('override_one');
    });
  });
});
