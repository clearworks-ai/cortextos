import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readScopingManifest, type ScopingManifest } from './scoping-gate';

/**
 * Solution-design 5-stack — the ON-DEMAND deal-context spine (S1).
 *
 * The solution-design chain (integration-engineer -> proposal-writer ->
 * pricing-analyst, with deal-room-producer + solutions-engineer as producers) runs
 * as a skill-chain in a Josh-driven agent session — NOT autonomously, NOT wired to
 * any event or cron. There is no orchestrator process. What CAN be made durable is a
 * single threaded DEAL CONTEXT that every stage reads from and writes back to, plus a
 * pure COHERENCE CHECK that refuses to call the chain "done" when the stage artifacts
 * disagree (the proposal's phases must equal the pricing's phases must equal the deal
 * room's phases; every number must trace to one anchor).
 *
 * This mirrors `scoping-gate.ts`: a pure, never-throwing function over a JSON artifact
 * the chain writes as it goes, plus a thin CLI that a skill invokes. It does NOT make
 * the producer skills proactive — it only (a) seeds one shared context so the five
 * skills don't each re-gather (and drift) the deal, and (b) verifies coherence before
 * the deal room ships.
 *
 * Chain order (Kadre-proven, same order the scoping gate enforces):
 *   integration-engineer  (per live-external Worker; sets integrationEngineerRan)
 *   -> solutions-engineer  (optional producer: prototype brief)
 *   -> proposal-writer     (scope as phases; every price marked [CONFIRM PRICE])
 *   -> pricing-analyst     (anchor + phase ranges + ROI; same phase ids as proposal)
 *   -> deal-room-producer  (packages proposal+pricing+proof; same phases, same price)
 */

/** A phase in the deal — the unit that must be identical across all stages. */
export interface DealPhase {
  /** Stable id threaded across every stage (e.g. "phase-0-audit"). */
  id: string;
  /** Human name (e.g. "Audit & Pilot"). */
  name: string;
}

/** The single deal context every stage of the chain reads and writes. */
export interface DealContext {
  /** Deal slug — the one key that collates every stage's output for this deal. */
  slug: string;
  /** Client / prospect display name. */
  client: string;
  /** Primary contact "Name, Role" (optional). */
  contact?: string;
  /** One-line description of the engagement. */
  engagement: string;
  /**
   * The agreed phase spine. proposal-writer authors it; pricing-analyst and
   * deal-room-producer MUST reuse these exact ids — never re-invent phases.
   */
  phases: DealPhase[];
  /**
   * Per-stage artifact paths, filled in as each stage completes. Used by the
   * coherence check to confirm every declared stage actually produced a file.
   */
  artifacts?: {
    integrations?: string;
    solutionsEngineer?: string;
    proposal?: string;
    pricing?: string;
    dealRoom?: string;
  };
}

/**
 * The two runtime files the chain threads through, kept next to each other so a skill
 * points at ONE directory and both the human-context spine and the code-enforced
 * scoping gate share it.
 */
export interface ChainPaths {
  /** deal-context.json — the human/deal spine (this module). */
  context: string;
  /** scoping-manifest.json — the code-enforced integration/grounding gate. */
  manifest: string;
}

export function defaultChainPaths(dir: string): ChainPaths {
  const base = resolve(dir);
  return {
    context: join(base, 'deal-context.json'),
    manifest: join(base, 'scoping-manifest.json'),
  };
}

function sanitizePhase(value: unknown): DealPhase | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null;
  const name = typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : obj.id;
  return { id: obj.id, name };
}

/**
 * Read + parse the deal context. On any failure returns a minimal empty context
 * (never throws — it runs inside a `--check`-style branch, exactly like
 * readScopingManifest).
 */
