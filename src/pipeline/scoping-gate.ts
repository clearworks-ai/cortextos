import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Deal-scoping mandatory gates (Altari Phase-1 lane E, Kadre-proven chain).
 *
 * The deal-scoping chain runs as a skill-chain in an agent session — there is no
 * orchestrator process to hook into. What CAN be code-enforced is a CHECKLIST GATE
 * over the run's artifact manifest, in the exact shape of `phase-lock.ts`: a pure
 * function that reads what a scoping run recorded and REFUSES (ok:false) to let the
 * run finalize when a mandatory step is missing. The scoping flow writes a
 * `scoping-manifest.json` as it goes; this gate is run before a complexity score
 * finalizes, before a price finalizes, and before the deal room is produced.
 *
 * The two mandatory gates (a skill someone "remembers to invoke" becomes a hard,
 * checked condition):
 *
 *  1. integration-engineer MANDATORY GATE — if ANY Worker in the run writes to a
 *     live external / 3rd-party system, the run may not finalize a spec for that
 *     Worker until integration-engineer has run for it (auth/scoping, idempotency,
 *     field-mapping, failure-handling checked). This is the "does Factor have an
 *     API" miss caught by hand on Kadre.
 *
 *  2. exemplar-grounding DOUBLE GATE — a complexity score may not finalize without
 *     an exemplar-grounding pass #1 for every Worker's artifact, and a price may not
 *     finalize without an exemplar-grounding pass #2. Both are required steps, not
 *     remembered ones.
 *
 * Chain-order enforcement: the two gate points sit in the Kadre-proven order
 * (grounding#1 -> complexity -> integration-engineer -> grounding#2 -> pricing).
 * solutions-engineer / pricing-analyst / deal-room-producer stay on-demand skills —
 * this gate does NOT make them proactive; it only refuses to FINALIZE past a gate
 * point whose mandatory predecessor has not run.
 */

/** The finalize actions a scoping run reaches, in Kadre-proven chain order. */
export const SCOPING_FINALIZE_ACTIONS = ['complexity', 'price', 'deal-room'] as const;
export type ScopingFinalizeAction = (typeof SCOPING_FINALIZE_ACTIONS)[number];

/** A Worker being scoped in the run. */
export interface ScopedWorker {
  /** Stable id for the Worker within this run (e.g. "proposal-automation"). */
  id: string;
  /**
   * True iff this Worker writes to a live external / 3rd-party system (CRM,
   * payment processor, transcription API, calendar, etc.). Drives gate #1.
   */
  touchesLiveExternalSystem: boolean;
  /**
   * Worker ids for which integration-engineer has actually run (auth/scoping,
   * idempotency, field-mapping, failure-handling checked). A Worker satisfies
   * gate #1 iff its own id appears here.
   */
  integrationEngineerRan?: boolean;
  /**
   * True iff an exemplar-grounding pass #1 (complexity grounding) exists for this
   * Worker's deliverable artifact. Drives gate #2 at the complexity finalize.
   */
  exemplarGroundingPass1?: boolean;
}

export interface ScopingManifest {
  /** The deal / run slug this manifest belongs to. */
  slug: string;
  /** Every Worker being scoped in this run. */
  workers: ScopedWorker[];
  /**
   * True iff an exemplar-grounding pass #2 (pricing re-check + prior-work sweep)
   * has run for the deal. Drives gate #2 at the price finalize.
   */
  exemplarGroundingPass2?: boolean;
}

export type ScopingCheckResult =
  | { ok: true }
  | {
      ok: false;
      code: 'INTEGRATION_ENGINEER_MISSING' | 'EXEMPLAR_GROUNDING_MISSING' | 'UNKNOWN_ACTION';
      detail: string;
    };

/**
 * Location of the scoping manifest: next to the pipeline ledger it lives with, so
 * overriding `--ledger` in tests relocates it too (mirrors defaultPhaseLockPath).
 */
export function defaultScopingManifestPath(ledgerPath: string): string {
  return join(dirname(resolve(ledgerPath)), 'scoping-manifest.json');
}

function defaultManifest(): ScopingManifest {
  return { slug: '', workers: [] };
}

function sanitizeWorker(value: unknown): ScopedWorker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null;
  return {
    id: obj.id,
    // Missing / non-boolean => treat as "touches a live system": fail SAFE. An
    // unmarked Worker must not slip past the integration gate on a typo.
    touchesLiveExternalSystem: obj.touchesLiveExternalSystem !== false,
    integrationEngineerRan: obj.integrationEngineerRan === true,
    exemplarGroundingPass1: obj.exemplarGroundingPass1 === true,
  };
}

