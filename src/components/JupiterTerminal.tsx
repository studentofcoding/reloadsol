"use client";

import { useEffect, useRef, useCallback } from "react";
import { useWallet } from "./WalletProvider";
import { useTradingData } from "./TradingDataProvider";
import { getSolPriceUSD } from "@/utils/solana";
import { RPC_ENDPOINTS } from "@/utils/connection";

interface JupiterTerminalProps {
  initialInputMint?: string;
  initialOutputMint?: string;
}

// Jupiter Terminal callback types based on documentation
interface SwapResult {
  txid: string;
  inputAddress: string;
  outputAddress: string;
  inputAmount: number;
  outputAmount: number;
  inputSymbol?: string;
  outputSymbol?: string;
  inputName?: string;
  outputName?: string;
  inputLogoURI?: string;
  outputLogoURI?: string;
  inputDecimals?: number;
  outputDecimals?: number;
  slippageBps?: number;
  feeAmount?: number;
}

interface QuoteResponseMeta {
  quoteResponse?: any;
  swapMode?: string;
}

interface SwapSuccessData {
  txid: string;
  swapResult: SwapResult;
  quoteResponseMeta?: QuoteResponseMeta;
}

interface SwapErrorData {
  error: any;
  quoteResponseMeta?: QuoteResponseMeta;
}

