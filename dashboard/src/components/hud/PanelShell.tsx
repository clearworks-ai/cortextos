'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const HUD_POLL_INTERVAL_MS = 10_000;

export interface HudAgentStatusSummary {
  label: 'online' | 'idle' | 'halted';
  color: string;
}

export function formatRelativeTime(timestamp?: string | null): string {
  if (!timestamp) return 'no heartbeat';

  const value = Date.parse(timestamp);
  if (Number.isNaN(value)) return 'unknown';

  const diffMs = Math.max(0, Date.now() - value);
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function formatTimestamp(timestamp?: string | null): string {
  if (!timestamp) return '—';

  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return '—';

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(value);
}

export function formatAgentStatus(timestamp?: string | null): HudAgentStatusSummary {
  if (!timestamp) {
    return { label: 'halted', color: 'var(--hud-halted)' };
  }

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return { label: 'halted', color: 'var(--hud-halted)' };
  }

  const diffHours = (Date.now() - parsed) / 3_600_000;
  if (diffHours < 3) {
    return { label: 'online', color: 'var(--hud-online)' };
  }
  if (diffHours <= 12) {
    return { label: 'idle', color: 'var(--hud-idle)' };
  }
  return { label: 'halted', color: 'var(--hud-halted)' };
}

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${input}`);
  }

  return response.json() as Promise<T>;
}

export function trimText(value: string | undefined, max: number): string {
  if (!value) return '—';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

interface PanelShellProps {
  eyebrow: string;
  className?: string;
  children: ReactNode;
}

export function PanelShell({ eyebrow, className, children }: PanelShellProps) {
  return (
    <section
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-[12px] border px-4 py-4 shadow-2xl',
        className,
      )}
      style={{
        background: 'var(--hud-panel)',
        borderColor: 'var(--hud-border)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 20px 80px rgba(0, 0, 0, 0.34)',
      }}
    >
      <div
        className="text-[11px] font-semibold uppercase tracking-[0.28em]"
        style={{ color: 'var(--hud-accent-2)' }}
      >
        {eyebrow}
      </div>
      <div className="mt-3 min-h-0 flex-1">{children}</div>
    </section>
  );
}