/**
 * Read + parse the scoping manifest. On ANY failure (missing, unreadable,
 * unparseable, non-object) returns an empty manifest. Never throws — it runs inside
 * a `--verify`-style branch. Happy-path fields are sanitized and fail safe.
 */
export function readScopingManifest(manifestPath: string): ScopingManifest {
  try {
    if (!existsSync(manifestPath)) return defaultManifest();
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaultManifest();
    }
    const obj = parsed as Record<string, unknown>;
    const slug = typeof obj.slug === 'string' ? obj.slug : '';
    const workers = Array.isArray(obj.workers)
      ? obj.workers.map(sanitizeWorker).filter((w): w is ScopedWorker => w !== null)
      : [];
    return {
      slug,
      workers,
      exemplarGroundingPass2: obj.exemplarGroundingPass2 === true,
    };
  } catch {
    return defaultManifest();
  }
}

/**
 * Gate #1 — integration-engineer MANDATORY GATE.
 * For every Worker that touches a live external system, integration-engineer must
 * have run for THAT Worker. Returns the list of offending Worker ids (empty = pass).
 */
export function workersMissingIntegrationEngineer(manifest: ScopingManifest): string[] {
  return manifest.workers
    .filter((w) => w.touchesLiveExternalSystem && !w.integrationEngineerRan)
    .map((w) => w.id);
}

/**
 * Gate the FINALIZE of a scoping action against the two mandatory gates, in
 * Kadre-proven chain order. Never throws.
 *
 * - `complexity` finalize: BLOCKED unless every Worker has exemplar-grounding pass #1
 *   AND (chain order) every live-external Worker has integration-engineer.
 *   Grounding#1 gates complexity directly; the integration gate sits between scoping
 *   and pricing, so it must also hold before we lock a complexity score that a price
 *   will be built on.
 * - `price` finalize: BLOCKED unless exemplar-grounding pass #2 has run AND every
 *   live-external Worker has integration-engineer (a live-API unknown changes the
 *   price — catching it after pricing means re-doing the number).
 * - `deal-room` finalize: BLOCKED unless both gates above hold (packaging must not
 *   ship past an unmet mandatory gate).
 */
