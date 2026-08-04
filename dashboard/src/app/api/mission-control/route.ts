import { NextRequest } from 'next/server';
import { getMissionControlData } from '@/lib/data/mission-control';
import { getOrgs } from '@/lib/config';
import { syncAll } from '@/lib/sync';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/mission-control - Aggregated Client Delivery ops-room snapshot.
//
// Reads LIVE snapshotted rows (tasks / approvals / events) from the SQLite
// read-cache after a best-effort sync from disk. Optional ?org= scopes to a
// single org; omitted returns all orgs.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  try { syncAll(); } catch { /* best-effort */ }

  const orgParam = searchParams.get('org') || undefined;
  const org = orgParam && getOrgs().includes(orgParam) ? orgParam : undefined;

  try {
    const data = getMissionControlData(org);
    return Response.json(data);
  } catch (err) {
    console.error('[api/mission-control] GET error:', err);
    return Response.json(
      { error: 'Failed to build mission control snapshot' },
      { status: 500 },
    );
  }
}
