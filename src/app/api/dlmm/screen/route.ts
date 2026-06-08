import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedRequest } from '@/utils/dlmm/config';
import { runDlmmScreen } from '@/utils/dlmm/screener';

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get('key');
    if (!isAuthorizedRequest(key, process.env.DLMM_SCREEN_SECRET)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const notify = searchParams.get('notify') !== 'false';
    const result = await runDlmmScreen({ notify });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Screen failed',
      },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
