import { useQuery } from "@tanstack/react-query";

export type OhlcBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

async function fetchOhlc(
  tokenAddress: string,
  interval = "5m",
  limit = 288,
): Promise<OhlcBar[]> {
  const response = await fetch(
    `/api/ohlc?mint=${tokenAddress}&interval=${interval}&limit=${limit}`,
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to fetch OHLC data");
  }
  return data.bars ?? data.candles ?? data ?? [];
}

export function useOhlcData(
  tokenAddress: string | null,
  options?: { interval?: string; limit?: number; enabled?: boolean },
) {
  const interval = options?.interval ?? "5m";
  const limit = options?.limit ?? 288;
  const enabled = options?.enabled !== false && !!tokenAddress;

  return useQuery({
    queryKey: ["ohlc", tokenAddress, interval, limit],
    queryFn: () => fetchOhlc(tokenAddress!, interval, limit),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });
}
