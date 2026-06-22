import { useQuery } from "@tanstack/react-query";

export interface LastReloadData {
  walletAddress: string;
  totalSolRecovered: number;
  lastOperationTime: string;
  operationType: "swap" | "close";
  shortWallet: string;
}

async function fetchLastReload(): Promise<LastReloadData[]> {
  const response = await fetch("/api/operations/last-reload", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    if (response.status === 404 || response.status >= 500) {
      return [];
    }
    const errorData = await response.json();
    throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
  }

  return response.json();
}

export function useLastReload(refreshInterval = 30_000) {
  return useQuery({
    queryKey: ["last-reload"],
    queryFn: fetchLastReload,
    refetchInterval: refreshInterval > 0 ? refreshInterval : false,
    staleTime: 15_000,
  });
}
