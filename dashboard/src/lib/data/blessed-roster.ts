// cortextOS Dashboard — Blessed client-engagement roster (authoritative)
//
// Source of truth: CLIENT-ROSTER-AND-PHASES.md (Josh-blessed 2026-08-03).
//
// WHY an explicit table and not a CRM-stage derivation:
//   The CRM carries SALES-only stages (lead·qualified·won·lost·dormant) that do
//   NOT describe delivery. Deriving the roster from `stage == won` alone showed
//   OCG / MSIA at the wrong phase and dropped Alloi / SEIU 521 / Kadre (which are
//   `won` under a different name, `qualified`, or not-yet-a-won-row). Per the
//   spec the roster is the 5 blessed DEALS, each pinned to its unified-lifecycle
//   phase. Live counts / status / contact / history are still joined from the
//   real org-brain md + bus tasks + Multica — only the membership and phase are
//   authoritative here.
//
// ENGAGEMENT = a DEAL, not a client. One client may appear more than once (e.g.
// SEIU 521 has a delivered/monitoring engagement AND, once it crosses into
// design, a separate new qualified deal). Each roster row keys on the DEAL.
//
// An engagement enters the roster the moment it crosses into pre-sales DESIGN
// and stays until it closes (lost) or runs through post-delivery follow-up.

// Unified lifecycle phases (aligns CRM sales stages + delivery phases — ONE model).
export const UNIFIED_PHASES = {
  1: 'Phase 1 · Pre-sales Design',
  2: 'Phase 2 · Build / Active Delivery',
  3: 'Phase 3 · Delivered / Monitoring',
  4: 'Phase 4 · Post-delivery Follow-up',
} as const;

export type PhaseNumber = keyof typeof UNIFIED_PHASES;

export interface BlessedEngagement {
  /** Stable per-DEAL key (a client may have several). */
  id: string;
  /** Display name. */
  client: string;
  /** Join key into CRM contacts / org-brain md filename derivation. */
  clientOrg: string;
  /** Org-brain md filename stem (clients/<slug>.md). */
  slug: string;
  /** Unified-lifecycle phase (1–4). */
  phaseNumber: PhaseNumber;
  /** Rendered phase label (unified model). */
  phase: string;
  /** Short state note from the roster doc. */
  state: string;
  industry?: string;
}

/**
 * The 5 blessed engagements (CLIENT-ROSTER-AND-PHASES.md, 2026-08-03).
 *
 *   OCG       — Phase 1 · Pre-sales Design (in design cycle, trying to close)
 *   Kadre     — Phase 1 · Pre-sales Design (solution designed, presenting next week)
 *   Alloi     — Phase 2 · Build / Active Delivery (active managed services, building)
 *   SEIU 521  — Phase 3 · Delivered / Monitoring (delivered, now monitoring)
 *   MSIA      — Phase 4 · Post-delivery Follow-up (shipped, staying close)
 */
const BLESSED: Omit<BlessedEngagement, 'phase'>[] = [
  {
    id: 'ocg',
    client: 'OCG',
    clientOrg: 'OCG Properties',
    slug: 'ocg',
    phaseNumber: 1,
    state: 'in design cycle, trying to close',
    industry: 'Real Estate',
  },
  {
    id: 'kadre',
    client: 'Kadre',
    clientOrg: 'Kadre',
    slug: 'kadre',
    phaseNumber: 1,
    state: 'solution designed, presenting next week',
    industry: 'AEC',
  },
  {
    id: 'alloi',
    client: 'Alloi',
    clientOrg: 'alloi.us',
    slug: 'alloi',
    phaseNumber: 2,
    state: 'active managed services, building',
    industry: 'AEC',
  },
  {
    id: 'seiu-521',
    client: 'SEIU 521',
    clientOrg: 'SEIU 521',
    slug: 'seiu-521',
    phaseNumber: 3,
    state: 'delivered, now monitoring',
    industry: 'Labor Union',
  },
  {
    id: 'msia',
    client: 'MSIA',
    clientOrg: 'Movement of Spiritual Awareness',
    slug: 'msia',
    phaseNumber: 4,
    state: 'shipped, staying close',
    industry: 'Non-Profit',
  },
];

/** The blessed roster, phase labels resolved. Deterministic order (phase asc). */
export function getBlessedRoster(): BlessedEngagement[] {
  return BLESSED.map((b) => ({ ...b, phase: UNIFIED_PHASES[b.phaseNumber] })).sort(
    (a, b) => a.phaseNumber - b.phaseNumber,
  );
}
