import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  verifyChainDetailed,
  verifyOneBigFeatureArtifacts,
  type LedgerRow,
  type LedgerVerifyFailure,
  defaultLedgerPath,
  readLedgerRows,
} from './ledger.js';
import { checkPhaseSequence, defaultPhaseLockPath } from './phase-lock.js';

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
  | 'PHASE_SKIPPED'
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

/**
 * Expand a leading ~ / ~/ to $HOME, matching gate-codexer-planning.sh's shell
 * expansion. build-gate.ts is the non-shell backstop chokepoint, so it must not
 * treat a literal '~' as a path segment when the hook (which does expand) is bypassed.
 */
function normalizeRepo(repo: string): string {
  if (repo === '~') return homedir();
  if (repo.startsWith('~/')) return join(homedir(), repo.slice(2));
  return repo;
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

  // Resolve ONE canonical ledger path and reuse it for BOTH the signed-chain verify
  // and the phase-sequencing check. Must NOT derive from directive.repo: the ledger
  // lives at the framework root (CTX_PROJECT_ROOT/CTX_FRAMEWORK_ROOT/cwd), while repo=
  // is dispatcher-controlled free text that, under the fleet's mandated worktree-isolated
  // build pattern, points at a worktree holding only a STALE clone-time ledger snapshot.
  // Deriving the phase check from repo would (a) false-block phases that shipped after the
  // worktree was cut, and (b) let a repo= pointed at an attacker-writable dir plant
  // fabricated true-verify rows, silently bypassing the sequencing gate. Matches
  // stage-emit.ts, which hoists one ledgerPath and never resolves it from --repo.
  const ledgerPath = defaultLedgerPath();

  const chain = verifyChainDetailed({
    slug: directive.slug,
    throughStage: directive.exempt ? 'exempt' : 'specs',
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
    scopeSha: directive.exempt ? undefined : directive.scopeSha,
    ledgerPath,
  });
  if (!chain.ok) {
    if (chain.code === 'SECRET_UNREADABLE') {
      throw brokenGateError(chain.detail);
    }
    throw new BuildGateError(chain.code, chain.detail);
  }

  if (directive.framework === 'one-big-feature') {
    // repo= locates the on-disk OBF planning artifacts (they DO live in the worktree),
    // so this one legitimately uses repo — but normalized + existence-checked first,
    // mirroring the shell hook's `[ -d "$REPO" ]` + ~ expansion for the non-shell path.
    const repoRoot = normalizeRepo(directive.repo);
    if (!existsSync(repoRoot)) {
      throw new BuildGateError(
        'INVALID_DIRECTIVE',
        `Build dispatch repo= does not exist on disk: ${directive.repo}. OBF artifact verification needs a real checkout/worktree path.`,
      );
    }
    const artifacts = verifyOneBigFeatureArtifacts({
      projectRoot: repoRoot,
      slug: directive.slug,
      rows: chain.rows,
    });
    if (!artifacts.ok) {
      throw new BuildGateError(artifacts.code, artifacts.detail);
    }
  }

  // Check phase sequencing before allowing dispatch — same canonical ledger as the chain.
  const rows = readLedgerRows(ledgerPath);
  const phaseCheck = checkPhaseSequence({
    slug: directive.slug,
    rows: rows,
    lockPath: defaultPhaseLockPath(ledgerPath),
  });
  if (!phaseCheck.ok) {
    throw new BuildGateError(phaseCheck.code, phaseCheck.detail);
  }

  return directive;
}
