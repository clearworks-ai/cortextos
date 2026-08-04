// cortextOS Dashboard - Mission Control · Client Delivery aggregation (v2)
//
// An ENGAGEMENT is a real CLIENT engagement (Alloi, MSIA, OCG …). All client
// derivation lives in `clients.ts` (pipeline.json + contacts.json + org-brain
// md). This module composes the render payload: client KPIs + signals +
// engagements, the role-tagged activity feed, the approvals lane mapped to a
// client engagement where attributable, and the ADDITIVE Fleet Ops section
// (epics + Josh's human tasks) from `fleet-ops.ts`.
//
// Reads LIVE snapshotted rows from the SQLite read-cache + the client source
// files on disk. Never fabricates a metric without a row behind it.

import { getPendingApprovals } from '@/lib/data/approvals';
import { getRecentEvents } from '@/lib/data/events';
import {
  buildEngagements,
  buildClientKpis,
  buildClientSignals,
  getClientSources,
  type ClientEngagement,
  type ClientKpis,
  type ClientSignal,
  type ClientSources,
  type EngagementStatus,
} from '@/lib/data/clients';
import { resolveRole } from '@/lib/data/skilltree-roles';
import { getFleetOps, type FleetOps } from '@/lib/data/fleet-ops';
import type { Approval } from '@/lib/types';

// Re-export shared types the client component imports.
export type { EngagementStatus, ClientEngagement, ClientSignal, ClientKpis } from '@/lib/data/clients';
export type { FleetOps, EpicRow, HumanTaskRow } from '@/lib/data/fleet-ops';

// Back-compat aliases (v1 component symbol names).
export type Engagement = ClientEngagement;
export type Signal = ClientSignal;
export type MissionKpis = ClientKpis;
export interface KpiValue {
  value: number;
  label: string;
  sublabel?: string;
  estimated?: boolean;
  spark?: number[];
}

export interface ActivityLine {
  id: string;
  agent: string;
  role: string; // SkillTree role (or raw agent name when fallback)
  roleFallback: boolean;
  client?: string; // attributed client_org, when known
  message: string;
  kind: string;
  timestamp: string;
}

export interface ApprovalLaneItem {
  id: string;
  title: string;
  description?: string;
  engagement: string;
  role: string;
  category: Approval['category'];
  created_at: string;
}

export interface MissionControlData {
  generatedAt: string;
  org: string | null;
  kpis: ClientKpis;
  signals: ClientSignal[];
  engagements: ClientEngagement[];
  activity: ActivityLine[];
  approvals: ApprovalLaneItem[];
  fleetOps: FleetOps;
  sources: ClientSources;
  empty: boolean;
}

// ---------------------------------------------------------------------------
// Main aggregation
// ---------------------------------------------------------------------------

export function getMissionControlData(org?: string): MissionControlData {
  const sources = getClientSources();

  const engagements = buildEngagements(org);
  const kpis = buildClientKpis(engagements, org);
  const signals = buildClientSignals(engagements, org);

  const pendingApprovals = getPendingApprovals(org);
  const events = getRecentEvents(200, org);
  const fleetOps = getFleetOps(org);

  // -- Activity feed (role-tagged) -----------------------------------------
  const clientNames = engagements.map((e) => ({ client: e.client, clientOrg: e.clientOrg }));
  const activity: ActivityLine[] = events
    .filter((e) => e.message)
    .slice(0, 40)
    .map((e) => {
      const resolved = resolveRole(e, clientNames);
      return {
        id: e.id,
        agent: e.agent,
        role: resolved.role,
        roleFallback: resolved.isFallback,
        client: resolved.client,
        message: e.message as string,
        kind: e.category || e.type,
        timestamp: e.timestamp,
      };
    });

  // -- Approvals lane -------------------------------------------------------
  // Map each pending approval to a client engagement when the title/description
  // references it; else fall back to the approval category.
  const approvals: ApprovalLaneItem[] = pendingApprovals.map((a) => {
    const hay = `${a.title} ${a.description ?? ''}`.toLowerCase();
    const match = engagements.find(
      (e) => hay.includes(e.client.toLowerCase()) || hay.includes(e.clientOrg.toLowerCase()),
    );
    return {
      id: a.id,
      title: a.title,
      description: a.description,
      engagement: match ? match.client : a.category,
      role: a.agent,
      category: a.category,
      created_at: a.created_at,
    };
  });

  const empty =
    engagements.length === 0 && pendingApprovals.length === 0 && activity.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    org: org ?? null,
    kpis,
    signals,
    engagements,
    activity,
    approvals,
    fleetOps,
    sources,
    empty,
  };
}
