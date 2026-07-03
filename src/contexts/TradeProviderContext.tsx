"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getTradeProvider,
  setTradeProvider as persistTradeProvider,
  subscribeTradeProvider,
  type TradeProvider,
} from "@/utils/trade-provider";

type TradeProviderContextValue = {
  provider: TradeProvider;
  setProvider: (provider: TradeProvider) => void;
  isShyft: boolean;
};

const TradeProviderContext = createContext<TradeProviderContextValue | null>(
  null,
);

export function TradeProviderProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [provider, setProviderState] = useState<TradeProvider>(() =>
    getTradeProvider(),
  );

  useEffect(() => subscribeTradeProvider(setProviderState), []);

  const setProvider = useCallback((next: TradeProvider) => {
    persistTradeProvider(next);
  }, []);

  const value = useMemo(
    () => ({
      provider,
      setProvider,
      isShyft: provider === "shyft",
    }),
    [provider, setProvider],
  );

  return (
    <TradeProviderContext.Provider value={value}>
      {children}
    </TradeProviderContext.Provider>
  );
}

export function useTradeProvider(): TradeProviderContextValue {
  const ctx = useContext(TradeProviderContext);
  if (!ctx) {
    throw new Error(
      "useTradeProvider must be used within TradeProviderProvider",
    );
  }
  return ctx;
}

/** Optional hook — returns null when provider context is absent. */
export function useTradeProviderOptional(): TradeProviderContextValue | null {
  return useContext(TradeProviderContext);
}
