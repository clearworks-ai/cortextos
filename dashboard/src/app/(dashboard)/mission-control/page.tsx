import { getOrgs } from '@/lib/config';
import { syncAll } from '@/lib/sync';
import { getMissionControlData } from '@/lib/data/mission-control';
import { MissionControlClient } from './client';

export const dynamic = 'force-dynamic';

export default async function MissionControlPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  // Best-effort sync so the first paint reflects the latest disk state.
  try { syncAll(); } catch { /* best-effort */ }

  const orgs = getOrgs();
  const orgParam = typeof params.org === 'string' ? params.org : undefined;
  const org = orgParam && orgs.includes(orgParam) ? orgParam : undefined;

  const initialData = getMissionControlData(org);

  return <MissionControlClient initialData={initialData} />;
}
