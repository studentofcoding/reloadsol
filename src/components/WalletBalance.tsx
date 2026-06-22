"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useWallet, useConnection } from "./WalletProvider";
import { fetchUserTokens, UserToken } from "@/utils/jupiter";
import { useSolPriceFromApi } from "@/hooks/useSolPrice";
import { useWalletBalances } from "@/hooks/useWalletBalances";

interface WalletBalanceProps {
  onBalanceChange?: (balance: number) => void;
}

export default function WalletBalance({ onBalanceChange }: WalletBalanceProps) {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const walletAddress = connected && publicKey ? publicKey.toString() : null;
  const [showUSD, setShowUSD] = useState<boolean>(false);
  const [totalPortfolioValue, setTotalPortfolioValue] = useState<number>(0);
  const [isLoadingPortfolio, setIsLoadingPortfolio] = useState<boolean>(false);
  const isFetchingRef = useRef(false);

  const {
    walletBalance: balance,
    isLoadingBalances: isLoading,
    refreshBalances,
  } = useWalletBalances({
    connection,
    publicKey,
    walletAddress,
    enabled: connected && !!publicKey,
  });

  const { data: solPrice = 0 } = useSolPriceFromApi(60_000);

  useEffect(() => {
    if (balance != null) {
      onBalanceChange?.(balance);
    }
  }, [balance, onBalanceChange]);

  const fetchTotalPortfolioValue = useCallback(async () => {
    if (!publicKey || !connected || !balance || balance <= 0 || solPrice <= 0) {
      return;
    }

    if (isFetchingRef.current) return;

    isFetchingRef.current = true;
    setIsLoadingPortfolio(true);

    try {
      const userTokens = await fetchUserTokens(
        connection,
        publicKey,
        false,
        false,
      );

      const tokensValue = userTokens.reduce(
        (total, token) => total + token.usdValue,
        0,
      );

      const solValue = balance * solPrice;
      const totalPortfolio = tokensValue + solValue;

      setTotalPortfolioValue(totalPortfolio);
    } catch (error) {
      console.error("Error fetching portfolio value:", error);
    } finally {
      setIsLoadingPortfolio(false);
      isFetchingRef.current = false;
    }
  }, [publicKey, connected, balance, solPrice, connection]);

  useEffect(() => {
    if (balance && balance > 0 && solPrice > 0) {
      const timeoutId = setTimeout(() => {
        void fetchTotalPortfolioValue();
      }, 1000);
      return () => clearTimeout(timeoutId);
    }
  }, [balance, solPrice, connected, publicKey, fetchTotalPortfolioValue]);

  const handleToggleDisplay = () => {
    setShowUSD((prev) => !prev);
  };

  const handleRefresh = () => {
    void refreshBalances();
    setTimeout(() => {
      void fetchTotalPortfolioValue();
    }, 1000);
  };

  if (!connected) {
    return (
      <div className="flex items-center space-x-2 text-sm">
        <span className="text-gray-400">Not connected</span>
      </div>
    );
  }

  const renderBalance = () => {
    if (isLoading) {
      return (
        <div className="flex items-center space-x-1">
          <div className="w-3 h-3 border border-gray-400 border-t-white rounded-full animate-spin"></div>
        </div>
      );
    }

    if (showUSD) {
      if (isLoadingPortfolio) {
        return (
          <div className="flex items-center space-x-1">
            <span>$</span>
            <div className="w-3 h-3 border border-gray-400 border-t-white rounded-full animate-spin"></div>
          </div>
        );
      }
      return `$${totalPortfolioValue.toFixed(2)} (Total)`;
    }

    return `${(balance ?? 0).toFixed(4)} SOL`;
  };

  return (
    <div className="flex items-center space-x-2 text-sm">
      <div className="flex items-center space-x-2">
        <span
          className="text-white font-mono cursor-pointer hover:text-blue-300 transition-colors"
          onClick={handleToggleDisplay}
          title={
            showUSD
              ? "Click to show SOL balance"
              : "Click to show total portfolio value"
          }
        >
          {renderBalance()}
        </span>
        <button
          onClick={handleRefresh}
          className="ml-1 text-gray-400 hover:text-white transition-colors"
          title="Refresh balance"
        >
          <svg
            className="w-3 h-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
