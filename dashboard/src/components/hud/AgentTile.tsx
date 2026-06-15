'use client';

import { trimText } from '@/components/hud/PanelShell';

interface AgentTileProps {
  name: string;
  status: 'online' | 'idle' | 'halted';
  currentTask?: string;
  lastHeartbeatAgo: string;
}

const STATUS_LABELS: Record<AgentTileProps['status'], string> = {
  online: 'var(--hud-online)',
  idle: 'var(--hud-idle)',
  halted: 'var(--hud-halted)',
};

export function AgentTile({
  name,
  status,
  currentTask,
  lastHeartbeatAgo,
}: AgentTileProps) {
  return (
    <article
      className="relative flex min-h-[120px] flex-col justify-between overflow-hidden rounded-2xl border p-3"
      style={{
        background: 'rgba(255,255,255,0.03)',
        borderColor: 'rgba(255,255,255,0.05)',
      }}
    >
      <div>
        <div className="text-sm font-semibold uppercase tracking-[0.2em]">
          {name}
        </div>
        <div className="mt-2 text-xs leading-5" style={{ color: 'var(--hud-muted)' }}>
          {trimText(currentTask, 60)}
        </div>
      </div>
      <div className="pr-4 text-[11px] uppercase tracking-[0.22em]" style={{ color: 'var(--hud-muted)' }}>
        {lastHeartbeatAgo}
      </div>
      <span
        aria-hidden="true"
        className="absolute bottom-3 right-3 h-3 w-3 rounded-full ring-4 ring-black/20"
        style={{ background: STATUS_LABELS[status] }}
      />
    </article>
  );
}