export function checkScopingGate(opts: {
  action: ScopingFinalizeAction;
  manifest: ScopingManifest;
}): ScopingCheckResult {
  const { action, manifest } = opts;

  if (!SCOPING_FINALIZE_ACTIONS.includes(action)) {
    return {
      ok: false,
      code: 'UNKNOWN_ACTION',
      detail:
        `unknown scoping finalize action '${action}'; expected one of ` +
        `${SCOPING_FINALIZE_ACTIONS.join(', ')}.`,
    };
  }

  // Gate #1 · integration-engineer — required before complexity finalizes (chain
  // order: it sits before pricing, so a complexity lock a price rests on must clear
  // it) and required before price and deal-room finalize.
  const missingIE = workersMissingIntegrationEngineer(manifest);
  if (missingIE.length > 0) {
    return {
      ok: false,
      code: 'INTEGRATION_ENGINEER_MISSING',
      detail:
        `cannot finalize '${action}' — Worker(s) [${missingIE.join(', ')}] write to a live ` +
        `external system but integration-engineer has not run for them. Run integration-engineer ` +
        `(auth/scoping, idempotency, field-mapping, failure-handling) per Worker and set ` +
        `integrationEngineerRan for each in scoping-manifest.json. There is NO override — a ` +
        `live-3rd-party write is a hard condition (the "does Factor have an API" miss).`,
    };
  }

  // Gate #2 · exemplar-grounding — pass #1 before complexity, pass #2 before price.
  if (action === 'complexity') {
    const ungrounded = manifest.workers
      .filter((w) => !w.exemplarGroundingPass1)
      .map((w) => w.id);
    if (ungrounded.length > 0) {
      return {
        ok: false,
        code: 'EXEMPLAR_GROUNDING_MISSING',
        detail:
          `cannot finalize complexity — Worker(s) [${ungrounded.join(', ')}] have no ` +
          `exemplar-grounding pass #1. A complexity score may not finalize until a real ` +
          `example of each Worker's deliverable artifact has been opened (Tier A/B). Run ` +
          `exemplar-grounding pass #1 and set exemplarGroundingPass1 per Worker. No override.`,
      };
    }
  }

  if (action === 'price' || action === 'deal-room') {
    // The deal room packages the price, so it inherits the pricing gate.
    if (!manifest.exemplarGroundingPass2) {
      return {
        ok: false,
        code: 'EXEMPLAR_GROUNDING_MISSING',
        detail:
          `cannot finalize '${action}' — exemplar-grounding pass #2 (pricing re-check + ` +
          `prior-work sweep) has not run. A price may not finalize until pass #2 confirms no ` +
          `real prior pricing work on this deal was left unread and the anchor cites Tier A/B ` +
          `evidence. Run exemplar-grounding pass #2 and set exemplarGroundingPass2. No override.`,
      };
    }
  }

  return { ok: true };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// A scoping run calls this before each finalize action; a non-zero exit BLOCKS the
// finalize. Mirrors pipeline-stage-emit's --verify shape (parse args, read the
// artifact, exit non-zero with code+detail on a failed gate).

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

function usage(): string {
  return [
    'Usage:',
    '  pipeline-scoping-gate --check --action <complexity|price|deal-room> [--manifest <path>] [--ledger <path>]',
    '',
    'Exit 0 = gate passes (finalize allowed). Non-zero = BLOCKED (mandatory gate unmet).',
  ].join('\n');
}

function printAndExit(message: string, code: number, stderr = true): never {
  (stderr ? console.error : console.log)(message);
  process.exit(code);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { flags, positional } = parseArgs(argv);
  if (flags.help || flags.h || positional.includes('help')) {
    printAndExit(usage(), 0, false);
  }

  if (!flags.check) {
    printAndExit(usage(), 5);
  }

  const action = stringFlag(flags, 'action');
  if (!action || !SCOPING_FINALIZE_ACTIONS.includes(action as ScopingFinalizeAction)) {
    printAndExit(
      `Invalid --action: expected one of ${SCOPING_FINALIZE_ACTIONS.join(', ')}`,
      5,
    );
  }

  const explicitManifest = stringFlag(flags, 'manifest');
  const ledgerPath = stringFlag(flags, 'ledger');
  const manifestPath =
    explicitManifest ||
    (ledgerPath
      ? defaultScopingManifestPath(ledgerPath)
      : join(process.cwd(), 'scoping-manifest.json'));

  const manifest = readScopingManifest(manifestPath);
  const result = checkScopingGate({ action: action as ScopingFinalizeAction, manifest });
  if (!result.ok) {
    printAndExit(`${result.code}: ${result.detail}`, 1);
  }

  printAndExit(
    JSON.stringify({ ok: true, action, slug: manifest.slug, manifest: manifestPath }),
    0,
    false,
  );
}

// Guard on the actual entry filename, not just `require.main === module`: the bundler
// inlines this module into sibling pipeline CLIs (e.g. deal-context.js), where the
// naked `require.main === module` guard would otherwise fire this CLI first.
if (require.main === module && /(?:^|[\\/])scoping-gate(?:\.js|\.ts)?$/.test(process.argv[1] ?? '')) {
  main();
}
