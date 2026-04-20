import { NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

function loadClearpathCreds(org: string): { baseUrl: string; apiKey: string } | null {
  const secretsPath = path.join(getFrameworkRoot(), 'orgs', org, 'secrets.env');
  if (!existsSync(secretsPath)) return null;
  const text = readFileSync(secretsPath, 'utf-8');
  const get = (key: string) => text.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
  const baseUrl = get('CLEARPATH_BASE_URL');
  const apiKey = get('CLEARPATH_API_KEY');
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/**
 * GET /api/kb/clearpath/stats?org=<org>
 * Proxies to Clearpath /api/intelligence/dashboard-stats using org API key.
 */
export async function GET(request: NextRequest) {
  const org = request.nextUrl.searchParams.get('org') ?? '';
  if (!org || !/^[a-z0-9_-]+$/i.test(org)) {
    return Response.json({ error: 'org required' }, { status: 400 });
  }

  const creds = loadClearpathCreds(org);
  if (!creds) {
    return Response.json({ error: 'Clearpath not configured for this org' }, { status: 503 });
  }

  try {
    const res = await fetch(`${creds.baseUrl}/api/intelligence/dashboard-stats`, {
      headers: { 'x-api-key': creds.apiKey },
    });
    if (!res.ok) {
      return Response.json({ error: `Clearpath API error: ${res.status}` }, { status: res.status });
    }
    const data = await res.json();
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: 'Failed to reach Clearpath API' }, { status: 502 });
  }
}
