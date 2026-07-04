/**
 * reconcile.ts — Fleet drift detection (pure logic).
 *
 * WS4 — Fleet Reconcile + Drift Alarms.
 *
 * Detects when the LIVE fleet has drifted from the DECLARED config:
 *   - missing_process — an agent is enabled/declared but NOT running
 *     (the real incident: "sage silently didn't come back after a fleet
 *      restart; Josh caught it, not the fleet").
 *   - orphan_process — a process is running that is NOT in the declared set
 *     (or is declared but intentionally disabled).
 *   - missing_cron — a cron is declared in an agent's config but the daemon
 *     has NOT scheduled it.
 *   - missing_env — an agent declares a credential/env key that is absent
 *     from its resolved environment.
 *
 * This module is DELIBERATELY PURE: it takes plain data inputs and returns a
 * structured report with NO side effects — no shell commands, no filesystem
 * reads, no daemon calls. That keeps it unit-testable without touching the
 * live machine. Gathering the live inputs and emitting drift events lives in
 * the CLI (src/cli/bus-reconcile.ts) and the daemon trigger
 * (src/daemon/reconcile-trigger.ts).
 *
 * FALSE-POSITIVE GUARD: an agent that is intentionally disabled
 * (`enabled === false`) or on the `knownOff` list (e.g. hunter, which is
 * permanently OFF and must NEVER be flagged) is excluded from missing_process
 * / missing_cron / missing_env drift entirely. A running process for such an
 * agent is reported as `orphan_process` (it should not be up), never as a
 * missing-process false positive.
 */

/** A process/agent status as reported by the daemon (subset of AgentStatus). */
export interface LiveProcess {
  name: string;
  /** running | stopped | crashed | starting | halted (daemon-reported). */
  status: string;
  pid?: number;
  uptime?: number;
}

/** A declared agent from config (filesystem scan + enabled-agents.json merge). */
export interface DeclaredAgent {
  name: string;
  org?: string;
  /**
   * Effective enabled flag: config.json `enabled !== false` AND
   * enabled-agents.json entry not disabled. Caller resolves this; the pure
   * function only reads it. Absent = treated as enabled (default-on, matches
   * the daemon's discoverAndStart behavior).
   */
  enabled?: boolean;
  /** Declared cron names for this agent (from config.json crons / crons.json). */
  declaredCrons?: string[];
  /** Declared env/credential keys this agent needs present. */
  declaredEnvKeys?: string[];
  /** Env keys actually present in the agent's resolved environment. */
  presentEnvKeys?: string[];
}

/** Crons the daemon has actually scheduled, keyed by agent name. */
export type ScheduledCrons = Record<string, string[]>;

export interface DriftFinding {
  kind: 'missing_process' | 'orphan_process' | 'missing_cron' | 'missing_env';
  agent: string;
  org?: string;
  /** Cron name (missing_cron) or env key (missing_env); undefined otherwise. */
  detail?: string;
  /** Human-readable one-line explanation for the drift event. */
  message: string;
}

export interface DriftReport {
  missing_process: DriftFinding[];
  orphan_process: DriftFinding[];
  missing_cron: DriftFinding[];
  missing_env: DriftFinding[];
  /** True when every category is empty — a healthy, in-sync fleet. */
  clean: boolean;
  /** Total number of findings across all categories. */
  total: number;
}

export interface ReconcileInput {
  /** Declared/configured agents (with per-agent enabled flag + crons + env). */
  declaredAgents: DeclaredAgent[];
  /** Live processes from the daemon / process list. */
  liveProcesses: LiveProcess[];
  /**
   * Crons the daemon has actually scheduled, keyed by agent name. When an
   * agent is absent from this map, its declared crons are all considered
   * unscheduled (missing_cron) — unless the agent itself is disabled.
   */
  scheduledCrons?: ScheduledCrons;
  /**
   * Agents that are intentionally OFF and must NEVER be flagged as missing
   * (e.g. "hunter" — permanently shut down). Matched by agent name. This is a
   * hard exclusion on top of the per-agent enabled flag: even if a stale
   * config still says enabled, a knownOff agent is never a missing-process
   * false positive.
   */
  knownOff?: string[];
}

/** Statuses that count as "the agent is actually up and healthy". */
const RUNNING_STATUSES = new Set(['running', 'starting']);

/**
 * Is a live process considered up? `running`/`starting` count as up;
 * `stopped`/`crashed`/`halted` do NOT (a halted agent is intentionally
 * paused, but for missing-process purposes it is not serving — however we do
 * NOT flag halted separately here; a declared-enabled agent that is halted
 * still counts as missing_process because it is not running).
 */
