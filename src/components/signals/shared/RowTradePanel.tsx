"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import BalanceSliderField from "@/components/BalanceSliderField";
import UniversalWalletButton from "@/components/UniversalWalletButton";
import GmgnChartEmbed from "@/components/signals/shared/GmgnChartEmbed";
import { useConnection, useWallet } from "@/components/WalletProvider";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { getSolPriceUSD } from "@/utils/solana";
import { inferGmgnChain } from "@/utils/gmgn";
import { isWalletUserRejection } from "@/utils/wallet-rejection";
import {
  TRACKER_BUY_DEFAULT_USD,
  defaultBuyAmountHuman,
  pickTrackerBaseAsset,
  trackerTradeLeg,
  type TrackerBaseAsset,
  type TrackerTradeSide,
} from "@/utils/tracker-base-asset";
import {
  TRACKER_AUTO_PRIORITY_FEE,
  TRACKER_PRIORITY_FEE_LAMPORTS,
} from "@/utils/tracker-market-swap";
import { rowMarketSwap } from "@/utils/row-market-swap";

type HoldingLeg = {
  balanceRaw: number;
  uiAmount: number;
  decimals: number;
};

/** Lazy GMGN kline used by signals and mcap-tracker rows. One open row mounts one iframe. */
export function RowGmgnChart({
  tokenAddress,
}: {
  tokenAddress: string;
}) {
  return (
    <div
      data-testid="row-gmgn-chart"
      className="mt-4 overflow-hidden rounded-lg border border-gray-700 bg-gray-900"
    >
      <div className="px-3 py-1.5 text-xs text-gray-400">Price chart (GMGN)</div>
      <GmgnChartEmbed
        tokenAddress={tokenAddress}
        interval="5"
        theme="dark"
        chain={inferGmgnChain(tokenAddress)}
        className="w-full rounded-b-lg"
        height={280}
        title={`GMGN chart ${tokenAddress.slice(0, 8)}`}
      />
    </div>
  );
}

function baseBalanceUi(
  asset: TrackerBaseAsset,
  solUi: number | null,
  usdcUi: number | null,
  usdtUi: number,
): number | null {
  if (asset === "SOL") return solUi;
  if (asset === "USDC") return usdcUi;
  return usdtUi;
}

/**
 * Manual row buy/sell for signals and mcap tracker.
 * Confirm quotes and sends through `rowMarketSwap` (the tracker auto-cap stack).
 * Early Enter Noul / soft-active does not gate this.
 */
