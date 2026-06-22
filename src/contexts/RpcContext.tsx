"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Connection } from "@solana/web3.js";
import type { RpcDiagnosticRow } from "@/app/api/rpc/diagnostics/route";

const STORAGE_KEY = "reloadsol:rpc-endpoint";
const AUTO_STORAGE_KEY = "reloadsol:rpc-auto";
const AUTO_RECHECK_MS = 30 * 60 * 1000;
const HEALTH_REFRESH_MS = 60_000;

const DEFAULT_FALLBACK_RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.mainnet-beta.solana.com";

function buildFallbackEndpoints(): RpcEndpoint[] {
  return [
    {
      index: 0,
      provider: "Fallback",
      sanitizedUrl: DEFAULT_FALLBACK_RPC_URL.replace(/api_key=[^&]+/, "api_key=***"),
      url: DEFAULT_FALLBACK_RPC_URL,
    },
  ];
}

export type RpcEndpoint = {
  index: number;
  provider: string;
  sanitizedUrl: string;
  url: string;
  responseTime?: number;
  healthy?: boolean;
};

export type TokenFetchMeta = {
  rawAccountCount: number;
  latencyMs: number;
  rpcLabel: string;
  error?: string;
};

type RpcContextValue = {
  endpoints: RpcEndpoint[];
  selectedEndpointIndex: number;
  selectedEndpoint: RpcEndpoint | null;
  activeRpcUrl: string;
  connection: Connection;
  autoSelectBest: boolean;
  isLoadingEndpoints: boolean;
  diagnostics: RpcDiagnosticRow[];
  isRunningDiagnostics: boolean;
  setSelectedEndpointIndex: (index: number) => void;
  setAutoSelectBest: (enabled: boolean) => void;
  runDiagnostics: (walletAddress: string) => Promise<RpcDiagnosticRow[]>;
  refreshHealth: () => Promise<void>;
  autoSelectBestEndpoint: (walletAddress: string) => Promise<void>;
};

const RpcContext = createContext<RpcContextValue | null>(null);

function readStoredIndex(): number | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readAutoSelect(): boolean {
  if (typeof window === "undefined") return true;
  const raw = localStorage.getItem(AUTO_STORAGE_KEY);
  return raw !== "false";
}

function resolveUrlForIndex(
  endpoints: RpcEndpoint[],
  index: number,
): string {
  const match = endpoints.find((ep) => ep.index === index);
  return match?.url ?? endpoints[0]?.url ?? DEFAULT_FALLBACK_RPC_URL;
}

