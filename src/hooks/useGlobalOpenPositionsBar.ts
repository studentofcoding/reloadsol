'use client';

import { useEffect, useMemo, useState } from 'react';
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

  const holdings = useWalletTokens({
    connection,
    publicKey,
    walletAddress,
    enabled,
    includeZeroBalance: false,
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

  const positions = useMemo(
    () => (enabled ? listLiveOpenBarPositions(records, holdingsByMint) : []),
    [enabled, records, holdingsByMint],
  );

  const mintsKey = positions.map((p) => p.mintAddress).join(',');
  const pricesQuery = useQuery({
    queryKey: [GLOBAL_OPEN_BAR_PRICES_KEY, walletAddress, network, mintsKey],
    queryFn: () =>
      fetchOpenBarPrices(
        positions.map((p) => p.mintAddress),
        network === 'robinhood' ? 'robinhood' : 'sol',
      ),
    enabled: enabled && positions.length > 0,
    staleTime: OPEN_BAR_PRICE_POLL_MS - 2_000,
    refetchInterval: OPEN_BAR_PRICE_POLL_MS,
  });

  const currentPrices = pricesQuery.data ?? {};
  const [untrackedBaseline, setUntrackedBaseline] = useState<
    Record<string, number>
  >({});

  useEffect(() => {
    setUntrackedBaseline((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const p of positions) {
        if (!p.untracked || next[p.mintAddress]) continue;
        const spot = currentPrices[p.mintAddress];
        if (spot != null && spot > 0) {
          next[p.mintAddress] = spot;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [positions, currentPrices]);

  const priceChangePct = useMemo(() => {
    const result: Record<string, number | null> = {};
    for (const p of positions) {
      const basis = p.untracked
        ? untrackedBaseline[p.mintAddress]
        : p.buyPriceUsd;
      result[p.mintAddress] = pctFromBaseline(
        basis,
        currentPrices[p.mintAddress],
      );
    }
    return result;
  }, [positions, currentPrices, untrackedBaseline]);

  return {
    positions,
    priceChangePct,
    enabled,
    refetchHoldings: holdings.refetchFresh,
  };
}