function isUp(p: LiveProcess): boolean {
  return RUNNING_STATUSES.has(p.status);
}

/**
 * Reconcile declared config against live state and return a structured drift
 * report. Pure — no side effects.
 *
 * Dedup note: agents are keyed by name. When the same agent name is declared
 * under two orgs (e.g. clearworksai/scout + personal/scout, where only one
 * needs to run), a single running process for that name satisfies BOTH
 * declarations — we treat the name as satisfied if ANY live process with that
 * name is up.
 */
export function reconcile(input: ReconcileInput): DriftReport {
  const { declaredAgents, liveProcesses } = input;
  const scheduledCrons = input.scheduledCrons ?? {};
  const knownOff = new Set(input.knownOff ?? []);

  // Names that are up, deduped by name (any org copy being up satisfies it).
  const upNames = new Set<string>();
  for (const p of liveProcesses) {
    if (isUp(p)) upNames.add(p.name);
  }

  // Effective-enabled set (respects enabled flag AND knownOff hard exclusion).
  const enabledDeclaredNames = new Set<string>();
  for (const a of declaredAgents) {
    if (knownOff.has(a.name)) continue; // never flag a known-off agent
    if (a.enabled === false) continue; // intentionally disabled — skip
    enabledDeclaredNames.add(a.name);
  }

  const missing_process: DriftFinding[] = [];
  const orphan_process: DriftFinding[] = [];
  const missing_cron: DriftFinding[] = [];
  const missing_env: DriftFinding[] = [];

  // --- missing_process + cron/env drift for each enabled declared agent ---
  // Dedup by name: multiple org copies of the same name produce one check.
  const seenAgentNames = new Set<string>();
  for (const a of declaredAgents) {
    if (!enabledDeclaredNames.has(a.name)) continue;
    if (seenAgentNames.has(a.name)) continue;
    seenAgentNames.add(a.name);

    // missing_process
    if (!upNames.has(a.name)) {
      missing_process.push({
        kind: 'missing_process',
        agent: a.name,
        org: a.org,
        message: `agent "${a.name}" is enabled but not running — process missing from the live fleet`,
      });
    }

    // missing_cron: declared crons not present in the scheduled set.
    const declaredCronNames = a.declaredCrons ?? [];
    if (declaredCronNames.length > 0) {
      const scheduled = new Set(scheduledCrons[a.name] ?? []);
      for (const cronName of declaredCronNames) {
        if (!scheduled.has(cronName)) {
          missing_cron.push({
            kind: 'missing_cron',
            agent: a.name,
            org: a.org,
            detail: cronName,
            message: `cron "${cronName}" is declared for agent "${a.name}" but not scheduled by the daemon`,
          });
        }
      }
    }

    // missing_env: declared env keys absent from the present set.
    const declaredEnv = a.declaredEnvKeys ?? [];
    if (declaredEnv.length > 0) {
      const present = new Set(a.presentEnvKeys ?? []);
      for (const key of declaredEnv) {
        if (!present.has(key)) {
          missing_env.push({
            kind: 'missing_env',
            agent: a.name,
            org: a.org,
            detail: key,
            message: `env key "${key}" is declared-needed for agent "${a.name}" but absent from its environment`,
          });
        }
      }
    }
  }

  // --- orphan_process: a live process whose name is not effective-enabled ---
  // This catches a process running for an agent that config says is disabled,
  // known-off, or entirely undeclared.
  const declaredNames = new Set(declaredAgents.map(a => a.name));
  const orphanSeen = new Set<string>();
  for (const p of liveProcesses) {
    if (!isUp(p)) continue;
    if (enabledDeclaredNames.has(p.name)) continue; // expected to be up
    if (orphanSeen.has(p.name)) continue;
    orphanSeen.add(p.name);
    const declared = declaredNames.has(p.name);
    const reason = knownOff.has(p.name)
      ? 'is on the known-off list (should be permanently stopped)'
      : declared
        ? 'is declared but intentionally disabled'
        : 'is not declared in fleet config';
    orphan_process.push({
      kind: 'orphan_process',
      agent: p.name,
      message: `process "${p.name}" is running but ${reason}`,
    });
  }

  const total =
    missing_process.length +
    orphan_process.length +
    missing_cron.length +
    missing_env.length;

  return {
    missing_process,
    orphan_process,
    missing_cron,
    missing_env,
    clean: total === 0,
    total,
  };
}

/** Flatten a DriftReport into a single ordered findings array. */
export function driftFindings(report: DriftReport): DriftFinding[] {
  return [
    ...report.missing_process,
    ...report.orphan_process,
    ...report.missing_cron,
    ...report.missing_env,
  ];
}
