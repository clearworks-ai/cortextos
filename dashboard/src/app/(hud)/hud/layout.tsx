import type { CSSProperties, ReactNode } from 'react';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { jwtVerify } from 'jose';
import { redirect } from 'next/navigation';

type HudThemeStyle = CSSProperties & {
  '--hud-bg': string;
  '--hud-panel': string;
  '--hud-border': string;
  '--hud-accent': string;
  '--hud-accent-2': string;
  '--hud-text': string;
  '--hud-muted': string;
  '--hud-online': string;
  '--hud-idle': string;
  '--hud-halted': string;
};

async function hasBearerDashboardAccess(): Promise<boolean> {
  const authorization = (await headers()).get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;

  const token = authorization.slice(7);
  const secretValue = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!token || !secretValue) return false;

  try {
    const secret = new TextEncoder().encode(secretValue);
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

const hudTheme: HudThemeStyle = {
  '--hud-bg': '#0a0a0f',
  '--hud-panel': 'rgba(255,255,255,0.04)',
  '--hud-border': 'rgba(255,255,255,0.08)',
  '--hud-accent': '#7c6af7',
  '--hud-accent-2': '#f3815e',
  '--hud-text': '#e8e8f0',
  '--hud-muted': '#6b6b7b',
  '--hud-online': '#22c55e',
  '--hud-idle': '#f59e0b',
  '--hud-halted': '#ef4444',
  minHeight: '100vh',
  overflow: 'hidden',
  background: 'radial-gradient(circle at top, rgba(124,106,247,0.18), transparent 36%), var(--hud-bg)',
  color: 'var(--hud-text)',
  fontFamily: 'Inter, system-ui, sans-serif',
};

export default async function HudLayout({ children }: { children: ReactNode }) {
  const bearerAccess = await hasBearerDashboardAccess();

  if (!bearerAccess) {
    const session = await auth();
    if (!session) redirect('/login');
  }

  return (
    <div className="hud-root" style={hudTheme}>
      {children}
    </div>
  );
}
