/**
 * tests/unit/bus/enabled-agents-io.test.ts
 *
 * Tests for src/bus/enabled-agents-io.ts — the canonical locked+atomic
 * reader/writer for enabled-agents.json.
 *
 * Each test uses a fresh tempdir so file paths never collide.
 * Cleanup is best-effort (rmSync in afterEach).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  enabledAgentsPath,
  enabledAgentsLockDir,
  readEnabledAgentsMap,
  writeEnabledAgentsMap,
  mutateEnabledAgentsMap,
  type EnabledAgentsMap,
} from '../../../src/bus/enabled-agents-io.js';

// ---------------------------------------------------------------------------
// Per-test tempdir
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'enabled-agents-io-test-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('enabledAgentsPath', () => {
  it('returns config/enabled-agents.json under ctxRoot', () => {
    expect(enabledAgentsPath('/some/root')).toBe('/some/root/config/enabled-agents.json');
  });
});

describe('enabledAgentsLockDir', () => {
  it('returns config dir under ctxRoot', () => {
    expect(enabledAgentsLockDir('/some/root')).toBe('/some/root/config');
  });
});

// ---------------------------------------------------------------------------
// readEnabledAgentsMap — missing file
// ---------------------------------------------------------------------------

describe('readEnabledAgentsMap — missing file', () => {
  it('returns {} when the file does not exist', () => {
    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// writeEnabledAgentsMap + readEnabledAgentsMap round-trip
// ---------------------------------------------------------------------------

describe('round-trip write → read', () => {
  it('preserves a simple map', () => {
    const agents: EnabledAgentsMap = {
      larry: { enabled: true, org: 'clearworksai', status: 'active' },
      sage: { enabled: false },
    };
    writeEnabledAgentsMap(tmpRoot, agents);
    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual(agents);
  });

  it('creates the config directory if it does not exist', () => {
    const configDir = join(tmpRoot, 'config');
    expect(existsSync(configDir)).toBe(false);
    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: true } });
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(enabledAgentsPath(tmpRoot))).toBe(true);
  });

  it('round-trips an empty map', () => {
    writeEnabledAgentsMap(tmpRoot, {});
    expect(readEnabledAgentsMap(tmpRoot)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// .bak creation on second write
// ---------------------------------------------------------------------------

describe('.bak file', () => {
  it('is produced on the second write (first write has no prior file)', () => {
    const bakPath = enabledAgentsPath(tmpRoot) + '.bak';

    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: true } });
    // After first write: no .bak (no prior file existed)
    expect(existsSync(bakPath)).toBe(false);

    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: false } });
    // After second write: .bak should hold the first write's content
    expect(existsSync(bakPath)).toBe(true);

    const bakContent = JSON.parse(readFileSync(bakPath, 'utf-8')) as EnabledAgentsMap;
    expect(bakContent).toEqual({ larry: { enabled: true } });
  });

  it('primary is updated, .bak holds previous content after each write', () => {
    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: true } });
    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: false }, sage: { enabled: true } });

    const primary = JSON.parse(
      readFileSync(enabledAgentsPath(tmpRoot), 'utf-8'),
    ) as EnabledAgentsMap;
    const bak = JSON.parse(
      readFileSync(enabledAgentsPath(tmpRoot) + '.bak', 'utf-8'),
    ) as EnabledAgentsMap;

    expect(primary).toEqual({ larry: { enabled: false }, sage: { enabled: true } });
    expect(bak).toEqual({ larry: { enabled: true } });
  });
});

// ---------------------------------------------------------------------------
// atomicWriteSync crash-safe ordering: tmp written first, then bak, then rename
// ---------------------------------------------------------------------------

describe('atomic write ordering (crash-safety)', () => {
  it('primary is valid after write + read-back, and .bak holds previous content', () => {
    // First write — establish baseline
    const initial: EnabledAgentsMap = { larry: { enabled: true } };
    writeEnabledAgentsMap(tmpRoot, initial);

    // Second write — exercises the bak→rename sequence
    const updated: EnabledAgentsMap = { larry: { enabled: false }, sage: { enabled: true } };
    writeEnabledAgentsMap(tmpRoot, updated);

    // Primary must be fully valid (not half-written)
    const primary = JSON.parse(readFileSync(enabledAgentsPath(tmpRoot), 'utf-8')) as EnabledAgentsMap;
    expect(primary).toEqual(updated);

    // .bak must hold the prior content
    const bak = JSON.parse(
      readFileSync(enabledAgentsPath(tmpRoot) + '.bak', 'utf-8'),
    ) as EnabledAgentsMap;
    expect(bak).toEqual(initial);
  });
});

// ---------------------------------------------------------------------------
// Corrupt JSON — quarantine + return {}
// ---------------------------------------------------------------------------

describe('readEnabledAgentsMap — corrupt JSON', () => {
  it('quarantines corrupt primary to .broken-* and returns {}', () => {
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    const filePath = enabledAgentsPath(tmpRoot);
    const corruptBytes = '{ this is definitely not valid json ';
    writeFileSync(filePath, corruptBytes, 'utf-8');

    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({});

    // Primary must be gone (renamed to .broken-*)
    expect(existsSync(filePath)).toBe(false);

    // A .broken-<timestamp> file must exist in the config dir and hold the corrupt bytes
    const files = readdirSync(configDir);
    const brokenFiles = files.filter(f => f.startsWith('enabled-agents.json.broken-'));
    expect(brokenFiles).toHaveLength(1);
    const brokenContent = readFileSync(join(configDir, brokenFiles[0]), 'utf-8');
    expect(brokenContent).toBe(corruptBytes);
  });

  it('returns {} for a JSON array (wrong shape)', () => {
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(enabledAgentsPath(tmpRoot), JSON.stringify([{ name: 'larry' }]), 'utf-8');

    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({});
  });

  it('returns {} for JSON null (wrong shape)', () => {
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(enabledAgentsPath(tmpRoot), 'null', 'utf-8');

    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// .bak fallback recovery
// ---------------------------------------------------------------------------

describe('readEnabledAgentsMap — .bak fallback', () => {
  it('recovers from .bak when primary is corrupt but .bak is valid', () => {
    // Write twice so we have a valid .bak
    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: true } });
    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: false } });

    // Now corrupt the primary
    writeFileSync(enabledAgentsPath(tmpRoot), '{ bad json', 'utf-8');

    const result = readEnabledAgentsMap(tmpRoot);
    // .bak held the first write: { larry: { enabled: true } }
    expect(result).toEqual({ larry: { enabled: true } });
  });

  it('returns {} when primary is corrupt and .bak is also corrupt', () => {
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    const filePath = enabledAgentsPath(tmpRoot);
    writeFileSync(filePath, '{ bad primary', 'utf-8');
    writeFileSync(filePath + '.bak', '{ bad bak', 'utf-8');

    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({});
  });

  it('returns {} when primary is corrupt and .bak does not exist', () => {
    const configDir = join(tmpRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(enabledAgentsPath(tmpRoot), '{ bad primary', 'utf-8');
    // No .bak written.

    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// mutateEnabledAgentsMap
// ---------------------------------------------------------------------------

describe('mutateEnabledAgentsMap', () => {
  it('applies fn and persists the result', () => {
    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: true } });

    mutateEnabledAgentsMap(tmpRoot, (agents) => {
      agents['sage'] = { enabled: false };
    });

    const result = readEnabledAgentsMap(tmpRoot);
    expect(result).toEqual({ larry: { enabled: true }, sage: { enabled: false } });
  });

  it('returns the written map', () => {
    const returned = mutateEnabledAgentsMap(tmpRoot, () => {
      return { larry: { enabled: true } };
    });
    expect(returned).toEqual({ larry: { enabled: true } });
  });

  it('fn receives {} when file is missing', () => {
    let received: EnabledAgentsMap | null = null;
    mutateEnabledAgentsMap(tmpRoot, (agents) => {
      received = { ...agents };
    });
    expect(received).toEqual({});
  });

  it('persists even when fn mutates in place and returns void', () => {
    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: true } });

    mutateEnabledAgentsMap(tmpRoot, (agents) => {
      agents['larry'] = { enabled: false };
      // no return — void
    });

    expect(readEnabledAgentsMap(tmpRoot)).toEqual({ larry: { enabled: false } });
  });

  it('fn returning a new object replaces the map entirely', () => {
    writeEnabledAgentsMap(tmpRoot, { larry: { enabled: true }, sage: { enabled: true } });

    mutateEnabledAgentsMap(tmpRoot, () => {
      return { sage: { enabled: false } };
    });

    expect(readEnabledAgentsMap(tmpRoot)).toEqual({ sage: { enabled: false } });
  });
});

// ---------------------------------------------------------------------------
// No-lost-update: two sequential mutate calls preserve both keys
// ---------------------------------------------------------------------------

describe('mutateEnabledAgentsMap — no-lost-update correctness', () => {
  it('back-to-back mutate calls for different keys both persist (no lost update)', () => {
    // Simulate two separate callers each adding one agent — if read+write were
    // NOT locked together a naive re-read between the two would lose the first
    // agent.  Because mutate holds the lock for the full read-modify-write,
    // the second call sees the result of the first.
    mutateEnabledAgentsMap(tmpRoot, (agents) => {
      agents['larry'] = { enabled: true };
    });

    mutateEnabledAgentsMap(tmpRoot, (agents) => {
      agents['sage'] = { enabled: false };
    });

    const result = readEnabledAgentsMap(tmpRoot);
    expect(result['larry']).toEqual({ enabled: true });
    expect(result['sage']).toEqual({ enabled: false });
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('three sequential mutates accumulate all changes', () => {
    const agents = ['larry', 'sage', 'frank'] as const;
    for (const agent of agents) {
      mutateEnabledAgentsMap(tmpRoot, (map) => {
        map[agent] = { enabled: true };
      });
    }

    const result = readEnabledAgentsMap(tmpRoot);
    expect(Object.keys(result)).toHaveLength(3);
    for (const agent of agents) {
      expect(result[agent]).toEqual({ enabled: true });
    }
  });
});
