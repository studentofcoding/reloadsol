import { NextRequest, NextResponse, connection } from 'next/server';
import { DbUnavailableError } from '@/utils/db-health';
import { isDlmmApiAuthorized } from '@/utils/dlmm/config';
import { defaultAgentConfig } from '@/utils/dlmm/config';
import { getAgentConfig, updateAgentConfig } from '@/utils/dlmm/db';
import { getDlmmDbStatus } from '@/utils/dlmm/db-status';
import type { DlmmAgentConfig } from '@/types/dlmm';

function getPassword(req: NextRequest): string | null {
  return req.headers.get('x-dlmm-password') || new URL(req.url).searchParams.get('password');
}

function envConfigFallback(): DlmmAgentConfig {
  return {
    id: 'env-fallback',
    ...defaultAgentConfig(),
    updated_at: new Date().toISOString(),
  };
}

export const dynamic = "force-dynamic"
export async function GET() {
  await connection()
  let config: DlmmAgentConfig = envConfigFallback();
  let dbStatus = await getDlmmDbStatus().catch(() => ({
    configured: false,
    reachable: false,
    schemaReady: false,
    error: 'Database status check failed',
  }));

  try {
    config = await getAgentConfig();
  } catch {
    config = envConfigFallback();
  }

  return NextResponse.json({
    success: true,
    config,
    dbStatus,
    usingEnvFallback: config.id === 'env-fallback',
  });
}

export async function PATCH(req: NextRequest) {
  try {
    if (!isDlmmApiAuthorized(getPassword(req))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = await req.json();
    const config = await updateAgentConfig(body);
    return NextResponse.json({ success: true, config });
  } catch (error) {
    if (error instanceof DbUnavailableError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 503 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 },
    );
  }
}
