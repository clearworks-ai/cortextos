import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getAgentDir, getAllAgents } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
  env?: Record<string, string>;
}

interface McpServer {
  name: string;
  type: 'local' | 'global';
  transport: 'stdio' | 'http' | 'unknown';
  command?: string;
  url?: string;
  disabled?: boolean;
}

function parseMcpConfig(raw: string): Record<string, McpServerConfig> {
  try {
    const parsed = JSON.parse(raw);
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

function inferTransport(cfg: McpServerConfig): 'stdio' | 'http' | 'unknown' {
  if (cfg.url || cfg.type === 'http') return 'http';
  if (cfg.command) return 'stdio';
  return 'unknown';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  const allAgents = getAllAgents();
  const agentEntry = allAgents.find((a) => a.name.toLowerCase() === decoded.toLowerCase());
  const systemName = agentEntry?.name ?? decoded;
  const org = agentEntry?.org;

  const servers: McpServer[] = [];

  // 1. Global ~/.claude.json mcpServers
  try {
    const globalPath = path.join(os.homedir(), '.claude.json');
    const raw = fs.readFileSync(globalPath, 'utf-8');
    const globalServers = parseMcpConfig(raw);
    for (const [sName, cfg] of Object.entries(globalServers)) {
      servers.push({
        name: sName,
        type: 'global',
        transport: inferTransport(cfg),
        command: cfg.command,
        url: cfg.url,
      });
    }
  } catch { /* no global config */ }

  // 2. Agent-local .mcp.json
  try {
    const agentDir = getAgentDir(systemName, org);
    const localPath = path.join(agentDir, '.mcp.json');
    const raw = fs.readFileSync(localPath, 'utf-8');
    const localServers = parseMcpConfig(raw);
    for (const [sName, cfg] of Object.entries(localServers)) {
      const disabled = cfg.command === 'false' || cfg.command === '';
      const existing = servers.find((s) => s.name === sName);
      if (existing) {
        // Local override — mark it
        existing.disabled = disabled;
      } else {
        servers.push({
          name: sName,
          type: 'local',
          transport: inferTransport(cfg),
          command: cfg.command,
          url: cfg.url,
          disabled,
        });
      }
    }
  } catch { /* no local config */ }

  return Response.json({ servers });
}
