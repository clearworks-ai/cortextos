/**
 * delivery-status.ts — Delivery Status Reporter core (Altari Phase-1 F).
 *
 * Pure, testable logic for the proactive weekly per-client status reporter.
 * Binds the generic `delivery-status-reporter` skill to Clearworks' org-brain
 * layout (see DESIGN-F-delivery-status.md). The crm agent's worker skill calls
 * this via the `bus delivery-status-plan` CLI command.
 *
 * HARD RULES enforced here (DESIGN-F §2):
 *   1. GOOD/NEUTRAL -> client draft. BAD or MIXED -> NO client draft; private
 *      brief to Josh only. Mixed counts as bad.
 *   2. The output is ALWAYS a DRAFT + an approval-row spec. This module NEVER
 *      sends anything and exposes no send path. Approve != send; a human sends.
 *   3. If data since last_update is insufficient, skip the client gracefully.
 *      Never fabricate a status.
 *
 * Channels: every good-news draft is rendered in BOTH Slack and email formats
 * (DESIGN-F §3). Approval of either is still not a send.
 *
 * No external runtime deps — parsing is done with plain string/regex work over
 * the org-brain markdown the fleet already maintains.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A dated line from the client file's `## History` section. */
export interface HistoryEntry {
  /** ISO date (YYYY-MM-DD) parsed from the leading `- YYYY-MM-DD — ...` line. */
  date: string;
  /** The text after the date dash. */
  text: string;
}

/** Parsed `## Reporting` block for a client (the DESIGN-F training payload). */
export interface ReportingConfig {
  /** e.g. 'weekly' | 'biweekly' | 'monthly'. */
  cadence: string;
  /** Cadence expressed in days, derived from `cadence`. */
  cadenceDays: number;
  /** Delivery channel(s): 'slack', 'email', or 'slack+email'. */
  channel: string;
  /** Primary contact name/handle for the update. */
  contact: string;
  /** 1-3 named milestones of the current engagement. */
  milestones: string[];
  /** ISO date (YYYY-MM-DD) of the last status update sent, or null. */
  lastUpdate: string | null;
}

/** Structured view of an org-brain client file. */
export interface ClientState {
  /** Slug/name as passed in (e.g. 'alloi'). */
  slug: string;
  /** Display name from `# Client: X`. */
  name: string;
  history: HistoryEntry[];
  reporting: ReportingConfig | null;
  /** Raw `## Open Items` table rows (text only), excluding header/separator. */
  openItems: string[];
}

/** A minimal Multica issue shape for gather (subset of MulticaIssue). */
export interface GatherIssue {
  title: string;
  status: string;
  updated_at: string;
}

/** A completed bus task tagged to a client. */
export interface GatherTask {
  title: string;
  completedAt: string;
}

/** A crm interaction/followup row. */
export interface GatherInteraction {
  summary: string;
  date: string;
}

/** Everything gathered since last_update, before classification. */
export interface GatheredMaterial {
  history: HistoryEntry[];
  issues: GatherIssue[];
  completedTasks: GatherTask[];
  interactions: GatherInteraction[];
  /** True when nothing at all moved since the baseline. */
  empty: boolean;
}

export type NewsClass = 'GOOD' | 'NEUTRAL' | 'BAD' | 'MIXED';

export interface Classification {
  klass: NewsClass;
  /** true for GOOD/NEUTRAL only — the only classes eligible for a client draft. */
  clientDraftEligible: boolean;
  /** The signal lines that triggered a BAD/MIXED classification (for the brief). */
  badSignals: string[];
}

/** A rendered draft in both channel formats (good-news path). */
export interface DraftBundle {
  slack: string;
  email: { subject: string; body: string };
}

/** The full plan the worker acts on. NEVER contains a send instruction. */
export interface StatusReportPlan {
  client: string;
  /** 'draft' (good news) | 'brief' (bad/mixed -> Josh only) | 'skip'. */
  action: 'draft' | 'brief' | 'skip';
  classification: NewsClass | null;
  /** Reason when action === 'skip'. */
  skipReason?: string;
  /** Present when action === 'draft'. */
  draft?: {
    /** Frontmatter+body markdown to file at clients/[client]/status-update-DATE.md. */
    fileContent: string;
    relPath: string;
    channels: DraftBundle;
    /** The approval row to create (spec only — NEVER a send). */
    approval: ApprovalRowSpec;
    /** The one-line activity feed entry. */
    activityLine: string;
  };
  /** Present when action === 'brief' (bad/mixed news). */
  brief?: {
    /** Private brief markdown for Josh — labelled HUMAN REVIEW REQUIRED. */
    fileContent: string;
    relPath: string;
    signals: string[];
  };
}