export default function JupiterTerminal({
  initialInputMint = "So11111111111111111111111111111111111111112", // SOL
  initialOutputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
}: JupiterTerminalProps) {
  const walletContextState = useWallet();
  const { trackOperation } = useTradingData();
  const terminalRef = useRef<HTMLDivElement>(null);

  // Handle successful swap
  // Handle successful swap
  const handleSwapSuccess = useCallback(
    async ({ txid, swapResult, quoteResponseMeta }: SwapSuccessData) => {
      console.log("🎉 Jupiter swap successful:", {
        txid,
        swapResult,
        quoteResponseMeta,
      });

      if (!walletContextState.publicKey || !trackOperation) {
        console.warn(
          "Cannot track swap: wallet not connected or trackOperation not available",
        );
        return;
      }

      try {
        const walletAddress = walletContextState.publicKey.toString();

        // Get current SOL price
        const solPriceResponse = await fetch("/api/sol-price");
        const { price: solPriceUsd } = await solPriceResponse.json();

        const SOL_MINT = "So11111111111111111111111111111111111111112";

        // Determine swap type and create a single tracking record
        let operationType: "buy" | "sell";
        let tokenInfo: any;
        let solAmount: number;
        let tokenAmount: number;

        // Convert raw amounts to UI amounts using proper decimals
        const inputUIAmount =
          swapResult.inputAmount / Math.pow(10, swapResult.inputDecimals || 9);
        const outputUIAmount =
          swapResult.outputAmount /
          Math.pow(10, swapResult.outputDecimals || 9);

        if (swapResult.inputAddress === SOL_MINT) {
          // SOL -> Token (Buy)
          operationType = "buy";
          solAmount = inputUIAmount; // SOL spent
          tokenAmount = outputUIAmount; // Tokens received
          tokenInfo = {
            mintAddress: swapResult.outputAddress,
            symbol: swapResult.outputSymbol || "Unknown",
            name:
              swapResult.outputName ||
              swapResult.outputSymbol ||
              "Unknown Token",
            logoURI: swapResult.outputLogoURI,
            tokenAmount,
            solAmount,
            priceUsd:
              quoteResponseMeta?.quoteResponse?.outputTokenPrice ||
              (tokenAmount > 0 ? (solAmount * solPriceUsd) / tokenAmount : 0),
            solPrice: solPriceUsd,
          };
        } else if (swapResult.outputAddress === SOL_MINT) {
          // Token -> SOL (Sell)
          operationType = "sell";
          solAmount = outputUIAmount; // SOL received
          tokenAmount = inputUIAmount; // Tokens sold
          tokenInfo = {
            mintAddress: swapResult.inputAddress,
            symbol: swapResult.inputSymbol || "Unknown",
            name:
              swapResult.inputName || swapResult.inputSymbol || "Unknown Token",
            logoURI: swapResult.inputLogoURI,
            tokenAmount,
            solAmount,
            priceUsd:
              quoteResponseMeta?.quoteResponse?.inputTokenPrice ||
              (tokenAmount > 0 ? (solAmount * solPriceUsd) / tokenAmount : 0),
            solPrice: solPriceUsd,
          };
        } else {
          // Token -> Token (treat as sell of input token)
          operationType = "sell";
          solAmount =
            (inputUIAmount *
              (quoteResponseMeta?.quoteResponse?.inputTokenPrice || 0)) /
            solPriceUsd;
          tokenAmount = inputUIAmount;
          tokenInfo = {
            mintAddress: swapResult.inputAddress,
            symbol: swapResult.inputSymbol || "Unknown",
            name:
              swapResult.inputName || swapResult.inputSymbol || "Unknown Token",
            logoURI: swapResult.inputLogoURI,
            tokenAmount,
            solAmount,
            priceUsd: quoteResponseMeta?.quoteResponse?.inputTokenPrice || 0,
            solPrice: solPriceUsd,
          };
        }

        // Ensure we have valid amounts
        if (tokenAmount <= 0) {
          console.warn("Invalid token amount, using fallback calculation");
          tokenAmount =
            operationType === "buy" ? outputUIAmount : inputUIAmount;
        }

        if (solAmount <= 0) {
          console.warn("Invalid SOL amount, using fallback calculation");
          solAmount = operationType === "buy" ? inputUIAmount : outputUIAmount;
        }

        // Track the operation
        await trackOperation({
          walletAddress,
          operationType,
          tokens: [tokenInfo],
          successCount: 1,
          failureCount: 0,
          totalTokens: 1,
          solAmount,
          feesPaid: (swapResult.feeAmount || 0) / Math.pow(10, 9), // Convert fee from lamports
          solPriceUsd,
          totalUsdValue: solAmount * solPriceUsd,
          signatures: [txid],
          slippage: swapResult.slippageBps
            ? swapResult.slippageBps / 100
            : undefined,
          is_bot_operation: false, // Jupiter Terminal swaps are manual
          jupiter_swap: true,
        });

        console.log(
          `✅ Successfully tracked Jupiter ${operationType} operation:`,
          {
            token: tokenInfo.symbol || tokenInfo.name || "Unknown",
            amount: tokenAmount,
            solAmount,
            txid: txid.slice(0, 8) + "...",
          },
        );
      } catch (error) {
        console.error("❌ Failed to track Jupiter swap:", error);
      }
    },
    [walletContextState.publicKey, trackOperation],
  );

  // Handle swap error
  const handleSwapError = useCallback(
    ({ error, quoteResponseMeta }: SwapErrorData) => {
      console.error("❌ Jupiter swap failed:", { error, quoteResponseMeta });

      // Could track failed swaps here if needed
      // For now, just log the error
    },
    [],
  );

  // Initialize Jupiter Terminal
  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    const initJupiter = () => {
      if (
        typeof window !== "undefined" &&
        window.Jupiter &&
        window.Jupiter.init
      ) {
        console.log("Initializing Jupiter Terminal with swap tracking:", {
          initialInputMint,
          initialOutputMint,
          displayMode: "integrated",
        });

        try {
          window.Jupiter.init({
            displayMode: "integrated",
            integratedTargetId: "jupiter-terminal-swap",
            endpoint: RPC_ENDPOINTS.mainnet,
            containerClassName: "rounded-2xl p-6 w-full max-w-2xl mx-auto",
            containerStyles: {
              height: "500px",
              paddingTop: "50px"
            },
            enableWalletPassthrough: true,
            passthroughWalletContextState: walletContextState,
            initialInputMint,
            initialOutputMint,
            // Add swap tracking callbacks
            onSuccess: handleSwapSuccess,
            onSwapError: handleSwapError,
          });
          return true;
        } catch (error) {
          console.error("Failed to initialize Jupiter Terminal:", error);
          return false;
        }
      }
      return false;
    };

    if (!initJupiter()) {
      // Poll for Jupiter script to load
      intervalId = setInterval(() => {
        if (initJupiter()) {
          clearInterval(intervalId);
        }
      }, 500);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [initialInputMint, initialOutputMint, handleSwapSuccess, handleSwapError, walletContextState]);

  // Sync wallet state with Jupiter Terminal
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.Jupiter?.syncProps &&
      walletContextState
    ) {
      try {
        console.log("Syncing wallet state with Jupiter Terminal:", {
          connected: walletContextState.connected,
          publicKey: walletContextState.publicKey?.toString(),
          wallet: walletContextState.wallet,
        });

        // Only sync if wallet is actually connected
        if (walletContextState.connected && walletContextState.publicKey) {
          window.Jupiter.syncProps({
            passthroughWalletContextState: walletContextState,
          });
        }
      } catch (error) {
        console.error(
          "Failed to sync wallet state with Jupiter Terminal:",
          error,
        );
      }
    }
  }, [walletContextState]);

  return (
    <div className="mx-auto border-none">
      <div id="jupiter-terminal-swap" ref={terminalRef} />
    </div>
  );
}
