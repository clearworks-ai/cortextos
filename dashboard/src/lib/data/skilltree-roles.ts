// cortextOS Dashboard - SkillTree role tagging for the activity feed.
//
// "Every line is a SkillTree role doing its job." Each activity event resolves
// to the SkillTree role that owns the work, in precedence order:
//
//   1. Explicit role in the event payload  (meta.role — zero schema change,
//      events.data already carries meta JSON).
//   2. Static (agent, category|keyword) → role map, seeded from the spec's six
//      roles + orgs/clearworksai/skilltree-your-tree.json departments.
//   3. Honest fallback: the raw agent name (never invent a role).

import type { Event } from '@/lib/types';

export interface ResolvedRole {
  role: string; // display label
  isFallback: boolean; // true => raw agent name, render muted
  client?: string; // attributed client_org / name if known
}

// Static map: keyword (matched against category + message, case-insensitive) → role.
// First match wins; ordering is by specificity.
interface RoleRule {
  agents?: string[]; // if set, event.agent must be one of these
  keywords: RegExp; // matched against `${category} ${message}`
  role: string;
}

const ROLE_RULES: RoleRule[] = [
  // Deals::Call Capture / Operations::Transcript Processing → Follow-Up Coordinator
  {
    keywords: /fireflies|transcript[- ]?scan|action[- ]?item|call capture|weekly[- ]?sweep|meeting recap|debrief/i,
    role: 'Follow-Up Coordinator',
  },
  // Back Office → Billing Manager
  {
    keywords: /invoice|moxie|billing|payment|overdue.*invoice|collections/i,
    role: 'Billing Manager',
  },
  // Operations::Status Updates → Delivery Status Reporter
  {
    keywords: /weekly[- ]?brief|status[- ]?draft|status update|delivery status|client[- ]?health/i,
    role: 'Delivery Status Reporter',
  },
  // Operations::Document Extraction → Document Processing Engineer
  {
    keywords: /extraction|accuracy|scorecard|document[- ]?extract|auditos/i,
    role: 'Document Processing Engineer',
  },
  // Operations::Portal Sync → Client Portal Manager
  {
    keywords: /deliverable|portal|publish.*deliverable|client portal/i,
    role: 'Client Portal Manager',
  },
  // Operations::Context Maintenance → Brain (orchestrator)
  {
    keywords: /kb[- ]?reconcile|knowledge[- ]?sync|writeback|memory|context maintenance|reconcile/i,
    role: 'Brain (orchestrator)',
  },
];

interface EventMeta {
  role?: string;
  client?: string;
  client_org?: string;
}

function readMeta(event: Event): EventMeta {
  const data = event.data;
  if (data && typeof data === 'object') {
    return {
      role: typeof data.role === 'string' ? data.role : undefined,
      client:
        typeof data.client === 'string'
          ? data.client
          : typeof data.client_org === 'string'
            ? (data.client_org as string)
            : undefined,
    };
  }
  return {};
}

/**
 * Resolve the SkillTree role for an activity event.
 * @param clientNames optional list of {client, org} to attribute the event to.
 */
export function resolveRole(
  event: Event,
  clientNames: { client: string; clientOrg: string }[] = [],
): ResolvedRole {
  const meta = readMeta(event);

  // Client attribution: meta.client, else case-insensitive name/org match in message.
  let client = meta.client;
  if (!client) {
    const msg = (event.message ?? '').toLowerCase();
    for (const c of clientNames) {
      if (
        (c.client && msg.includes(c.client.toLowerCase())) ||
        (c.clientOrg && msg.includes(c.clientOrg.toLowerCase()))
      ) {
        client = c.clientOrg;
        break;
      }
    }
  }

  // 1. Explicit role.
  if (meta.role && meta.role.trim()) {
    return { role: meta.role.trim(), isFallback: false, client };
  }

  // 2. Static map.
  const haystack = `${event.category ?? ''} ${event.message ?? ''}`;
  for (const rule of ROLE_RULES) {
    if (rule.agents && !rule.agents.includes(event.agent)) continue;
    if (rule.keywords.test(haystack)) {
      return { role: rule.role, isFallback: false, client };
    }
  }

  // 3. Honest fallback: raw agent name.
  return { role: event.agent, isFallback: true, client };
}
