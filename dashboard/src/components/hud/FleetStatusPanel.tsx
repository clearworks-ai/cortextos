'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentListItem } from '@/lib/agents';
import { AgentTile } from '@/components/hud/AgentTile';
import {
  HUD_POLL_INTERVAL_MS,
  PanelShell,
  fetchJson,
  formatAgentStatus,
  formatRelativeTime,
} from '@/components/hud/PanelShell';

interface HudAgent extends AgentListItem {
  health?: string;
  status?: string;
}

const ACTIVE_AGENT_NAMES = [
  'frank2',
  'larry',
  'crm',
  'muse',
  'codexer',
  'ophir',
  'scout',
  'maven',
] as const;

const EXCLUDED_AGENTS = new Set([
  'sage',
  'auditos',
  'auditos2',
  'sre',
  'capital',
  'academy',
  'codexer-v2',
]);

export function FleetStatusPanel() {
  const [agents, setAgents] = useState<HudAgent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const response = await fetchJson<HudAgent[]>('/api/agents');
        if (!alive) return;
        setAgents(response.filter((agent) => !EXCLUDED_AGENTS.has(agent.name)));
        setError(null);
      } catch {
        if (!alive) return;
        setError('Agent feed unavailable');
      }
    }

    void load();
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      void load();
    }, HUD_POLL_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const orderedAgents = useMemo(() => {
    return ACTIVE_AGENT_NAMES.map((name) => {
      return agents.find((agent) => agent.name === name) ?? { name, org: 'clearworksai' };
    });
  }, [agents]);

  return (
    <PanelShell eyebrow="Fleet Status">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <div className="text-3xl font-light">{orderedAgents.length}</div>
          <div className="text-xs uppercase tracking-[0.24em]" style={{ color: 'var(--hud-muted)' }}>
            Active agents
          </div>
        </div>
        {error ? (
          <div className="text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--hud-accent-2)' }}>
            {error}
          </div>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
        {orderedAgents.map((agent) => {
          const status = formatAgentStatus(agent.lastHeartbeat);
          return (
            <AgentTile
              key={agent.name}
              name={agent.name}
              status={status.label}
              currentTask={agent.currentTask}
              lastHeartbeatAgo={formatRelativeTime(agent.lastHeartbeat)}
            />
          );
        })}
      </div>
    </PanelShell>
  );
}
