'use client';

import Link from 'next/link';
import { IconArrowLeft } from '@tabler/icons-react';
import { LiveClock } from '@/components/hud/LiveClock';
import { FleetStatusPanel } from '@/components/hud/FleetStatusPanel';
import { TasksHubPanel } from '@/components/hud/TasksHubPanel';
import { PipelinePanel } from '@/components/hud/PipelinePanel';
import { CommsPanel } from '@/components/hud/CommsPanel';
import { ContentQueuePanel } from '@/components/hud/ContentQueuePanel';
import { QuickActionsPanel } from '@/components/hud/QuickActionsPanel';

export function HUDLayout() {
  return (
    <div className="flex min-h-screen flex-col px-4 py-4 sm:px-6">
      <header className="mb-4 flex items-center justify-between gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium transition hover:opacity-80"
          style={{ color: 'var(--hud-muted)' }}
        >
          <IconArrowLeft size={16} />
          <span>Dashboard</span>
        </Link>
        <LiveClock />
      </header>

      <main className="flex-1 overflow-hidden">
        <div className="flex h-full flex-col gap-4 overflow-y-auto xl:grid xl:grid-cols-3 xl:grid-rows-[1.2fr_1fr_1fr] xl:overflow-hidden">
          <TasksHubPanel className="xl:col-span-3" />
          <FleetStatusPanel />
          <PipelinePanel className="xl:col-span-2" />
          <CommsPanel />
          <ContentQueuePanel />
          <QuickActionsPanel />
        </div>
      </main>
    </div>
  );
}
