import { existsSync, statSync } from 'fs';
import {
  STAGES,
  defaultLedgerPath,
  defaultSecretPath,
  emitLedgerRow,
  verifyChainDetailed,
  verifyOneBigFeatureArtifacts,
  type LedgerRow,
  type Stage,
} from './ledger.js';

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    if (!rawKey) continue;
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[rawKey] = true;
      continue;
    }
    flags[rawKey] = next;
    index += 1;
  }

  return { flags, positional };
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function requireString(flags: Record<string, string | boolean>, name: string): string {
  const value = stringFlag(flags, name);
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function parseStage(value: string | undefined, field: string): Stage {
  if (!value || !(STAGES as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${field}: expected one of ${STAGES.join(', ')}`);
  }
  return value as Stage;
}

function usage(): string {
  return [
    'Usage:',
    '  pipeline-stage-emit --slug <slug> --stage <stage> --artifact <path> [--runner <runner> --session <id> --transcript <path>] [--evidence <path>] [--reason <text>] [--ledger <path>] [--secret <path>]',
    '  pipeline-stage-emit --verify --slug <slug> --through <stage> --max-age <seconds> [--scope-sha <sha>] [--repo <path>] [--framework <name>] [--ledger <path>] [--secret <path>]',
  ].join('\n');
}

function printAndExit(message: string, code: number, stderr = true): never {
  (stderr ? console.error : console.log)(message);
  process.exit(code);
}

function mapEmitError(error: unknown): number {
  const message = String(error);
  if (message.includes('SECRET_UNREADABLE')) return 2;
  if (message.includes('CHAIN_BREAK')) return 3;
  if (message.includes('ENOENT') || message.includes('Artifact/evidence missing') || message.includes('EISDIR')) return 4;
  if (message.includes('Missing required --') || message.includes('Invalid ') || message.includes('requires --')) return 5;
  if (message.includes('NO_PROVENANCE') || message.includes('TRANSCRIPT_') || message.includes('PROVENANCE_MISMATCH')) return 6;
  return 1;
}

function verifyPrereqs(framework: string | undefined, repo: string | undefined, slug: string, rows: LedgerRow[]) {
  if (framework !== 'one-big-feature' || !repo) return { ok: true as const };
  return verifyOneBigFeatureArtifacts({
    projectRoot: repo,
    slug,
    rows,
  });
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { flags, positional } = parseArgs(argv);
  if (flags.help || flags.h || positional.includes('help')) {
    printAndExit(usage(), 0, false);
  }

  if (flags.verify) {
    const slug = requireString(flags, 'slug');
    const throughStage = parseStage(stringFlag(flags, 'through'), 'through');
    const maxAgeRaw = requireString(flags, 'max-age');
    const maxAgeSeconds = Number.parseInt(maxAgeRaw, 10);
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
      printAndExit(`Invalid --max-age: ${maxAgeRaw}`, 5);
    }

    const result = verifyChainDetailed({
      slug,
      throughStage,
      maxAgeSeconds,
      scopeSha: stringFlag(flags, 'scope-sha'),
      ledgerPath: stringFlag(flags, 'ledger') || defaultLedgerPath(),
      secretPath: stringFlag(flags, 'secret') || defaultSecretPath(),
    });
    if (!result.ok) {
      printAndExit(`${result.code}: ${result.detail}`, 1);
    }

    const framework = stringFlag(flags, 'framework');
    const repo = stringFlag(flags, 'repo');
    const artifactCheck = verifyPrereqs(framework, repo, slug, result.rows);
    if (!artifactCheck.ok) {
      printAndExit(`${artifactCheck.code}: ${artifactCheck.detail}`, 1);
    }

    printAndExit(JSON.stringify(result.terminal), 0, false);
  }

  try {
    const row = emitLedgerRow({
      slug: requireString(flags, 'slug'),
      stage: parseStage(stringFlag(flags, 'stage'), 'stage'),
      artifactPath: requireString(flags, 'artifact'),
      runner: stringFlag(flags, 'runner'),
      sessionId: stringFlag(flags, 'session'),
      transcriptPath: stringFlag(flags, 'transcript'),
      evidencePath: stringFlag(flags, 'evidence'),
      reason: stringFlag(flags, 'reason'),
      ledgerPath: stringFlag(flags, 'ledger'),
      secretPath: stringFlag(flags, 'secret'),
      nowSeconds: stringFlag(flags, 'now') ? Number.parseInt(requireString(flags, 'now'), 10) : undefined,
    });
    printAndExit(JSON.stringify(row), 0, false);
  } catch (error) {
    const message = String(error);
    if (message.includes('ENOENT')) {
      const artifact = stringFlag(flags, 'artifact');
      const evidence = stringFlag(flags, 'evidence');
      if (artifact && !existsSync(artifact)) {
        printAndExit(`Artifact missing: ${artifact}`, 4);
      }
      if (evidence && (!existsSync(evidence) || statSync(evidence).size === 0)) {
        printAndExit(`Evidence missing or empty: ${evidence}`, 4);
      }
    }
    printAndExit(message, mapEmitError(error));
  }
}

if (require.main === module) {
  main();
}
