'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { OptimizedImage } from '@/components/OptimizedImage';
import BalanceSliderField from '@/components/BalanceSliderField';
import { useConnection, useWallet } from '@/components/WalletProvider';
import { useWalletBalances } from '@/hooks/useWalletBalances';
import { useGlobalWatchlist } from '@/hooks/useGlobalWatchlist';
import { useGlobalOpenPositionsBar } from '@/hooks/useGlobalOpenPositionsBar';
import { getSolPriceUSD } from '@/utils/solana';
import { useQuery } from '@tanstack/react-query';
import {
  pickTrackerBaseAsset,
  trackerTradeLeg,
  type TrackerBaseAsset,
} from '@/utils/tracker-base-asset';
import {
  TRACKER_AUTO_PRIORITY_FEE,
  TRACKER_PRIORITY_FEE_LAMPORTS,
} from '@/utils/tracker-market-swap';
import { rowMarketSwap } from '@/utils/row-market-swap';
import { publishLiveSwap } from '@/utils/trade-tracking';
import { useTradingData } from '@/components/TradingDataProvider';
import { isWalletUserRejection } from '@/utils/wallet-rejection';
import type { OpenBarPosition } from '@/utils/open-bar-positions';
import { RowGmgnChart } from '@/components/signals/shared/RowTradePanel';

function formatPct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function pctColor(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value) || value === 0) return 'text-gray-400';
  return value > 0 ? 'text-green-400' : 'text-red-400';
}

