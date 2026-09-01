import { NextRequest, NextResponse, connection } from 'next/server';
import { requireWalletSession } from '@/utils/api-auth';
import { parseDbChain } from '@/utils/app-network-db';
import {
  addWatchlistEntry,
  getWatchlist,
  removeWatchlistEntry,
} from '@/utils/watchlist/db';

function resolveWallet(
  request: NextRequest,
  chain: 'sol' | 'robinhood',
  bodyWallet?: string | null,
): { wallet: string } | NextResponse {
  if (chain === 'robinhood') {
    const wallet = (
      bodyWallet ??
      request.nextUrl.searchParams.get('wallet') ??
      ''
    ).trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return NextResponse.json(
        { success: false, error: 'wallet (0x…) required for robinhood' },
        { status: 400 },
      );
    }
    return { wallet };
  }

  const auth = requireWalletSession(request);
  if (auth instanceof NextResponse) return auth;
  return { wallet: auth.session.address };
}

export async function GET(request: NextRequest) {
  try {
    await connection()
    const chain = parseDbChain(request.nextUrl.searchParams.get('chain'));
    const resolved = resolveWallet(request, chain);
    if (resolved instanceof NextResponse) return resolved;

    const entries = await getWatchlist(resolved.wallet, chain);
    return NextResponse.json({ success: true, entries, chain });
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
    const body = await request.json();
    const chain = parseDbChain(body.chain);
    const resolved = resolveWallet(request, chain, body.wallet);
    if (resolved instanceof NextResponse) return resolved;

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
      wallet_address: resolved.wallet,
      token_address: tokenAddress,
      token_symbol: tokenSymbol ? String(tokenSymbol) : null,
      logo_url: logoUrl ? String(logoUrl) : null,
      initial_price_usd: initialPriceUsd,
      chain,
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
    const chain = parseDbChain(request.nextUrl.searchParams.get('chain'));
    const resolved = resolveWallet(request, chain);
    if (resolved instanceof NextResponse) return resolved;

    const tokenAddress = request.nextUrl.searchParams.get('tokenAddress')?.trim();
    if (!tokenAddress) {
      return NextResponse.json(
        { success: false, error: 'tokenAddress query param is required' },
        { status: 400 },
      );
    }

    await removeWatchlistEntry(resolved.wallet, tokenAddress, chain);
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
