'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Approval } from '@/lib/types';
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

function isFresh(timestamp: string): boolean {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed <= 15 * 60_000;
}

export function CommsPanel() {
  const [messages, setMessages] = useState<BusMessage[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const [feed, approvals] = await Promise.all([
          fetchJson<BusMessage[]>('/api/comms/feed?limit=5'),
          fetchJson<Approval[]>('/api/approvals?status=pending'),
        ]);

        if (!alive) return;
        setMessages(feed.slice(0, 5));
        setPendingApprovals(approvals);
        setError(null);
      } catch {
        if (!alive) return;
        setError('Comms feed unavailable');
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

  const headline = useMemo(() => pendingApprovals.length, [pendingApprovals.length]);

  return (
    <PanelShell eyebrow="Comms Triage">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <div className="text-3xl font-light">{headline}</div>
          <div className="text-xs uppercase tracking-[0.24em]" style={{ color: 'var(--hud-muted)' }}>
            Pending approvals
          </div>
        </div>
        {error ? (
          <div className="text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--hud-accent-2)' }}>
            {error}
          </div>
        ) : null}
      </div>

      <div className="space-y-3 overflow-y-auto">
        {messages.length > 0 ? (
          messages.map((message) => (
            <div
              key={message.id}
              className="rounded-2xl border border-white/5 bg-white/[0.025] p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      background: isFresh(message.timestamp)
                        ? 'var(--hud-accent-2)'
                        : 'rgba(255,255,255,0.18)',
                    }}
                  />
                  <span>{message.from}</span>
                </div>
                <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: 'var(--hud-muted)' }}>
                  {formatRelativeTime(message.timestamp)}
                </div>
              </div>
              <div className="mt-2 text-sm leading-6" style={{ color: 'var(--hud-muted)' }}>
                {trimText(message.text, 80)}
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-sm" style={{ color: 'var(--hud-muted)' }}>
            No recent inbound messages.
          </div>
        )}
      </div>
    </PanelShell>
  );
}
