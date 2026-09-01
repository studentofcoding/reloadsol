import { NextRequest, NextResponse, connection } from 'next/server';
import { rejectWrongNetwork } from '@/utils/app-network-api';
import { DbUnavailableError } from '@/utils/db-health';
import { isDlmmApiAuthorized } from '@/utils/dlmm/config';
import { deployPosition } from '@/utils/dlmm/actions';
import { getPositions, getRecentLessons } from '@/utils/dlmm/db';
import { getDlmmDbStatus } from '@/utils/dlmm/db-status';

function getPassword(req: NextRequest): string | null {
  return req.headers.get('x-dlmm-password') || new URL(req.url).searchParams.get('password');
}

export async function GET(req: NextRequest) {
  await connection()
  const wrong = rejectWrongNetwork(req, 'sol');
  if (wrong) return wrong;
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') ?? undefined;
    const includeLessons = searchParams.get('lessons') === 'true';

    const [positions, dbStatus] = await Promise.all([
      getPositions(status ?? undefined),
      getDlmmDbStatus(),
    ]);
    const payload: Record<string, unknown> = { success: true, positions, dbStatus };

    if (includeLessons) {
      payload.lessons = await getRecentLessons(30);
    }

    return NextResponse.json(payload);
  } catch (error) {
    const dbStatus = await getDlmmDbStatus().catch(() => undefined);
    return NextResponse.json({
      success: true,
      positions: [],
      lessons: [],
      dbStatus,
      warning: error instanceof Error ? error.message : 'Partial data load failed',
    });
  }
}

export async function POST(req: NextRequest) {
  const wrong = rejectWrongNetwork(req, 'sol');
  if (wrong) return wrong;
  try {
    if (!isDlmmApiAuthorized(getPassword(req))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const result = await deployPosition({
      poolAddress: body.poolAddress,
      amountSol: Number(body.amountSol),
      binRangeInterval: body.binRangeInterval != null ? Number(body.binRangeInterval) : undefined,
      strategyType: body.strategyType,
      takeProfitPct: body.takeProfitPct != null ? Number(body.takeProfitPct) : undefined,
      stopLossPct: body.stopLossPct != null ? Number(body.stopLossPct) : undefined,
      oorTimeoutMin: body.oorTimeoutMin != null ? Number(body.oorTimeoutMin) : undefined,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    if (error instanceof DbUnavailableError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 503 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Deploy failed' },
      { status: 500 },
    );
  }
}
