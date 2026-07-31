import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureMissionAnchorFromBuffer } from '../../../src/daemon/restart-context.js';

/**
 * Unit tests for mission-anchor freshness in restart-context.ts.
 *
 * Regression: a present-but-stale current-mission.txt used to block ALL refreshes
 * (the function returned early whenever the file merely existed), leaving agents to
 * resume onto days-old missions. The anchor must now also refresh when the existing
 * file is older than the 2h staleness threshold.
 */

function writeBuffer(ctxRoot: string, agentName: string, contents: string): void {
  const dir = join(ctxRoot, 'state', agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'conversation-buffer.jsonl'), contents, 'utf-8');
}

function inboundLine(agentName: string, content: string): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    sender: 'josh',
    via: 'telegram',
    content,
    chat_id: '123',
  });
}

describe('ensureMissionAnchorFromBuffer freshness', () => {
  let root: string;
  let agentDir: string;
  let ctxRoot: string;
  const agentName = 'testagent';

  beforeEach(() => {
    root = join(tmpdir(), `restart-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    agentDir = join(root, 'agents', agentName);
    ctxRoot = join(root, 'ctx');
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('writes the anchor when the file is absent', () => {
    writeBuffer(ctxRoot, agentName, inboundLine(agentName, 'do the new mission'));

    ensureMissionAnchorFromBuffer(agentDir, ctxRoot, agentName);

    const missionPath = join(agentDir, 'state', 'current-mission.txt');
    expect(existsSync(missionPath)).toBe(true);
    expect(readFileSync(missionPath, 'utf-8')).toContain('do the new mission');
  });

  it('does NOT overwrite a fresh anchor (age <= 2h)', () => {
    const missionPath = join(agentDir, 'state', 'current-mission.txt');
    mkdirSync(join(agentDir, 'state'), { recursive: true });
    writeFileSync(missionPath, 'existing fresh mission', 'utf-8');
    writeBuffer(ctxRoot, agentName, inboundLine(agentName, 'a newer inbound mission'));

    ensureMissionAnchorFromBuffer(agentDir, ctxRoot, agentName);

    expect(readFileSync(missionPath, 'utf-8')).toBe('existing fresh mission');
  });

  it('refreshes the anchor when the existing file is stale (age > 2h)', () => {
    const missionPath = join(agentDir, 'state', 'current-mission.txt');
    mkdirSync(join(agentDir, 'state'), { recursive: true });
    writeFileSync(missionPath, 'days-old stale mission', 'utf-8');
    // backdate mtime to 3h ago
    const threeHoursAgoSec = Date.now() / 1000 - 3 * 3600;
    utimesSync(missionPath, threeHoursAgoSec, threeHoursAgoSec);

    writeBuffer(ctxRoot, agentName, inboundLine(agentName, 'the current authoritative mission'));

    ensureMissionAnchorFromBuffer(agentDir, ctxRoot, agentName);

    const written = readFileSync(missionPath, 'utf-8');
    expect(written).toContain('the current authoritative mission');
    expect(written).not.toContain('days-old stale mission');
  });

  it('leaves a stale anchor untouched when no inbound is derivable (non-destructive)', () => {
    const missionPath = join(agentDir, 'state', 'current-mission.txt');
    mkdirSync(join(agentDir, 'state'), { recursive: true });
    writeFileSync(missionPath, 'stale but only outbound in buffer', 'utf-8');
    const threeHoursAgoSec = Date.now() / 1000 - 3 * 3600;
    utimesSync(missionPath, threeHoursAgoSec, threeHoursAgoSec);

    // buffer contains only the agent's own outbound message => no inbound to derive from
    writeBuffer(
      ctxRoot,
      agentName,
      JSON.stringify({ ts: new Date().toISOString(), sender: agentName, via: 'telegram', content: 'back — idle' }),
    );

    ensureMissionAnchorFromBuffer(agentDir, ctxRoot, agentName);

    expect(readFileSync(missionPath, 'utf-8')).toBe('stale but only outbound in buffer');
  });
});
