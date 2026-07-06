"use client";

import { useCallback, useState } from "react";
import { useWallet, useConnection } from "@/components/WalletProvider";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { executeBulkBuy } from "@/utils/jupiter";
import { trackBuy } from "@/utils/operations-api";
import type { BulkBuyRequest } from "@/types";

export type FastBuyState = {
  loading?: boolean;
  error?: string;
  status?: string;
};

export type FastBuyConfig = {
  solAmount: number;
  fees: number;
};

const DEFAULT_CONFIG: FastBuyConfig = {
  solAmount: 0.1,
  fees: 0.001,
};

export function useFastBuy(initialConfig: Partial<FastBuyConfig> = {}) {
  const { connected, publicKey, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const [buyConfig] = useState<FastBuyConfig>({
    ...DEFAULT_CONFIG,
    ...initialConfig,
  });
  const [buyStates, setBuyStates] = useState<Record<string, FastBuyState>>({});

  const fastBuy = useCallback(
    async (tokenAddress: string, tokenSymbol?: string) => {
      if (!connected || !publicKey || !signAllTransactions) {
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: "Connect wallet" },
        }));
        return;
      }
      if (!connection) {
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: "RPC not ready" },
        }));
        return;
      }

      const solAmount = buyConfig.solAmount;
      if (!solAmount || solAmount <= 0) {
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: "Set buy amount" },
        }));
        return;
      }

      setBuyStates((prev) => ({
        ...prev,
        [tokenAddress]: { loading: true, status: "Buying…" },
      }));

      try {
        const priorityFee = Math.round(buyConfig.fees * LAMPORTS_PER_SOL);
        const balanceBeforeOp = await connection.getBalance(publicKey);
        const balanceBeforeSOL = balanceBeforeOp / LAMPORTS_PER_SOL;
        const requiredAmount = solAmount + priorityFee / LAMPORTS_PER_SOL;
        if (balanceBeforeSOL < requiredAmount) {
          throw new Error(
            `Need ${requiredAmount.toFixed(4)} SOL, have ${balanceBeforeSOL.toFixed(4)}`,
          );
        }

        const request: BulkBuyRequest = {
          solAmount,
          tokenMints: [tokenAddress],
          slippage: 200,
          priorityFee,
        };

        const buyResult = await executeBulkBuy(
          request,
          publicKey.toString(),
          connection,
          signAllTransactions,
        );

        if (!buyResult.success || buyResult.successfulPurchases.length === 0) {
          throw new Error(
            buyResult.failedPurchases[0]?.error || "Buy failed",
          );
        }

        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, status: "Done" },
        }));
        setTimeout(() => {
          setBuyStates((prev) => {
            const next = { ...prev };
            delete next[tokenAddress];
            return next;
          });
        }, 2500);

        trackBuy(publicKey.toString(), buyResult.successfulPurchases.length, {
          failureCount: buyResult.failedPurchases.length,
          solAmount,
          tokenMints: [tokenAddress],
          signatures: buyResult.signatures,
        }).catch(console.error);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: msg },
        }));
        console.error(`Fast buy failed for ${tokenSymbol ?? tokenAddress}:`, e);
      }
    },
    [
      buyConfig.fees,
      buyConfig.solAmount,
      connected,
      connection,
      publicKey,
      signAllTransactions,
    ],
  );

  return { fastBuy, buyStates, buyConfig };
}
