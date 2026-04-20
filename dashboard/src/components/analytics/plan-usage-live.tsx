'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconRefresh, IconAlertTriangle } from '@tabler/icons-react';

interface UsageLive {
  five_hour: { utilization: number; resets_at: string } | null;
  seven_day: { utilization: number; resets_at: string } | null;
  seven_day_sonnet: { utilization: number; resets_at: string } | null;
  extra_usage: { is_enabled: boolean; monthly_limit: number; used_credits: number; utilization: number; currency: string } | null;
  fetched_at: string;
  error?: string;
}

function UsageBar({ pct, label, sublabel, warn }: { pct: number; label: string; sublabel?: string; warn?: boolean }) {
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-green-500';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium flex items-center gap-1.5">
          {warn && pct >= 80 && <IconAlertTriangle size={13} className="text-amber-500" />}
          {label}
        </span>
        <span className="tabular-nums font-mono">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {sublabel && <p className="text-[10px] text-muted-foreground">{sublabel}</p>}
    </div>
  );
}

function formatResets(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return `resets ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/Los_Angeles' })}`;
  } catch {
    return '';
  }
}

export function PlanUsageLive() {
  const [data, setData] = useState<UsageLive | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  async function fetchUsage() {
    setLoading(true);
    try {
      const res = await fetch('/api/usage');
      const d = await res.json();
      setData(d);
      setLastFetch(new Date());
    } catch {
      setData({ error: 'Failed to fetch', fetched_at: '', five_hour: null, seven_day: null, seven_day_sonnet: null, extra_usage: null });
    }
    setLoading(false);
  }

  useEffect(() => { fetchUsage(); }, []);

  if (loading && !data) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Claude Plan Usage</CardTitle></CardHeader>
        <CardContent><div className="space-y-3">{[...Array(3)].map((_, i) => <div key={i} className="h-8 rounded bg-muted/30 animate-pulse" />)}</div></CardContent>
      </Card>
    );
  }

  if (!data || data.error) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Claude Plan Usage</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Usage data unavailable</p></CardContent>
      </Card>
    );
  }

  const extraUsd = data.extra_usage
    ? `$${data.extra_usage.used_credits.toFixed(0)} / $${data.extra_usage.monthly_limit}`
    : undefined;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Claude Plan Usage</CardTitle>
          <button
            onClick={fetchUsage}
            disabled={loading}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh"
          >
            <IconRefresh size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        {lastFetch && (
          <p className="text-[10px] text-muted-foreground">
            Updated {lastFetch.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {data.five_hour && (
          <UsageBar
            pct={data.five_hour.utilization}
            label="5-hour window"
            sublabel={formatResets(data.five_hour.resets_at)}
          />
        )}
        {data.seven_day && (
          <UsageBar
            pct={data.seven_day.utilization}
            label="7-day (all models)"
            sublabel={data.seven_day.resets_at ? formatResets(data.seven_day.resets_at) : undefined}
            warn
          />
        )}
        {data.seven_day_sonnet && (
          <UsageBar
            pct={data.seven_day_sonnet.utilization}
            label="7-day Sonnet"
            warn
          />
        )}
        {data.extra_usage?.is_enabled && (
          <div className="pt-2 border-t">
            <UsageBar
              pct={data.extra_usage.utilization}
              label="Extra credits (monthly)"
              sublabel={extraUsd}
              warn
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
