import { NextResponse } from 'next/server';
import { getDlmmDbStatus } from '@/utils/dlmm/db-status';
import { fetchMeteoraPools } from '@/utils/meteora';

export async function GET() {
  const dbStatus = await getDlmmDbStatus(true);

  let meteoraOk = false;
  let meteoraError: string | undefined;
  try {
    await fetchMeteoraPools({ limit: 1 });
    meteoraOk = true;
  } catch (error) {
    meteoraError = error instanceof Error ? error.message : 'Meteora API failed';
  }

  const healthy = dbStatus.reachable && dbStatus.schemaReady && meteoraOk;

  return NextResponse.json(
    {
      success: healthy,
      db: dbStatus,
      meteora: { ok: meteoraOk, error: meteoraError },
      setup:
        !dbStatus.configured || !dbStatus.reachable || !dbStatus.schemaReady
          ? [
              'Set DATABASE_URL in .env (via reloadsol-bouncer in Docker)',
              'Fresh dev: docker compose up applies db/init/*.sql automatically',
              'Migrate from Supabase: bash scripts/migrate-from-supabase.sh',
              'Restart: npm run docker:down && npm run docker:up',
            ]
          : undefined,
    },
    { status: healthy ? 200 : 503 },
  );
}
