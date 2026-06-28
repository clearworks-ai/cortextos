'use client';

import { useState } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/shared';
import { TaskCard } from './task-card';
import type { Task, TaskStatus } from '@/lib/types';

type ColumnStatus = TaskStatus;
type DropTargetStatus = Exclude<TaskStatus, 'completed'>;

interface KanbanColumn {
  status: ColumnStatus;
  label: string;
  tasks: Task[];
  droppable: boolean;
}

interface KanbanBoardProps {
  tasks: Task[];
  completedTodayTasks: Task[];
  onTaskClick: (task: Task) => void;
  onTaskMove: (taskId: string, status: DropTargetStatus) => Promise<void>;
}

function isDropTargetStatus(status: string): status is DropTargetStatus {
  return status === 'pending'
    || status === 'in_progress'
    || status === 'waiting'
    || status === 'blocked';
}

function KanbanColumnPanel({
  column,
  onTaskClick,
  movingTaskId,
}: {
  column: KanbanColumn;
  onTaskClick: (task: Task) => void;
  movingTaskId: string | null;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: column.status,
    disabled: !column.droppable,
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <StatusBadge status={column.status} />
          <span className="text-xs text-muted-foreground">
            {column.tasks.length}
          </span>
        </div>
      </div>
      <ScrollArea className="h-[calc(100vh-280px)] min-h-[300px]">
        <div
          ref={setNodeRef}
          className={cn(
            'flex min-h-full flex-col gap-2 rounded-xl px-0.5 pt-0.5 pb-1 transition-colors',
            column.droppable && 'border border-transparent',
            column.droppable && isOver && 'border-amber-400/60 bg-amber-500/5',
          )}
        >
          {column.tasks.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              No tasks
            </p>
          ) : (
            column.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={onTaskClick}
                draggable={column.droppable}
                busy={movingTaskId === task.id}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function KanbanBoard({
  tasks,
  completedTodayTasks,
  onTaskClick,
  onTaskMove,
}: KanbanBoardProps) {
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const columns: KanbanColumn[] = [
    {
      status: 'pending',
      label: 'Pending',
      tasks: tasks.filter((t) => t.status === 'pending'),
      droppable: true,
    },
    {
      status: 'in_progress',
      label: 'In Progress',
      tasks: tasks.filter((t) => t.status === 'in_progress'),
      droppable: true,
    },
    {
      status: 'waiting',
      label: 'Waiting',
      tasks: tasks.filter((t) => t.status === 'waiting'),
      droppable: true,
    },
    {
      status: 'blocked',
      label: 'Blocked',
      tasks: tasks.filter((t) => t.status === 'blocked'),
      droppable: true,
    },
    {
      status: 'completed',
      label: 'Completed (today)',
      tasks: completedTodayTasks,
      droppable: false,
    },
  ];

  async function handleDragEnd(event: DragEndEvent) {
    const targetId = event.over?.id;
    if (typeof targetId !== 'string' || !isDropTargetStatus(targetId)) {
      return;
    }

    const taskId = String(event.active.id);
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.status === targetId) {
      return;
    }

    setMovingTaskId(taskId);
    try {
      await onTaskMove(taskId, targetId);
    } finally {
      setMovingTaskId(null);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
        {columns.map((column) => (
          <KanbanColumnPanel
            key={column.status}
            column={column}
            onTaskClick={onTaskClick}
            movingTaskId={movingTaskId}
          />
        ))}
      </div>
    </DndContext>
  );
}
