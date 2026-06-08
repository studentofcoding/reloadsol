import { NextRequest, NextResponse } from 'next/server';
import { isDlmmApiAuthorized } from '@/utils/dlmm/config';
import { editPosition, removePosition } from '@/utils/dlmm/actions';
import { getPositionById } from '@/utils/dlmm/db';

function getPassword(req: NextRequest): string | null {
  return req.headers.get('x-dlmm-password') || new URL(req.url).searchParams.get('password');
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const position = await getPositionById(params.id);
    if (!position) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, position });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    if (!isDlmmApiAuthorized(getPassword(req))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = await req.json();
    const result = await editPosition(params.id, {
      takeProfitPct: body.takeProfitPct != null ? Number(body.takeProfitPct) : undefined,
      stopLossPct: body.stopLossPct != null ? Number(body.stopLossPct) : undefined,
      oorTimeoutMin: body.oorTimeoutMin != null ? Number(body.oorTimeoutMin) : undefined,
      binRangeInterval: body.binRangeInterval != null ? Number(body.binRangeInterval) : undefined,
      muted: body.muted,
    });
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Edit failed' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    if (!isDlmmApiAuthorized(getPassword(req))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const result = await removePosition(params.id);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Remove failed' },
      { status: 500 },
    );
  }
}