/** Spec for a bus create-approval row. Consumed by the worker, not a send. */
export interface ApprovalRowSpec {
  title: string;
  /** Always 'external-comms' — routes to the always_ask gate. */
  category: 'external-comms';
  context: string;
  client: string;
  owningJob: 'delivery-status-reporter';
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const CADENCE_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  'bi-weekly': 14,
  monthly: 30,
};

/** Map a cadence word to days; default 7 (skill default) for unknown values. */
export function cadenceToDays(cadence: string): number {
  const key = cadence.trim().toLowerCase();
  return CADENCE_DAYS[key] ?? 7;
}

/**
 * Extract a named `## Section` body from a markdown doc (text up to the next
 * `## ` heading or EOF). Returns '' when the section is absent.
 */
function extractSection(md: string, heading: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (capturing) break; // hit the next section
      const title = line.replace(/^##\s+/, '').trim().toLowerCase();
      // Match on the heading word even when it carries a suffix, e.g.
      // "## History (dated, newest first)" matches heading "History".
      const want = heading.toLowerCase();
      capturing = title === want || title.startsWith(`${want} `) || title.startsWith(`${want}(`);
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join('\n').trim();
}

/** Parse `## History` lines of the form `- YYYY-MM-DD — text`. */
export function parseHistory(md: string): HistoryEntry[] {
  const body = extractSection(md, 'History');
  const entries: HistoryEntry[] = [];
  for (const line of body.split('\n')) {
    // Only top-level list items (not indented continuation lines).
    const m = /^- (\d{4}-\d{2}-\d{2})\s*[—-]\s*(.*)$/.exec(line);
    if (m) {
      entries.push({ date: m[1], text: m[2].trim() });
    }
  }
  return entries;
}

/** Parse `## Open Items` table rows (text of the first column, non-empty). */
export function parseOpenItems(md: string): string[] {
  const body = extractSection(md, 'Open Items');
  const items: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    if (/^\|\s*-+/.test(line.trim())) continue; // separator row
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is '' (leading pipe); first real cell is cells[1]
    const first = cells[1] ?? '';
    if (!first || /^item$/i.test(first)) continue; // header / empty
    items.push(first);
  }
  return items;
}

/**
 * Parse a `## Reporting` block. Expected key: value lines:
 *   - cadence: weekly
 *   - channel: slack+email
 *   - contact: Marcos Santa Ana <marcos@alloi.us>
 *   - milestones: A; B; C
 *   - last_update: 2026-08-02
 * Returns null when the block is absent.
 */
