import { NextRequest, NextResponse } from 'next/server';
import type { TokenRugSource } from '@/types/rug-list';
import {
  getRugList,
  markTokenRug,
  unmarkTokenRug,
} from '@/utils/rug-list/service';

const VALID_SOURCES: TokenRugSource[] = [
  'signals',
  'live',
  'board',
  'tracker',
  'tracker-stop',
  'signals-label',
  'algo-dashboard',
  'algo-history',
  'dlmm-general',
  'gmgn-radar',
  'concentration',
];

/** Backward-compatible alias — delegates to shared token_rug_list service. */
export async function GET() {
  try {
    const entries = await getRugList();
    return NextResponse.json({ success: true, entries });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load rug list',
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const tokenAddress = String(body.tokenAddress ?? body.token_address ?? '').trim();
    const tokenSymbol = body.tokenSymbol ?? body.token_symbol ?? null;
    const source = (body.source ?? 'dlmm-general') as TokenRugSource;

    if (!tokenAddress) {
      return NextResponse.json(
        { success: false, error: 'tokenAddress is required' },
        { status: 400 },
      );
    }

    if (!VALID_SOURCES.includes(source)) {
      return NextResponse.json(
        { success: false, error: 'Invalid source' },
        { status: 400 },
      );
    }

    const entry = await markTokenRug({
      tokenAddress,
      tokenSymbol: tokenSymbol ? String(tokenSymbol) : null,
      source,
    });

    return NextResponse.json({ success: true, entry });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add to rug list',
      },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const tokenAddress = req.nextUrl.searchParams.get('tokenAddress')?.trim();
    if (!tokenAddress) {
      return NextResponse.json(
        { success: false, error: 'tokenAddress query param is required' },
        { status: 400 },
      );
    }

    await unmarkTokenRug(tokenAddress);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove from rug list',
      },
      { status: 500 },
    );
  }
}
