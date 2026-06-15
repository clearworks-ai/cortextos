'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@/lib/types';
import {
  HUD_POLL_INTERVAL_MS,
  PanelShell,
  fetchJson,
  formatRelativeTime,
  trimText,
} from '@/components/hud/PanelShell';

interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
}

export function ContentQueuePanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<BusMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const [taskResponse, feedResponse] = await Promise.all([
          fetchJson<Task[]>('/api/tasks'),
          fetchJson<BusMessage[]>('/api/comms/feed?limit=50'),
        ]);

        if (!alive) return;
        setTasks(taskResponse);
        setMessages(feedResponse);
        setError(null);
      } catch {
        if (!alive) return;
        setError('Content queue unavailable');
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

  const model = useMemo(() => {
    const activeTasks = tasks.filter(
      (task) => task.status === 'in_progress' || task.status === 'pending',
    );

    const museTasks = activeTasks.filter((task) => task.assignee === 'muse');
    const engineeringTasks = activeTasks.filter(
      (task) => task.assignee === 'larry' || task.assignee === 'codexer',
    );

    function latestMessageFor(agent: string): string | null {
      const entry = messages.find((message) => message.from === agent || message.to === agent);
      return entry?.timestamp ?? null;
    }

    return {
      museTasks,
      engineeringTasks,
      lastMuseActivity: latestMessageFor('muse'),
      lastLarryActivity: latestMessageFor('larry'),
      lastCodexerActivity: latestMessageFor('codexer'),
    };
  }, [messages, tasks]);

  return (
    <PanelShell eyebrow="Content Queue">
      <div className="grid h-full gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/5 bg-white/[0.025] p-4">
          <div className="text-xs uppercase tracking-[0.24em]" style={{ color: 'var(--hud-muted)' }}>
            Muse tasks
          </div>
          <div className="mt-3 space-y-3">
            {model.museTasks.length > 0 ? (
              model.museTasks.slice(0, 4).map((task) => (
                <div key={task.id} className="rounded-xl border border-white/5 bg-black/10 p-3">
                  <div className="text-sm font-medium">{trimText(task.title, 72)}</div>
                  <div className="mt-1 text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--hud-muted)' }}>
                    {formatRelativeTime(task.updated_at ?? task.created_at)}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-sm" style={{ color: 'var(--hud-muted)' }}>
                No active muse tasks.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/5 bg-white/[0.025] p-4">
          <div className="text-xs uppercase tracking-[0.24em]" style={{ color: 'var(--hud-muted)' }}>
            Larry / Codexer
          </div>
          <div className="mt-3 space-y-3">
            {model.engineeringTasks.length > 0 ? (
              model.engineeringTasks.slice(0, 4).map((task) => (
                <div key={task.id} className="rounded-xl border border-white/5 bg-black/10 p-3">
                  <div className="text-sm font-medium">{trimText(task.title, 72)}</div>
                  <div className="mt-1 text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--hud-muted)' }}>
                    @{task.assignee ?? 'unknown'} · {formatRelativeTime(task.updated_at ?? task.created_at)}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-sm" style={{ color: 'var(--hud-muted)' }}>
                No active engineering tasks.
              </div>
            )}
          </div>

          <div className="mt-4 space-y-1 text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--hud-muted)' }}>
            <div>Muse activity: {model.lastMuseActivity ? formatRelativeTime(model.lastMuseActivity) : '—'}</div>
            <div>Larry activity: {model.lastLarryActivity ? formatRelativeTime(model.lastLarryActivity) : '—'}</div>
            <div>Codexer activity: {model.lastCodexerActivity ? formatRelativeTime(model.lastCodexerActivity) : '—'}</div>
          </div>

          {error ? (
            <div className="mt-3 text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--hud-accent-2)' }}>
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </PanelShell>
  );
}
