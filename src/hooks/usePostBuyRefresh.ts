import { useCallback } from "react";
import { useTradingData } from "@/components/TradingDataProvider";

const WALLET_REFRESH_DELAYS_MS = [0, 2000, 5000] as const;

export type PostBuyRefreshCallbacks = {
  refreshWalletTokens: (forceRefresh?: boolean) => void | Promise<void>;
  refreshBalances?: () => void | Promise<void>;
};

/** Refetch trading records and retry wallet token/balance loads after RPC lag. */
export function usePostBuyRefresh() {
  const { refetchRecords } = useTradingData();

  return useCallback(
    (callbacks: PostBuyRefreshCallbacks) => {
      refetchRecords();
      void callbacks.refreshBalances?.();

      for (const delay of WALLET_REFRESH_DELAYS_MS) {
        setTimeout(() => {
          void callbacks.refreshWalletTokens(true);
          if (delay > 0) {
            void callbacks.refreshBalances?.();
          }
        }, delay);
      }
    },
    [refetchRecords],
  );
}