function ChipFace({
  symbol,
  logoUrl,
  pct,
}: {
  symbol: string;
  logoUrl?: string | null;
  pct: number | null | undefined;
}) {
  return (
    <>
      {logoUrl ? (
        <OptimizedImage
          src={logoUrl}
          alt={symbol}
          width={24}
          height={24}
          className="w-6 h-6 rounded-full"
        />
      ) : (
        <span className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center text-xs text-gray-300">
          {symbol.slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className="text-xs font-medium text-white max-w-[72px] truncate">
        {symbol}
      </span>
      <span className={`text-xs font-semibold tabular-nums ${pctColor(pct)}`}>
        {formatPct(pct)}
      </span>
    </>
  );
}

function OpenSellModal({
  position,
  onClose,
  onSettled,
}: {
  position: OpenBarPosition;
  onClose: () => void;
  onSettled: () => void;
}) {
  const { publicKey, connected, signTransaction } = useWallet();
  const { connection } = useConnection();
  const { trackOperation } = useTradingData();
  const walletAddress = connected && publicKey ? publicKey.toBase58() : null;
  const { walletBalance, usdcBalance, refreshBalances } = useWalletBalances({
    walletAddress,
    enabled: Boolean(walletAddress),
  });
  const solPrice = useQuery({
    queryKey: ['tracker-sol-price-usd'],
    queryFn: () => getSolPriceUSD(),
    staleTime: 60_000,
  });
  const solUsd =
    solPrice.data != null &&
    solPrice.data > 0 &&
    walletBalance != null
      ? walletBalance * solPrice.data
      : null;
  const asset: TrackerBaseAsset = pickTrackerBaseAsset({
    solUi: walletBalance,
    solUsd,
    usdcUi: usdcBalance,
    usdtUi: 0,
  });

  const [sellPercent, setSellPercent] = useState('100');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const confirm = async () => {
    if (!connected || !publicKey || !signTransaction || !connection) {
      setError('Connect a Solana wallet first');
      return;
    }
    setBusy(true);
    setError('');
    setStatus('Quoting…');
    try {
      const feeSol = TRACKER_PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
      if ((walletBalance ?? 0) < feeSol) {
        throw new Error(`Need a little SOL for fees (${feeSol.toFixed(4)}).`);
      }
      const leg = trackerTradeLeg({
        side: 'sell',
        asset,
        tokenMint: position.mintAddress,
        buyHuman: 0,
        sellBalanceRaw: position.balanceRaw,
        sellPercent: Number.parseFloat(sellPercent),
      });
      if (leg.amountRaw <= 0) throw new Error('Nothing to sell');

      const result = await rowMarketSwap(
        {
          connection,
          userPublicKey: publicKey.toBase58(),
          signTransaction: (tx) => signTransaction(tx),
          inputMint: leg.inputMint,
          outputMint: leg.outputMint,
          amount: leg.amountRaw,
          priorityFeeLamports: TRACKER_AUTO_PRIORITY_FEE,
        },
        setStatus,
      );
      setStatus(`Sent · ${result.signature.slice(0, 8)}…`);
      const soldUi =
        (position.uiAmount * (Number.parseFloat(sellPercent) || 0)) / 100;
      void publishLiveSwap(trackOperation, {
        side: 'sell',
        walletAddress: publicKey.toBase58(),
        signature: result.signature,
        tokenMint: position.mintAddress,
        tokenSymbol: position.symbol,
        tokenUiAmount: soldUi,
        quoteAmount: Math.max(soldUi, 1e-9),
      });
      await refreshBalances(true);
      onSettled();
      onClose();
    } catch (err) {
      if (isWalletUserRejection(err)) {
        setStatus('Wallet cancelled');
        return;
      }
      setError(err instanceof Error ? err.message : 'Sell failed');
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-bar-sell-title"
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-gray-600 bg-gray-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            id="open-bar-sell-title"
            className="text-sm font-semibold text-white"
          >
            Sell {position.symbol}
          </h2>
          <button
            type="button"
            className="text-xs text-gray-400 hover:text-white disabled:opacity-50"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>
        <div className="-mx-1">
          <RowGmgnChart tokenAddress={position.mintAddress} />
        </div>
        <BalanceSliderField
          mode="percent"
          inputId={`open-bar-sell-${position.mintAddress}`}
          label="Sell %"
          value={sellPercent}
          onChange={setSellPercent}
          unit="%"
          maxPercent={100}
          minPercent={1}
          disabled={busy}
          hint={`${((position.uiAmount * (Number.parseFloat(sellPercent) || 0)) / 100).toLocaleString()} ${position.symbol} → ${asset}`}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className="mt-3 w-full rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? 'Confirm in wallet…' : `Confirm sell to ${asset}`}
        </button>
        {status ? <p className="mt-2 text-xs text-gray-400">{status}</p> : null}
        {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
      </div>
    </div>
  );
}

export default function GlobalWatchlistBar() {
  const {
    entries,
    priceChangePct,
    remove,
    isRemoving,
    walletConnected,
  } = useGlobalWatchlist();
  const {
    positions,
    priceChangePct: openPct,
    enabled: openEnabled,
    refetchHoldings,
  } = useGlobalOpenPositionsBar();
  const [sellMint, setSellMint] = useState<string | null>(null);

  const showWatchlist = walletConnected && entries.length > 0;
  const showOpen = openEnabled && positions.length > 0;
  if (!showWatchlist && !showOpen) return null;

  const sellPosition = positions.find((p) => p.mintAddress === sellMint) ?? null;

  return (
    <div className="w-full min-h-[40px] mb-2">
      <div className="flex max-w-6xl mx-auto items-center gap-2 overflow-x-auto px-2 py-1.5 flex-nowrap scrollbar-thin">
        {showWatchlist ? (
          <>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-500">
              Watchlist
            </span>
            {entries.map((entry) => {
              const symbol =
                entry.token_symbol ?? entry.token_address.slice(0, 6);
              const pct = priceChangePct[entry.token_address];
              const removing = isRemoving(entry.token_address);
              return (
                <div
                  key={entry.id}
                  className="relative flex items-center gap-1.5 shrink-0 rounded-md bg-gray-900/70 border border-gray-700 px-2 py-1"
                >
                  <Link
                    href={`/chart/${entry.token_address}`}
                    prefetch
                    className="flex items-center gap-1.5 min-h-[28px] hover:opacity-90"
                    title={`Open ${symbol} chart`}
                  >
                    <ChipFace
                      symbol={symbol}
                      logoUrl={entry.logo_url}
                      pct={pct}
                    />
                  </Link>
                  <button
                    type="button"
                    disabled={removing}
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(entry.token_address);
                    }}
                    className="min-w-[28px] min-h-[28px] flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded disabled:opacity-50"
                    title="Remove from watchlist"
                    aria-label={`Remove ${symbol} from watchlist`}
                  >
                    {removing ? '…' : '×'}
                  </button>
                </div>
              );
            })}
          </>
        ) : null}

        {showWatchlist && showOpen ? (
          <span
            className="shrink-0 h-5 w-px bg-gray-600"
            aria-hidden
          />
        ) : null}

        {showOpen ? (
          <>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-600/90">
              Open
            </span>
            {positions.map((pos) => {
              const pct = openPct[pos.mintAddress];
              return (
                <div
                  key={pos.mintAddress}
                  className="flex items-center gap-1.5 shrink-0 rounded-md bg-amber-950/40 border border-amber-800/60 px-2 py-1"
                >
                  <button
                    type="button"
                    onClick={() => setSellMint(pos.mintAddress)}
                    className="flex items-center gap-1.5 min-h-[28px] hover:opacity-90"
                    title={`Sell ${pos.symbol}`}
                  >
                    <ChipFace
                      symbol={pos.symbol}
                      logoUrl={pos.logoURI}
                      pct={pct}
                    />
                  </button>
                </div>
              );
            })}
          </>
        ) : null}
      </div>

      {sellPosition ? (
        <OpenSellModal
          position={sellPosition}
          onClose={() => setSellMint(null)}
          onSettled={() => {
            void refetchHoldings();
          }}
        />
      ) : null}
    </div>
  );
}
