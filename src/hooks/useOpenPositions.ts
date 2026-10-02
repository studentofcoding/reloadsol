'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTradingData } from '@/components/TradingDataProvider';
import { useWallet, useConnection } from '@/components/WalletProvider';
import { useAppNetwork } from '@/contexts/AppNetworkContext';
import { useWalletTokens } from '@/hooks/useWalletTokens';
import {
  listLiveOpenBarPositions,
  visibleOpenBarPositions,
} from '@/utils/open-bar-positions';
import type { OpenBarPosition } from '@/utils/open-bar-positions';
import { pctFromBaseline } from '@/utils/watchlist/pct';
import { mergeTokensByMint } from '@/components/signals/shared/row-holdings';
import { useIsClient } from '@/hooks/useIsClient';
import { subscribeOpenPrices } from '@/utils/open-price-stream';
import {
  readOpenBarPositionsCache,
  writeOpenBarPositionsCache,
} from '@/utils/open-positions-cache';

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

/**
 * The single derivation of "what open positions does this wallet hold, and how are they doing".
 *
 * This is the one place open positions are computed. It was lifted verbatim out of
 * `useGlobalOpenPositionsBar` so that surface and `PnLTracker` cannot drift: agreement between them
 * used to be maintained by a comment in the bar ("Match PnL open marks"), which is exactly the kind
 * of invariant that rots silently. Callers get the same list and the same percentages by
 * construction rather than by coincidence.
 *
 * The comments below are load-bearing — each records a bug already paid for. Do not tidy them.
 */
export function useOpenPositions() {
  const { network } = useAppNetwork();
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const walletAddress = connected && publicKey ? publicKey.toBase58() : null;
  const { records } = useTradingData();
  const isSol = network === 'sol';
  const enabled = isSol && !!walletAddress && !!connection;
  const chain: 'sol' | 'robinhood' = network === 'robinhood' ? 'robinhood' : 'sol';
  const isClient = useIsClient();

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

  // Provisional paint: the last list observed for this wallet+chain, so chips render before the
  // holdings fetch resolves — the whole reload delay. Read in an effect, not during render: the
  // cache validates its age with `Date.now()`, and a clock read in render aborts the Next prerender
  // pass (`blocking-prerender-current-time-client`) — a build failure, not a warning. `useIsClient`
  // keeps the server and hydration renders identical, so nothing can mismatch.
  const [cachedPositions, setCachedPositions] = useState<OpenBarPosition[]>([]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only source (localStorage);
  // there is no render-time way to read it without a clock (see the comment above).
  useEffect(() => {
    if (!isClient || !enabled || !walletAddress) return;
    setCachedPositions(readOpenBarPositionsCache(walletAddress, chain));
  }, [isClient, enabled, walletAddress, chain]);

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

  // Live prices pushed over the ONE shared SSE connection (see open-price-stream.ts). This is what
  // takes the bar off a 15s poll and onto near-realtime, and it is deliberately layered ON TOP of
  // the poll rather than replacing it: `pricesQuery` stays exactly as it was, so if the stream dies
  // the safety net is still there and the worst case is the old cadence, never a missing price.
  const [streamPrices, setStreamPrices] = useState<Record<string, number>>({});
  // Keyed on the mint SET, not the array: `candidates` is rebuilt whenever records or holdings
  // change, and an array dependency would resubscribe (and, via the refcount dropping to zero,
  // reconnect) more often than the set actually changes.
  const streamMintsKey = useMemo(
    () =>
      candidates
        .map((p) => p.mintAddress)
        .sort()
        .join(','),
    [candidates],
  );
  useEffect(() => {
    if (!enabled || !streamMintsKey) return;
    return subscribeOpenPrices(streamMintsKey.split(',').filter(Boolean), (mint, price) => {
      setStreamPrices((prev) =>
        prev[mint] === price ? prev : { ...prev, [mint]: price },
      );
    });
  }, [enabled, streamMintsKey]);

  // Stream wins over poll: it is strictly fresher, and the poll can only ever be a lagging copy of
  // the same server-side cache. Merging rather than replacing keeps every mint the stream has not
  // sent yet at its polled value.
  const currentPrices = useMemo(
    () => ({ ...(pricesQuery.data ?? {}), ...streamPrices }),
    [pricesQuery.data, streamPrices],
  );

  // The response this one replaced. One poll of grace: a price that misses a single poll must not
  // make a real position flap out of the bar. Counting polls instead of milliseconds keeps every
  // clock read out of render (see above). Display never uses it — the percentage reads the live
  // price only, so a held-over position shows `—` rather than a stale percentage.
  const previousPricesRef = useRef<Record<string, number>>({});
  useEffect(() => {
    previousPricesRef.current = currentPrices;
  }, [currentPrices]);

  /**
   * Only priced positions make the bar. An unpriced hold is the signature of an airdropped clone —
   * relying on the price feed rather than on the symbol avoids hiding anything real, because a live
   * position is priced. Fail-open when the feed returned nothing at all, so a pricing outage cannot
   * empty the bar.
   */
  const positions = useMemo(
    () =>
      visibleOpenBarPositions(candidates, currentPrices, previousPricesRef.current),
    [candidates, currentPrices],
  );

  // Live inputs (holdings or records) replace the provisional list as soon as they exist, so a
  // wallet with genuinely no positions does not keep stale chips on screen.
  const hasLiveInputs = holdings.allTokens.length > 0 || records.length > 0;
  const shownPositions =
    !hasLiveInputs && cachedPositions.length > 0 ? cachedPositions : positions;

  // Write only on change — this list is polled, and an unconditional write would churn storage.
  // Never written from `cachedPositions`, so a provisional list cannot refresh its own age.
  const lastWrittenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !walletAddress || !hasLiveInputs) return;
    const signature = positions
      .map((p) => `${p.mintAddress}:${p.balanceRaw}:${p.buyPriceUsd}`)
      .join('|');
    if (signature === lastWrittenRef.current) return;
    lastWrittenRef.current = signature;
    writeOpenBarPositionsCache(walletAddress, chain, positions);
  }, [enabled, walletAddress, chain, hasLiveInputs, positions]);

  const priceChangePct = useMemo(() => {
    const result: Record<string, number | null> = {};
    for (const p of shownPositions) {
      result[p.mintAddress] = pctFromBaseline(
        p.buyPriceUsd,
        currentPrices[p.mintAddress],
      );
    }
    return result;
  }, [shownPositions, currentPrices]);

  return {
    positions: shownPositions,
    priceChangePct,
    enabled,
    refetchHoldings: holdings.refetchFresh,
  };
}
