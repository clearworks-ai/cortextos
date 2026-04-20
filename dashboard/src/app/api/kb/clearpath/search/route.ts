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
 * GET /api/kb/clearpath/search?org=<org>&q=<query>&limit=<n>&promptKeys=<csv>&dateFrom=<date>&dateTo=<date>
 * Proxies to Clearpath /api/intelligence/search using org API key.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') ?? '';
  const q = searchParams.get('q') ?? '';

  if (!org || !/^[a-z0-9_-]+$/i.test(org)) {
    return Response.json({ error: 'org required' }, { status: 400 });
  }
  if (!q.trim()) {
    return Response.json({ error: 'q required' }, { status: 400 });
  }
  if (q.length > 500) {
    return Response.json({ error: 'q too long' }, { status: 400 });
  }

  const creds = loadClearpathCreds(org);
  if (!creds) {
    return Response.json({ error: 'Clearpath not configured for this org' }, { status: 503 });
  }

  const upstream = new URL(`${creds.baseUrl}/api/intelligence/search`);
  upstream.searchParams.set('q', q);
  const limit = searchParams.get('limit');
  if (limit) upstream.searchParams.set('limit', limit);
  const promptKeys = searchParams.get('promptKeys');
  if (promptKeys) upstream.searchParams.set('promptKeys', promptKeys);
  const dateFrom = searchParams.get('dateFrom');
  if (dateFrom) upstream.searchParams.set('dateFrom', dateFrom);
  const dateTo = searchParams.get('dateTo');
  if (dateTo) upstream.searchParams.set('dateTo', dateTo);

  try {
    const res = await fetch(upstream.toString(), {
      headers: { 'x-api-key': creds.apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return Response.json({ error: `Clearpath API error: ${res.status}`, detail: body }, { status: res.status });
    }
    const data = await res.json();
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: 'Failed to reach Clearpath API' }, { status: 502 });
  }
}
