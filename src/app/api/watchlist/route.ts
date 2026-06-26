import { NextRequest, NextResponse } from 'next/server';
import { requireWalletSession } from '@/utils/api-auth';
import {
  addWatchlistEntry,
  getWatchlist,
  removeWatchlistEntry,
} from '@/utils/watchlist/db';

export async function GET(request: NextRequest) {
  try {
    const auth = requireWalletSession(request);
    if (auth instanceof NextResponse) return auth;

    const entries = await getWatchlist(auth.session.address);
    return NextResponse.json({ success: true, entries });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load watchlist',
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = requireWalletSession(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const tokenAddress = String(
      body.tokenAddress ?? body.token_address ?? '',
    ).trim();
    const tokenSymbol = body.tokenSymbol ?? body.token_symbol ?? null;
    const logoUrl = body.logoUrl ?? body.logo_url ?? null;
    const initialPriceRaw =
      body.initialPrice ?? body.initial_price_usd ?? null;
    const initialPriceUsd =
      initialPriceRaw != null && Number(initialPriceRaw) > 0
        ? Number(initialPriceRaw)
        : null;

    if (!tokenAddress) {
      return NextResponse.json(
        { success: false, error: 'tokenAddress is required' },
        { status: 400 },
      );
    }

    const entry = await addWatchlistEntry({
      wallet_address: auth.session.address,
      token_address: tokenAddress,
      token_symbol: tokenSymbol ? String(tokenSymbol) : null,
      logo_url: logoUrl ? String(logoUrl) : null,
      initial_price_usd: initialPriceUsd,
    });

    return NextResponse.json({ success: true, entry });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to add to watchlist';
    const status = message.includes('limit reached') ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = requireWalletSession(request);
    if (auth instanceof NextResponse) return auth;

    const tokenAddress = request.nextUrl.searchParams.get('tokenAddress')?.trim();
    if (!tokenAddress) {
      return NextResponse.json(
        { success: false, error: 'tokenAddress query param is required' },
        { status: 400 },
      );
    }

    await removeWatchlistEntry(auth.session.address, tokenAddress);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to remove from watchlist',
      },
      { status: 500 },
    );
  }
}
