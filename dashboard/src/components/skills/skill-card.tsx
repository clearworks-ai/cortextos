'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { IconPlayerPlay } from '@tabler/icons-react';

interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  triggers: string[];
  installed: boolean;
  installedFor: string[];
  source: 'catalog' | 'agent';
}

interface SkillCardProps {
  skill: SkillInfo;
  agents: Array<{ name: string; org: string }>;
  onRefresh: () => void;
}

export function SkillCard({ skill, agents, onRefresh }: SkillCardProps) {
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [runTarget, setRunTarget] = useState<string>(skill.installedFor[0] ?? '');
  const [error, setError] = useState('');
  const [runResult, setRunResult] = useState('');

  async function handleInstall() {
    if (!selectedAgent) { setError('Select an agent first'); return; }
    const [org, agent] = selectedAgent.split('/');
    setLoading(true); setError('');
    const res = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: skill.slug, org, agent }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Install failed');
    }
    setLoading(false);
    onRefresh();
  }

  async function handleUninstall(orgAgent: string) {
    const [org, agent] = orgAgent.split('/');
    setLoading(true); setError('');
    const res = await fetch('/api/skills', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: skill.slug, org, agent }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Uninstall failed');
    }
    setLoading(false);
    onRefresh();
  }

  async function handleRun() {
    if (!runTarget) { setError('Select an agent to run on'); return; }
    const [org, agent] = runTarget.split('/');
    setRunning(true); setError(''); setRunResult('');
    const res = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'run', slug: skill.slug, org, agent }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setRunResult(`Triggered on ${agent}`);
    } else {
      setError(data.error ?? 'Run failed');
    }
    setRunning(false);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">{skill.name}</CardTitle>
            <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">{skill.slug}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {skill.source === 'agent' && (
              <Badge variant="outline" className="text-[10px]">agent</Badge>
            )}
            {skill.installed ? (
              <Badge variant="secondary" className="text-[10px]">
                {skill.installedFor.length} agent{skill.installedFor.length !== 1 ? 's' : ''}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">Available</Badge>
            )}
          </div>
        </div>
        {skill.description && (
          <CardDescription className="line-clamp-2">{skill.description}</CardDescription>
        )}
        {skill.triggers.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {skill.triggers.slice(0, 3).map((t) => (
              <span key={t} className="inline-flex items-center rounded bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                {t}
              </span>
            ))}
            {skill.triggers.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{skill.triggers.length - 3}</span>
            )}
          </div>
        )}
      </CardHeader>

      {skill.installedFor.length > 0 && (
        <CardContent className="pt-0">
          <div className="flex flex-wrap gap-1.5">
            {skill.installedFor.map((orgAgent) => (
              <span
                key={orgAgent}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
              >
                {orgAgent.split('/').pop()}
                <button
                  type="button"
                  onClick={() => handleUninstall(orgAgent)}
                  disabled={loading}
                  className="ml-0.5 text-muted-foreground hover:text-destructive"
                  aria-label={`Uninstall from ${orgAgent}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </CardContent>
      )}

      <CardFooter>
        <div className="flex w-full flex-col gap-2">
          {/* Run an installed skill */}
          {skill.installedFor.length > 0 && (
            <div className="flex items-center gap-2">
              <Select value={runTarget} onValueChange={(v) => setRunTarget(v ?? '')}>
                <SelectTrigger className="flex-1 h-8 text-xs">
                  <SelectValue placeholder="Select agent..." />
                </SelectTrigger>
                <SelectContent>
                  {skill.installedFor.map((key) => (
                    <SelectItem key={key} value={key}>{key.split('/').pop()}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="default"
                className="h-8 gap-1"
                onClick={handleRun}
                disabled={running || !runTarget}
              >
                <IconPlayerPlay size={12} />
                {running ? 'Running…' : 'Run'}
              </Button>
            </div>
          )}

          {/* Install to a new agent */}
          <div className="flex items-center gap-2">
            <Select value={selectedAgent} onValueChange={(v) => setSelectedAgent(v ?? '')}>
              <SelectTrigger className="flex-1 h-8 text-xs">
                <SelectValue placeholder="Install to agent..." />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => {
                  const key = `${a.org}/${a.name}`;
                  const alreadyInstalled = skill.installedFor.includes(key);
                  return (
                    <SelectItem key={key} value={key} disabled={alreadyInstalled}>
                      {key}{alreadyInstalled ? ' ✓' : ''}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={handleInstall}
              disabled={loading || !selectedAgent}
            >
              Install
            </Button>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          {runResult && <p className="text-xs text-green-600">{runResult}</p>}
        </div>
      </CardFooter>
    </Card>
  );
}
