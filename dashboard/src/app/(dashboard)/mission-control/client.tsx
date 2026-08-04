'use client';

import { useCallback, useEffect, useState } from 'react';
import { useOrg } from '@/hooks/use-org';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { SparkLine } from '@/components/charts/spark-line';
import { TimeAgo } from '@/components/shared';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconCheck,
  IconChevronRight,
  IconArrowRight,
  IconX,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type {
  MissionControlData,
  ClientEngagement,
  EngagementStatus,
  ClientSignal,
  ClientKpis,
  KpiValue,
  ApprovalLaneItem,
  ActivityLine,
  FleetOps,
} from '@/lib/data/mission-control';

// Single teal accent, data-viz only (sparkline + progress + status dots).
// Greyscale everywhere else, per spec. Not wired into the global theme.
const TEAL = '#5EEAD4';

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ generatedAt }: { generatedAt: string }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1
          className="text-2xl font-semibold tracking-tight"
          style={{ fontFamily: 'Marcellus, var(--font-heading), serif' }}
        >
          Mission Control · Client Delivery
        </h1>
        <p className="text-sm text-muted-foreground">
          Real client engagements — every row a SkillTree role, run by agents on schedule.
        </p>
      </div>
      <span className="text-xs text-muted-foreground">
        updated <TimeAgo date={generatedAt} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI row (exactly 5)
// ---------------------------------------------------------------------------

function KpiCard({ kpi, suffix }: { kpi: KpiValue; suffix?: string }) {
  return (
    <Card size="sm" className="min-w-0">
      <CardContent className="px-4">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {kpi.label}
          </p>
          {kpi.estimated && (
            <Badge variant="outline" className="border-muted-foreground/30 text-[10px] text-muted-foreground">
              est.
            </Badge>
          )}
        </div>
        <div className="mt-1.5 flex items-end justify-between gap-2">
          <p className="text-2xl font-semibold tabular-nums">
            {kpi.value}
            {suffix && <span className="ml-0.5 text-base text-muted-foreground">{suffix}</span>}
          </p>
          {kpi.spark && kpi.spark.length > 0 && (
            <SparkLine data={kpi.spark} color={TEAL} width={72} height={26} />
          )}
        </div>
        {kpi.sublabel && (
          <p className="mt-1 text-xs text-muted-foreground">{kpi.sublabel}</p>
        )}
      </CardContent>
    </Card>
  );
}

