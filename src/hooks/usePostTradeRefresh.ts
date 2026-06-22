import { useCallback } from "react";
import { useTradingData } from "@/components/TradingDataProvider";

const WALLET_REFRESH_DELAYS_MS = [0, 2000, 5000] as const;

export type PostTradeRefreshCallbacks = {
  refreshWalletTokens: (forceRefresh?: boolean) => void | Promise<void>;
  refreshBalances?: () => void | Promise<void>;
};

type PostTradeRefreshOptions = {
  refetchRecords?: boolean;
};

/** Retry wallet token/balance loads after RPC lag (buy, sell, close). */
export function usePostTradeRefresh(options: PostTradeRefreshOptions = {}) {
  const { refetchRecords } = useTradingData();
  const shouldRefetchRecords = options.refetchRecords !== false;

  return useCallback(
    (callbacks: PostTradeRefreshCallbacks) => {
      if (shouldRefetchRecords) {
        refetchRecords();
      }
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
    [refetchRecords, shouldRefetchRecords],
  );
}
