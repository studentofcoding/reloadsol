"use client";

import React, { createContext, useContext, useCallback, useState, useEffect } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { tradingTracker, TrackingRecord } from "@/utils/trading-tracker";
import { useWalletSession } from "./WalletSessionContext";
import { queryClient } from "./AppQueryClientProvider";
import { useSolPrice } from "@/hooks/useSolPrice";
import { usePortfolioWallet } from "@/hooks/usePortfolioWallet";
import type { AppNetwork } from "@/utils/app-network";

// Trading data context
interface TradingDataContextType {
  // Records management
  records: TrackingRecord[];
  isLoadingRecords: boolean;
  recordsError: string | null;
  refetchRecords: () => void;

  // Mutations
  trackOperation: (
    operation: Omit<TrackingRecord, "id" | "timestamp">,
  ) => Promise<void>;
  deleteRecord: (id: string) => Promise<void>;

  // Real-time subscription status
  isSubscribed: boolean;

  // Market Data
  solPrice: number;
}

const TradingDataContext = createContext<TradingDataContextType | null>(null);

// Custom hook to use trading data
export function useTradingData() {
  const context = useContext(TradingDataContext);
  if (!context) {
    throw new Error("useTradingData must be used within TradingDataProvider");
  }
  return context;
}

// Query keys
const QUERY_KEYS = {
  tradingRecords: (walletAddress: string, chain: AppNetwork = "sol") =>
    ["trading-records", walletAddress, chain] as const,
  walletTokens: (walletAddress: string) => ["wallet-tokens", walletAddress],
} as const;

// Trading records hook
export function useTradingRecords(
  walletAddress?: string,
  sessionReady = true,
  refetchIntervalMs: number | false = 5_000,
  chain: AppNetwork = "sol",
) {
  return useQuery({
    queryKey: QUERY_KEYS.tradingRecords(walletAddress || "", chain),
    queryFn: async () => {
      if (!walletAddress) return [];
      return await tradingTracker.getWalletRecords(
        walletAddress,
        false,
        chain,
      );
    },
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message === 'WALLET_SESSION_REQUIRED') {
        return failureCount < 2;
      }
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
    enabled: !!walletAddress && sessionReady,
    staleTime: 1000 * 3,
    refetchInterval:
      sessionReady && walletAddress && refetchIntervalMs !== false
        ? refetchIntervalMs
        : false,
  });
}

// Track operation mutation
export function useTrackOperation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (operation: Omit<TrackingRecord, "id" | "timestamp">) => {
      return await tradingTracker.trackOperation(operation);
    },
    onMutate: async (operation) => {
      const opWallet = operation.walletAddress;
      const chain = operation.chain ?? "sol";
      if (!opWallet) return undefined;

      await queryClient.cancelQueries({
        queryKey: QUERY_KEYS.tradingRecords(opWallet, chain),
      });

      const previous = queryClient.getQueryData<TrackingRecord[]>(
        QUERY_KEYS.tradingRecords(opWallet, chain),
      );

      const optimisticRecord: TrackingRecord = {
        ...operation,
        id: `optimistic-${Date.now()}`,
        timestamp: Date.now(),
      };

      queryClient.setQueryData<TrackingRecord[]>(
        QUERY_KEYS.tradingRecords(opWallet, chain),
        (old) => [optimisticRecord, ...(old ?? [])],
      );

      return { previous, optimisticId: optimisticRecord.id, opWallet, chain };
    },
    onSuccess: (savedRecord, _operation, context) => {
      const opWallet = context?.opWallet ?? _operation.walletAddress;
      const chain = context?.chain ?? _operation.chain ?? "sol";
      if (!opWallet) return;

      queryClient.setQueryData<TrackingRecord[]>(
        QUERY_KEYS.tradingRecords(opWallet, chain),
        (old) => {
          const withoutOptimistic = (old ?? []).filter(
            (r) => r.id !== context?.optimisticId && !r.id.startsWith('optimistic-'),
          );
          const withoutDuplicate = withoutOptimistic.filter(
            (r) => r.id !== savedRecord.id,
          );
          return [savedRecord, ...withoutDuplicate];
        },
      );
    },
    onError: (error, operation, context) => {
      const opWallet = context?.opWallet ?? operation.walletAddress;
      const chain = context?.chain ?? operation.chain ?? "sol";
      if (opWallet && context?.previous !== undefined) {
        queryClient.setQueryData(
          QUERY_KEYS.tradingRecords(opWallet, chain),
          context.previous,
        );
      }
      console.error("Failed to track operation:", error);
    },
    onSettled: (_data, _error, operation) => {
      const opWallet = operation.walletAddress;
      const chain = operation.chain ?? "sol";
      if (!opWallet) return;

      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.tradingRecords(opWallet, chain),
      });
      void queryClient.refetchQueries({
        queryKey: QUERY_KEYS.tradingRecords(opWallet, chain),
      });
    },
  });
}

