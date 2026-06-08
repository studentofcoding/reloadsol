import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedRequest } from '@/utils/dlmm/config';
import { runDlmmManageCycle } from '@/utils/dlmm/manager';

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get('key');
    if (!isAuthorizedRequest(key, process.env.DLMM_MANAGE_SECRET)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await runDlmmManageCycle();
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        success: true,
        skipped: true,
        reason: error instanceof Error ? error.message : 'Manage cycle failed',
        decisions: [],
        activeCount: 0,
        closedCount: 0,
      },
      { status: 200 },
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
