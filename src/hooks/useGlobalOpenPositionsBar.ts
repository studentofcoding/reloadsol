'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTradingData } from '@/components/TradingDataProvider';
import { useWallet, useConnection } from '@/components/WalletProvider';
import { useAppNetwork } from '@/contexts/AppNetworkContext';
import { useWalletTokens } from '@/hooks/useWalletTokens';
import { listLiveOpenBarPositions } from '@/utils/open-bar-positions';
import { pctFromBaseline } from '@/utils/watchlist/pct';
import { mergeTokensByMint } from '@/components/signals/shared/row-holdings';

export const GLOBAL_OPEN_BAR_PRICES_KEY = 'global-open-bar-prices';
/** Match PnL open marks — `/api/prices/open` (GMGN/Jupiter), not slow 60s Jupiter-only. */
export const OPEN_BAR_PRICE_POLL_MS = 15_000;

async function fetchOpenBarPrices(
  tokenAddresses: string[],
  chain: 'sol' | 'robinhood',
): Promise<Record<string, number>> {
  if (tokenAddresses.length === 0) return {};
  const res = await fetch('/api/prices/open/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mints: tokenAddresses, chain }),
  });
  if (!res.ok) throw new Error('Failed to fetch open bar prices');
  const data = (await res.json()) as {
    success?: boolean;
    prices?: Record<string, number>;
  };
  if (!data.success) throw new Error('Open bar price refresh failed');
  return data.prices ?? {};
}

/** Real Solana open positions for the global bar (watchlist-style marks). */
export function useGlobalOpenPositionsBar() {
  const { network } = useAppNetwork();
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const walletAddress = connected && publicKey ? publicKey.toBase58() : null;
  const { records } = useTradingData();
  const isSol = network === 'sol';
  const enabled = isSol && !!walletAddress && !!connection;

  // Deliberately the DEFAULT `includeZeroBalance` (true), not false.
  //
  // The query key is `['wallet-tokens', address, includeZeroBalance, source]`, so asking for the
  // filtered list put this bar on a DIFFERENT cache entry from the one the buy flow refreshes:
  // BulkTokenBuyer and ChartBuyModal omit the flag, so their post-buy `refetchFresh()` only ever
  // updated the `true` entry — and this bar, on `false`, kept its pre-buy list forever. That is the
  // whole "new buys never show up in Open positions" bug. Sharing the canonical key means the
  // post-trade refresh reaches this bar too; zero-balance tokens are excluded by the bar's own
  // filter below, so the visible result is unchanged.
  const holdings = useWalletTokens({
    connection,
    publicKey,
    walletAddress,
    enabled,
  });

  const holdingsByMint = useMemo(() => {
    const map = new Map<
      string,
      {
        balanceRaw: number;
        uiAmount: number;
        decimals: number;
        symbol?: string;
        logoURI?: string;
      }
    >();
    for (const tok of mergeTokensByMint(holdings.allTokens).values()) {
      const mint = tok.mintAddress;
      if (!mint) continue;
      map.set(mint, {
        balanceRaw: tok.balance,
        uiAmount: tok.uiAmount,
        decimals: tok.decimals,
        symbol: tok.symbol,
        logoURI: tok.logoURI,
      });
    }
    return map;
  }, [holdings.allTokens]);

  const candidates = useMemo(
    () => (enabled ? listLiveOpenBarPositions(records, holdingsByMint) : []),
    [enabled, records, holdingsByMint],
  );

  const mintsKey = candidates.map((p) => p.mintAddress).join(',');
  const pricesQuery = useQuery({
    queryKey: [GLOBAL_OPEN_BAR_PRICES_KEY, walletAddress, network, mintsKey],
    queryFn: () =>
      fetchOpenBarPrices(
        candidates.map((p) => p.mintAddress),
        network === 'robinhood' ? 'robinhood' : 'sol',
      ),
    enabled: enabled && candidates.length > 0,
    staleTime: OPEN_BAR_PRICE_POLL_MS - 2_000,
    refetchInterval: OPEN_BAR_PRICE_POLL_MS,
  });

  const currentPrices = pricesQuery.data ?? {};

  /**
   * Only priced positions make the bar. An unpriced hold is the signature of an airdropped clone —
   * relying on the price feed rather than on the symbol avoids hiding anything real, because a live
   * position is priced. Fail-open when the feed returned nothing at all, so a pricing outage cannot
   * empty the bar.
   */
  const positions = useMemo(() => {
    if (candidates.length === 0) return candidates;
    if (Object.keys(currentPrices).length === 0) return candidates;
    return candidates.filter((p) => (currentPrices[p.mintAddress] ?? 0) > 0);
  }, [candidates, currentPrices]);

  const priceChangePct = useMemo(() => {
    const result: Record<string, number | null> = {};
    for (const p of positions) {
      result[p.mintAddress] = pctFromBaseline(
        p.buyPriceUsd,
        currentPrices[p.mintAddress],
      );
    }
    return result;
  }, [positions, currentPrices]);

  return {
    positions,
    priceChangePct,
    enabled,
    refetchHoldings: holdings.refetchFresh,
  };
}
