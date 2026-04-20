'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { OrgBadge } from '@/components/shared/org-badge';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { AgentActions } from './agent-actions';
import { IconChecklist, IconDatabase } from '@tabler/icons-react';
import type { HealthStatus } from '@/lib/types';

export interface AgentCardData {
  name: string;
  /** Filesystem / config key (e.g. "devbot"). Used for URL routing. */
  systemName: string;
  org: string;
  emoji: string;
  role: string;
  health: HealthStatus;
  currentTask?: string;
  tasksToday: number;
  /** stdout.log size in bytes */
  stdoutBytes?: number;
  /** Rotate threshold in bytes (default 50 MB) */
  stdoutCapBytes?: number;
}

interface AgentCardProps {
  agent: AgentCardData;
}

export function AgentCard({ agent }: AgentCardProps) {
  const router = useRouter();

  const healthLabel =
    agent.health === 'healthy' ? 'Online' :
    agent.health === 'stale' ? 'Stale' : 'Offline';

  return (
    <Link href={`/agents/${encodeURIComponent(agent.systemName)}`}>
      <Card className="group relative h-full cursor-pointer transition-all hover:shadow-md hover:border-primary/20">
        <CardContent className="space-y-3">
          {/* Header: avatar + name + health */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <AgentAvatar name={agent.name} emoji={agent.emoji} size="md" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold leading-tight">{agent.name}</p>
                  <HealthDot status={agent.health} />
                </div>
                {agent.systemName && agent.systemName !== agent.name && (
                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">
                    {agent.systemName}
                  </p>
                )}
                {agent.role && (
                  <p className="text-[11px] text-muted-foreground truncate max-w-[180px] mt-0.5">
                    {agent.role}
                  </p>
                )}
              </div>
            </div>
            <AgentActions
              agentName={agent.systemName}
              org={agent.org}
              health={agent.health}
              onAction={() => router.refresh()}
            />
          </div>

          {/* Org badge */}
          {agent.org && <OrgBadge org={agent.org} />}

          {/* Current task */}
          {agent.currentTask ? (
            <div className="rounded-md bg-muted/40 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground mb-0.5">Working on</p>
              <p className="text-xs leading-snug line-clamp-2">
                {agent.currentTask.replace(/^WORKING ON:\s*/i, '')}
              </p>
            </div>
          ) : (
            <div className="rounded-md bg-muted/20 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground">
                {agent.health === 'healthy' ? 'Idle' : healthLabel}
              </p>
            </div>
          )}

          {/* Footer: tasks count + log size */}
          <div className="flex items-center justify-between gap-1.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <IconChecklist size={13} />
              {agent.tasksToday} task{agent.tasksToday !== 1 ? 's' : ''} today
            </span>
            {agent.stdoutBytes !== undefined && (
              <span className="flex items-center gap-1">
                <IconDatabase size={11} />
                {(agent.stdoutBytes / 1_048_576).toFixed(1)}MB
              </span>
            )}
          </div>

          {/* Transcript usage bar */}
          {agent.stdoutBytes !== undefined && agent.stdoutCapBytes !== undefined && (
            (() => {
              const pct = Math.min(100, (agent.stdoutBytes / agent.stdoutCapBytes) * 100);
              const color = pct > 90 ? 'bg-destructive' : pct > 70 ? 'bg-yellow-500' : 'bg-primary/40';
              return (
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[10px] text-muted-foreground/60">
                    <span>Log</span>
                    <span>{pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-1 w-full rounded-full bg-muted/40">
                    <div className={`h-1 rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })()
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
