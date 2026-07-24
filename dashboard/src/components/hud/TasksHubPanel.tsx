'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@/lib/types';
import type { FleetPulseItem } from '@/lib/agents';
import { cn } from '@/lib/utils';
import {
  HUD_POLL_INTERVAL_MS,
  PanelShell,
  fetchJson,
  formatRelativeTime,
  formatTimestamp,
  trimText,
} from '@/components/hud/PanelShell';

interface TasksHubPanelProps {
  className?: string;
}

function isToday(timestamp?: string): boolean {
  if (!timestamp) return false;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return false;

  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function TasksHubPanel({ className }: TasksHubPanelProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [fleetPulse, setFleetPulse] = useState<FleetPulseItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const [taskResponse, pulseResponse] = await Promise.all([
          fetchJson<Task[]>('/api/tasks'),
          fetchJson<FleetPulseItem[]>('/api/home/fleet-pulse'),
        ]);

        if (!alive) return;
        setTasks(taskResponse);
        setFleetPulse(pulseResponse);
        setError(null);
      } catch {
        if (!alive) return;
        setError('Task hub degraded');
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

  const metrics = useMemo(() => {
    const activeTasks = tasks.filter((task) => task.status === 'in_progress');
    const humanPending = tasks.filter(
      (task) => task.status === 'pending' && task.assignee === 'human',
    );
    const completedToday = tasks.filter(
      (task) => task.status === 'completed' && isToday(task.completed_at ?? task.updated_at),
    );
    const lastPulse = [...fleetPulse]
      .filter((item) => item.lastActiveAt)
      .sort((left, right) => {
        return Date.parse(right.lastActiveAt ?? '') - Date.parse(left.lastActiveAt ?? '');
      })[0];

    return {
      activeCount: activeTasks.length,
      humanPendingCount: humanPending.length,
      humanPendingTitle: humanPending[0]?.title,
      completedTodayCount: completedToday.length,
      eventsToday: '—',
      lastPulse,
    };
  }, [fleetPulse, tasks]);

  return (
    <PanelShell eyebrow="Daily Ops Hub" className={cn(className, 'min-h-[220px]')}>
      <div className="grid h-full gap-4 xl:grid-cols-[1.3fr_1fr_1fr_1fr]">
        <div className="rounded-2xl border border-white/5 bg-white/[0.025] p-4">
          <div className="text-xs uppercase tracking-[0.24em]" style={{ color: 'var(--hud-muted)' }}>
            In progress
          </div>
          <div className="mt-3 text-6xl font-extralight leading-none">
            {metrics.activeCount}
          </div>
          <div className="mt-4 text-sm" style={{ color: 'var(--hud-muted)' }}>
            {error ?? 'Polling every 10 seconds'}
          </div>
        </div>

        <div className="rounded-2xl border border-white/5 bg-white/[0.025] p-4">
          <div className="text-xs uppercase tracking-[0.24em]" style={{ color: 'var(--hud-muted)' }}>
            Human queue
          </div>
          <div className="mt-3 text-3xl font-light">{metrics.humanPendingCount}</div>
          <div className="mt-3 text-sm leading-6" style={{ color: 'var(--hud-muted)' }}>
            {trimText(metrics.humanPendingTitle, 72)}
          </div>
        </div>

        <div className="rounded-2xl border border-white/5 bg-white/[0.025] p-4">
          <div className="text-xs uppercase tracking-[0.24em]" style={{ color: 'var(--hud-muted)' }}>
            Completed today
          </div>
          <div className="mt-3 text-3xl font-light">{metrics.completedTodayCount}</div>
          <div className="mt-3 text-sm leading-6" style={{ color: 'var(--hud-muted)' }}>
            Events today: {metrics.eventsToday}
          </div>
        </div>

        <div className="rounded-2xl border border-white/5 bg-white/[0.025] p-4">
          <div className="text-xs uppercase tracking-[0.24em]" style={{ color: 'var(--hud-muted)' }}>
            Fleet pulse
          </div>
          <div className="mt-3 text-lg font-medium">
            {metrics.lastPulse?.name ?? 'Unavailable'}
          </div>
          <div className="mt-2 text-sm leading-6" style={{ color: 'var(--hud-muted)' }}>
            {metrics.lastPulse?.lastVerb
              ? trimText(metrics.lastPulse.lastVerb, 56)
              : 'Last comms-check unavailable'}
          </div>
          <div className="mt-3 text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--hud-muted)' }}>
            {metrics.lastPulse?.lastActiveAt
              ? `${formatRelativeTime(metrics.lastPulse.lastActiveAt)} · ${formatTimestamp(metrics.lastPulse.lastActiveAt)}`
              : 'No recent activity'}
          </div>
        </div>
      </div>
    </PanelShell>
  );
}
