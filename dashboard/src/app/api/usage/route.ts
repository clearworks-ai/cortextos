import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

const execAsync = promisify(exec);

export interface UsageLive {
  five_hour: { utilization: number; resets_at: string } | null;
  seven_day: { utilization: number; resets_at: string } | null;
  seven_day_sonnet: { utilization: number; resets_at: string } | null;
  extra_usage: { is_enabled: boolean; monthly_limit: number; used_credits: number; utilization: number; currency: string } | null;
  fetched_at: string;
}

export async function GET() {
  try {
    const script = path.join(getFrameworkRoot(), 'bus', 'check-usage-api.sh');
    const { stdout } = await execAsync(`bash "${script}" 2>/dev/null`, { timeout: 15000 });
    const raw = JSON.parse(stdout.trim());
    const result: UsageLive = {
      five_hour: raw.five_hour ?? null,
      seven_day: raw.seven_day ?? null,
      seven_day_sonnet: raw.seven_day_sonnet ?? null,
      extra_usage: raw.extra_usage ?? null,
      fetched_at: new Date().toISOString(),
    };
    return Response.json(result);
  } catch {
    return Response.json({ error: 'Usage data unavailable' }, { status: 503 });
  }
}
