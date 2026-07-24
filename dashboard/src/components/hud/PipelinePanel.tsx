'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  HUD_POLL_INTERVAL_MS,
  PanelShell,
  fetchJson,
  formatRelativeTime,
  trimText,
} from '@/components/hud/PanelShell';

interface PipelinePanelProps {
  className?: string;
}

const STAGES = ['prospect', 'qualified', 'proposal', 'active'] as const;

function detectStage(task: Task): (typeof STAGES)[number] {
  const haystack = `${task.title} ${task.description ?? ''}`.toLowerCase();
  if (haystack.includes('proposal')) return 'proposal';
  if (haystack.includes('qualif')) return 'qualified';
  if (haystack.includes('prospect')) return 'prospect';
  return 'active';
}

function getNewestTimestamp(task: Task): string {
  return task.updated_at ?? task.completed_at ?? task.created_at;
}

export function PipelinePanel({ className }: PipelinePanelProps) {
  const [crmTasks, setCrmTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const response = await fetchJson<Task[]>('/api/tasks');
        if (!alive) return;
        const active = response.filter(
          (task) =>
            task.assignee === 'crm' &&
            (task.status === 'in_progress' || task.status === 'pending'),
        );
        setCrmTasks(active);
        setError(null);
      } catch {
        if (!alive) return;
        setError('CRM feed unavailable');
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

  const grouped = useMemo(() => {
    const counts = {
      prospect: 0,
      qualified: 0,
      proposal: 0,
      active: 0,
    };

    for (const task of crmTasks) {
      counts[detectStage(task)] += 1;
    }

    const latestTask = [...crmTasks].sort((left, right) => {
      return Date.parse(getNewestTimestamp(right)) - Date.parse(getNewestTimestamp(left));
    })[0];

    const marcosAlloi = [...crmTasks]
      .filter((task) => {
        const haystack = `${task.title} ${task.description ?? ''}`.toLowerCase();
        return haystack.includes('marcos') || haystack.includes('alloi');
      })
      .sort((left, right) => {
        return Date.parse(getNewestTimestamp(right)) - Date.parse(getNewestTimestamp(left));
      })[0];

    return { counts, latestTask, marcosAlloi };
  }, [crmTasks]);

  return (
    <PanelShell eyebrow="Sales & Pipeline" className={cn(className, 'min-h-[220px]')}>
      <div className="grid h-full gap-4 lg:grid-cols-[1fr_1.2fr]">
        <div className="grid grid-cols-2 gap-3">
          {STAGES.map((stage) => (
            <div
              key={stage}
              className="rounded-2xl border border-white/5 bg-white/[0.025] p-4"
            >
              <div className="text-xs uppercase tracking-[0.22em]" style={{ color: 'var(--hud-muted)' }}>
                {stage}
              </div>
              <div className="mt-3 text-3xl font-light">{grouped.counts[stage]}</div>
            </div>
          ))}
        </div>

        <div className="space-y-3 rounded-2xl border border-white/5 bg-white/[0.025] p-4">
          <div>
            <div className="text-xs uppercase tracking-[0.22em]" style={{ color: 'var(--hud-muted)' }}>
              Latest CRM task
            </div>
            <div className="mt-2 text-lg font-medium">
              {grouped.latestTask ? trimText(grouped.latestTask.title, 90) : 'No active CRM task'}
            </div>
            <div className="mt-2 text-sm" style={{ color: 'var(--hud-muted)' }}>
              {grouped.latestTask
                ? formatRelativeTime(getNewestTimestamp(grouped.latestTask))
                : error ?? 'Waiting for CRM activity'}
            </div>
          </div>

          <div className="rounded-2xl border border-white/5 bg-black/10 p-4">
            <div className="text-xs uppercase tracking-[0.22em]" style={{ color: 'var(--hud-muted)' }}>
              Marcos / Alloi
            </div>
            <div className="mt-2 text-base font-medium">
              {grouped.marcosAlloi
                ? trimText(grouped.marcosAlloi.title, 90)
                : 'No Marcos/Alloi task'}
            </div>
            <div className="mt-2 text-sm" style={{ color: 'var(--hud-muted)' }}>
              {grouped.marcosAlloi
                ? formatRelativeTime(getNewestTimestamp(grouped.marcosAlloi))
                : 'Monitor ready'}
            </div>
          </div>
        </div>
      </div>
    </PanelShell>
  );
}
