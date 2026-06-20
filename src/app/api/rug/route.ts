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
];

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
    const action = body.action as 'mark' | 'unmark' | 'toggle' | undefined;

    if (!tokenAddress) {
      return NextResponse.json(
        { success: false, error: 'tokenAddress is required' },
        { status: 400 },
      );
    }

    if (action === 'unmark') {
      await unmarkTokenRug(tokenAddress);
      return NextResponse.json({ success: true, rugged: false });
    }

    if (!VALID_SOURCES.includes(source)) {
      return NextResponse.json(
        { success: false, error: 'Invalid source' },
        { status: 400 },
      );
    }

    if (action === 'toggle') {
      const { toggleTokenRug } = await import('@/utils/rug-list/service');
      const rugged = await toggleTokenRug({
        tokenAddress,
        tokenSymbol: tokenSymbol ? String(tokenSymbol) : null,
        source,
      });
      return NextResponse.json({ success: true, rugged });
    }

    const entry = await markTokenRug({
      tokenAddress,
      tokenSymbol: tokenSymbol ? String(tokenSymbol) : null,
      source,
    });

    return NextResponse.json({ success: true, entry, rugged: true });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update rug list',
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