export default function RowTradePanel({
  tokenAddress,
  tokenSymbol,
  side,
  usdtUi,
  usdtReady,
  holding,
  onClose,
  onSettled,
}: {
  tokenAddress: string;
  tokenSymbol: string;
  side: TrackerTradeSide;
  usdtUi: number;
  usdtReady: boolean;
  holding?: HoldingLeg | null;
  onClose: () => void;
  onSettled: () => void;
}) {
  const { publicKey, connected, signTransaction } = useWallet();
  const { connection } = useConnection();
  const walletAddress = connected && publicKey ? publicKey.toBase58() : null;
  const { walletBalance, usdcBalance, isLoadingBalances, refreshBalances } =
    useWalletBalances({
      walletAddress,
      enabled: Boolean(walletAddress),
    });
  const solPrice = useQuery({
    queryKey: ["tracker-sol-price-usd"],
    queryFn: () => getSolPriceUSD(),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const priceReady = solPrice.isSuccess || solPrice.isError;
  const balancesReady = !walletAddress || !isLoadingBalances;
  const ready = Boolean(walletAddress) && priceReady && balancesReady && usdtReady;
  const solUsd =
    priceReady &&
    solPrice.data != null &&
    solPrice.data > 0 &&
    walletBalance != null
      ? walletBalance * solPrice.data
      : null;
  const asset: TrackerBaseAsset = pickTrackerBaseAsset({
    solUi: walletBalance,
    solUsd: priceReady ? solUsd : null,
    usdcUi: usdcBalance,
    usdtUi: usdtReady ? usdtUi : 0,
  });
  const solSpot =
    solPrice.data != null && solPrice.data > 0 ? solPrice.data : null;

  const defaultAmount = defaultBuyAmountHuman(asset, solSpot);
  const [amountOverride, setAmountOverride] = useState<{
    asset: TrackerBaseAsset;
    value: string;
  } | null>(null);
  const amount =
    amountOverride?.asset === asset ? amountOverride.value : defaultAmount;
  const [sellPercent, setSellPercent] = useState("100");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState<string | null>(null);

  const spendable = baseBalanceUi(asset, walletBalance, usdcBalance, usdtUi);
  const humanAmount = Number.parseFloat(amount);
  const usdPreview =
    Number.isFinite(humanAmount) && humanAmount > 0
      ? asset === "SOL"
        ? solSpot != null
          ? humanAmount * solSpot
          : null
        : humanAmount
      : null;

  const confirm = async () => {
    if (!connected || !publicKey || !signTransaction) {
      setError("Connect a Solana wallet first");
      return;
    }
    if (!connection) {
      setError("RPC connection is not ready");
      return;
    }
    setBusy(true);
    setError("");
    setSignature(null);
    setStatus("Quoting…");
    try {
      const feeSol = TRACKER_PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
      if (side === "buy") {
        if (!Number.isFinite(humanAmount) || humanAmount <= 0) {
          throw new Error(`Enter a ${asset} amount`);
        }
        if (asset === "SOL") {
          if ((walletBalance ?? 0) < humanAmount + feeSol) {
            throw new Error(
              `Not enough SOL. Need ${(humanAmount + feeSol).toFixed(4)} including fees, have ${(walletBalance ?? 0).toFixed(4)}.`,
            );
          }
        } else if ((spendable ?? 0) < humanAmount) {
          throw new Error(
            `Not enough ${asset}. Need ${humanAmount}, have ${(spendable ?? 0).toFixed(2)}.`,
          );
        } else if ((walletBalance ?? 0) < feeSol) {
          throw new Error(
            `Need a little SOL for fees (${feeSol.toFixed(4)}).`,
          );
        }
      }

      const leg = trackerTradeLeg({
        side,
        asset,
        tokenMint: tokenAddress,
        buyHuman: humanAmount,
        sellBalanceRaw: holding?.balanceRaw,
        sellPercent: Number.parseFloat(sellPercent),
      });
      if (leg.amountRaw <= 0) {
        throw new Error(
          side === "sell" ? "Nothing to sell" : "Amount is too small",
        );
      }

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
      setSignature(result.signature);
      setStatus(
        `Sent · impact ${result.impactPct.toFixed(2)}% · auto slippage ${(result.slippageBps / 100).toFixed(2)}%${result.volatile ? " (capped)" : ""}`,
      );
      await refreshBalances(true);
      onSettled();
    } catch (err) {
      if (isWalletUserRejection(err)) {
        setStatus("Wallet cancelled the transaction");
        return;
      }
      setError(err instanceof Error ? err.message : "Trade failed");
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const route =
    side === "buy"
      ? `${asset} → ${tokenSymbol}`
      : `${tokenSymbol} → ${asset}`;

  return (
    <div
      data-testid={side === "buy" ? "row-buy-panel" : "row-sell-panel"}
      className="mt-4 rounded-lg border border-gray-700 bg-gray-900/80 p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-white">
            {side === "buy" ? "Buy" : "Sell"} {tokenSymbol}
          </div>
          <div
            data-testid="row-base-route"
            className="text-xs text-gray-400"
          >
            {connected
              ? ready
                ? `Route ${route}`
                : "Checking balances…"
              : "Connect a wallet to choose SOL, USDC, or USDT"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-gray-400 hover:text-white"
        >
          Close
        </button>
      </div>

      {!connected ? (
        <UniversalWalletButton />
      ) : !ready ? (
        <div className="text-xs text-gray-400">Loading wallet balances…</div>
      ) : side === "sell" && !(holding && holding.balanceRaw > 0) ? (
        <div className="text-xs text-gray-400">No balance to sell.</div>
      ) : (
        <>
          {side === "buy" ? (
            <div data-testid="row-buy-amount">
              <BalanceSliderField
                mode="amount"
                inputId={`row-buy-${tokenAddress}`}
                label={`Amount (${asset})`}
                value={amount}
                onChange={(next) => {
                  setAmountOverride({ asset, value: next });
                }}
                balance={spendable}
                decimals={asset === "SOL" ? 6 : 2}
                unit={asset}
                disabled={busy}
                sliderDisabled={busy}
                hint={
                  <span>
                    Default ${TRACKER_BUY_DEFAULT_USD} of {asset}
                    {usdPreview != null
                      ? ` · ≈ $${usdPreview.toFixed(2)}`
                      : asset === "SOL"
                        ? " · SOL price unavailable, enter an amount"
                        : ""}
                    {spendable != null
                      ? ` · bal ${spendable.toFixed(asset === "SOL" ? 4 : 2)} ${asset}`
                      : ""}
                  </span>
                }
              />
            </div>
          ) : (
            <BalanceSliderField
              mode="percent"
              inputId={`row-sell-${tokenAddress}`}
              label="Sell %"
              value={sellPercent}
              onChange={setSellPercent}
              unit="%"
              maxPercent={100}
              minPercent={1}
              disabled={busy}
              hint={
                holding
                  ? `${((holding.uiAmount * (Number.parseFloat(sellPercent) || 0)) / 100).toLocaleString()} ${tokenSymbol} → ${asset}`
                  : null
              }
            />
          )}

          <button
            type="button"
            data-testid="row-confirm-trade"
            onClick={() => void confirm()}
            disabled={busy}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded"
          >
            {busy
              ? "Confirm in wallet…"
              : side === "buy"
                ? `Confirm ${asset} buy`
                : `Confirm sell to ${asset}`}
          </button>
        </>
      )}

      {status ? <div className="text-xs text-gray-300">{status}</div> : null}
      {error ? <div className="text-xs text-red-300">{error}</div> : null}
      {signature ? (
        <a
          href={`https://solscan.io/tx/${signature}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-300 hover:text-blue-200"
        >
          View transaction
        </a>
      ) : null}
    </div>
  );
}