export function RpcProvider({ children }: { children: React.ReactNode }) {
  const [endpoints, setEndpoints] = useState<RpcEndpoint[]>([]);
  const [selectedEndpointIndex, setSelectedEndpointIndexState] = useState(0);
  const [activeRpcUrl, setActiveRpcUrl] = useState(DEFAULT_FALLBACK_RPC_URL);
  const [autoSelectBest, setAutoSelectBestState] = useState(true);
  const [isLoadingEndpoints, setIsLoadingEndpoints] = useState(true);
  const [diagnostics, setDiagnostics] = useState<RpcDiagnosticRow[]>([]);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);
  const autoSelectRanRef = useRef(false);
  const lastAutoCheckRef = useRef(0);
  const selectedEndpointIndexRef = useRef(selectedEndpointIndex);
  const endpointsRef = useRef(endpoints);
  selectedEndpointIndexRef.current = selectedEndpointIndex;
  endpointsRef.current = endpoints;

  const connection = useMemo(
    () => new Connection(activeRpcUrl, "confirmed"),
    [activeRpcUrl],
  );

  const refreshHealth = useCallback(async () => {
    const currentEndpoints = endpointsRef.current;
    if (currentEndpoints.length === 0) return;
    try {
      const response = await fetch("/api/rpc/health");
      if (!response.ok) return;
      const data = await response.json();
      setEndpoints((prev) =>
        prev.map((ep) => {
          const match = (data.endpoints ?? []).find(
            (row: { url: string; healthy: boolean; responseTime: number }) =>
              row.url === ep.url,
          );
          return match
            ? {
                ...ep,
                healthy: match.healthy,
                responseTime: match.responseTime,
              }
            : ep;
        }),
      );
    } catch {
      // best effort
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadEndpoints() {
      setIsLoadingEndpoints(true);
      try {
        const response = await fetch("/api/rpc/diagnostics");
        if (!response.ok) throw new Error("Failed to load RPC endpoints");
        const data = await response.json();
        if (cancelled) return;

        const loaded: RpcEndpoint[] = data.endpoints ?? [];
        if (loaded.length === 0) throw new Error("No RPC endpoints configured");

        endpointsRef.current = loaded;
        setEndpoints(loaded);

        const stored = readStoredIndex();
        const auto = readAutoSelect();
        setAutoSelectBestState(auto);

        const initialIndex =
          stored !== null && loaded.some((ep) => ep.index === stored)
            ? stored
            : loaded[0].index;

        setSelectedEndpointIndexState(initialIndex);
        setActiveRpcUrl(resolveUrlForIndex(loaded, initialIndex));
        void refreshHealth();
      } catch (error) {
        console.error("Failed to load RPC endpoints:", error);
        if (cancelled) return;

        const fallback = buildFallbackEndpoints();
        endpointsRef.current = fallback;
        setEndpoints(fallback);
        setSelectedEndpointIndexState(0);
        setActiveRpcUrl(fallback[0].url);
        void refreshHealth();
      } finally {
        if (!cancelled) setIsLoadingEndpoints(false);
      }
    }

    void loadEndpoints();
    return () => {
      cancelled = true;
    };
  }, [refreshHealth]);

  useEffect(() => {
    if (endpoints.length === 0) return;
    const interval = setInterval(() => {
      void refreshHealth();
    }, HEALTH_REFRESH_MS);
    return () => clearInterval(interval);
  }, [endpoints.length, refreshHealth]);

  const setSelectedEndpointIndex = useCallback((index: number) => {
    const currentEndpoints = endpointsRef.current;
    setSelectedEndpointIndexState(index);
    const next = resolveUrlForIndex(currentEndpoints, index);
    setActiveRpcUrl((prev) => (prev === next ? prev : next));
    localStorage.setItem(STORAGE_KEY, String(index));
    localStorage.setItem(AUTO_STORAGE_KEY, "false");
    setAutoSelectBestState(false);
  }, []);

  const setAutoSelectBest = useCallback((enabled: boolean) => {
    setAutoSelectBestState(enabled);
    localStorage.setItem(AUTO_STORAGE_KEY, enabled ? "true" : "false");
  }, []);

  const runDiagnostics = useCallback(async (walletAddress: string) => {
    setIsRunningDiagnostics(true);
    try {
      const response = await fetch("/api/rpc/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      if (!response.ok) {
        throw new Error("RPC diagnostics failed");
      }
      const data = await response.json();
      const results: RpcDiagnosticRow[] = data.results ?? [];
      setDiagnostics(results);
      return results;
    } finally {
      setIsRunningDiagnostics(false);
    }
  }, []);

  const autoSelectBestEndpoint = useCallback(
    async (walletAddress: string) => {
      if (!autoSelectBest) return;

      const now = Date.now();
      if (
        autoSelectRanRef.current &&
        now - lastAutoCheckRef.current < AUTO_RECHECK_MS
      ) {
        return;
      }

      const currentIndex = selectedEndpointIndexRef.current;
      const currentEndpoints = endpointsRef.current;
      const currentEndpoint = currentEndpoints.find(
        (ep) => ep.index === currentIndex,
      );
      if (currentEndpoint?.healthy && autoSelectRanRef.current) {
        return;
      }

      const results = await runDiagnostics(walletAddress);
      lastAutoCheckRef.current = now;
      autoSelectRanRef.current = true;

      const best = [...results]
        .filter((r) => r.healthy)
        .sort((a, b) => {
          if (b.rawAccountCount !== a.rawAccountCount) {
            return b.rawAccountCount - a.rawAccountCount;
          }
          return a.getParsedTokenAccountsMs - b.getParsedTokenAccountsMs;
        })[0];

      if (best && best.index !== currentIndex) {
        setSelectedEndpointIndexState(best.index);
        const next = resolveUrlForIndex(currentEndpoints, best.index);
        setActiveRpcUrl((prev) => (prev === next ? prev : next));
        localStorage.setItem(STORAGE_KEY, String(best.index));
      }
    },
    [autoSelectBest, runDiagnostics],
  );

  const selectedEndpoint =
    endpoints.find((ep) => ep.index === selectedEndpointIndex) ??
    endpoints[0] ??
    null;

  const value = useMemo(
    () => ({
      endpoints,
      selectedEndpointIndex,
      selectedEndpoint,
      activeRpcUrl,
      connection,
      autoSelectBest,
      isLoadingEndpoints,
      diagnostics,
      isRunningDiagnostics,
      setSelectedEndpointIndex,
      setAutoSelectBest,
      runDiagnostics,
      refreshHealth,
      autoSelectBestEndpoint,
    }),
    [
      endpoints,
      selectedEndpointIndex,
      selectedEndpoint,
      activeRpcUrl,
      connection,
      autoSelectBest,
      isLoadingEndpoints,
      diagnostics,
      isRunningDiagnostics,
      setSelectedEndpointIndex,
      setAutoSelectBest,
      runDiagnostics,
      refreshHealth,
      autoSelectBestEndpoint,
    ],
  );

  return <RpcContext.Provider value={value}>{children}</RpcContext.Provider>;
}

export function useRpc() {
  const context = useContext(RpcContext);
  if (!context) {
    throw new Error("useRpc must be used within RpcProvider");
  }
  return context;
}

export function useRpcOptional() {
  return useContext(RpcContext);
}
