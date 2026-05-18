export const dynamic = 'force-dynamic';

import { WikiShell } from '@/components/wiki/wiki-shell';
import { getOrgs } from '@/lib/config';

interface PageProps {
  searchParams: Promise<{ org?: string }>;
}

export default async function WikiPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const org = params.org ?? getOrgs()[0] ?? 'sondre-hq';
  return <WikiShell org={org} />;
}