function KpiRow({ kpis }: { kpis: ClientKpis }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <KpiCard kpi={kpis.activeEngagements} />
      <KpiCard kpi={kpis.shippedThisWeek} />
      <KpiCard kpi={kpis.onTimeRate} suffix="%" />
      <KpiCard kpi={kpis.openItems} />
      <KpiCard kpi={kpis.avgResponse} suffix="m" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signals panel
// ---------------------------------------------------------------------------

const SIGNAL_TONE: Record<
  ClientSignal['tone'],
  { icon: typeof IconInfoCircle; className: string }
> = {
  warn: { icon: IconAlertTriangle, className: 'text-destructive' },
  good: { icon: IconCircleCheck, className: 'text-success' },
  info: { icon: IconInfoCircle, className: 'text-muted-foreground' },
};

function SignalsPanel({ signals }: { signals: ClientSignal[] }) {
  if (signals.length === 0) {
    return (
      <Card size="sm">
        <CardContent className="px-4 py-3 text-sm text-muted-foreground">
          No active signals — no blocked engagements, overdue milestones, or accuracy events flagged.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {signals.map((s) => {
        const tone = SIGNAL_TONE[s.tone];
        const Icon = tone.icon;
        return (
          <Card key={s.id} size="sm">
            <CardContent className="flex items-start gap-2.5 px-4 py-3">
              <Icon size={16} className={cn('mt-0.5 shrink-0', tone.className)} />
              <div className="min-w-0">
                <p className="text-sm font-medium leading-snug">{s.title}</p>
                {s.detail && (
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{s.detail}</p>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engagements table + peek panel
// ---------------------------------------------------------------------------

const ENGAGEMENT_STATUS: Record<
  EngagementStatus,
  { label: string; dot: string; badge: string }
> = {
  on_track: { label: 'On track', dot: 'bg-success', badge: 'bg-success/10 text-success' },
  at_risk: {
    label: 'At risk',
    dot: 'bg-amber-500',
    badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  blocked: { label: 'Blocked', dot: 'bg-destructive', badge: 'bg-destructive/10 text-destructive' },
};

function EngagementsTable({
  engagements,
  onPeek,
  noSources,
}: {
  engagements: ClientEngagement[];
  onPeek: (e: ClientEngagement) => void;
  noSources: boolean;
}) {
  if (engagements.length === 0) {
    return (
      <Card size="sm">
        <CardContent className="px-4 py-6 text-center text-sm text-muted-foreground">
          {noSources
            ? 'No client sources configured — set CRM_DIR / ORG_BRAIN_CLIENTS_DIR to load engagements.'
            : 'No client engagements — the blessed roster (OCG · Kadre · Alloi · SEIU 521 · MSIA) will appear here.'}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card size="sm" className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Client / Contact</th>
              <th className="px-4 py-2 font-medium">Phase</th>
              <th className="px-4 py-2 font-medium">Progress</th>
              <th className="px-4 py-2 font-medium">Open</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {engagements.map((e) => {
              const st = ENGAGEMENT_STATUS[e.status];
              return (
                <tr
                  key={e.id}
                  className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                  onClick={() => onPeek(e)}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{e.client}</div>
                    {e.contact && (
                      <div className="text-xs text-muted-foreground">
                        {e.contact.name}
                        {e.contact.role ? ` · ${e.contact.role}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{e.phase}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${e.progress}%`, backgroundColor: TEAL }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-muted-foreground">{e.progress}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {e.open}
                    {e.overdue > 0 && (
                      <span className="ml-1 text-xs text-destructive">({e.overdue} od)</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                        st.badge,
                      )}
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} />
                      {st.label}
                    </span>
                    {e.liveStatus && e.liveStatus !== 'blocked' && (
                      <span className="ml-1.5 text-xs text-muted-foreground" title="Live Multica status">
                        · {e.liveStatus}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PeekPanel({
  engagement,
  activity,
  onClose,
}: {
  engagement: ClientEngagement;
  activity: ActivityLine[];
  onClose: () => void;
}) {
  const st = ENGAGEMENT_STATUS[engagement.status];
  // "This week, run by agents": activity attributed to this client.
  const timeline = activity.filter(
    (a) =>
      a.client?.toLowerCase() === engagement.clientOrg.toLowerCase() ||
      a.message.toLowerCase().includes(engagement.client.toLowerCase()) ||
      a.message.toLowerCase().includes(engagement.clientOrg.toLowerCase()),
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-card p-5 shadow-xl ring-1 ring-foreground/10"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3
              className="text-lg font-semibold"
              style={{ fontFamily: 'Marcellus, var(--font-heading), serif' }}
            >
              {engagement.client}
            </h3>
            {engagement.contact && (
              <p className="text-sm text-muted-foreground">
                {engagement.contact.name}
                {engagement.contact.role ? ` · ${engagement.contact.role}` : ''}
              </p>
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {engagement.clientOrg}
              {engagement.industry ? ` · ${engagement.industry}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <IconX size={18} />
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
              st.badge,
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} />
            {st.label}
          </span>
          <span className="text-xs text-muted-foreground">{engagement.phase}</span>
          {engagement.liveStatus && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              title="Live Multica status"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TEAL }} />
              {engagement.liveStatus}
            </span>
          )}
        </div>

        {/* 3-up stats */}
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[
            { label: 'Progress', value: `${engagement.progress}%` },
            { label: 'Open', value: String(engagement.open) },
            { label: 'In progress', value: String(engagement.inProgress) },
          ].map((s) => (
            <div key={s.label} className="rounded-lg bg-muted/50 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</p>
              <p className="text-lg font-semibold tabular-nums">{s.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full"
            style={{ width: `${engagement.progress}%`, backgroundColor: TEAL }}
          />
        </div>

        {engagement.nextMilestone && (
          <p className="mt-3 text-sm">
            <span className="text-muted-foreground">Next: </span>
            {engagement.nextMilestone}
            {engagement.nextDue && (
              <span className="text-muted-foreground">
                {' '}· <TimeAgo date={engagement.nextDue} />
              </span>
            )}
          </p>
        )}

        {/* This week, run by agents */}
        <div className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            This week, run by agents
          </p>
          {timeline.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No attributed agent activity this week.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {timeline.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: TEAL }} />
                  <div className="min-w-0">
                    <p className="text-sm leading-snug">{a.message}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className={a.roleFallback ? 'italic' : ''}>{a.role}</span> · <TimeAgo date={a.timestamp} />
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {engagement.history.length > 0 && (
          <div className="mt-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">History</p>
            <ul className="mt-2 space-y-1.5">
              {engagement.history.slice(0, 5).map((h, i) => (
                <li key={i} className="text-xs text-muted-foreground line-clamp-2">
                  {h}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity feed (role sublines)
// ---------------------------------------------------------------------------

function ActivityFeed({ activity }: { activity: ActivityLine[] }) {
  if (activity.length === 0) {
    return (
      <Card size="sm">
        <CardContent className="px-4 py-6 text-center text-sm text-muted-foreground">
          No agent activity recorded yet.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card size="sm">
      <CardContent className="px-0 py-0">
        <ul className="divide-y">
          {activity.map((a) => (
            <li key={a.id} className="flex items-start gap-3 px-4 py-2.5">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: TEAL }} />
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-snug">
                  <span
                    className={cn(
                      'font-medium',
                      a.roleFallback && 'font-normal italic text-muted-foreground',
                    )}
                  >
                    {a.role}
                  </span>{' '}
                  <span className="text-muted-foreground">{a.message}</span>
                </p>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="uppercase tracking-wide">{a.kind}</span>
                  {a.client && (
                    <>
                      <span>·</span>
                      <span>{a.client}</span>
                    </>
                  )}
                  <span>·</span>
                  <TimeAgo date={a.timestamp} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Approvals lane
// ---------------------------------------------------------------------------

function ApprovalsLane({
  approvals,
  onApprove,
  approvingId,
}: {
  approvals: ApprovalLaneItem[];
  onApprove: (id: string) => void;
  approvingId: string | null;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
      <div className="rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-medium">Needs approval</p>
          <Badge variant="secondary" className="tabular-nums">
            {approvals.length}
          </Badge>
        </div>
        {approvals.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            Queue is clear — nothing waiting on you.
          </div>
        ) : (
          <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {approvals.map((a) => (
              <Card key={a.id} size="sm" className="ring-1 ring-foreground/10">
                <CardContent className="space-y-2 px-3 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium leading-snug line-clamp-2">{a.title}</p>
                    <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
                      {a.category}
                    </Badge>
                  </div>
                  {a.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{a.description}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="rounded bg-muted px-1.5 py-0.5">{a.engagement}</span>
                    <span>·</span>
                    <span>{a.role}</span>
                    <span>·</span>
                    <TimeAgo date={a.created_at} />
                  </div>
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={approvingId === a.id}
                    onClick={() => onApprove(a.id)}
                  >
                    <IconCheck size={14} />
                    {approvingId === a.id ? 'Approving…' : 'Approve'}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fleet Ops tab (epics + Josh's human tasks)
// ---------------------------------------------------------------------------

function FleetOpsPanel({ fleetOps }: { fleetOps: FleetOps }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Open epics · run by agents
        </h2>
        {fleetOps.epics.length === 0 ? (
          <Card size="sm">
            <CardContent className="px-4 py-6 text-center text-sm text-muted-foreground">
              No open epics.
            </CardContent>
          </Card>
        ) : (
          <Card size="sm" className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Epic</th>
                    <th className="px-4 py-2 font-medium">Owner</th>
                    <th className="px-4 py-2 font-medium">Tasks</th>
                    <th className="px-4 py-2 font-medium">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {fleetOps.epics.map((e) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="px-4 py-2.5 font-medium">{e.title}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{e.owner}</td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                        {e.completed}/{e.total}
                        {e.blocked > 0 && (
                          <span className="ml-1 text-destructive">({e.blocked} blk)</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{e.ageDays}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Your tasks · waiting on Josh
        </h2>
        {fleetOps.humanTasks.length === 0 ? (
          <Card size="sm">
            <CardContent className="px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing waiting on you.
            </CardContent>
          </Card>
        ) : (
          <Card size="sm">
            <CardContent className="px-0 py-0">
              <ul className="divide-y">
                {fleetOps.humanTasks.map((t) => (
                  <li key={t.id} className="flex items-start gap-3 px-4 py-2.5">
                    <span
                      className={cn(
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        t.overdue ? 'bg-destructive' : 'bg-muted-foreground/40',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug line-clamp-2">{t.title}</p>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="capitalize">{t.priority}</span>
                        {t.dueDate && (
                          <>
                            <span>·</span>
                            <span className={t.overdue ? 'text-destructive' : ''}>
                              {t.overdue ? 'overdue · ' : 'due '}
                              <TimeAgo date={t.dueDate} />
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab toggle
// ---------------------------------------------------------------------------

type Tab = 'delivery' | 'fleet';

function TabToggle({ tab, setTab, fleetCount }: { tab: Tab; setTab: (t: Tab) => void; fleetCount: number }) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5 text-sm">
      <button
        onClick={() => setTab('delivery')}
        className={cn(
          'rounded-md px-3 py-1 font-medium transition-colors',
          tab === 'delivery' ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        Client Delivery
      </button>
      <button
        onClick={() => setTab('fleet')}
        className={cn(
          'rounded-md px-3 py-1 font-medium transition-colors',
          tab === 'fleet' ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        Fleet Ops
        {fleetCount > 0 && <span className="ml-1.5 text-xs text-muted-foreground">{fleetCount}</span>}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CTA strip
// ---------------------------------------------------------------------------

function CtaStrip() {
  return (
    <Card size="sm" className="ring-1 ring-foreground/10">
      <CardContent className="flex flex-col items-start justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm font-medium">Keep delivery moving</p>
          <p className="text-xs text-muted-foreground">
            Clear the approval queue, review at-risk engagements, and let the agents run the rest.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href="/tasks" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Open tasks
            <IconChevronRight size={14} />
          </Link>
          <Link href="/approvals" className={buttonVariants({ size: 'sm' })}>
            Review approvals
            <IconArrowRight size={14} />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Root client component
// ---------------------------------------------------------------------------

export function MissionControlClient({ initialData }: { initialData: MissionControlData }) {
  const { currentOrg } = useOrg();
  const [data, setData] = useState<MissionControlData>(initialData);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('delivery');
  const [peek, setPeek] = useState<ClientEngagement | null>(null);

  const fetchData = useCallback(async () => {
    const orgParam = currentOrg && currentOrg !== 'all' ? `?org=${encodeURIComponent(currentOrg)}` : '';
    try {
      const res = await fetch(`/api/mission-control${orgParam}`);
      if (res.ok) setData(await res.json());
    } catch {
      // keep last-good data
    }
  }, [currentOrg]);

  useEffect(() => {
    if (currentOrg && currentOrg !== 'all') fetchData();
  }, [currentOrg, fetchData]);

  const handleApprove = useCallback(
    async (id: string) => {
      setApprovingId(id);
      try {
        const res = await fetch(`/api/approvals/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approved' }),
        });
        if (res.ok) {
          setData((prev) => ({
            ...prev,
            approvals: prev.approvals.filter((a) => a.id !== id),
          }));
          await fetchData();
        }
      } catch {
        // leave the card in place on failure
      } finally {
        setApprovingId(null);
      }
    },
    [fetchData],
  );

  const fleetCount =
    (data.fleetOps?.epics.length ?? 0) + (data.fleetOps?.humanTasks.length ?? 0);
  const noSources = !data.sources?.configured;

  return (
    <div className="space-y-5 pb-6" style={{ fontFamily: 'var(--font-sans)' }}>
      <Header generatedAt={data.generatedAt} />

      <div className="flex items-center justify-between">
        <TabToggle tab={tab} setTab={setTab} fleetCount={fleetCount} />
      </div>

      {tab === 'delivery' ? (
        <>
          <KpiRow kpis={data.kpis} />

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Signals</h2>
            <SignalsPanel signals={data.signals} />
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Engagements
            </h2>
            <EngagementsTable engagements={data.engagements} onPeek={setPeek} noSources={noSources} />
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Approvals · the heart of the screen
            </h2>
            <ApprovalsLane
              approvals={data.approvals}
              onApprove={handleApprove}
              approvingId={approvingId}
            />
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Activity · run by agents
            </h2>
            <ActivityFeed activity={data.activity} />
          </section>

          <CtaStrip />
        </>
      ) : (
        <FleetOpsPanel fleetOps={data.fleetOps} />
      )}

      {peek && (
        <PeekPanel engagement={peek} activity={data.activity} onClose={() => setPeek(null)} />
      )}
    </div>
  );
}
