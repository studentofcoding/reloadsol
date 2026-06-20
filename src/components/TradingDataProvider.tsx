"use client";

import React, { createContext, useContext, useCallback } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { tradingTracker, TrackingRecord } from "@/utils/trading-tracker";
import { useWallet, useWalletAddress } from "./WalletProvider";
import { useWalletSession } from "./WalletSessionContext";

// Create a stable query client instance
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      retry: 2,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 1,
    },
  },
});

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
  tradingRecords: (walletAddress: string) => ["trading-records", walletAddress],
  walletTokens: (walletAddress: string) => ["wallet-tokens", walletAddress],
  solPrice: ["sol-price"],
} as const;

// SOL Price hook
export function useSolPrice() {
  return useQuery({
    queryKey: QUERY_KEYS.solPrice,
    queryFn: async () => {
      try {
        // Try to fetch from API
        if (typeof window !== "undefined") {
          const response = await fetch("/api/solprice");
          if (response.ok) {
            const data = await response.json();
            return data.price || 0;
          }
        }
        return 0;
      } catch (error) {
        console.warn("Failed to fetch SOL price:", error);
        return 0;
      }
    },
    staleTime: 1000 * 60, // 1 minute
    refetchInterval: 1000 * 60 * 5, // 5 minutes
  });
}

// Trading records hook
export function useTradingRecords(
  walletAddress?: string,
  sessionReady = true,
) {
  return useQuery({
    queryKey: QUERY_KEYS.tradingRecords(walletAddress || ""),
    queryFn: async () => {
      if (!walletAddress) return [];
      return await tradingTracker.getWalletRecords(walletAddress, false); // Force fresh fetch
    },
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message === 'WALLET_SESSION_REQUIRED') {
        return failureCount < 2;
      }
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
    enabled: !!walletAddress && sessionReady,
    staleTime: 1000 * 10, // 10 seconds for trading records
    refetchInterval: sessionReady && walletAddress ? 1000 * 15 : false,
  });
}

// Track operation mutation
export function useTrackOperation() {
  const queryClient = useQueryClient();
  const walletAddress = useWalletAddress();

  return useMutation({
    mutationFn: async (operation: Omit<TrackingRecord, "id" | "timestamp">) => {
      await tradingTracker.trackOperation(operation);
    },
    onMutate: async (operation) => {
      if (!walletAddress) return undefined;

      await queryClient.cancelQueries({
        queryKey: QUERY_KEYS.tradingRecords(walletAddress),
      });

      const previous = queryClient.getQueryData<TrackingRecord[]>(
        QUERY_KEYS.tradingRecords(walletAddress),
      );

      const optimisticRecord: TrackingRecord = {
        ...operation,
        id: `optimistic-${Date.now()}`,
        timestamp: Date.now(),
      };

      queryClient.setQueryData<TrackingRecord[]>(
        QUERY_KEYS.tradingRecords(walletAddress),
        (old) => [optimisticRecord, ...(old ?? [])],
      );

      return { previous };
    },
    onError: (error, _operation, context) => {
      if (walletAddress && context?.previous !== undefined) {
        queryClient.setQueryData(
          QUERY_KEYS.tradingRecords(walletAddress),
          context.previous,
        );
      }
      console.error("Failed to track operation:", error);
    },
    onSettled: () => {
      if (walletAddress) {
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.tradingRecords(walletAddress),
        });
      }
    },
  });
}

// Delete record mutation
export function useDeleteRecord() {
  const queryClient = useQueryClient();
  const { publicKey } = useWallet();
  const walletAddress = useWalletAddress();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!walletAddress) throw new Error("Wallet not connected");
      await tradingTracker.deleteRecord(id, walletAddress);
    },
    onSuccess: () => {
      if (walletAddress) {
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.tradingRecords(walletAddress),
        });

        setTimeout(() => {
          queryClient.refetchQueries({
            queryKey: QUERY_KEYS.tradingRecords(walletAddress),
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
  const walletAddress = useWalletAddress();
  const { status: walletSessionStatus } = useWalletSession();
  const sessionReady = walletSessionStatus === 'ready';

  // Query for trading records
  const {
    data: records = [],
    isLoading: isLoadingRecords,
    error: recordsError,
    refetch: refetchRecords,
  } = useTradingRecords(walletAddress ?? undefined, sessionReady);

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
  const [isSubscribed, setIsSubscribed] = React.useState(false);

  React.useEffect(() => {
    if (!walletAddress || !sessionReady) {
      setIsSubscribed(false);
      return;
    }

    setIsSubscribed(true);

    const refetchRecordsForWallet = () => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.tradingRecords(walletAddress),
      });
      setTimeout(() => {
        queryClient.refetchQueries({
          queryKey: QUERY_KEYS.tradingRecords(walletAddress),
        });
      }, 300);
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
      setIsSubscribed(false);
      window.removeEventListener("reloadsol-wallet-session", onSessionReady);
      unsubscribe();
    };
  }, [walletAddress, sessionReady, queryClient]);

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

// Main provider that includes QueryClient
export default function TradingDataProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <TradingDataProviderInner>{children}</TradingDataProviderInner>
    </QueryClientProvider>
  );
}

// Export the query client for direct access if needed
export { queryClient };