export function parseReporting(md: string): ReportingConfig | null {
  const body = extractSection(md, 'Reporting');
  if (!body) return null;

  const get = (key: string): string | null => {
    const re = new RegExp(`^-?\\s*${key}\\s*:\\s*(.+)$`, 'im');
    const m = re.exec(body);
    return m ? m[1].trim() : null;
  };

  const cadence = get('cadence') ?? 'weekly';
  const channelRaw = (get('channel') ?? 'slack+email').toLowerCase().replace(/\s+/g, '');
  const contact = get('contact') ?? '';
  const milestonesRaw = get('milestones') ?? '';
  const milestones = milestonesRaw
    .split(/[;•]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lastUpdateRaw = get('last_update') ?? get('last-update');
  const lastUpdate =
    lastUpdateRaw && /^\d{4}-\d{2}-\d{2}$/.test(lastUpdateRaw.trim())
      ? lastUpdateRaw.trim()
      : null;

  return {
    cadence,
    cadenceDays: cadenceToDays(cadence),
    channel: channelRaw || 'slack+email',
    contact,
    milestones,
    lastUpdate,
  };
}

/** Parse a full org-brain client file into a ClientState. */
export function parseClientFile(slug: string, md: string): ClientState {
  const nameMatch = /^#\s*Client:\s*(.+)$/im.exec(md);
  const name = nameMatch ? nameMatch[1].trim() : slug;
  return {
    slug,
    name,
    history: parseHistory(md),
    reporting: parseReporting(md),
    openItems: parseOpenItems(md),
  };
}

// ---------------------------------------------------------------------------
// Gather
// ---------------------------------------------------------------------------

/** Keep only ISO-dated rows strictly after `since` (exclusive). null = keep all. */
function afterDate<T extends { date?: string; completedAt?: string; updated_at?: string }>(
  rows: T[],
  since: string | null,
  field: 'date' | 'completedAt' | 'updated_at',
): T[] {
  if (!since) return rows;
  return rows.filter((r) => {
    const v = (r as Record<string, unknown>)[field];
    if (typeof v !== 'string') return false;
    // Compare on the YYYY-MM-DD prefix so timestamps sort correctly.
    return v.slice(0, 10) > since;
  });
}

export interface GatherInput {
  history: HistoryEntry[];
  issues?: GatherIssue[];
  completedTasks?: GatherTask[];
  interactions?: GatherInteraction[];
  /** last_update baseline (YYYY-MM-DD). null => everything is "new". */
  lastUpdate: string | null;
}

/**
 * Gather everything that moved since `lastUpdate` across all sources.
 * Multica issues are limited to delivery-relevant statuses.
 */
export function gatherSinceLastUpdate(input: GatherInput): GatheredMaterial {
  const RELEVANT_ISSUE_STATUSES = new Set([
    'done',
    'in_review',
    'in_progress',
    'blocked',
  ]);

  const history = afterDate(input.history, input.lastUpdate, 'date');
  const issues = afterDate(
    (input.issues ?? []).filter((i) => RELEVANT_ISSUE_STATUSES.has(i.status)),
    input.lastUpdate,
    'updated_at',
  );
  const completedTasks = afterDate(input.completedTasks ?? [], input.lastUpdate, 'completedAt');
  const interactions = afterDate(input.interactions ?? [], input.lastUpdate, 'date');

  const empty =
    history.length === 0 &&
    issues.length === 0 &&
    completedTasks.length === 0 &&
    interactions.length === 0;

  return { history, issues, completedTasks, interactions, empty };
}

// ---------------------------------------------------------------------------
// Classification (HARD RULE — DESIGN-F §2)
// ---------------------------------------------------------------------------

/**
 * Words/phrases that signal bad news. A single hit forces BAD (or MIXED when
 * good signals coexist — both route to the private-brief path, never a client
 * draft).
 */
const BAD_SIGNAL_RE =
  /\b(delay|delayed|slip|slipped|blocked|blocker|behind schedule|over budget|scope (creep|problem|issue)|missed|miss(ed)? (the )?deadline|apolog|regret|sorry|escalat|churn|at risk|at-risk|cancel|cancell|pushed back|setback|outage|broke|broken|failure|failed)\b/i;

const GOOD_SIGNAL_RE =
  /\b(shipped|delivered|launched|live|merged|completed|done|approved|signed|invoice|milestone|on track|progress|built|deployed|released|finished)\b/i;

function collectText(m: GatheredMaterial): { good: string[]; bad: string[] } {
  const good: string[] = [];
  const bad: string[] = [];
  const lines = [
    ...m.history.map((h) => h.text),
    ...m.issues.map((i) => `${i.title} [${i.status}]`),
    ...m.completedTasks.map((t) => t.title),
    ...m.interactions.map((x) => x.summary),
  ];
  for (const line of lines) {
    // A blocked issue is unambiguously a bad signal regardless of wording.
    if (/\[blocked\]$/.test(line) || BAD_SIGNAL_RE.test(line)) bad.push(line);
    else if (GOOD_SIGNAL_RE.test(line)) good.push(line);
  }
  return { good, bad };
}

/**
 * Classify gathered material. Mixed (any bad signal alongside good) is BAD by
 * policy. Only GOOD/NEUTRAL are draft-eligible.
 */
export function classifyNews(m: GatheredMaterial): Classification {
  const { good, bad } = collectText(m);
  let klass: NewsClass;
  if (bad.length > 0 && good.length > 0) klass = 'MIXED';
  else if (bad.length > 0) klass = 'BAD';
  else if (good.length > 0) klass = 'GOOD';
  else klass = 'NEUTRAL';

  return {
    klass,
    clientDraftEligible: klass === 'GOOD' || klass === 'NEUTRAL',
    badSignals: bad,
  };
}

// ---------------------------------------------------------------------------
// Draft rendering (good-news path) — BOTH Slack + email
// ---------------------------------------------------------------------------

function outcomeBullets(m: GatheredMaterial): { done: string[]; inProgress: string[] } {
  const done: string[] = [];
  const inProgress: string[] = [];
  for (const i of m.issues) {
    if (i.status === 'done') done.push(i.title);
    else if (i.status === 'in_review' || i.status === 'in_progress') inProgress.push(i.title);
  }
  for (const t of m.completedTasks) done.push(t.title);
  for (const h of m.history) {
    if (GOOD_SIGNAL_RE.test(h.text)) done.push(h.text);
  }
  // De-dup while preserving order.
  const uniq = (arr: string[]) => Array.from(new Set(arr));
  return { done: uniq(done), inProgress: uniq(inProgress) };
}

/**
 * Render the same update in Slack and email formats. Both are DRAFTS.
 * Voice polish (the-humanizer) is applied by the worker; this is the skeleton.
 */
export function renderDrafts(
  client: ClientState,
  m: GatheredMaterial,
  date: string,
): DraftBundle {
  const { done, inProgress } = outcomeBullets(m);
  const contact = client.reporting?.contact?.split('<')[0].trim() || 'there';
  const firstName = contact.split(/\s+/)[0] || 'there';
  const nextMilestone = client.reporting?.milestones?.[0] ?? 'the next milestone';

  const lead =
    done.length > 0
      ? done[0]
      : inProgress.length > 0
        ? `Heads-down progress on ${inProgress[0]}`
        : `Steady progress on ${client.name}`;

  // ----- Slack format (tighter, no subject) -----
  const slackParts: string[] = [];
  slackParts.push(`Hi ${firstName} — quick update on ${client.name}.`);
  slackParts.push('');
  slackParts.push(`*${lead}.*`);
  if (done.length > 0) {
    slackParts.push('');
    slackParts.push('*Done since last update*');
    for (const d of done.slice(0, 4)) slackParts.push(`• ${d}`);
  }
  if (inProgress.length > 0) {
    slackParts.push('');
    slackParts.push('*In progress*');
    for (const p of inProgress.slice(0, 2)) slackParts.push(`• ${p}`);
  }
  slackParts.push('');
  slackParts.push(`Next up: ${nextMilestone}. More soon.`);
  const slack = slackParts.join('\n');

  // ----- Email format (with subject) -----
  const emailParts: string[] = [];
  emailParts.push(`Hi ${firstName},`);
  emailParts.push('');
  emailParts.push(`${lead}.`);
  if (done.length > 0) {
    emailParts.push('');
    emailParts.push('Done since last update:');
    for (const d of done.slice(0, 4)) emailParts.push(`  - ${d}`);
  }
  if (inProgress.length > 0) {
    emailParts.push('');
    emailParts.push('In progress:');
    for (const p of inProgress.slice(0, 2)) emailParts.push(`  - ${p}`);
  }
  emailParts.push('');
  emailParts.push(`Next up is ${nextMilestone}. I'll check back in with the next update.`);
  emailParts.push('');
  emailParts.push('Best,');
  emailParts.push('Josh');
  const email = {
    subject: `${client.name} — status update ${date}`,
    body: emailParts.join('\n'),
  };

  return { slack, email };
}

// ---------------------------------------------------------------------------
// Plan assembly (top-level entry point)
// ---------------------------------------------------------------------------

export interface BuildPlanInput {
  slug: string;
  clientFileMarkdown: string;
  /** Today, YYYY-MM-DD. */
  today: string;
  issues?: GatherIssue[];
  completedTasks?: GatherTask[];
  interactions?: GatherInteraction[];
}

/**
 * Build the full StatusReportPlan for one client. This is the single entry
 * point the worker/CLI uses. It NEVER emits a send — only draft files,
 * approval-row specs, brief files, or a skip.
 */
export function buildStatusReportPlan(input: BuildPlanInput): StatusReportPlan {
  const client = parseClientFile(input.slug, input.clientFileMarkdown);
  const lastUpdate = client.reporting?.lastUpdate ?? null;

  const material = gatherSinceLastUpdate({
    history: client.history,
    issues: input.issues,
    completedTasks: input.completedTasks,
    interactions: input.interactions,
    lastUpdate,
  });

  // Skip gracefully when nothing moved — never fabricate a status.
  if (material.empty) {
    return {
      client: input.slug,
      action: 'skip',
      classification: null,
      skipReason: lastUpdate
        ? `No delivery activity since last_update (${lastUpdate}).`
        : 'No delivery activity found and no reporting baseline set.',
    };
  }

  const classification = classifyNews(material);

  // BAD / MIXED -> NO client draft. Private brief to Josh only.
  if (!classification.clientDraftEligible) {
    const relPath = `raw/areas/clearworks/clients/${input.slug}/status-brief-${input.today}.md`;
    const fileContent = renderBrief(client, classification, input.today);
    return {
      client: input.slug,
      action: 'brief',
      classification: classification.klass,
      brief: {
        fileContent,
        relPath,
        signals: classification.badSignals,
      },
    };
  }

  // GOOD / NEUTRAL -> client draft (both channels) + approval row (never a send).
  const channels = renderDrafts(client, material, input.today);
  const relPath = `raw/areas/clearworks/clients/${input.slug}/status-update-${input.today}.md`;
  const fileContent = renderDraftFile(client, classification, channels, input.today, lastUpdate);

  const approval: ApprovalRowSpec = {
    title: `Status update for ${client.name} (${input.today}) — needs approval before send`,
    category: 'external-comms',
    context:
      `Weekly delivery-status draft for ${client.name}. Classification: ${classification.klass}. ` +
      `Slack + email formats drafted at ${relPath}. Approve = content is right; a HUMAN still sends. ` +
      `Never auto-sent.`,
    client: input.slug,
    owningJob: 'delivery-status-reporter',
  };

  const activityLine = `Weekly status update drafted for ${client.name} · pending approval`;

  return {
    client: input.slug,
    action: 'draft',
    classification: classification.klass,
    draft: { fileContent, relPath, channels, approval, activityLine },
  };
}

// ---------------------------------------------------------------------------
// File renderers
// ---------------------------------------------------------------------------

function renderDraftFile(
  client: ClientState,
  classification: Classification,
  channels: DraftBundle,
  today: string,
  lastUpdate: string | null,
): string {
  const cadence = client.reporting?.cadence ?? 'weekly';
  return [
    '---',
    'agent: crm',
    'job: status-updates',
    'skill: delivery-status-reporter',
    `date: ${today}`,
    `client: ${client.slug}`,
    'type: status-update',
    'status: DRAFT — needs approval',
    'auto_send: false',
    '---',
    '',
    `# Status Update: ${client.name} · ${today}`,
    `**Type:** weekly`,
    `**Classification:** ${classification.klass}`,
    `**Status:** DRAFT · needs approval`,
    `**Cadence:** ${cadence} · last update: ${lastUpdate ?? 'none on file'}`,
    '',
    '## Slack draft',
    '',
    channels.slack,
    '',
    '## Email draft',
    '',
    `**Subject:** ${channels.email.subject}`,
    '',
    channels.email.body,
    '',
    '## Send discipline',
    '',
    'Approve = "the content is right." Approval is NOT a send. A human sends via',
    'Slack or email. This draft is never auto-sent.',
    '',
  ].join('\n');
}

function renderBrief(
  client: ClientState,
  classification: Classification,
  today: string,
): string {
  return [
    '---',
    'agent: crm',
    'job: status-updates',
    'skill: delivery-status-reporter',
    `date: ${today}`,
    `client: ${client.slug}`,
    'type: status-brief',
    'status: HUMAN REVIEW REQUIRED',
    'auto_send: false',
    '---',
    '',
    `# Status Brief (BAD NEWS · HUMAN REVIEW REQUIRED): ${client.name} · ${today}`,
    `**Classification:** ${classification.klass}`,
    '',
    '> No client-facing draft was written. Per DESIGN-F §2, bad/mixed news goes',
    '> to Josh privately first — he decides call vs personal email vs a drafted',
    '> message with his edits. This is NEVER eligible for an agent send.',
    '',
    '## Signals that triggered this',
    '',
    ...classification.badSignals.map((s) => `- ${s}`),
    '',
    '## For Josh',
    '',
    `- What happened: see signals above (${client.name}).`,
    '- Impact (dates / scope / cost): needs Josh judgment.',
    '- Options: (call · personal email · Josh-edited draft). No draft prepared until Josh chooses.',
    '',
  ].join('\n');
}
