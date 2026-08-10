import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkCoherence,
  defaultChainPaths,
  initDealContext,
  readDealContext,
  slugifyClient,
  type DealContext,
} from '../../../src/pipeline/deal-context';
import { readScopingManifest } from '../../../src/pipeline/scoping-gate';

const PHASES = [
  { id: 'phase-0-audit', name: 'Audit & Pilot' },
  { id: 'phase-1-build', name: 'Main Build' },
  { id: 'ongoing-retainer', name: 'Retainer' },
];

/** A markdown artifact tagging each phase with the machine marker + priced. */
function stageArtifact(phaseIds: string[], opts: { priced?: boolean; placeholder?: boolean } = {}): string {
  const { priced = true, placeholder = false } = opts;
  return phaseIds
    .map((id) => {
      const price = placeholder ? '[CONFIRM PRICE: $X]' : priced ? '$10,000' : 'TBD';
      return `## ${id}\n<!-- phase: ${id} -->\nPrice: ${price}\n`;
    })
    .join('\n');
}

function writeDealDir(dir: string, over: Partial<DealContext> = {}): void {
  const paths = defaultChainPaths(dir);
  const context: DealContext = {
    slug: 'acme-co',
    client: 'Acme Co',
    engagement: 'lead-triage automation',
    phases: PHASES,
    artifacts: {
      proposal: 'proposal.md',
      pricing: 'pricing.md',
      dealRoom: 'deal-room.md',
    },
    ...over,
  };
  writeFileSync(paths.context, JSON.stringify(context, null, 2));
}

describe('deal-context', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deal-context-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('slugifyClient', () => {
    it('normalizes to a stable slug', () => {
      expect(slugifyClient('  Acme Co., Inc! ')).toBe('acme-co-inc');
      expect(slugifyClient('Kadre')).toBe('kadre');
    });
  });

  describe('initDealContext', () => {
    it('seeds both the context and the scoping manifest', () => {
      const { context, paths, created } = initDealContext({
        dir,
        client: 'Acme Co',
        engagement: 'lead-triage automation',
        phases: PHASES,
        liveExternalWorkers: ['crm-sync'],
      });
      expect(created).toBe(true);
      expect(context.slug).toBe('acme-co');
      expect(readDealContext(paths.context).phases).toHaveLength(3);
      const manifest = readScopingManifest(paths.manifest);
      expect(manifest.slug).toBe('acme-co');
      expect(manifest.workers[0]).toMatchObject({
        id: 'crm-sync',
        touchesLiveExternalSystem: true,
        integrationEngineerRan: false,
      });
    });

    it('is idempotent by slug (re-init does not wipe progress)', () => {
      const first = initDealContext({ dir, client: 'Acme Co', engagement: 'x', phases: PHASES });
      // record a stage artifact into the context
      const withArtifact = { ...readDealContext(first.paths.context), artifacts: { proposal: 'proposal.md' } };
      writeFileSync(first.paths.context, JSON.stringify(withArtifact, null, 2));
      const second = initDealContext({ dir, client: 'Acme Co', engagement: 'x', phases: PHASES });
      expect(second.created).toBe(false);
      expect(readDealContext(second.paths.context).artifacts?.proposal).toBe('proposal.md');
    });
  });

  describe('checkCoherence', () => {
    function seedArtifacts(over: { proposalIds?: string[]; pricingIds?: string[]; dealRoomIds?: string[]; placeholder?: boolean } = {}): void {
      const ids = PHASES.map((p) => p.id);
      writeFileSync(join(dir, 'proposal.md'), stageArtifact(over.proposalIds ?? ids));
      writeFileSync(join(dir, 'pricing.md'), stageArtifact(over.pricingIds ?? ids));
      writeFileSync(join(dir, 'deal-room.md'), stageArtifact(over.dealRoomIds ?? ids, { placeholder: over.placeholder }));
    }

    it('passes when every stage shares the phase spine', () => {
      writeDealDir(dir);
      seedArtifacts();
      const ctx = readDealContext(defaultChainPaths(dir).context);
      const result = checkCoherence({ context: ctx, baseDir: dir });
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('fails on a phase-set mismatch between stages', () => {
      writeDealDir(dir);
      seedArtifacts({ pricingIds: ['phase-0-audit', 'phase-1-build'] }); // dropped retainer
      const ctx = readDealContext(defaultChainPaths(dir).context);
      const result = checkCoherence({ context: ctx, baseDir: dir });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'PHASE_MISMATCH')).toBe(true);
      expect(result.issues.some((i) => i.code === 'UNPRICED_PHASE')).toBe(true);
    });

    it('fails when a required stage artifact is missing', () => {
      writeDealDir(dir, { artifacts: { proposal: 'proposal.md', pricing: 'pricing.md' } });
      seedArtifacts();
      const ctx = readDealContext(defaultChainPaths(dir).context);
      const result = checkCoherence({ context: ctx, baseDir: dir });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'MISSING_ARTIFACT')).toBe(true);
    });

    it('fails when a recorded artifact is not on disk', () => {
      writeDealDir(dir);
      writeFileSync(join(dir, 'pricing.md'), stageArtifact(PHASES.map((p) => p.id)));
      writeFileSync(join(dir, 'deal-room.md'), stageArtifact(PHASES.map((p) => p.id)));
      // proposal.md intentionally not written
      const ctx = readDealContext(defaultChainPaths(dir).context);
      const result = checkCoherence({ context: ctx, baseDir: dir });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'ARTIFACT_NOT_ON_DISK')).toBe(true);
    });

    it('fails when the deal room still carries a placeholder', () => {
      writeDealDir(dir);
      seedArtifacts({ placeholder: true });
      const ctx = readDealContext(defaultChainPaths(dir).context);
      const result = checkCoherence({ context: ctx, baseDir: dir });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'UNCONFIRMED_PRICE_IN_DEALROOM')).toBe(true);
    });

    it('flags a scoping-manifest slug that disagrees with the context', () => {
      writeDealDir(dir);
      seedArtifacts();
      const ctx = readDealContext(defaultChainPaths(dir).context);
      const result = checkCoherence({
        context: ctx,
        baseDir: dir,
        scopingManifest: { slug: 'other-deal', workers: [] },
      });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'SCOPING_MANIFEST_SLUG_MISMATCH')).toBe(true);
    });

    it('returns NO_CONTEXT when the context is empty', () => {
      const result = checkCoherence({ context: readDealContext(join(dir, 'missing.json')), baseDir: dir });
      expect(result.ok).toBe(false);
      expect(result.issues[0].code).toBe('NO_CONTEXT');
    });
  });
});
