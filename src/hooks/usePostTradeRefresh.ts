import { useCallback } from "react";
import { useTradingData } from "@/components/TradingDataProvider";

// One immediate pass + one retry after RPC lag settles. Previously [0, 2000,
// 5000] fired three full-portfolio `fresh=1` refetches (each purging the shared
// cache) plus three balance refetches — a self-amplifying burst right after a
// trade that froze busy wallets.
const WALLET_REFRESH_DELAYS_MS = [0, 2500] as const;

export type PostTradeRefreshCallbacks = {
  refreshWalletTokens: (forceRefresh?: boolean) => void | Promise<void>;
  refreshBalances?: (fresh?: boolean) => void | Promise<void>;
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
      // Immediate balance pass — callers' closures already use `fresh=1` where
      // the swap just confirmed, so the just-changed balance shows up right away.
      void callbacks.refreshBalances?.(true);

      for (const delay of WALLET_REFRESH_DELAYS_MS) {
        setTimeout(() => {
          void callbacks.refreshWalletTokens(true);
          if (delay > 0) {
            void callbacks.refreshBalances?.(true);
          }
        }, delay);
      }
    },
    [refetchRecords, shouldRefetchRecords],
  );
}
