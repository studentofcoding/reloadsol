import { usePostTradeRefresh, type PostTradeRefreshCallbacks } from "@/hooks/usePostTradeRefresh";

export type PostBuyRefreshCallbacks = PostTradeRefreshCallbacks;

/** Refetch trading records and retry wallet token/balance loads after RPC lag. */
export function usePostBuyRefresh() {
  return usePostTradeRefresh({ refetchRecords: true });
}
