import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedRequest } from '@/utils/dlmm/config';
import { runDlmmManageCycle } from '@/utils/dlmm/manager';

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get('key');
  if (!isAuthorizedRequest(key, process.env.DLMM_MANAGE_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { acquireJobLock, releaseJobLock } = await import('@/utils/bot-job-lock');
  const jobLock = await acquireJobLock('dlmm_manage', 120);
  if (!jobLock.acquired) {
    return NextResponse.json(
      { success: false, skipped: true, reason: jobLock.reason },
      { status: 409 },
    );
  }

  try {
    const result = await runDlmmManageCycle();
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Manage cycle failed',
        decisions: [],
        activeCount: 0,
        closedCount: 0,
      },
      { status: 500 },
    );
  } finally {
    await releaseJobLock('dlmm_manage');
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