// Delete record mutation
export function useDeleteRecord() {
  const queryClient = useQueryClient();
  const { network, walletAddress } = usePortfolioWallet();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!walletAddress) throw new Error("Wallet not connected");
      await tradingTracker.deleteRecord(id, walletAddress);
    },
    onSuccess: () => {
      if (walletAddress) {
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.tradingRecords(walletAddress, network),
        });

        setTimeout(() => {
          queryClient.refetchQueries({
            queryKey: QUERY_KEYS.tradingRecords(walletAddress, network),
          });
        }, 500);
      }
    },
    onError: (error) => {
      console.error("Failed to delete record:", error);
    },
  });
}

// Trading data provider component
function TradingDataProviderInner({ children }: { children: React.ReactNode }) {
  const { network, walletAddress } = usePortfolioWallet();
  const { status: walletSessionStatus } = useWalletSession();
  const sessionReady =
    network === "robinhood"
      ? Boolean(walletAddress)
      : walletSessionStatus === "ready" || walletSessionStatus === "checking";

  const [sseConnected, setSseConnected] = useState(false);

  useEffect(() => {
    return tradingTracker.onSSEStateChange(setSseConnected);
  }, []);

  const recordsRefetchInterval =
    sessionReady && walletAddress ? (sseConnected ? 30_000 : 5_000) : false;

  // Query for trading records
  const {
    data: records = [],
    isLoading: isLoadingRecords,
    error: recordsError,
    refetch: refetchRecords,
  } = useTradingRecords(
    walletAddress ?? undefined,
    sessionReady,
    recordsRefetchInterval,
    network,
  );

  // Track operation mutation
  const trackOperationMutation = useTrackOperation();

  // SOL Price
  const { data: solPrice } = useSolPrice();

  // Track operation wrapper
  const trackOperation = useCallback(
    async (operation: Omit<TrackingRecord, "id" | "timestamp">) => {
      await trackOperationMutation.mutateAsync(operation);
    },
    [trackOperationMutation],
  );

  // Delete record mutation
  const deleteRecordMutation = useDeleteRecord();

  const deleteRecord = useCallback(
    async (id: string) => {
      await deleteRecordMutation.mutateAsync(id);
    },
    [deleteRecordMutation],
  );

  // Set up real-time subscription
  const isSubscribed = !!(walletAddress && sessionReady);

  React.useEffect(() => {
    if (!walletAddress || !sessionReady) {
      return;
    }

    const refetchRecordsForWallet = () => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.tradingRecords(walletAddress, network),
      });
      queryClient.invalidateQueries({
        queryKey: ["wallet-tokens", walletAddress],
      });
    };

    const onSessionReady = (event: Event) => {
      const detail = (event as CustomEvent<{ address?: string }>).detail;
      if (!detail?.address || detail.address === walletAddress) {
        refetchRecordsForWallet();
      }
    };

    window.addEventListener("reloadsol-wallet-session", onSessionReady);

    // Subscribe to real-time updates
    const unsubscribe = tradingTracker.subscribeToWallet(walletAddress, () => {
      console.log("📡 Real-time update received, invalidating queries...");
      refetchRecordsForWallet();
    });

    return () => {
      window.removeEventListener("reloadsol-wallet-session", onSessionReady);
      unsubscribe();
    };
  }, [walletAddress, sessionReady, network]);

  const contextValue: TradingDataContextType = {
    records,
    isLoadingRecords,
    recordsError: recordsError?.message || null,
    refetchRecords,
    trackOperation,
    deleteRecord,
    isSubscribed,
    solPrice: solPrice || 0,
  };

  return (
    <TradingDataContext.Provider value={contextValue}>
      {children}
    </TradingDataContext.Provider>
  );
}

// Main provider — mount under (trade) layout only (SSE + records polling)
export default function TradingDataProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <TradingDataProviderInner>{children}</TradingDataProviderInner>;
}
