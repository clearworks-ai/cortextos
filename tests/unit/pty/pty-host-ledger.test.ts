/**
 * pty-host-ledger.test.ts — RW-6 durable PID ledger unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
  ledgerPathFor,
  readPtyHostLedger,
  recordPtyHost,
  updatePtyHostPtyPid,
  removePtyHost,
  isPidAlive,
  type PtyHostLedgerEntry,
} from '../../../src/pty/pty-host-ledger.js';

let ctxRoot: string;
let ledgerPath: string;

function entry(overrides: Partial<PtyHostLedgerEntry> = {}): PtyHostLedgerEntry {
  return {
    hostPid: 11111,
    ptyPid: 0,
    file: 'claude',
    agent: 'alice',
    daemonPid: process.pid,
    startedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'pty-ledger-test-'));
  ledgerPath = ledgerPathFor(ctxRoot);
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('pty-host-ledger', () => {
  it('ledgerPathFor points at <ctxRoot>/state/pty-hosts.json', () => {
    expect(ledgerPath).toBe(join(ctxRoot, 'state', 'pty-hosts.json'));
  });

  it('read on a missing file returns []', () => {
    expect(readPtyHostLedger(ledgerPath)).toEqual([]);
  });

  it('record → read roundtrip', () => {
    const e = entry();
    recordPtyHost(ledgerPath, e);
    expect(existsSync(ledgerPath)).toBe(true);
    expect(readPtyHostLedger(ledgerPath)).toEqual([e]);
  });

  it('record replaces a stale entry with the same hostPid', () => {
    recordPtyHost(ledgerPath, entry({ agent: 'old' }));
    recordPtyHost(ledgerPath, entry({ agent: 'new' }));
    const hosts = readPtyHostLedger(ledgerPath);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].agent).toBe('new');
  });

  it('updatePtyHostPtyPid fills in the pty child pid', () => {
    recordPtyHost(ledgerPath, entry());
    updatePtyHostPtyPid(ledgerPath, 11111, 22222);
    expect(readPtyHostLedger(ledgerPath)[0].ptyPid).toBe(22222);
  });

  it('updatePtyHostPtyPid on an unknown host is a no-op', () => {
    recordPtyHost(ledgerPath, entry());
    updatePtyHostPtyPid(ledgerPath, 99999, 22222);
    expect(readPtyHostLedger(ledgerPath)[0].ptyPid).toBe(0);
  });

  it('removePtyHost deletes only the matching entry', () => {
    recordPtyHost(ledgerPath, entry({ hostPid: 1 }));
    recordPtyHost(ledgerPath, entry({ hostPid: 2 }));
    removePtyHost(ledgerPath, 1);
    const hosts = readPtyHostLedger(ledgerPath);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostPid).toBe(2);
  });

  it('corrupt JSON reads as [] and never throws', () => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, '{not json', 'utf-8');
    expect(readPtyHostLedger(ledgerPath)).toEqual([]);
    // and a write on top of corruption recovers the file
    recordPtyHost(ledgerPath, entry());
    expect(readPtyHostLedger(ledgerPath)).toHaveLength(1);
  });

  it('entries with invalid shapes are filtered on read', () => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      JSON.stringify({ version: 1, hosts: [entry(), null, { hostPid: 0 }, 'junk'] }),
      'utf-8',
    );
    const hosts = readPtyHostLedger(ledgerPath);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostPid).toBe(11111);
  });

  it('ledger file survives round-trips as valid JSON with version field', () => {
    recordPtyHost(ledgerPath, entry());
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(Array.isArray(raw.hosts)).toBe(true);
  });

  it('isPidAlive: own pid alive, absurd pid dead, non-positive dead', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    // pid_max on macOS is 99998; 2^28 can never be a live pid
    expect(isPidAlive(2 ** 28)).toBe(false);
  });
});
