import {
  verifyChainDetailed,
  verifyOneBigFeatureArtifacts,
  type LedgerVerifyFailure,
} from './ledger.js';

const BUILD_TARGETS = new Set(['codexer', 'opencoder', 'opencode']);
const DEFAULT_MAX_AGE_SECONDS = 86_400;

export interface BuildDirective {
  framework: string;
  slug: string;
  repo: string;
  scopeSha?: string;
  exempt: boolean;
}

export type BuildGateCode =
  | 'INVALID_DIRECTIVE'
  | 'ORDERING'
  | 'PIPELINE_GATE_BROKEN'
  | LedgerVerifyFailure['code'];

export class BuildGateError extends Error {
  constructor(
    public readonly code: BuildGateCode,
    message: string,
  ) {
    super(message);
    this.name = 'BuildGateError';
  }
}

export function isBuildWorker(target: string): boolean {
  return BUILD_TARGETS.has(target);
}

export function parseBuildDirective(text: string): BuildDirective | null {
  if (!/\bGATE:\s*build\b/i.test(text)) return null;

  const framework = text.match(/\bframework=([A-Za-z0-9_-]+)/i)?.[1]?.toLowerCase() ?? '';
  const slug = text.match(/\bslug=([A-Za-z0-9-]+)/)?.[1] ?? '';
  const repo = text.match(/\brepo=([^\s'"]+)/)?.[1] ?? '';
  const scopeSha = text.match(/\bscope-sha=([a-f0-9]{64})\b/i)?.[1]?.toLowerCase();
  const exempt = /(?:^|\s)exempt=true(?:\s|$)/i.test(text);

  if (!framework || !slug || !repo) {
    throw new BuildGateError(
      'INVALID_DIRECTIVE',
      'Build dispatch missing framework=, slug=, or repo=. Required shape: GATE: build framework=<...> slug=<...> repo=<...> scope-sha=<64-hex>.',
    );
  }
  if (!exempt && !scopeSha) {
    throw new BuildGateError(
      'INVALID_DIRECTIVE',
      'Build dispatch missing scope-sha=<64-hex>. Dispatches must bind to the signed specs artifact.',
    );
  }

  return {
    framework,
    slug,
    repo,
    scopeSha,
    exempt,
  };
}

function brokenGateError(detail: string): BuildGateError {
  return new BuildGateError(
    'PIPELINE_GATE_BROKEN',
    `PIPELINE_GATE_BROKEN: ${detail} — restore with 'bin/pipeline-provision-secret' (Josh-run); build dispatch blocked.`,
  );
}

export function enforceBuildDispatchGate(to: string, text: string): BuildDirective | null {
  if (!isBuildWorker(to)) return null;
  const directive = parseBuildDirective(text);
  if (!directive) return null;

  const chain = verifyChainDetailed({
    slug: directive.slug,
    throughStage: directive.exempt ? 'exempt' : 'specs',
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
    scopeSha: directive.exempt ? undefined : directive.scopeSha,
  });
  if (!chain.ok) {
    if (chain.code === 'SECRET_UNREADABLE') {
      throw brokenGateError(chain.detail);
    }
    throw new BuildGateError(chain.code, chain.detail);
  }

  if (directive.framework === 'one-big-feature') {
    const artifacts = verifyOneBigFeatureArtifacts({
      projectRoot: directive.repo,
      slug: directive.slug,
      rows: chain.rows,
    });
    if (!artifacts.ok) {
      throw new BuildGateError(artifacts.code, artifacts.detail);
    }
  }

  return directive;
}
