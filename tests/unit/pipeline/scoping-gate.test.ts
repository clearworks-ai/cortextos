import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkScopingGate,
  defaultScopingManifestPath,
  readScopingManifest,
  workersMissingIntegrationEngineer,
  type ScopingManifest,
  type ScopedWorker,
} from '../../../src/pipeline/scoping-gate';

function worker(id: string, over: Partial<ScopedWorker> = {}): ScopedWorker {
  return {
    id,
    touchesLiveExternalSystem: false,
    integrationEngineerRan: false,
    exemplarGroundingPass1: false,
    ...over,
  };
}

// A fully-cleared single-Worker deal that touches a live system: both gates satisfied.
function clearedManifest(): ScopingManifest {
  return {
    slug: 'kadre-proposal-automation',
    workers: [
      worker('proposal-automation', {
        touchesLiveExternalSystem: true,
        integrationEngineerRan: true,
        exemplarGroundingPass1: true,
      }),
    ],
    exemplarGroundingPass2: true,
  };
}

describe('scoping-gate', () => {
  let dir: string;
  let manifestPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scoping-gate-'));
    manifestPath = join(dir, 'scoping-manifest.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('defaultScopingManifestPath', () => {
    it('places the manifest next to the ledger', () => {
      expect(defaultScopingManifestPath('/x/state/pipeline-ledger.jsonl')).toBe(
        '/x/state/scoping-manifest.json',
      );
    });
  });

  describe('readScopingManifest', () => {
    it('returns empty manifest when the file is missing', () => {
      expect(readScopingManifest(manifestPath)).toEqual({ slug: '', workers: [] });
    });

    it('returns empty manifest on unparseable JSON (never throws)', () => {
      writeFileSync(manifestPath, '{not json');
      expect(readScopingManifest(manifestPath)).toEqual({ slug: '', workers: [] });
    });

    it('fails SAFE: a Worker missing touchesLiveExternalSystem is treated as live', () => {
      writeFileSync(
        manifestPath,
        JSON.stringify({ slug: 's', workers: [{ id: 'w1' }] }),
      );
      const m = readScopingManifest(manifestPath);
      expect(m.workers[0].touchesLiveExternalSystem).toBe(true);
      expect(m.workers[0].integrationEngineerRan).toBe(false);
      expect(m.workers[0].exemplarGroundingPass1).toBe(false);
    });

    it('drops malformed worker entries (no id)', () => {
      writeFileSync(
        manifestPath,
        JSON.stringify({ slug: 's', workers: [{ id: 'ok' }, { nope: true }, 42] }),
      );
      const m = readScopingManifest(manifestPath);
      expect(m.workers.map((w) => w.id)).toEqual(['ok']);
    });
  });

  describe('gate #1 · integration-engineer MANDATORY GATE', () => {
    it('BLOCKS complexity finalize when a live-API Worker skipped integration-engineer', () => {
      const manifest: ScopingManifest = {
        slug: 'kadre',
        workers: [
          worker('proposal-automation', {
            touchesLiveExternalSystem: true,
            integrationEngineerRan: false,
            exemplarGroundingPass1: true, // grounding OK — isolate the IE gate
          }),
        ],
        exemplarGroundingPass2: true,
      };
      const r = checkScopingGate({ action: 'complexity', manifest });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe('INTEGRATION_ENGINEER_MISSING');
      expect(r.ok === false && r.detail).toContain('proposal-automation');
    });

    it('BLOCKS price finalize when a live-API Worker skipped integration-engineer', () => {
      const manifest: ScopingManifest = {
        slug: 'kadre',
        workers: [worker('lead-mgmt', { touchesLiveExternalSystem: true })],
        exemplarGroundingPass2: true,
      };
      const r = checkScopingGate({ action: 'price', manifest });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe('INTEGRATION_ENGINEER_MISSING');
    });

    it('does NOT block when the Worker touches no live external system', () => {
      const manifest: ScopingManifest = {
        slug: 'kadre',
        workers: [
          worker('local-only', {
            touchesLiveExternalSystem: false,
            integrationEngineerRan: false,
            exemplarGroundingPass1: true,
          }),
        ],
        exemplarGroundingPass2: true,
      };
      expect(checkScopingGate({ action: 'complexity', manifest }).ok).toBe(true);
    });

    it('lists every offending live-API Worker via helper', () => {
      const manifest: ScopingManifest = {
        slug: 'kadre',
        workers: [
          worker('a', { touchesLiveExternalSystem: true, integrationEngineerRan: true }),
          worker('b', { touchesLiveExternalSystem: true }),
          worker('c', { touchesLiveExternalSystem: false }),
          worker('d', { touchesLiveExternalSystem: true }),
        ],
      };
      expect(workersMissingIntegrationEngineer(manifest)).toEqual(['b', 'd']);
    });
  });

  describe('gate #2 · exemplar-grounding DOUBLE GATE', () => {
    it('BLOCKS complexity finalize when pass #1 has not run for a Worker', () => {
      const manifest: ScopingManifest = {
        slug: 'kadre',
        workers: [
          worker('proposal-automation', {
            touchesLiveExternalSystem: true,
            integrationEngineerRan: true, // IE OK — isolate the grounding gate
            exemplarGroundingPass1: false,
          }),
        ],
        exemplarGroundingPass2: true,
      };
      const r = checkScopingGate({ action: 'complexity', manifest });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe('EXEMPLAR_GROUNDING_MISSING');
      expect(r.ok === false && r.detail).toContain('pass #1');
    });

    it('BLOCKS price finalize when pass #2 has not run', () => {
      const manifest: ScopingManifest = {
        slug: 'kadre',
        workers: [
          worker('proposal-automation', {
            touchesLiveExternalSystem: true,
            integrationEngineerRan: true,
            exemplarGroundingPass1: true,
          }),
        ],
        exemplarGroundingPass2: false,
      };
      const r = checkScopingGate({ action: 'price', manifest });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe('EXEMPLAR_GROUNDING_MISSING');
      expect(r.ok === false && r.detail).toContain('pass #2');
    });

    it('BLOCKS deal-room finalize when pass #2 has not run (inherits pricing gate)', () => {
      const manifest = clearedManifest();
      manifest.exemplarGroundingPass2 = false;
      const r = checkScopingGate({ action: 'deal-room', manifest });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe('EXEMPLAR_GROUNDING_MISSING');
    });
  });

  describe('chain-order + happy path', () => {
    it('PASSES complexity when both gates hold', () => {
      expect(checkScopingGate({ action: 'complexity', manifest: clearedManifest() }).ok).toBe(
        true,
      );
    });

    it('PASSES price when both gates hold', () => {
      expect(checkScopingGate({ action: 'price', manifest: clearedManifest() }).ok).toBe(true);
    });

    it('PASSES deal-room when both gates hold', () => {
      expect(checkScopingGate({ action: 'deal-room', manifest: clearedManifest() }).ok).toBe(
        true,
      );
    });

    it('integration gate is checked BEFORE grounding (order): IE-missing beats grounding-missing', () => {
      const manifest: ScopingManifest = {
        slug: 'kadre',
        workers: [
          worker('w', {
            touchesLiveExternalSystem: true,
            integrationEngineerRan: false,
            exemplarGroundingPass1: false,
          }),
        ],
        exemplarGroundingPass2: false,
      };
      const r = checkScopingGate({ action: 'complexity', manifest });
      expect(r.ok === false && r.code).toBe('INTEGRATION_ENGINEER_MISSING');
    });

    it('rejects an unknown finalize action', () => {
      const r = checkScopingGate({
        // @ts-expect-error — deliberately invalid action
        action: 'invoice',
        manifest: clearedManifest(),
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe('UNKNOWN_ACTION');
    });
  });
});