export function readDealContext(contextPath: string): DealContext {
  const empty: DealContext = { slug: '', client: '', engagement: '', phases: [] };
  try {
    if (!existsSync(contextPath)) return empty;
    const parsed = JSON.parse(readFileSync(contextPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const obj = parsed as Record<string, unknown>;
    const phases = Array.isArray(obj.phases)
      ? obj.phases.map(sanitizePhase).filter((p): p is DealPhase => p !== null)
      : [];
    const artifactsRaw =
      obj.artifacts && typeof obj.artifacts === 'object' && !Array.isArray(obj.artifacts)
        ? (obj.artifacts as Record<string, unknown>)
        : {};
    const artifacts: DealContext['artifacts'] = {};
    for (const key of ['integrations', 'solutionsEngineer', 'proposal', 'pricing', 'dealRoom'] as const) {
      const v = artifactsRaw[key];
      if (typeof v === 'string' && v.length > 0) artifacts[key] = v;
    }
    return {
      slug: typeof obj.slug === 'string' ? obj.slug : '',
      client: typeof obj.client === 'string' ? obj.client : '',
      contact: typeof obj.contact === 'string' ? obj.contact : undefined,
      engagement: typeof obj.engagement === 'string' ? obj.engagement : '',
      phases,
      artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
    };
  } catch {
    return empty;
  }
}

/** Slugify a client name deterministically so every stage collates under one key. */
export function slugifyClient(client: string): string {
  return client
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Seed a fresh deal context + scoping manifest for a deal. Writes both files into
 * `dir`. Idempotent by slug: re-init of the same slug returns the existing context
 * (so a re-run of the chain doesn't wipe stage progress).
 */
export function initDealContext(opts: {
  dir: string;
  client: string;
  engagement: string;
  contact?: string;
  phases: DealPhase[];
  /**
   * Worker ids that write to a live external system (drives the integration-engineer
   * gate in scoping-manifest.json). Empty is valid (no live-external write).
   */
  liveExternalWorkers?: string[];
}): { context: DealContext; paths: ChainPaths; created: boolean } {
  const paths = defaultChainPaths(opts.dir);
  mkdirSync(dirname(paths.context), { recursive: true });

  if (existsSync(paths.context)) {
    const existing = readDealContext(paths.context);
    if (existing.slug) {
      return { context: existing, paths, created: false };
    }
  }

  const slug = slugifyClient(opts.client);
  const context: DealContext = {
    slug,
    client: opts.client,
    contact: opts.contact,
    engagement: opts.engagement,
    phases: opts.phases,
  };
  writeFileSync(paths.context, `${JSON.stringify(context, null, 2)}\n`, 'utf-8');

  // Seed the scoping manifest the code-enforced gate reads. Live-external workers
  // start ungated (integrationEngineerRan:false) so the gate blocks pricing/deal-room
  // until integration-engineer actually runs for each.
  const manifest: ScopingManifest = {
    slug,
    workers: (opts.liveExternalWorkers ?? []).map((id) => ({
      id,
      touchesLiveExternalSystem: true,
      integrationEngineerRan: false,
      exemplarGroundingPass1: false,
    })),
    exemplarGroundingPass2: false,
  };
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return { context, paths, created: true };
}

// ── Coherence check ────────────────────────────────────────────────────────────

export type CoherenceIssueCode =
  | 'NO_CONTEXT'
  | 'NO_PHASES'
  | 'MISSING_ARTIFACT'
  | 'ARTIFACT_NOT_ON_DISK'
  | 'PHASE_MISMATCH'
  | 'SLUG_MISMATCH'
  | 'UNPRICED_PHASE'
  | 'UNCONFIRMED_PRICE_IN_DEALROOM'
  | 'SCOPING_MANIFEST_SLUG_MISMATCH';

export interface CoherenceIssue {
  code: CoherenceIssueCode;
  detail: string;
}

export interface CoherenceResult {
  ok: boolean;
  slug: string;
  issues: CoherenceIssue[];
}

/** Which stage artifacts are required for a coherent, delegatable deal package. */
const REQUIRED_ARTIFACTS: Array<{
  key: keyof NonNullable<DealContext['artifacts']>;
  label: string;
}> = [
  { key: 'proposal', label: 'proposal-writer' },
  { key: 'pricing', label: 'pricing-analyst' },
  { key: 'dealRoom', label: 'deal-room-producer' },
];

function extractPhaseIds(markdown: string): Set<string> {
  // Stages tag each phase block with a machine-readable marker:  <!-- phase: id -->
  // (proposal, pricing, and deal-room all emit this on their phase headings). We key
  // coherence off the marker, not prose, so wording differences never break the check.
  const ids = new Set<string>();
  const re = /<!--\s*phase:\s*([a-z0-9][a-z0-9-]*)\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    ids.add(m[1].toLowerCase());
  }
  return ids;
}

function readFileSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Assert the five-stack produced ONE coherent deal package. Pure + never throws.
 *
 * A deal is coherent when:
 *  - a context with a slug and a non-empty phase spine exists;
 *  - proposal, pricing, and deal-room artifacts are declared AND exist on disk;
 *  - the phase-id sets in the proposal, pricing, and deal-room artifacts are IDENTICAL
 *    to the context spine (scope == pricing line items == deal-room sections);
 *  - every context phase is priced in the pricing artifact (no phase quoted naked);
 *  - the deal room carries no unresolved [CONFIRM PRICE] / [CONFIRM SCOPE] marker
 *    (those are the human's call; a room must not ship with a placeholder number);
 *  - the scoping-manifest slug matches the context slug (the two spines agree).
 *
 * The `baseDir` resolves relative artifact paths recorded in the context.
 */
export function checkCoherence(opts: {
  context: DealContext;
  baseDir: string;
  scopingManifest?: ScopingManifest;
}): CoherenceResult {
  const { context, baseDir } = opts;
  const issues: CoherenceIssue[] = [];

  if (!context.slug) {
    return {
      ok: false,
      slug: '',
      issues: [{ code: 'NO_CONTEXT', detail: 'no deal context (run `deal-context init` first).' }],
    };
  }
  if (context.phases.length === 0) {
    issues.push({ code: 'NO_PHASES', detail: 'deal context has no phase spine; the chain has nothing to keep consistent.' });
  }

  const contextPhaseIds = new Set(context.phases.map((p) => p.id.toLowerCase()));

  // Scoping manifest slug agreement (the two spines must describe the same deal).
  if (opts.scopingManifest && opts.scopingManifest.slug && opts.scopingManifest.slug !== context.slug) {
    issues.push({
      code: 'SCOPING_MANIFEST_SLUG_MISMATCH',
      detail: `scoping-manifest slug '${opts.scopingManifest.slug}' != deal-context slug '${context.slug}'.`,
    });
  }

  const artifactContent: Partial<Record<string, string>> = {};
  for (const { key, label } of REQUIRED_ARTIFACTS) {
    const rel = context.artifacts?.[key];
    if (!rel) {
      issues.push({ code: 'MISSING_ARTIFACT', detail: `${label} artifact not recorded in deal-context.artifacts.${key}.` });
      continue;
    }
    const abs = resolve(baseDir, rel);
    const content = readFileSafe(abs);
    if (content === null) {
      issues.push({ code: 'ARTIFACT_NOT_ON_DISK', detail: `${label} artifact recorded (${rel}) but not readable at ${abs}.` });
      continue;
    }
    artifactContent[key] = content;
  }

  // Phase-id set equality across proposal / pricing / deal-room vs the context spine.
  for (const { key, label } of REQUIRED_ARTIFACTS) {
    const content = artifactContent[key];
    if (content === undefined) continue;
    const ids = extractPhaseIds(content);
    const missing = [...contextPhaseIds].filter((id) => !ids.has(id));
    const extra = [...ids].filter((id) => !contextPhaseIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
      issues.push({
        code: 'PHASE_MISMATCH',
        detail:
          `${label} phase set != deal spine` +
          (missing.length ? ` — missing [${missing.join(', ')}]` : '') +
          (extra.length ? ` — extra [${extra.join(', ')}]` : '') +
          `. Every stage must reuse the deal-context phase ids (marker "<!-- phase: id -->").`,
      });
    }
  }

  // Every context phase must be priced (appear in the pricing artifact).
  const pricing = artifactContent.pricing;
  if (pricing !== undefined) {
    const pricedIds = extractPhaseIds(pricing);
    for (const p of context.phases) {
      if (!pricedIds.has(p.id.toLowerCase())) {
        issues.push({ code: 'UNPRICED_PHASE', detail: `phase '${p.id}' has no pricing line in the pricing artifact.` });
      }
    }
  }

  // The deal room must not ship with an unresolved placeholder.
  const dealRoom = artifactContent.dealRoom;
  if (dealRoom !== undefined) {
    if (/\[CONFIRM PRICE[^\]]*\]|\[CONFIRM SCOPE[^\]]*\]/i.test(dealRoom)) {
      issues.push({
        code: 'UNCONFIRMED_PRICE_IN_DEALROOM',
        detail: 'deal-room still contains a [CONFIRM PRICE]/[CONFIRM SCOPE] marker — resolve it (founder decision) before the room ships.',
      });
    }
  }

  return { ok: issues.length === 0, slug: context.slug, issues };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// A skill invokes this: `init` seeds the shared context; `coherence-check` refuses
// (non-zero) to call the chain done when the stage artifacts disagree. Mirrors
// scoping-gate's CLI shape.

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
    '  pipeline-deal-context init --dir <deal-dir> --client <name> --engagement <one-liner> \\',
    '      --phases <id:Name,id:Name,...> [--contact <"Name, Role">] [--live-workers <id,id>]',
    '  pipeline-deal-context coherence-check --dir <deal-dir>',
    '',
    'init seeds deal-context.json + scoping-manifest.json under --dir (idempotent by slug).',
    'coherence-check exits 0 iff the proposal/pricing/deal-room artifacts recorded in the',
    'context all share the deal spine (same phase ids, every phase priced, no placeholder',
    'left in the room). Non-zero = INCOHERENT (chain not done).',
  ].join('\n');
}

function printAndExit(message: string, code: number, stderr = true): never {
  (stderr ? console.error : console.log)(message);
  process.exit(code);
}

function parsePhases(spec: string): DealPhase[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, ...nameParts] = entry.split(':');
      const cleanId = slugifyClient(id);
      const name = nameParts.join(':').trim() || cleanId;
      return { id: cleanId, name };
    })
    .filter((p) => p.id.length > 0);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { flags, positional } = parseArgs(argv);
  if (flags.help || flags.h || positional.includes('help')) {
    printAndExit(usage(), 0, false);
  }

  const command = positional[0];
  const dir = stringFlag(flags, 'dir');
  if (!dir) printAndExit('missing --dir\n\n' + usage(), 5);

  if (command === 'init') {
    const client = stringFlag(flags, 'client');
    const engagement = stringFlag(flags, 'engagement');
    const phasesSpec = stringFlag(flags, 'phases');
    if (!client || !engagement || !phasesSpec) {
      printAndExit('init requires --client, --engagement, and --phases\n\n' + usage(), 5);
    }
    const phases = parsePhases(phasesSpec);
    if (phases.length === 0) printAndExit('--phases parsed to zero phases (expected id:Name,...)', 5);
    const liveWorkers = (stringFlag(flags, 'live-workers') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const { context, paths, created } = initDealContext({
      dir,
      client,
      engagement,
      contact: stringFlag(flags, 'contact'),
      phases,
      liveExternalWorkers: liveWorkers,
    });
    printAndExit(
      JSON.stringify({ ok: true, created, slug: context.slug, paths, phases: context.phases.map((p) => p.id) }, null, 2),
      0,
      false,
    );
  }

  if (command === 'coherence-check') {
    const paths = defaultChainPaths(dir);
    const context = readDealContext(paths.context);
    const scopingManifest = readScopingManifest(paths.manifest);
    const result = checkCoherence({ context, baseDir: resolve(dir), scopingManifest });
    if (!result.ok) {
      const lines = result.issues.map((i) => `  ${i.code}: ${i.detail}`);
      printAndExit(`INCOHERENT (${result.slug || 'no-slug'}):\n${lines.join('\n')}`, 1);
    }
    printAndExit(
      JSON.stringify({ ok: true, slug: result.slug, phases: context.phases.map((p) => p.id) }, null, 2),
      0,
      false,
    );
  }

  printAndExit(`unknown command '${command ?? ''}'\n\n${usage()}`, 5);
}

// Filename-guarded entry (see scoping-gate.ts): keeps this CLI from firing when the
// module is inlined into a sibling bundle.
if (require.main === module && /(?:^|[\\/])deal-context(?:\.js|\.ts)?$/.test(process.argv[1] ?? '')) {
  main();
}
