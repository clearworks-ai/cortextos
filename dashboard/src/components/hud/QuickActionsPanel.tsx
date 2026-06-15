'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  HUD_POLL_INTERVAL_MS,
  PanelShell,
  fetchJson,
} from '@/components/hud/PanelShell';

interface SkillEntry {
  slug: string;
  name: string;
  description: string;
  installed: boolean;
  installedFor: string[];
  source: string;
}

interface DispatchResult {
  ok?: boolean;
  error?: string;
}

interface QuickAction {
  slug: string;
  label: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  { slug: 'morning-review', label: 'Morning review' },
  { slug: 'evening-review', label: 'Evening review' },
  { slug: 'comms', label: 'Check comms' },
  { slug: 'heartbeat', label: 'Heartbeat' },
  { slug: 'approvals', label: 'Approvals' },
];

function getAgentForSkill(action: QuickAction, skills: SkillEntry[]): string {
  const match = skills.find((skill) => skill.slug === action.slug || skill.name === action.slug);
  const firstInstall = match?.installedFor[0];
  if (!firstInstall) return 'frank2';
  const segments = firstInstall.split('/');
  return segments[segments.length - 1] ?? 'frank2';
}

export function QuickActionsPanel() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [sendingSlug, setSendingSlug] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const response = await fetchJson<SkillEntry[]>('/api/skills');
        if (!alive) return;
        setSkills(response);
        setError(null);
      } catch {
        if (!alive) return;
        setError('Skill catalog unavailable');
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

  const actionTargets = useMemo(() => {
    return new Map(
      QUICK_ACTIONS.map((action) => [action.slug, getAgentForSkill(action, skills)]),
    );
  }, [skills]);

  async function dispatchAction(action: QuickAction) {
    const agent = actionTargets.get(action.slug) ?? 'frank2';
    setSendingSlug(action.slug);
    setStatus(null);
    setError(null);

    try {
      const response = await fetch('/api/home/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, text: `/${action.slug}` }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Dispatch failed' })) as DispatchResult;
        setError(payload.error ?? 'Dispatch failed');
        return;
      }

      setStatus(`Dispatched /${action.slug} to @${agent}`);
    } catch {
      setError('Dispatch failed');
    } finally {
      setSendingSlug(null);
    }
  }

  return (
    <PanelShell eyebrow="Calendar + Quick Actions">
      <div className="flex h-full flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.slug}
              type="button"
              onClick={() => void dispatchAction(action)}
              disabled={sendingSlug !== null}
              className="rounded-2xl border px-3 py-3 text-left text-sm font-medium transition hover:border-white/20 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                borderColor: 'rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.025)',
              }}
            >
              <div>{action.label}</div>
              <div className="mt-1 text-[11px] uppercase tracking-[0.18em]" style={{ color: 'var(--hud-muted)' }}>
                @{actionTargets.get(action.slug) ?? 'frank2'}
              </div>
            </button>
          ))}
        </div>

        <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-4">
          <div className="text-xs uppercase tracking-[0.24em]" style={{ color: 'var(--hud-muted)' }}>
            Calendar
          </div>
          <div className="mt-3 text-lg font-medium">Google Calendar pending</div>
          <div className="mt-2 text-sm leading-6" style={{ color: 'var(--hud-muted)' }}>
            Phase 2 will wire live schedule data into this slot. The HUD ships today with the
            placeholder state only.
          </div>
        </div>

        <div className="min-h-[20px] text-sm" style={{ color: error ? 'var(--hud-accent-2)' : 'var(--hud-muted)' }}>
          {error ?? status ?? 'Dispatch actions through the existing launcher route.'}
        </div>
      </div>
    </PanelShell>
  );
}
