'use client';

import { useEffect, useState } from 'react';

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function LiveClock() {
  const [value, setValue] = useState(() => formatClock(new Date()));

  useEffect(() => {
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      setValue(formatClock(new Date()));
    }, 1_000);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="text-sm font-medium tracking-[0.32em]" style={{ color: 'var(--hud-muted)' }}>
      {value}
    </div>
  );
}
