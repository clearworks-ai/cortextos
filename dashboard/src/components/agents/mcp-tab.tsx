'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { IconPlugConnected, IconPlugConnectedX, IconGlobe, IconTerminal2 } from '@tabler/icons-react';

interface McpServer {
  name: string;
  type: 'local' | 'global';
  transport: 'stdio' | 'http' | 'unknown';
  command?: string;
  url?: string;
  disabled?: boolean;
}

interface McpTabProps {
  agentName: string;
}

export function McpTab({ agentName }: McpTabProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/agents/${encodeURIComponent(agentName)}/mcp`)
      .then((r) => r.json())
      .then((d) => { setServers(d.servers ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [agentName]);

  if (loading) {
    return (
      <div className="space-y-2 pt-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-10 rounded-lg bg-muted/30 animate-pulse" />
        ))}
      </div>
    );
  }

  const active = servers.filter((s) => !s.disabled);
  const disabled = servers.filter((s) => s.disabled);

  return (
    <div className="space-y-6 pt-4">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <IconPlugConnected size={14} className="text-green-500" />
          {active.length} active
        </span>
        {disabled.length > 0 && (
          <span className="flex items-center gap-1.5">
            <IconPlugConnectedX size={14} className="text-muted-foreground/50" />
            {disabled.length} disabled
          </span>
        )}
      </div>

      {servers.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No MCP servers configured.</p>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <div
              key={s.name}
              className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm ${s.disabled ? 'opacity-40' : ''}`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {s.disabled ? (
                  <IconPlugConnectedX size={15} className="text-muted-foreground shrink-0" />
                ) : (
                  <IconPlugConnected size={15} className="text-green-500 shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="font-medium truncate">{s.name}</p>
                  {(s.command || s.url) && (
                    <p className="text-[11px] text-muted-foreground font-mono truncate">
                      {s.command || s.url}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                {s.transport === 'http' ? (
                  <Badge variant="outline" className="text-[10px] gap-1">
                    <IconGlobe size={9} />HTTP
                  </Badge>
                ) : s.transport === 'stdio' ? (
                  <Badge variant="outline" className="text-[10px] gap-1">
                    <IconTerminal2 size={9} />stdio
                  </Badge>
                ) : null}
                <Badge variant={s.type === 'global' ? 'secondary' : 'outline'} className="text-[10px]">
                  {s.type}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
