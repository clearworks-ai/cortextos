import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseEtimeToSeconds,
  listDescendantPids,
  killProcessTree,
  type ProcessTableEntry,
} from '../../../src/utils/process-tree.js';

describe('parseEtimeToSeconds', () => {
  it('parses mm:ss', () => {
    expect(parseEtimeToSeconds('05:30')).toBe(330);
  });

  it('parses hh:mm:ss', () => {
    expect(parseEtimeToSeconds('02:05:30')).toBe(7530);
  });

  it('parses dd-hh:mm:ss', () => {
    expect(parseEtimeToSeconds('3-02:05:30')).toBe(3 * 86400 + 7530);
  });

  it('tolerates surrounding whitespace (raw ps output)', () => {
    expect(parseEtimeToSeconds('   00:42\n')).toBe(42);
  });

  it('returns null on garbage', () => {
    expect(parseEtimeToSeconds('')).toBeNull();
    expect(parseEtimeToSeconds('not-a-time')).toBeNull();
  });
});

describe('listDescendantPids', () => {
  // Tree: 100 → 200 → 300, 100 → 201; unrelated: 900 → 901
  const table: ProcessTableEntry[] = [
    { pid: 200, ppid: 100 },
    { pid: 201, ppid: 100 },
    { pid: 300, ppid: 200 },
    { pid: 901, ppid: 900 },
  ];

  it('BFS-walks the full descendant set, excluding the roots themselves', () => {
    const result = listDescendantPids([100], table);
    expect(result.sort()).toEqual([200, 201, 300]);
    expect(result).not.toContain(100);
  });

  it('does not leak unrelated branches', () => {
    expect(listDescendantPids([100], table)).not.toContain(901);
  });

  it('handles multiple roots with a shared snapshot', () => {
    expect(listDescendantPids([200, 900], table).sort()).toEqual([300, 901]);
  });

  it('returns [] for a leaf root', () => {
    expect(listDescendantPids([300], table)).toEqual([]);
  });
});

describe('killProcessTree safety rails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never signals pid 0, 1, or the daemon own pid', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessTree([0, 1, process.pid]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('ignores ESRCH/EPERM from already-dead or recycled pids', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    // 999999: near-certain nonexistent; must not throw
    expect(() => killProcessTree([999999])).not.toThrow();
    expect(killProcessTree([999999])).toEqual([]);
  });

  it('returns the list of successfully signaled pids', () => {
    const signaled: number[] = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 'SIGKILL') signaled.push(pid);
      return true;
    }) as typeof process.kill);
    // Use a pid with no descendants in the real table walk — the mock above
    // intercepts the actual SIGKILL either way.
    const killed = killProcessTree([999998]);
    expect(killed).toContain(999998);
    expect(signaled).toContain(999998);
  });
});
